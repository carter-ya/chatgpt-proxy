package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"log"
	"mime"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	"chatgpt-proxy/backend/internal/db"
	"chatgpt-proxy/backend/internal/httpresp"
	"chatgpt-proxy/backend/internal/proxy"
	"chatgpt-proxy/backend/internal/session"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// ProxyHandler holds dependencies for proxy HTTP handlers.
type ProxyHandler struct {
	client         proxy.ProxyClient
	sessionManager *session.Manager
	queries        *db.Queries
}

// NewProxyHandler creates a new ProxyHandler.
func NewProxyHandler(client proxy.ProxyClient, sessionManager *session.Manager, queries *db.Queries) *ProxyHandler {
	return &ProxyHandler{
		client:         client,
		sessionManager: sessionManager,
		queries:        queries,
	}
}

// conversationRequest is the expected JSON body for POST /api/conversation.
type conversationRequest struct {
	Message          string             `json:"message"`
	Model            string             `json:"model"`
	ConversationID   string             `json:"conversation_id"`
	Stream           bool               `json:"stream"`
	GenID            string             `json:"gen_id"`
	AttachmentFileID string             `json:"attachment_file_id"`
	Attachment       *attachmentRequest `json:"attachment"`
	OriginalGenID    string             `json:"original_gen_id"`
	OriginalFileID   string             `json:"original_file_id"`
	WebSearch        bool               `json:"web_search"`
	ImageMode        bool               `json:"-"`
}

type attachmentRequest struct {
	FileID    string `json:"file_id"`
	FileName  string `json:"file_name"`
	MIMEType  string `json:"mime_type"`
	SizeBytes int64  `json:"size_bytes"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
}

type upstreamFileCreateResponse struct {
	FileID    string `json:"file_id"`
	UploadURL string `json:"upload_url"`
}

type upstreamFileDownloadResponse struct {
	Status      string `json:"status"`
	DownloadURL string `json:"download_url"`
	FileName    string `json:"file_name"`
	MIMEType    string `json:"mime_type"`
	FileSize    int64  `json:"file_size_bytes"`
}

type apiFileAsset struct {
	FileID      string `json:"file_id"`
	FileName    string `json:"file_name"`
	MIMEType    string `json:"mime_type"`
	SizeBytes   int64  `json:"size_bytes"`
	Width       int    `json:"width"`
	Height      int    `json:"height"`
	DownloadURL string `json:"download_url"`
}

type apiMessage struct {
	Role        string         `json:"role"`
	Content     string         `json:"content"`
	Images      []apiFileAsset `json:"images,omitempty"`
	Attachments []apiFileAsset `json:"attachments,omitempty"`
}

// Conversation handles POST /api/conversation.
func (h *ProxyHandler) Conversation(c *gin.Context) {
	var reqBody conversationRequest
	if err := c.ShouldBindJSON(&reqBody); err != nil {
		httpresp.Error(c, http.StatusBadRequest, "请求格式错误: "+err.Error())
		return
	}

	// Validate non-empty message.
	if strings.TrimSpace(reqBody.Message) == "" {
		httpresp.Error(c, http.StatusBadRequest, "消息内容不能为空")
		return
	}

	h.proxyConversation(c, reqBody)
}

// ImageGeneration handles the independent ChatGPT Images workflow. It uses
// the same upstream conversation transport with the picture_v2 hint that the
// official /images page sends.
func (h *ProxyHandler) ImageGeneration(c *gin.Context) {
	var req struct {
		Prompt         string             `json:"prompt"`
		Model          string             `json:"model"`
		Attachment     *attachmentRequest `json:"attachment"`
		ConversationID string             `json:"conversation_id"`
		OriginalGenID  string             `json:"original_gen_id"`
		OriginalFileID string             `json:"original_file_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Prompt) == "" {
		httpresp.Error(c, http.StatusBadRequest, "图片提示词不能为空")
		return
	}
	h.proxyConversation(c, conversationRequest{
		Message:        req.Prompt,
		Model:          req.Model,
		Stream:         true,
		ImageMode:      true,
		Attachment:     req.Attachment,
		ConversationID: req.ConversationID,
		OriginalGenID:  req.OriginalGenID,
		OriginalFileID: req.OriginalFileID,
	})
}

// ImageSelection forwards the Images workspace candidate-selection signal.
func (h *ProxyHandler) ImageSelection(c *gin.Context) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
	defer cancel()
	req, err := h.client.BuildRequest(ctx, http.MethodPost, "/backend-api/image-gen/message-select", "", bytes.NewReader([]byte(`{}`)), "application/json")
	if err != nil {
		httpresp.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		httpresp.Error(c, http.StatusBadGateway, err.Error())
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	c.Data(resp.StatusCode, "application/json", body)
}

func (h *ProxyHandler) proxyConversation(c *gin.Context, reqBody conversationRequest) {
	ctx := c.Request.Context()

	// Image generation regularly exceeds one minute; keep a finite upper bound
	// without terminating valid long-running handoff streams.
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()

	// Browser-profile mode authenticates upstream requests through sidecar Chrome.
	resp, tokenValue, err := h.doConversationWithRetry(ctx, reqBody)
	if err != nil {
		httpresp.Error(c, http.StatusInternalServerError, "代理请求失败: "+err.Error())
		return
	}
	defer resp.Body.Close()

	// Handle non-streaming response.
	if !reqBody.Stream {
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			httpresp.Error(c, http.StatusBadGateway, "读取上游响应失败")
			return
		}

		// Check if response is valid JSON (not Cloudflare challenge HTML).
		if !json.Valid(body) {
			log.Printf("[Proxy] 非 JSON 响应 (Conversation 非流式) status=%d body_prefix=%.200s", resp.StatusCode, string(body))
			writeProxyError(c, resp.StatusCode, body, "上游返回了非 JSON 响应（可能触发了 Cloudflare 验证）")
			return
		}

		c.Data(resp.StatusCode, "application/json", body)
		return
	}

	// Handle SSE streaming.
	// Gate: reject non-event-stream responses before streaming (R-1.14).
	if !strings.Contains(resp.Header.Get("Content-Type"), "text/event-stream") {
		log.Printf("[Proxy] 非 JSON 响应 (Conversation 流式) status=%d content_type=%s", resp.StatusCode, resp.Header.Get("Content-Type"))
		body, _ := io.ReadAll(resp.Body)
		writeProxyError(c, resp.StatusCode, body, "上游返回了非 JSON 响应（可能触发了 Cloudflare 验证）")
		return
	}
	if err := proxy.StreamSSE(c, resp); err != nil {
		// SSE streaming errors are logged but the response may already be partially sent.
		log.Printf("[Proxy] SSE 流异常: %v", err)
		h.markTokenExpiredByValue(ctx, tokenValue)
		return
	}
}

// doConversationWithRetry sends the conversation request through sidecar Chrome.
// The token return value is retained for the old interface but is always empty in browser-profile mode.
func (h *ProxyHandler) doConversationWithRetry(ctx context.Context, reqBody conversationRequest) (*http.Response, string, error) {
	tokenValue := ""

	now := float64(time.Now().UnixMilli()) / 1000
	messageHints := []interface{}{}
	thinkingEffort := "max"
	if reqBody.ImageMode {
		messageHints = []interface{}{"picture_v2"}
		thinkingEffort = "standard"
	}

	attachment := reqBody.Attachment
	if attachment == nil && reqBody.AttachmentFileID != "" {
		attachment = &attachmentRequest{
			FileID:   reqBody.AttachmentFileID,
			FileName: reqBody.AttachmentFileID,
			MIMEType: "image/png",
		}
	}

	// Build the user message with ChatGPT's attachment metadata.
	var userMessage map[string]interface{}
	if attachment != nil && attachment.FileID != "" {
		attachmentMetadata := map[string]interface{}{
			"id":       attachment.FileID,
			"name":     attachment.FileName,
			"mimeType": attachment.MIMEType,
			"size":     attachment.SizeBytes,
		}
		messageMetadata := map[string]interface{}{
			"attachments":      []interface{}{attachmentMetadata},
			"selected_sources": []interface{}{},
			"serialization_metadata": map[string]interface{}{
				"custom_symbol_offsets": []interface{}{},
			},
		}
		if reqBody.ImageMode {
			messageMetadata["system_hints"] = messageHints
		}

		content := map[string]interface{}{
			"content_type": "text",
			"parts":        []string{reqBody.Message},
		}
		if strings.HasPrefix(attachment.MIMEType, "image/") {
			attachmentMetadata["width"] = attachment.Width
			attachmentMetadata["height"] = attachment.Height
			content = map[string]interface{}{
				"content_type": "multimodal_text",
				"parts": []interface{}{
					map[string]interface{}{
						"content_type":  "image_asset_pointer",
						"asset_pointer": "file-service://" + attachment.FileID,
						"size_bytes":    attachment.SizeBytes,
						"width":         attachment.Width,
						"height":        attachment.Height,
					},
					reqBody.Message,
				},
			}
		}

		userMessage = map[string]interface{}{
			"id":          uuid.New().String(),
			"author":      map[string]interface{}{"role": "user"},
			"create_time": now,
			"content":     content,
			"metadata":    messageMetadata,
		}
	} else {
		userMessage = map[string]interface{}{
			"id":          uuid.New().String(),
			"author":      map[string]interface{}{"role": "user"},
			"create_time": now,
			"content": map[string]interface{}{
				"content_type": "text",
				"parts":        []string{reqBody.Message},
			},
			"metadata": func() map[string]interface{} {
				metadata := map[string]interface{}{
					"selected_sources": []interface{}{},
					"serialization_metadata": map[string]interface{}{
						"custom_symbol_offsets": []interface{}{},
					},
				}
				if reqBody.ImageMode {
					metadata["system_hints"] = messageHints
				}
				return metadata
			}(),
		}
	}
	if reqBody.ImageMode && reqBody.OriginalGenID != "" && reqBody.OriginalFileID != "" {
		metadata := userMessage["metadata"].(map[string]interface{})
		metadata["dalle"] = map[string]interface{}{"from_client": map[string]interface{}{"operation": map[string]interface{}{
			"type": "transformation", "original_gen_id": reqBody.OriginalGenID, "original_file_id": reqBody.OriginalFileID,
		}}}
	}

	// Default to the model currently used by the web app. Older slugs such as
	// gpt-4o/auto are more likely to hit the web anti-abuse path on /f/conversation.
	model := reqBody.Model
	if model == "" || model == "auto" || model == "gpt-4o" {
		model = "gpt-5-6-thinking"
	}

	// Build the upstream request body matching chatgpt.com's current /backend-api/f/conversation format.
	upstreamBody := map[string]interface{}{
		"action":               "next",
		"messages":             []map[string]interface{}{userMessage},
		"model":                model,
		"parent_message_id":    "client-created-root",
		"client_prepare_state": "none",
		"timezone_offset_min":  -480,
		"timezone":             "Asia/Shanghai",
		"conversation_mode": map[string]interface{}{
			"kind": "primary_assistant",
		},
		"supports_buffering":                   true,
		"supported_encodings":                  []string{"v1"},
		"system_hints":                         messageHints,
		"enable_message_followups":             true,
		"paragen_cot_summary_display_override": "allow",
		"force_parallel_switch":                "auto",
		"client_contextual_info": map[string]interface{}{
			"is_dark_mode":                     false,
			"time_since_loaded":                0,
			"page_height":                      452,
			"page_width":                       1282,
			"pixel_ratio":                      2,
			"screen_height":                    1280,
			"screen_width":                     1920,
			"app_name":                         "chatgpt.com",
			"has_web_push_capabilities":        true,
			"web_push_notification_permission": "default",
		},
	}
	if model == "gpt-5-6-thinking" {
		upstreamBody["thinking_effort"] = thinkingEffort
	}
	if reqBody.ConversationID != "" {
		upstreamBody["conversation_id"] = reqBody.ConversationID
		upstreamBody["parent_message_id"] = uuid.New().String()
	}
	if reqBody.GenID != "" {
		upstreamBody["gen_id"] = reqBody.GenID
	}
	if reqBody.WebSearch {
		upstreamBody["webslap"] = true
	}

	bodyJSON, err := json.Marshal(upstreamBody)
	if err != nil {
		return nil, "", fmt.Errorf("序列化请求体失败: %w", err)
	}

	path := "/backend-api/f/conversation"
	req, err := h.client.BuildRequest(ctx, http.MethodPost, path, tokenValue, bytes.NewReader(bodyJSON), "application/json")
	if err != nil {
		return nil, "", err
	}

	resp, err := h.client.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("代理请求失败: %w", err)
	}

	return resp, tokenValue, nil
}

// UploadFile handles ChatGPT's three-step file upload protocol:
// create a file record, PUT bytes to signed storage, then confirm the upload.
func (h *ProxyHandler) UploadFile(c *gin.Context) {
	ctx := c.Request.Context()

	file, header, err := c.Request.FormFile("file")
	if err != nil {
		httpresp.Error(c, http.StatusBadRequest, "未找到上传文件")
		return
	}
	defer file.Close()

	// Validate file is not empty.
	if header.Size == 0 {
		httpresp.Error(c, http.StatusBadRequest, "上传文件不能为空")
		return
	}

	// Validate file size does not exceed 50MB.
	const maxUploadSize = 50 * 1024 * 1024 // 50MB
	if header.Size > maxUploadSize {
		httpresp.Error(c, http.StatusRequestEntityTooLarge, "上传文件大小不能超过 50MB")
		return
	}

	fileBytes, err := io.ReadAll(file)
	if err != nil {
		httpresp.Error(c, http.StatusInternalServerError, "读取上传文件失败")
		return
	}

	contentType := strings.TrimSpace(strings.Split(header.Header.Get("Content-Type"), ";")[0])
	if contentType == "" || contentType == "application/octet-stream" {
		contentType = http.DetectContentType(fileBytes)
	}
	fileName := filepath.Base(header.Filename)
	if fileName == "." || fileName == "" {
		fileName = "upload"
	}

	createPayload, err := json.Marshal(map[string]interface{}{
		"file_name": fileName,
		"file_size": len(fileBytes),
		"use_case":  fileUseCase(contentType),
	})
	if err != nil {
		httpresp.Error(c, http.StatusInternalServerError, "构建文件元数据失败")
		return
	}

	createStatus, createBody, err := h.doProxyBytes(ctx, http.MethodPost, "/backend-api/files", createPayload, "application/json")
	if err != nil {
		httpresp.Error(c, http.StatusBadGateway, "申请上游上传地址失败")
		return
	}
	if createStatus < 200 || createStatus >= 300 {
		writeProxyError(c, createStatus, createBody, "申请上游上传地址失败")
		return
	}

	var created upstreamFileCreateResponse
	if err := json.Unmarshal(createBody, &created); err != nil || created.FileID == "" || created.UploadURL == "" {
		log.Printf("[Proxy] 文件创建响应无效 status=%d body_prefix=%.200s", createStatus, string(createBody))
		httpresp.Error(c, http.StatusBadGateway, "上游未返回有效的文件 ID 或上传地址")
		return
	}

	putStatus, putBody, err := h.doProxyBytes(ctx, http.MethodPut, created.UploadURL, fileBytes, contentType)
	if err != nil {
		httpresp.Error(c, http.StatusBadGateway, "上传文件内容失败")
		return
	}
	if putStatus < 200 || putStatus >= 300 {
		writeProxyError(c, putStatus, putBody, "上传文件内容失败")
		return
	}

	confirmPath := "/backend-api/files/" + url.PathEscape(created.FileID) + "/uploaded"
	confirmStatus, confirmBody, err := h.doProxyBytes(ctx, http.MethodPost, confirmPath, []byte("{}"), "application/json")
	if err != nil {
		httpresp.Error(c, http.StatusBadGateway, "确认文件上传失败")
		return
	}
	if confirmStatus < 200 || confirmStatus >= 300 {
		writeProxyError(c, confirmStatus, confirmBody, "确认文件上传失败")
		return
	}

	width, height := 0, 0
	if strings.HasPrefix(contentType, "image/") {
		if config, _, decodeErr := image.DecodeConfig(bytes.NewReader(fileBytes)); decodeErr == nil {
			width, height = config.Width, config.Height
		}
	}
	downloadURL := "/api/files/" + url.PathEscape(created.FileID) + "/download"
	c.JSON(http.StatusOK, gin.H{
		"file_id":      created.FileID,
		"file_name":    fileName,
		"mime_type":    contentType,
		"size_bytes":   len(fileBytes),
		"width":        width,
		"height":       height,
		"url":          downloadURL,
		"download_url": downloadURL,
	})
}

// DownloadFile proxies file bytes through the authenticated sidecar session.
func (h *ProxyHandler) DownloadFile(c *gin.Context) {
	fileID := strings.TrimSpace(c.Param("id"))
	if fileID == "" {
		httpresp.Error(c, http.StatusBadRequest, "文件 ID 不能为空")
		return
	}

	path := "/backend-api/files/download/" + url.PathEscape(fileID)
	req, err := h.client.BuildRequest(c.Request.Context(), http.MethodGet, path, "", nil, "application/octet-stream")
	if err != nil {
		httpresp.Error(c, http.StatusInternalServerError, "构建文件下载请求失败")
		return
	}
	resp, err := h.client.Do(req)
	if err != nil {
		httpresp.Error(c, http.StatusBadGateway, "下载上游文件失败")
		return
	}
	metadataBody, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		httpresp.Error(c, http.StatusBadGateway, "读取文件下载信息失败")
		return
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		writeProxyError(c, resp.StatusCode, metadataBody, "获取文件下载地址失败")
		return
	}

	var metadata upstreamFileDownloadResponse
	if err := json.Unmarshal(metadataBody, &metadata); err != nil || metadata.DownloadURL == "" {
		httpresp.Error(c, http.StatusBadGateway, "上游未返回有效的文件下载地址")
		return
	}

	downloadTarget := metadata.DownloadURL
	if parsed, parseErr := url.Parse(metadata.DownloadURL); parseErr == nil && strings.EqualFold(parsed.Hostname(), "chatgpt.com") {
		downloadTarget = parsed.RequestURI()
	}
	downloadStatus, fileBytes, err := h.doProxyBytes(c.Request.Context(), http.MethodGet, downloadTarget, nil, "application/octet-stream")
	if err != nil {
		httpresp.Error(c, http.StatusBadGateway, "下载文件内容失败")
		return
	}
	if downloadStatus < 200 || downloadStatus >= 300 {
		writeProxyError(c, downloadStatus, fileBytes, "下载文件内容失败")
		return
	}

	contentType := metadata.MIMEType
	if contentType == "" && len(fileBytes) > 0 {
		contentType = http.DetectContentType(fileBytes)
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	fileName := filepath.Base(metadata.FileName)
	if fileName == "." || fileName == "" {
		fileName = fileID
	}
	c.Header("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": fileName}))
	c.Data(http.StatusOK, contentType, fileBytes)
}

func (h *ProxyHandler) doProxyBytes(ctx context.Context, method, path string, body []byte, contentType string) (int, []byte, error) {
	if strings.HasPrefix(path, "https://") || strings.HasPrefix(path, "http://") {
		req, err := http.NewRequestWithContext(ctx, method, path, bytes.NewReader(body))
		if err != nil {
			return 0, nil, err
		}
		req.Header.Set("Content-Type", contentType)
		if method == http.MethodPut {
			req.Header.Set("x-ms-blob-type", "BlockBlob")
		}
		resp, err := (&http.Client{Timeout: 60 * time.Second}).Do(req)
		if err != nil {
			return 0, nil, err
		}
		defer resp.Body.Close()
		responseBody, err := io.ReadAll(resp.Body)
		if err != nil {
			return 0, nil, err
		}
		return resp.StatusCode, responseBody, nil
	}

	req, err := h.client.BuildRequest(ctx, method, path, "", bytes.NewReader(body), contentType)
	if err != nil {
		return 0, nil, err
	}
	resp, err := h.client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	responseBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, nil, err
	}
	return resp.StatusCode, responseBody, nil
}

func fileUseCase(contentType string) string {
	switch contentType {
	case "image/jpeg", "image/png", "image/gif", "image/webp":
		return "multimodal"
	case "application/pdf", "application/msword",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		"application/vnd.ms-excel",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		"application/vnd.ms-powerpoint",
		"application/vnd.openxmlformats-officedocument.presentationml.presentation",
		"application/json", "text/plain", "text/markdown", "text/csv", "text/html":
		return "my_files"
	default:
		return "ace_upload"
	}
}

// ListConversations handles GET /api/conversations.
// Proxies to upstream, then filters the response to only include conversations
// owned by the current authenticated user. Auto-registers new conversations.
func (h *ProxyHandler) ListConversations(c *gin.Context) {
	ctx := c.Request.Context()

	// Extract authenticated user ID from context.
	userID, _ := c.Get("user_id")
	userIDStr, ok := userID.(string)
	if !ok || userIDStr == "" {
		httpresp.Error(c, http.StatusUnauthorized, "未认证用户")
		return
	}

	tokenValue := ""

	upstreamPath := "/backend-api/conversations"
	req, err := h.client.BuildRequest(ctx, http.MethodGet, upstreamPath, tokenValue, nil, "application/json")
	if err != nil {
		httpresp.Error(c, http.StatusInternalServerError, "构建代理请求失败")
		return
	}

	resp, err := h.client.Do(req)
	if err != nil {
		httpresp.Error(c, http.StatusBadGateway, "上游请求失败")
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		httpresp.Error(c, http.StatusServiceUnavailable, "浏览器登录态不可用，请在 sidecar Chrome 中重新登录后重试")
		return
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		httpresp.Error(c, http.StatusBadGateway, "读取上游响应失败")
		return
	}

	if !json.Valid(body) {
		log.Printf("[Proxy] 非 JSON 响应 (ListConversations) status=%d body_prefix=%.200s", resp.StatusCode, string(body))
		writeProxyError(c, resp.StatusCode, body, "上游返回了非 JSON 响应（可能触发了 Cloudflare 验证）")
		return
	}

	// Filter upstream response by conversation ownership.
	filtered, filterErr := h.filterConversationsByOwner(ctx, body, userIDStr)
	if filterErr != nil {
		log.Printf("[Proxy] ListConversations 过滤失败: %v，返回原始上游响应", filterErr)
		c.Data(resp.StatusCode, "application/json", body)
		return
	}

	c.Data(resp.StatusCode, "application/json", filtered)
}

// GetConversation handles GET /api/conversations/:id.
// Checks local conversation ownership before proxying. Returns 403 if the
// conversation belongs to a different user. Auto-registers on first access.
func (h *ProxyHandler) GetConversation(c *gin.Context) {
	ctx := c.Request.Context()
	convID := c.Param("id")

	// Extract authenticated user ID from context.
	userID, _ := c.Get("user_id")
	userIDStr, ok := userID.(string)
	if !ok || userIDStr == "" {
		httpresp.Error(c, http.StatusUnauthorized, "未认证用户")
		return
	}

	// Check local conversation ownership.
	conv, err := h.queries.GetConversationByID(ctx, convID)
	if err == nil {
		// Conversation exists locally — check ownership.
		if conv.UserID != userIDStr {
			httpresp.Error(c, http.StatusForbidden, "无权访问该对话")
			return
		}
		// Owned by current user — proceed to proxy.
	} else {
		// Not found locally — auto-register and proceed.
		log.Printf("[Proxy] GetConversation: 自动注册对话 convID=%s userID=%s", convID, userIDStr)
		if regErr := h.queries.CreateConversation(ctx, convID, userIDStr, ""); regErr != nil {
			log.Printf("[Proxy] GetConversation: 自动注册失败 convID=%s err=%v", convID, regErr)
		}
	}

	req, err := h.client.BuildRequest(ctx, http.MethodGet, "/backend-api/conversation/"+url.PathEscape(convID), "", nil, "application/json")
	if err != nil {
		httpresp.Error(c, http.StatusInternalServerError, "构建对话详情请求失败")
		return
	}
	resp, err := h.client.Do(req)
	if err != nil {
		httpresp.Error(c, http.StatusBadGateway, "获取上游对话详情失败")
		return
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		httpresp.Error(c, http.StatusBadGateway, "读取上游对话详情失败")
		return
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		writeProxyError(c, resp.StatusCode, body, "获取上游对话详情失败")
		return
	}
	normalized, err := normalizeConversationDetail(body, convID)
	if err != nil {
		httpresp.Error(c, http.StatusBadGateway, "解析上游对话详情失败")
		return
	}
	c.JSON(http.StatusOK, normalized)
}

func normalizeConversationDetail(body []byte, conversationID string) (gin.H, error) {
	var raw map[string]interface{}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, err
	}
	mapping, _ := raw["mapping"].(map[string]interface{})
	currentNode, _ := raw["current_node"].(string)
	orderedNodes := make([]map[string]interface{}, 0, len(mapping))
	visited := make(map[string]bool)
	for currentNode != "" && !visited[currentNode] {
		visited[currentNode] = true
		node, _ := mapping[currentNode].(map[string]interface{})
		if node == nil {
			break
		}
		orderedNodes = append(orderedNodes, node)
		currentNode, _ = node["parent"].(string)
	}
	for left, right := 0, len(orderedNodes)-1; left < right; left, right = left+1, right-1 {
		orderedNodes[left], orderedNodes[right] = orderedNodes[right], orderedNodes[left]
	}

	messages := make([]apiMessage, 0, len(orderedNodes))
	seenImages := make(map[string]bool)
	model := ""
	for _, node := range orderedNodes {
		message, _ := node["message"].(map[string]interface{})
		if message == nil {
			continue
		}
		author, _ := message["author"].(map[string]interface{})
		role, _ := author["role"].(string)
		content, _ := message["content"].(map[string]interface{})
		contentType, _ := content["content_type"].(string)
		metadata, _ := message["metadata"].(map[string]interface{})
		if model == "" {
			model, _ = metadata["resolved_model_slug"].(string)
		}

		parts, _ := content["parts"].([]interface{})
		textParts := make([]string, 0, len(parts))
		for _, part := range parts {
			if text, ok := part.(string); ok {
				textParts = append(textParts, text)
			}
		}

		switch {
		case role == "user":
			attachments := assetsFromMetadata(metadata)
			messages = append(messages, apiMessage{
				Role:        "user",
				Content:     strings.Join(textParts, "\n"),
				Attachments: attachments,
			})
		case role == "assistant" && contentType == "text" && metadata["is_thinking_preamble_message"] != true:
			text := strings.Join(textParts, "\n")
			if text != "" {
				messages = append(messages, apiMessage{Role: "assistant", Content: text})
			}
		case contentType == "multimodal_text" && role != "user":
			images := generatedAssetsFromParts(parts, seenImages)
			if len(images) > 0 {
				messages = append(messages, apiMessage{Role: "assistant", Content: "", Images: images})
			}
		}
	}

	title, _ := raw["title"].(string)
	return gin.H{
		"conversation": gin.H{
			"id":         conversationID,
			"title":      title,
			"model":      model,
			"created_at": raw["create_time"],
			"updated_at": raw["update_time"],
		},
		"messages": messages,
	}, nil
}

func assetsFromMetadata(metadata map[string]interface{}) []apiFileAsset {
	rawAttachments, _ := metadata["attachments"].([]interface{})
	assets := make([]apiFileAsset, 0, len(rawAttachments))
	for _, rawAttachment := range rawAttachments {
		attachment, _ := rawAttachment.(map[string]interface{})
		fileID, _ := attachment["id"].(string)
		if fileID == "" {
			continue
		}
		fileName, _ := attachment["name"].(string)
		mimeType, _ := attachment["mimeType"].(string)
		assets = append(assets, apiFileAsset{
			FileID:      fileID,
			FileName:    fileName,
			MIMEType:    mimeType,
			SizeBytes:   int64(numberValue(attachment["size"])),
			Width:       int(numberValue(attachment["width"])),
			Height:      int(numberValue(attachment["height"])),
			DownloadURL: "/api/files/" + url.PathEscape(fileID) + "/download",
		})
	}
	return assets
}

func generatedAssetsFromParts(parts []interface{}, seen map[string]bool) []apiFileAsset {
	assets := make([]apiFileAsset, 0)
	for _, rawPart := range parts {
		part, _ := rawPart.(map[string]interface{})
		if part == nil || part["content_type"] != "image_asset_pointer" {
			continue
		}
		partMetadata, _ := part["metadata"].(map[string]interface{})
		if partMetadata["generation"] == nil && partMetadata["dalle"] == nil {
			continue
		}
		pointer, _ := part["asset_pointer"].(string)
		fileID := strings.TrimPrefix(strings.TrimPrefix(pointer, "sediment://"), "file-service://")
		if fileID == "" || seen[fileID] {
			continue
		}
		seen[fileID] = true
		mimeType, _ := part["mime_type"].(string)
		if mimeType == "" {
			mimeType = "image/png"
		}
		assets = append(assets, apiFileAsset{
			FileID:      fileID,
			FileName:    fileID + ".png",
			MIMEType:    mimeType,
			SizeBytes:   int64(numberValue(part["size_bytes"])),
			Width:       int(numberValue(part["width"])),
			Height:      int(numberValue(part["height"])),
			DownloadURL: "/api/files/" + url.PathEscape(fileID) + "/download",
		})
	}
	return assets
}

func numberValue(value interface{}) float64 {
	switch number := value.(type) {
	case float64:
		return number
	case float32:
		return float64(number)
	case int:
		return float64(number)
	case int64:
		return float64(number)
	default:
		return 0
	}
}

// filterConversationsByOwner takes the raw upstream JSON response body,
// extracts conversation IDs from the "items" array, cross-references with
// the local DB, auto-registers new conversations, and returns a filtered
// JSON response containing only conversations owned by the given user.
func (h *ProxyHandler) filterConversationsByOwner(ctx context.Context, body []byte, userID string) ([]byte, error) {
	var response map[string]interface{}
	if err := json.Unmarshal(body, &response); err != nil {
		return nil, fmt.Errorf("解析上游响应失败: %w", err)
	}

	// Extract the items array.
	rawItems, ok := response["items"]
	if !ok {
		return nil, fmt.Errorf("上游响应缺少 items 字段")
	}
	items, ok := rawItems.([]interface{})
	if !ok {
		return nil, fmt.Errorf("上游响应的 items 字段不是数组")
	}

	if len(items) == 0 {
		return body, nil
	}

	// Extract IDs from upstream items and their titles.
	type upstreamConv struct {
		id    string
		title string
	}
	var upstream []upstreamConv
	for _, item := range items {
		obj, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		id, _ := obj["id"].(string)
		if id == "" {
			continue
		}
		title, _ := obj["title"].(string)
		upstream = append(upstream, upstreamConv{id: id, title: title})
	}

	// Build a set of conversation IDs owned by the current user.
	ownedIDs, err := h.queries.ListConversationIDsByUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("查询用户对话失败: %w", err)
	}
	ownedSet := make(map[string]bool, len(ownedIDs))
	for _, id := range ownedIDs {
		ownedSet[id] = true
	}

	// Auto-register any upstream conversations not yet in the local DB.
	for _, uc := range upstream {
		if !ownedSet[uc.id] {
			if regErr := h.queries.CreateConversation(ctx, uc.id, userID, uc.title); regErr != nil {
				log.Printf("[Proxy] filterConversationsByOwner: 自动注册失败 convID=%s err=%v", uc.id, regErr)
			} else {
				ownedSet[uc.id] = true
			}
		}
	}

	// Filter items to only owned conversations.
	filtered := make([]interface{}, 0, len(items))
	for _, item := range items {
		obj, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		id, _ := obj["id"].(string)
		if ownedSet[id] {
			filtered = append(filtered, item)
		}
	}

	response["items"] = filtered
	result, err := json.Marshal(response)
	if err != nil {
		return nil, fmt.Errorf("序列化过滤后的响应失败: %w", err)
	}
	return result, nil
}

// UpdateConversation handles PATCH /api/conversations/:id.
func (h *ProxyHandler) UpdateConversation(c *gin.Context) {
	id := c.Param("id")
	h.proxyWithBody(c, http.MethodPatch, "/backend-api/conversation/"+id)
}

// proxyGet is a helper for simple GET proxy endpoints.
func (h *ProxyHandler) proxyGet(c *gin.Context, upstreamPath string) {
	ctx := c.Request.Context()

	tokenValue := ""

	req, err := h.client.BuildRequest(ctx, http.MethodGet, upstreamPath, tokenValue, nil, "application/json")
	if err != nil {
		httpresp.Error(c, http.StatusInternalServerError, "构建代理请求失败")
		return
	}

	resp, err := h.client.Do(req)
	if err != nil {
		httpresp.Error(c, http.StatusBadGateway, "上游请求失败")
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		httpresp.Error(c, http.StatusServiceUnavailable, "浏览器登录态不可用，请在 sidecar Chrome 中重新登录后重试")
		return
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		httpresp.Error(c, http.StatusBadGateway, "读取上游响应失败")
		return
	}

	if !json.Valid(body) {
		log.Printf("[Proxy] 非 JSON 响应 (proxyGet) path=%s status=%d body_prefix=%.200s", upstreamPath, resp.StatusCode, string(body))
		writeProxyError(c, resp.StatusCode, body, "上游返回了非 JSON 响应（可能触发了 Cloudflare 验证）")
		return
	}

	c.Data(resp.StatusCode, "application/json", body)
}

// proxyWithBody is a helper for proxy endpoints that forward the request body.
func (h *ProxyHandler) proxyWithBody(c *gin.Context, method, upstreamPath string) {
	ctx := c.Request.Context()

	tokenValue := ""

	bodyBytes, err := io.ReadAll(c.Request.Body)
	if err != nil {
		httpresp.Error(c, http.StatusBadRequest, "读取请求体失败")
		return
	}

	req, err := h.client.BuildRequest(ctx, method, upstreamPath, tokenValue, bytes.NewReader(bodyBytes), "application/json")
	if err != nil {
		httpresp.Error(c, http.StatusInternalServerError, "构建代理请求失败")
		return
	}

	resp, err := h.client.Do(req)
	if err != nil {
		httpresp.Error(c, http.StatusBadGateway, "上游请求失败")
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		httpresp.Error(c, http.StatusServiceUnavailable, "浏览器登录态不可用，请在 sidecar Chrome 中重新登录后重试")
		return
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		httpresp.Error(c, http.StatusBadGateway, "读取上游响应失败")
		return
	}

	if !json.Valid(body) {
		log.Printf("[Proxy] 非 JSON 响应 (proxyWithBody) path=%s status=%d body_prefix=%.200s", upstreamPath, resp.StatusCode, string(body))
		writeProxyError(c, resp.StatusCode, body, "上游返回了非 JSON 响应（可能触发了 Cloudflare 验证）")
		return
	}

	c.Data(resp.StatusCode, "application/json", body)
}

func (h *ProxyHandler) markTokenExpiredByValue(ctx context.Context, tokenValue string) {
	if tokenValue == "" {
		return
	}
	token, findErr := h.sessionManager.GetTokenByValue(ctx, tokenValue)
	if findErr == nil && token != nil {
		if markErr := h.sessionManager.MarkTokenExpired(ctx, token.ID); markErr != nil {
			log.Printf("[Proxy] 标记 token 失效失败: %v", markErr)
		}
	}
}

func writeProxyError(c *gin.Context, statusCode int, body []byte, fallback string) {
	if statusCode == 0 {
		statusCode = http.StatusBadGateway
	}
	if statusCode >= http.StatusBadRequest && json.Valid(body) {
		c.Data(statusCode, "application/json", body)
		return
	}
	c.JSON(http.StatusBadGateway, gin.H{"error": fallback})
}

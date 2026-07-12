package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
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
	"regexp"
	"strings"
	"time"

	"chatgpt-proxy/backend/internal/db"
	"chatgpt-proxy/backend/internal/httpresp"
	"chatgpt-proxy/backend/internal/proxy"
	"chatgpt-proxy/backend/internal/session"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
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
	Message          string              `json:"message"`
	Model            string              `json:"model"`
	ConversationID   string              `json:"conversation_id"`
	Stream           bool                `json:"stream"`
	GenID            string              `json:"gen_id"`
	AttachmentFileID string              `json:"attachment_file_id"`
	Attachment       *attachmentRequest  `json:"attachment"`
	Attachments      []attachmentRequest `json:"attachments"`
	OriginalGenID    string              `json:"original_gen_id"`
	OriginalFileID   string              `json:"original_file_id"`
	ThinkingEffort   string              `json:"thinking_effort"`
	WebSearch        bool                `json:"web_search"`
	ImageMode        bool                `json:"-"`
	Action           string              `json:"-"`
	ParentMessageID  string              `json:"-"`
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
	FileID                  string `json:"file_id"`
	FileName                string `json:"file_name"`
	MIMEType                string `json:"mime_type"`
	SizeBytes               int64  `json:"size_bytes"`
	Width                   int    `json:"width"`
	Height                  int    `json:"height"`
	DownloadURL             string `json:"download_url"`
	GenerationID            string `json:"generation_id,omitempty"`
	MessageID               string `json:"message_id,omitempty"`
	CandidateGroupMessageID string `json:"candidate_group_message_id,omitempty"`
}

type apiMessage struct {
	ID          string          `json:"id"`
	ParentID    string          `json:"parent_id,omitempty"`
	Role        string          `json:"role"`
	Content     string          `json:"content"`
	Images      []apiFileAsset  `json:"images,omitempty"`
	Attachments []apiFileAsset  `json:"attachments,omitempty"`
	Reasoning   string          `json:"reasoning,omitempty"`
	Sources     []apiSource     `json:"sources,omitempty"`
	ImageGroups []apiImageGroup `json:"image_groups,omitempty"`
}

type apiImageGroup struct {
	MatchedText string           `json:"matched_text"`
	AspectRatio string           `json:"aspect_ratio,omitempty"`
	Images      []apiSearchImage `json:"images"`
}

type apiSearchImage struct {
	ThumbnailURL string `json:"thumbnail_url"`
	ContentURL   string `json:"content_url"`
	SourceURL    string `json:"source_url,omitempty"`
	Title        string `json:"title,omitempty"`
	Width        int    `json:"width,omitempty"`
	Height       int    `json:"height,omitempty"`
}

type apiSource struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	URL    string `json:"url"`
	Domain string `json:"domain,omitempty"`
}

type apiModelOption struct {
	Label          string `json:"label"`
	Model          string `json:"model"`
	ThinkingEffort string `json:"thinking_effort,omitempty"`
	Lane           string `json:"lane,omitempty"`
}

// Models returns the models and thinking presets available to the logged-in
// ChatGPT browser account.
func (h *ProxyHandler) Models(c *gin.Context) {
	req, err := h.client.BuildRequest(c.Request.Context(), http.MethodGet, "/backend-api/models", "", nil, "application/json")
	if err != nil {
		httpresp.Error(c, http.StatusInternalServerError, "构建模型目录请求失败")
		return
	}
	resp, err := h.client.Do(req)
	if err != nil {
		httpresp.Error(c, http.StatusBadGateway, "读取模型目录失败")
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		writeProxyError(c, resp.StatusCode, body, "读取模型目录失败")
		return
	}
	var raw struct {
		DefaultModel string `json:"default_model_slug"`
		Versions     []struct {
			ID      string `json:"id"`
			Enabled bool   `json:"enabled"`
			Presets []struct {
				Label          string `json:"selected_display_title"`
				Title          string `json:"title"`
				Model          string `json:"model_slug"`
				ThinkingEffort string `json:"thinking_effort"`
				Lane           string `json:"lane"`
				PresetType     string `json:"preset_type"`
			} `json:"intelligence_presets"`
		} `json:"versions"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		httpresp.Error(c, http.StatusBadGateway, "解析模型目录失败")
		return
	}
	options := make([]apiModelOption, 0)
	seen := map[string]bool{}
	for _, version := range raw.Versions {
		if !version.Enabled || (version.ID != "latest" && len(options) > 0) {
			continue
		}
		for _, preset := range version.Presets {
			if preset.PresetType != "available" || preset.Model == "" {
				continue
			}
			key := preset.Model + ":" + preset.ThinkingEffort
			if seen[key] {
				continue
			}
			seen[key] = true
			label := preset.Label
			if label == "" {
				label = preset.Title
			}
			options = append(options, apiModelOption{Label: label, Model: preset.Model, ThinkingEffort: preset.ThinkingEffort, Lane: preset.Lane})
		}
	}
	c.JSON(http.StatusOK, gin.H{"default_model": raw.DefaultModel, "options": options})
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

// RetryConversation regenerates the selected assistant response as an
// upstream variant while keeping the visible conversation branch stable.
func (h *ProxyHandler) RetryConversation(c *gin.Context) {
	conversationID := c.Param("id")
	var retry struct {
		AssistantMessageID string `json:"assistant_message_id"`
		Model              string `json:"model"`
		ThinkingEffort     string `json:"thinking_effort"`
	}
	if err := c.ShouldBindJSON(&retry); err != nil || retry.AssistantMessageID == "" {
		httpresp.Error(c, http.StatusBadRequest, "重试缺少回答标识")
		return
	}
	userID, ok := authenticatedUserID(c)
	if !ok || !h.requireConversationOwner(c, conversationID, userID) {
		return
	}
	req, err := h.client.BuildRequest(c.Request.Context(), http.MethodGet, "/backend-api/conversation/"+url.PathEscape(conversationID), "", nil, "application/json")
	if err != nil {
		httpresp.Error(c, http.StatusInternalServerError, "构建重试上下文失败")
		return
	}
	resp, err := h.client.Do(req)
	if err != nil {
		httpresp.Error(c, http.StatusBadGateway, "读取重试上下文失败")
		return
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	normalized, err := normalizeConversationDetail(body, conversationID)
	if err != nil {
		httpresp.Error(c, http.StatusBadGateway, "解析重试上下文失败")
		return
	}
	messages, _ := normalized["messages"].([]apiMessage)
	var userMessage *apiMessage
	for index := range messages {
		if messages[index].ID == retry.AssistantMessageID {
			for previous := index - 1; previous >= 0; previous-- {
				if messages[previous].Role == "user" {
					userMessage = &messages[previous]
					break
				}
			}
			break
		}
	}
	if userMessage == nil {
		httpresp.Error(c, http.StatusNotFound, "找不到待重试的原始消息")
		return
	}
	attachments := make([]attachmentRequest, 0, len(userMessage.Attachments))
	for _, asset := range userMessage.Attachments {
		attachments = append(attachments, attachmentRequest{FileID: asset.FileID, FileName: asset.FileName, MIMEType: asset.MIMEType, SizeBytes: asset.SizeBytes, Width: asset.Width, Height: asset.Height})
	}
	h.proxyConversation(c, conversationRequest{Message: userMessage.Content, Model: retry.Model, ThinkingEffort: retry.ThinkingEffort, ConversationID: conversationID, Stream: true, Attachments: attachments, Action: "variant", ParentMessageID: userMessage.ID})
}

// ImageGeneration handles the independent ChatGPT Images workflow. It uses
// the same upstream conversation transport with the picture_v2 hint that the
// official /images page sends.
func (h *ProxyHandler) ImageGeneration(c *gin.Context) {
	var req struct {
		Prompt         string              `json:"prompt"`
		Model          string              `json:"model"`
		Attachment     *attachmentRequest  `json:"attachment"`
		Attachments    []attachmentRequest `json:"attachments"`
		ConversationID string              `json:"conversation_id"`
		OriginalGenID  string              `json:"original_gen_id"`
		OriginalFileID string              `json:"original_file_id"`
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
		Attachments:    req.Attachments,
		ConversationID: req.ConversationID,
		OriginalGenID:  req.OriginalGenID,
		OriginalFileID: req.OriginalFileID,
	})
}

// ImageSelection forwards the Images workspace candidate-selection signal.
func (h *ProxyHandler) ImageSelection(c *gin.Context) {
	var selection struct {
		ConversationID         string `json:"conversation_id"`
		FileID                 string `json:"file_id"`
		MessageID              string `json:"message_id"`
		SelectedImageMessageID string `json:"selected_image_message_id"`
	}
	if err := c.ShouldBindJSON(&selection); err != nil || selection.ConversationID == "" || selection.FileID == "" || selection.MessageID == "" || selection.SelectedImageMessageID == "" {
		httpresp.Error(c, http.StatusBadRequest, "候选图片缺少对话或文件标识")
		return
	}
	userID, ok := authenticatedUserID(c)
	if !ok {
		httpresp.Error(c, http.StatusUnauthorized, "未认证用户")
		return
	}
	if !h.requireConversationOwner(c, selection.ConversationID, userID) || !h.requireFileOwner(c, selection.FileID, userID) {
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
	defer cancel()
	payload, _ := json.Marshal(map[string]string{
		"conversation_id":           selection.ConversationID,
		"message_id":                selection.MessageID,
		"selected_image_message_id": selection.SelectedImageMessageID,
	})
	req, err := h.client.BuildRequest(ctx, http.MethodPost, "/backend-api/image-gen/message-select", "", bytes.NewReader(payload), "application/json")
	if err != nil {
		httpresp.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	resp, err := h.client.Do(req)
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
	userID, ok := authenticatedUserID(c)
	if !ok {
		httpresp.Error(c, http.StatusUnauthorized, "未认证用户")
		return
	}
	if reqBody.ConversationID != "" && !h.requireConversationOwner(c, reqBody.ConversationID, userID) {
		return
	}
	if reqBody.OriginalFileID != "" && !h.requireImageSource(c, reqBody.OriginalFileID, reqBody.OriginalGenID, userID) {
		return
	}
	fileIDs := map[string]struct{}{}
	if reqBody.OriginalFileID != "" {
		fileIDs[reqBody.OriginalFileID] = struct{}{}
	}
	if reqBody.Attachment != nil && reqBody.Attachment.FileID != "" {
		fileIDs[reqBody.Attachment.FileID] = struct{}{}
	}
	for _, attachment := range reqBody.Attachments {
		if attachment.FileID != "" {
			fileIDs[attachment.FileID] = struct{}{}
		}
	}
	if reqBody.AttachmentFileID != "" {
		fileIDs[reqBody.AttachmentFileID] = struct{}{}
	}
	for fileID := range fileIDs {
		if !h.requireFileOwner(c, fileID, userID) {
			return
		}
	}
	if !reqBody.Stream && reqBody.ConversationID == "" {
		httpresp.Error(c, http.StatusBadRequest, "创建新对话必须使用流式响应以建立安全归属")
		return
	}

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
	observer := func(line string) error {
		return h.bindResourcesFromSSE(ctx, userID, line, reqBody.ImageMode)
	}
	if err := proxy.StreamSSEWithObserver(c, resp, observer); err != nil {
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

	attachments := append([]attachmentRequest{}, reqBody.Attachments...)
	if reqBody.Attachment != nil {
		attachments = append(attachments, *reqBody.Attachment)
	}
	if len(attachments) == 0 && reqBody.AttachmentFileID != "" {
		attachments = append(attachments, attachmentRequest{
			FileID:   reqBody.AttachmentFileID,
			FileName: reqBody.AttachmentFileID,
			MIMEType: "image/png",
		})
	}

	// Build the user message with ChatGPT's attachment metadata.
	var userMessage map[string]interface{}
	if len(attachments) > 0 {
		attachmentMetadata := make([]interface{}, 0, len(attachments))
		contentParts := make([]interface{}, 0, len(attachments)+1)
		for _, attachment := range attachments {
			if attachment.FileID == "" {
				continue
			}
			metadata := map[string]interface{}{
				"id": attachment.FileID, "name": attachment.FileName,
				"mimeType": attachment.MIMEType, "size": attachment.SizeBytes,
			}
			if strings.HasPrefix(attachment.MIMEType, "image/") {
				metadata["width"] = attachment.Width
				metadata["height"] = attachment.Height
				contentParts = append(contentParts, map[string]interface{}{
					"content_type": "image_asset_pointer", "asset_pointer": "file-service://" + attachment.FileID,
					"size_bytes": attachment.SizeBytes, "width": attachment.Width, "height": attachment.Height,
				})
			}
			attachmentMetadata = append(attachmentMetadata, metadata)
		}
		messageMetadata := map[string]interface{}{
			"attachments":      attachmentMetadata,
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
		if len(contentParts) > 0 {
			contentParts = append(contentParts, reqBody.Message)
			content = map[string]interface{}{
				"content_type": "multimodal_text",
				"parts":        contentParts,
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
	action := reqBody.Action
	if action == "" {
		action = "next"
	}
	upstreamBody := map[string]interface{}{
		"action":               action,
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
	if reqBody.ThinkingEffort != "" {
		thinkingEffort = reqBody.ThinkingEffort
	}
	if strings.Contains(model, "thinking") {
		upstreamBody["thinking_effort"] = thinkingEffort
	}
	if reqBody.ConversationID != "" {
		upstreamBody["conversation_id"] = reqBody.ConversationID
		if reqBody.ParentMessageID != "" {
			upstreamBody["parent_message_id"] = reqBody.ParentMessageID
		} else {
			upstreamBody["parent_message_id"] = uuid.New().String()
		}
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
	userID, ok := authenticatedUserID(c)
	if !ok {
		httpresp.Error(c, http.StatusUnauthorized, "未认证用户")
		return
	}

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
	owned, err := h.queries.BindFile(ctx, created.FileID, userID, fileName, "")
	if err != nil {
		httpresp.Error(c, http.StatusInternalServerError, "保存文件归属失败")
		return
	}
	if !owned {
		httpresp.Error(c, http.StatusForbidden, "文件已属于其他用户")
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
	userID, ok := authenticatedUserID(c)
	if !ok {
		httpresp.Error(c, http.StatusUnauthorized, "未认证用户")
		return
	}
	if !h.requireFileOwner(c, fileID, userID) {
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
// already owned by the current authenticated user.
func (h *ProxyHandler) ListConversations(c *gin.Context) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()

	// Extract authenticated user ID from context.
	userID, _ := c.Get("user_id")
	userIDStr, ok := userID.(string)
	if !ok || userIDStr == "" {
		httpresp.Error(c, http.StatusUnauthorized, "未认证用户")
		return
	}

	tokenValue := ""

	archived := c.Query("archived") == "true"
	upstreamPath := "/backend-api/conversations"
	if archived {
		upstreamPath += "?is_archived=true"
	}
	req, err := h.client.BuildRequest(ctx, http.MethodGet, upstreamPath, tokenValue, nil, "application/json")
	if err != nil {
		httpresp.Error(c, http.StatusInternalServerError, "构建代理请求失败")
		return
	}

	upstreamStartedAt := time.Now()
	resp, err := h.client.Do(req)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			httpresp.Error(c, http.StatusGatewayTimeout, "读取对话列表超时，请重试")
			return
		}
		httpresp.Error(c, http.StatusBadGateway, "上游请求失败")
		return
	}
	defer resp.Body.Close()
	upstreamDuration := time.Since(upstreamStartedAt)

	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		httpresp.Error(c, http.StatusServiceUnavailable, "浏览器登录态不可用，请在 sidecar Chrome 中重新登录后重试")
		return
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			httpresp.Error(c, http.StatusGatewayTimeout, "读取对话列表超时，请重试")
			return
		}
		httpresp.Error(c, http.StatusBadGateway, "读取上游响应失败")
		return
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		if resp.StatusCode == http.StatusServiceUnavailable || resp.StatusCode == http.StatusBadGateway {
			httpresp.Error(c, http.StatusServiceUnavailable, "Sidecar 浏览器不可用，请保持 Chrome 窗口开启后重试")
			return
		}
		writeProxyError(c, resp.StatusCode, body, "读取对话列表失败")
		return
	}

	if !json.Valid(body) {
		log.Printf("[Proxy] 非 JSON 响应 (ListConversations) status=%d body_prefix=%.200s", resp.StatusCode, string(body))
		writeProxyError(c, resp.StatusCode, body, "上游返回了非 JSON 响应（可能触发了 Cloudflare 验证）")
		return
	}

	// Filter upstream response by conversation ownership.
	filterStartedAt := time.Now()
	filtered, filterErr := h.filterConversationsByOwner(ctx, body, userIDStr, archived)
	filterDuration := time.Since(filterStartedAt)
	if filterErr != nil {
		log.Printf("[Proxy] ListConversations 过滤失败: %v", filterErr)
		httpresp.Error(c, http.StatusInternalServerError, "读取用户对话归属失败")
		return
	}
	log.Printf("[Proxy] ListConversations archived=%t upstream=%s local_filter=%s", archived, upstreamDuration.Round(time.Millisecond), filterDuration.Round(time.Millisecond))

	c.Data(resp.StatusCode, "application/json", filtered)
}

// GetConversation handles GET /api/conversations/:id.
// Checks local conversation ownership before proxying. Unknown conversations
// return 404 and conversations owned by another user return 403.
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
	if !h.requireConversationOwner(c, convID, userIDStr) {
		return
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
	if err := h.bindFilesFromConversation(ctx, userIDStr, normalized); err != nil {
		httpresp.Error(c, http.StatusInternalServerError, "保存对话文件归属失败")
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
	groupMessageByFile := make(map[string]string)
	selectedMessageByFile := make(map[string]string)
	for _, node := range orderedNodes {
		message, _ := node["message"].(map[string]interface{})
		if message == nil {
			continue
		}
		messageID, _ := message["id"].(string)
		content, _ := message["content"].(map[string]interface{})
		parts, _ := content["parts"].([]interface{})
		fileIDs := generatedFileIDs(parts)
		for _, fileID := range fileIDs {
			if len(fileIDs) > 1 {
				groupMessageByFile[fileID] = messageID
			}
			if len(fileIDs) == 1 {
				selectedMessageByFile[fileID] = messageID
			}
		}
	}
	model := ""
	pendingReasoning := ""
	pendingSources := make([]apiSource, 0)
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
		messageID, _ := message["id"].(string)
		parentID, _ := node["parent"].(string)
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
		pendingSources = mergeSources(pendingSources, sourcesFromMetadata(metadata))

		switch {
		case role == "user":
			pendingReasoning = ""
			pendingSources = nil
			attachments := assetsFromMetadata(metadata)
			messages = append(messages, apiMessage{
				ID:          messageID,
				ParentID:    parentID,
				Role:        "user",
				Content:     strings.Join(textParts, "\n"),
				Attachments: attachments,
			})
		case role == "assistant" && (contentType == "thoughts" || contentType == "reasoning_recap" || metadata["is_thinking_preamble_message"] == true):
			text := strings.TrimSpace(strings.Join(textParts, "\n"))
			if text != "" {
				if pendingReasoning != "" {
					pendingReasoning += "\n"
				}
				pendingReasoning += text
			}
		case role == "assistant" && contentType == "text":
			text := strings.Join(textParts, "\n")
			if text != "" {
				messages = append(messages, apiMessage{ID: messageID, ParentID: parentID, Role: "assistant", Content: sanitizeCitations(text), Reasoning: pendingReasoning, Sources: pendingSources, ImageGroups: imageGroupsFromMetadata(metadata)})
				pendingReasoning = ""
				pendingSources = nil
			}
		case contentType == "multimodal_text" && role != "user":
			images := generatedAssetsFromParts(parts, seenImages, groupMessageByFile, selectedMessageByFile)
			if len(images) > 0 {
				messages = append(messages, apiMessage{ID: messageID, ParentID: parentID, Role: "assistant", Content: "", Images: images, Reasoning: pendingReasoning, Sources: pendingSources})
				pendingReasoning = ""
				pendingSources = nil
			}
		}
	}

	title, _ := raw["title"].(string)
	return gin.H{
		"conversation": gin.H{
			"id":         conversationID,
			"title":      title,
			"model":      model,
			"created_at": normalizeTimestamp(raw["create_time"]),
			"updated_at": normalizeTimestamp(raw["update_time"]),
		},
		"messages": messages,
	}, nil
}

func imageGroupsFromMetadata(metadata map[string]interface{}) []apiImageGroup {
	references, _ := metadata["content_references"].([]interface{})
	groups := make([]apiImageGroup, 0)
	for _, rawReference := range references {
		reference, _ := rawReference.(map[string]interface{})
		if reference == nil || reference["type"] != "image_group" {
			continue
		}
		matchedText, _ := reference["matched_text"].(string)
		if matchedText == "" {
			continue
		}
		images := make([]apiSearchImage, 0)
		rawImages, _ := reference["images"].([]interface{})
		for _, rawImage := range rawImages {
			image, _ := rawImage.(map[string]interface{})
			result, _ := image["image_result"].(map[string]interface{})
			if result == nil {
				continue
			}
			thumbnailURL, _ := result["thumbnail_url"].(string)
			contentURL, _ := result["content_url"].(string)
			if thumbnailURL == "" || contentURL == "" {
				continue
			}
			sourceURL, _ := result["url"].(string)
			title, _ := result["title"].(string)
			thumbnailSize, _ := result["thumbnail_size"].(map[string]interface{})
			images = append(images, apiSearchImage{
				ThumbnailURL: thumbnailURL,
				ContentURL:   contentURL,
				SourceURL:    sourceURL,
				Title:        title,
				Width:        int(numberValue(thumbnailSize["width"])),
				Height:       int(numberValue(thumbnailSize["height"])),
			})
		}
		if len(images) == 0 {
			continue
		}
		aspectRatio, _ := reference["aspect_ratio"].(string)
		groups = append(groups, apiImageGroup{MatchedText: matchedText, AspectRatio: aspectRatio, Images: images})
	}
	return groups
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

func generatedFileIDs(parts []interface{}) []string {
	ids := make([]string, 0)
	for _, rawPart := range parts {
		part, _ := rawPart.(map[string]interface{})
		if part == nil || part["content_type"] != "image_asset_pointer" {
			continue
		}
		metadata, _ := part["metadata"].(map[string]interface{})
		if metadata["generation"] == nil && metadata["dalle"] == nil {
			continue
		}
		pointer, _ := part["asset_pointer"].(string)
		id := strings.TrimPrefix(strings.TrimPrefix(pointer, "sediment://"), "file-service://")
		if id != "" {
			ids = append(ids, id)
		}
	}
	return ids
}

func generatedAssetsFromParts(parts []interface{}, seen map[string]bool, groupMessages, selectedMessages map[string]string) []apiFileAsset {
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
		generationID := ""
		if generation, ok := partMetadata["generation"].(map[string]interface{}); ok {
			generationID, _ = generation["gen_id"].(string)
		}
		if generationID == "" {
			if dalle, ok := partMetadata["dalle"].(map[string]interface{}); ok {
				generationID, _ = dalle["gen_id"].(string)
			}
		}
		assets = append(assets, apiFileAsset{
			FileID:                  fileID,
			FileName:                fileID + ".png",
			MIMEType:                mimeType,
			SizeBytes:               int64(numberValue(part["size_bytes"])),
			Width:                   int(numberValue(part["width"])),
			Height:                  int(numberValue(part["height"])),
			DownloadURL:             "/api/files/" + url.PathEscape(fileID) + "/download",
			GenerationID:            generationID,
			MessageID:               selectedMessages[fileID],
			CandidateGroupMessageID: groupMessages[fileID],
		})
	}
	return assets
}

var citationTokenPattern = regexp.MustCompile(`cite[^]*`)

func sanitizeCitations(content string) string {
	return citationTokenPattern.ReplaceAllString(content, "[来源](#sources)")
}

func normalizeTimestamp(value interface{}) string {
	seconds := numberValue(value)
	if seconds <= 0 {
		return ""
	}
	whole := int64(seconds)
	nanos := int64((seconds - float64(whole)) * float64(time.Second))
	return time.Unix(whole, nanos).UTC().Format(time.RFC3339Nano)
}

func sourcesFromMetadata(metadata map[string]interface{}) []apiSource {
	groups, _ := metadata["search_result_groups"].([]interface{})
	result := make([]apiSource, 0)
	seen := map[string]bool{}
	for _, rawGroup := range groups {
		group, _ := rawGroup.(map[string]interface{})
		domain, _ := group["domain"].(string)
		entries, _ := group["entries"].([]interface{})
		for _, rawEntry := range entries {
			entry, _ := rawEntry.(map[string]interface{})
			link, _ := entry["url"].(string)
			if link == "" || seen[link] {
				continue
			}
			seen[link] = true
			title, _ := entry["title"].(string)
			id := fmt.Sprintf("source-%d", len(result)+1)
			result = append(result, apiSource{ID: id, Title: title, URL: link, Domain: domain})
			if len(result) >= 12 {
				return result
			}
		}
	}
	return result
}

func mergeSources(existing, incoming []apiSource) []apiSource {
	seen := map[string]bool{}
	for _, source := range existing {
		seen[source.URL] = true
	}
	for _, source := range incoming {
		if !seen[source.URL] {
			existing = append(existing, source)
			seen[source.URL] = true
		}
	}
	return existing
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

func authenticatedUserID(c *gin.Context) (string, bool) {
	value, exists := c.Get("user_id")
	if !exists {
		return "", false
	}
	userID, ok := value.(string)
	return userID, ok && userID != ""
}

func (h *ProxyHandler) requireConversationOwner(c *gin.Context, conversationID, userID string) bool {
	conversation, err := h.queries.GetConversationByID(c.Request.Context(), conversationID)
	if errors.Is(err, pgx.ErrNoRows) {
		httpresp.Error(c, http.StatusNotFound, "对话不存在")
		return false
	}
	if err != nil {
		httpresp.Error(c, http.StatusInternalServerError, "读取对话归属失败")
		return false
	}
	if conversation.UserID != userID {
		httpresp.Error(c, http.StatusForbidden, "无权访问该对话")
		return false
	}
	return true
}

func (h *ProxyHandler) requireFileOwner(c *gin.Context, fileID, userID string) bool {
	file, err := h.queries.GetFileByID(c.Request.Context(), fileID)
	if errors.Is(err, pgx.ErrNoRows) {
		httpresp.Error(c, http.StatusNotFound, "文件不存在")
		return false
	}
	if err != nil {
		httpresp.Error(c, http.StatusInternalServerError, "读取文件归属失败")
		return false
	}
	if file.UserID != userID {
		httpresp.Error(c, http.StatusForbidden, "无权访问该文件")
		return false
	}
	return true
}

func (h *ProxyHandler) requireImageSource(c *gin.Context, fileID, generationID, userID string) bool {
	file, err := h.queries.GetFileByID(c.Request.Context(), fileID)
	if errors.Is(err, pgx.ErrNoRows) {
		httpresp.Error(c, http.StatusNotFound, "图片不存在")
		return false
	}
	if err != nil {
		httpresp.Error(c, http.StatusInternalServerError, "读取图片归属失败")
		return false
	}
	if file.UserID != userID {
		httpresp.Error(c, http.StatusForbidden, "无权编辑该图片")
		return false
	}
	if generationID != "" && file.GenerationID != generationID {
		httpresp.Error(c, http.StatusForbidden, "图片生成标识与文件不匹配")
		return false
	}
	return true
}

func (h *ProxyHandler) bindResourcesFromSSE(ctx context.Context, userID, line string, imageMode ...bool) error {
	if !strings.HasPrefix(line, "data:") {
		return nil
	}
	data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
	if data == "" || data == "[DONE]" {
		return nil
	}
	var payload struct {
		ConversationID string         `json:"conversation_id"`
		Images         []apiFileAsset `json:"images"`
	}
	if err := json.Unmarshal([]byte(data), &payload); err != nil {
		return nil
	}
	if payload.ConversationID != "" {
		kind := "chat"
		if len(imageMode) > 0 && imageMode[0] {
			kind = "image"
		}
		owned, err := h.queries.BindConversation(ctx, payload.ConversationID, userID, "", kind)
		if err != nil {
			return fmt.Errorf("保存对话归属: %w", err)
		}
		if !owned {
			return errors.New("上游对话已属于其他用户")
		}
	}
	for _, image := range payload.Images {
		if image.FileID == "" {
			continue
		}
		owned, err := h.queries.BindFile(ctx, image.FileID, userID, image.FileName, image.GenerationID)
		if err != nil {
			return fmt.Errorf("保存图片归属: %w", err)
		}
		if !owned {
			return errors.New("上游图片已属于其他用户")
		}
	}
	return nil
}

func (h *ProxyHandler) bindFilesFromConversation(ctx context.Context, userID string, normalized gin.H) error {
	messages, _ := normalized["messages"].([]apiMessage)
	for _, message := range messages {
		assets := append(append([]apiFileAsset{}, message.Images...), message.Attachments...)
		for _, asset := range assets {
			if asset.FileID == "" {
				continue
			}
			owned, err := h.queries.BindFile(ctx, asset.FileID, userID, asset.FileName, asset.GenerationID)
			if err != nil {
				return err
			}
			if !owned {
				return errors.New("对话包含属于其他用户的文件")
			}
		}
	}
	return nil
}

// filterConversationsByOwner takes the raw upstream JSON response body,
// cross-references IDs with the local DB and returns only conversations owned
// by the given user. Unknown upstream conversations are never auto-claimed.
func (h *ProxyHandler) filterConversationsByOwner(ctx context.Context, body []byte, userID string, archived ...bool) ([]byte, error) {
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

	// Build a set of conversation IDs owned by the current user.
	ownedConversations, err := h.queries.ListConversationsByUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("查询用户对话失败: %w", err)
	}
	targetArchived := len(archived) > 0 && archived[0]
	ownedKinds := make(map[string]string, len(ownedConversations))
	for _, conversation := range ownedConversations {
		if conversation.Archived == targetArchived {
			ownedKinds[conversation.ID] = conversation.Kind
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
		if kind, owned := ownedKinds[id]; owned {
			obj["created_at"] = normalizeTimestamp(obj["create_time"])
			obj["updated_at"] = normalizeTimestamp(obj["update_time"])
			if kind == "" {
				kind = "chat"
			}
			obj["kind"] = kind
			filtered = append(filtered, item)
		}
	}

	response["items"] = filtered
	response["total"] = len(filtered)
	result, err := json.Marshal(response)
	if err != nil {
		return nil, fmt.Errorf("序列化过滤后的响应失败: %w", err)
	}
	return result, nil
}

// UpdateConversation handles PATCH /api/conversations/:id.
func (h *ProxyHandler) UpdateConversation(c *gin.Context) {
	id := c.Param("id")
	userID, ok := authenticatedUserID(c)
	if !ok {
		httpresp.Error(c, http.StatusUnauthorized, "未认证用户")
		return
	}
	if !h.requireConversationOwner(c, id, userID) {
		return
	}
	body, err := io.ReadAll(c.Request.Body)
	if err != nil {
		httpresp.Error(c, http.StatusBadRequest, "读取请求体失败")
		return
	}
	var update struct {
		IsArchived *bool `json:"is_archived"`
	}
	if err := json.Unmarshal(body, &update); err != nil {
		httpresp.Error(c, http.StatusBadRequest, "请求格式错误")
		return
	}
	status, responseBody, err := h.doUpstreamRequest(c.Request.Context(), http.MethodPatch, "/backend-api/conversation/"+url.PathEscape(id), body)
	if err != nil {
		httpresp.Error(c, http.StatusBadGateway, "更新上游对话失败")
		return
	}
	if status < 200 || status >= 300 {
		writeProxyError(c, status, responseBody, "更新对话失败")
		return
	}
	if update.IsArchived != nil {
		if err := h.queries.SetConversationArchived(c.Request.Context(), id, userID, *update.IsArchived); err != nil {
			httpresp.Error(c, http.StatusInternalServerError, "保存归档状态失败")
			return
		}
	}
	c.Data(status, "application/json", responseBody)
}

// DeleteConversation permanently deletes an owned conversation upstream and
// removes its local ownership record only after the upstream operation succeeds.
func (h *ProxyHandler) DeleteConversation(c *gin.Context) {
	id := c.Param("id")
	userID, ok := authenticatedUserID(c)
	if !ok {
		httpresp.Error(c, http.StatusUnauthorized, "未认证用户")
		return
	}
	if !h.requireConversationOwner(c, id, userID) {
		return
	}
	// ChatGPT represents deletion as hiding a conversation. Using the upstream
	// visibility mutation keeps this endpoint compatible with the browser API.
	status, body, err := h.doUpstreamRequest(c.Request.Context(), http.MethodPatch, "/backend-api/conversation/"+url.PathEscape(id), []byte(`{"is_visible":false}`))
	if err != nil {
		httpresp.Error(c, http.StatusBadGateway, "删除上游对话失败")
		return
	}
	if status < 200 || status >= 300 {
		writeProxyError(c, status, body, "删除对话失败")
		return
	}
	if err := h.queries.DeleteConversation(c.Request.Context(), id, userID); err != nil {
		httpresp.Error(c, http.StatusInternalServerError, "清理本地对话失败")
		return
	}
	c.Status(http.StatusNoContent)
}

func (h *ProxyHandler) doUpstreamRequest(ctx context.Context, method, path string, body []byte) (int, []byte, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := h.client.BuildRequest(ctx, method, path, "", reader, "application/json")
	if err != nil {
		return 0, nil, err
	}
	resp, err := h.client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	responseBody, err := io.ReadAll(resp.Body)
	return resp.StatusCode, responseBody, err
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

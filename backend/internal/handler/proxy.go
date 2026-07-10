package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
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
	Message          string `json:"message"`
	Model            string `json:"model"`
	ConversationID   string `json:"conversation_id"`
	Stream           bool   `json:"stream"`
	GenID            string `json:"gen_id"`
	AttachmentFileID string `json:"attachment_file_id"`
	WebSearch        bool   `json:"web_search"`
}

// Conversation handles POST /api/conversation.
func (h *ProxyHandler) Conversation(c *gin.Context) {
	userID, _ := c.Get("user_id")

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

	ctx := c.Request.Context()

	// Wrap with overall timeout to ensure user-facing response <60s
	// even if sentinel fetch adds latency (R-1.15).
	ctx, cancel := context.WithTimeout(ctx, 55*time.Second)
	defer cancel()

	// Browser-profile mode authenticates upstream requests through sidecar Chrome.
	resp, tokenValue, err := h.doConversationWithRetry(ctx, reqBody, userID)
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
func (h *ProxyHandler) doConversationWithRetry(ctx context.Context, reqBody conversationRequest, userID interface{}) (*http.Response, string, error) {
	tokenValue := ""

	now := float64(time.Now().UnixMilli()) / 1000

	// Build the user message — multimodal when attachment_file_id is present.
	var userMessage map[string]interface{}
	if reqBody.AttachmentFileID != "" {
		userMessage = map[string]interface{}{
			"id":          uuid.New().String(),
			"author":      map[string]interface{}{"role": "user"},
			"create_time": now,
			"content": map[string]interface{}{
				"content_type": "multimodal_text",
				"parts": []interface{}{
					map[string]interface{}{
						"content_type":  "image_asset_pointer",
						"asset_pointer": "file-service://" + reqBody.AttachmentFileID,
						"size_bytes":    0,
						"width":         0,
						"height":        0,
					},
					reqBody.Message,
				},
			},
			"metadata": map[string]interface{}{
				"selected_sources": []interface{}{},
				"serialization_metadata": map[string]interface{}{
					"custom_symbol_offsets": []interface{}{},
				},
			},
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
			"metadata": map[string]interface{}{
				"selected_sources": []interface{}{},
				"serialization_metadata": map[string]interface{}{
					"custom_symbol_offsets": []interface{}{},
				},
			},
		}
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
		"system_hints":                         []interface{}{},
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
		upstreamBody["thinking_effort"] = "max"
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

// UploadFile handles POST /api/files — multipart file upload proxy.
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

	// Validate MIME type is image/*.
	if !strings.HasPrefix(header.Header.Get("Content-Type"), "image/") {
		httpresp.Error(c, http.StatusBadRequest, "仅支持上传图片文件（image/*）")
		return
	}

	tokenValue := ""

	// Build multipart body for upstream.
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	part, err := writer.CreateFormFile("file", header.Filename)
	if err != nil {
		httpresp.Error(c, http.StatusInternalServerError, "构建上传请求失败")
		return
	}
	if _, err := io.Copy(part, file); err != nil {
		httpresp.Error(c, http.StatusInternalServerError, "读取上传文件失败")
		return
	}
	writer.Close()

	// Build and send request to upstream.
	req, err := h.client.BuildRequest(ctx, http.MethodPost, "/backend-api/files", tokenValue, &buf, writer.FormDataContentType())
	if err != nil {
		httpresp.Error(c, http.StatusInternalServerError, "构建代理请求失败")
		return
	}

	resp, err := h.client.Do(req)
	if err != nil {
		httpresp.Error(c, http.StatusBadGateway, "上游文件上传失败")
		return
	}
	defer resp.Body.Close()

	// Handle 401/403 for file upload as well.
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		httpresp.Error(c, http.StatusServiceUnavailable, "浏览器登录态不可用，请在 sidecar Chrome 中重新登录后重试")
		return
	}

	// Read upstream response.
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		httpresp.Error(c, http.StatusBadGateway, "读取上游响应失败")
		return
	}

	// Check for non-JSON response (Cloudflare challenge).
	if !json.Valid(body) {
		log.Printf("[Proxy] 非 JSON 响应 (UploadFile) status=%d body_prefix=%.200s", resp.StatusCode, string(body))
		writeProxyError(c, resp.StatusCode, body, "上游返回了非 JSON 响应（可能触发了 Cloudflare 验证）")
		return
	}

	c.Data(resp.StatusCode, "application/json", body)
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

	h.proxyGet(c, "/backend-api/conversation/"+convID)
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
	h.proxyWithBody(c, http.MethodPatch, "/backend-api/conversations/"+id)
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

package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"strings"

	"chatgpt-proxy/backend/internal/db"
	"chatgpt-proxy/backend/internal/httpresp"
	"chatgpt-proxy/backend/internal/proxy"
	"chatgpt-proxy/backend/internal/session"

	"github.com/gin-gonic/gin"
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
	Message        string `json:"message"`
	Model          string `json:"model"`
	ConversationID string `json:"conversation_id"`
	Stream         bool   `json:"stream"`
	GenID          string `json:"gen_id"`
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

	// Get an active token and attempt the request with retry on 401/403.
	resp, tokenValue, err := h.doConversationWithRetry(ctx, reqBody, userID)
	if err != nil {
		if errors.Is(err, session.ErrNoActiveToken) {
			httpresp.Error(c, http.StatusServiceUnavailable, "所有 session token 均已失效，请稍后重试")
			return
		}
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
			c.String(http.StatusBadGateway, "上游返回了非 JSON 响应（可能触发了 Cloudflare 验证）")
			return
		}

		c.Data(resp.StatusCode, "application/json", body)
		return
	}

	// Handle SSE streaming.
	if err := proxy.StreamSSE(c, resp); err != nil {
		// SSE streaming errors are logged but the response may already be partially sent.
		_ = tokenValue // tokenValue captured for logging
		return
	}
}

// doConversationWithRetry attempts the conversation request with one retry on 401/403.
func (h *ProxyHandler) doConversationWithRetry(ctx context.Context, reqBody conversationRequest, userID interface{}) (*http.Response, string, error) {
	tokenValue, err := h.sessionManager.GetActiveToken(ctx)
	if err != nil {
		return nil, "", err
	}

	// Build the upstream request body.
	upstreamBody := map[string]interface{}{
		"action":          "next",
		"messages":        []map[string]interface{}{{"role": "user", "content": reqBody.Message}},
		"model":           reqBody.Model,
		"conversation_id": reqBody.ConversationID,
		"stream":          reqBody.Stream,
	}
	if reqBody.GenID != "" {
		upstreamBody["gen_id"] = reqBody.GenID
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

	// Check for 401/403 → mark token expired and retry once.
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		resp.Body.Close()

		// Mark token as expired.
		log.Printf("[Proxy] token 已失效 token_prefix=%.8s...", tokenValue[:min(8, len(tokenValue))])
		token, findErr := h.sessionManager.GetTokenByValue(ctx, tokenValue)
		if findErr == nil && token != nil {
			_ = h.sessionManager.MarkTokenExpired(ctx, token.ID)
		}

		// Retry with a different token.
		retryToken, retryErr := h.sessionManager.GetActiveToken(ctx)
		if retryErr != nil {
			return nil, "", retryErr
		}

		req2, buildErr := h.client.BuildRequest(ctx, http.MethodPost, path, retryToken, bytes.NewReader(bodyJSON), "application/json")
		if buildErr != nil {
			return nil, "", buildErr
		}

		resp2, doErr := h.client.Do(req2)
		return resp2, retryToken, doErr
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

	// Get active token.
	tokenValue, err := h.sessionManager.GetActiveToken(ctx)
	if err != nil {
		if errors.Is(err, session.ErrNoActiveToken) {
			httpresp.Error(c, http.StatusServiceUnavailable, "所有 session token 均已失效，请稍后重试")
			return
		}
		httpresp.Error(c, http.StatusInternalServerError, "获取 session token 失败")
		return
	}

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
		log.Printf("[Proxy] token 已失效 token_prefix=%.8s...", tokenValue[:min(8, len(tokenValue))])
		token, findErr := h.sessionManager.GetTokenByValue(ctx, tokenValue)
		if findErr == nil && token != nil {
			_ = h.sessionManager.MarkTokenExpired(ctx, token.ID)
		}
		httpresp.Error(c, http.StatusServiceUnavailable, "session token 已失效")
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
		c.String(http.StatusBadGateway, "上游返回了非 JSON 响应（可能触发了 Cloudflare 验证）")
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

	tokenValue, err := h.sessionManager.GetActiveToken(ctx)
	if err != nil {
		if errors.Is(err, session.ErrNoActiveToken) {
			httpresp.Error(c, http.StatusServiceUnavailable, "所有 session token 均已失效，请稍后重试")
			return
		}
		httpresp.Error(c, http.StatusInternalServerError, "获取 session token 失败")
		return
	}

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
		log.Printf("[Proxy] token 已失效 token_prefix=%.8s...", tokenValue[:min(8, len(tokenValue))])
		token, findErr := h.sessionManager.GetTokenByValue(ctx, tokenValue)
		if findErr == nil && token != nil {
			_ = h.sessionManager.MarkTokenExpired(ctx, token.ID)
		}
		httpresp.Error(c, http.StatusServiceUnavailable, "session token 已失效")
		return
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		httpresp.Error(c, http.StatusBadGateway, "读取上游响应失败")
		return
	}

	if !json.Valid(body) {
		log.Printf("[Proxy] 非 JSON 响应 (ListConversations) status=%d body_prefix=%.200s", resp.StatusCode, string(body))
		c.String(http.StatusBadGateway, "上游返回了非 JSON 响应（可能触发了 Cloudflare 验证）")
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

	h.proxyGet(c, "/backend-api/conversations/"+convID)
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

	tokenValue, err := h.sessionManager.GetActiveToken(ctx)
	if err != nil {
		if errors.Is(err, session.ErrNoActiveToken) {
			httpresp.Error(c, http.StatusServiceUnavailable, "所有 session token 均已失效，请稍后重试")
			return
		}
		httpresp.Error(c, http.StatusInternalServerError, "获取 session token 失败")
		return
	}

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
		log.Printf("[Proxy] token 已失效 token_prefix=%.8s...", tokenValue[:min(8, len(tokenValue))])
		token, findErr := h.sessionManager.GetTokenByValue(ctx, tokenValue)
		if findErr == nil && token != nil {
			_ = h.sessionManager.MarkTokenExpired(ctx, token.ID)
		}
		httpresp.Error(c, http.StatusServiceUnavailable, "session token 已失效")
		return
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		httpresp.Error(c, http.StatusBadGateway, "读取上游响应失败")
		return
	}

	if !json.Valid(body) {
		log.Printf("[Proxy] 非 JSON 响应 (proxyGet) path=%s status=%d body_prefix=%.200s", upstreamPath, resp.StatusCode, string(body))
		c.String(http.StatusBadGateway, "上游返回了非 JSON 响应（可能触发了 Cloudflare 验证）")
		return
	}

	c.Data(resp.StatusCode, "application/json", body)
}

// proxyWithBody is a helper for proxy endpoints that forward the request body.
func (h *ProxyHandler) proxyWithBody(c *gin.Context, method, upstreamPath string) {
	ctx := c.Request.Context()

	tokenValue, err := h.sessionManager.GetActiveToken(ctx)
	if err != nil {
		if errors.Is(err, session.ErrNoActiveToken) {
			httpresp.Error(c, http.StatusServiceUnavailable, "所有 session token 均已失效，请稍后重试")
			return
		}
		httpresp.Error(c, http.StatusInternalServerError, "获取 session token 失败")
		return
	}

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
		log.Printf("[Proxy] token 已失效 token_prefix=%.8s...", tokenValue[:min(8, len(tokenValue))])
		token, findErr := h.sessionManager.GetTokenByValue(ctx, tokenValue)
		if findErr == nil && token != nil {
			_ = h.sessionManager.MarkTokenExpired(ctx, token.ID)
		}
		httpresp.Error(c, http.StatusServiceUnavailable, "session token 已失效")
		return
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		httpresp.Error(c, http.StatusBadGateway, "读取上游响应失败")
		return
	}

	if !json.Valid(body) {
		log.Printf("[Proxy] 非 JSON 响应 (proxyWithBody) path=%s status=%d body_prefix=%.200s", upstreamPath, resp.StatusCode, string(body))
		c.String(http.StatusBadGateway, "上游返回了非 JSON 响应（可能触发了 Cloudflare 验证）")
		return
	}

	c.Data(resp.StatusCode, "application/json", body)
}

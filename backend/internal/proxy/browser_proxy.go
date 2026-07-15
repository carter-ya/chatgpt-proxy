package proxy

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// SidecarProxyRequest 是发送给 Sidecar 代理端点的 JSON 请求体。
type SidecarProxyRequest struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"` // base64 编码
}

// SidecarProxyResponse 是 Sidecar 非流式端点返回的 JSON 响应体。
type SidecarProxyResponse struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"` // base64 编码
	Error   string            `json:"error,omitempty"`
}

// BrowserProxyClient 实现 ProxyClient 接口，将代理请求委托给 Playwright Sidecar。
// sentinel token 获取已迁移至 Sidecar Chrome 端，Go 端不再管理 sentinelCache。
type BrowserProxyClient struct {
	sidecarURL string
	httpClient *http.Client
	baseURL    string
}

// NewBrowserProxyClient 创建一个新的 BrowserProxyClient。
// sentinel token 现已由 Sidecar 通过 Chrome 自动获取，不再需要 Go 端的 sentinelCache。
func NewBrowserProxyClient(sidecarURL string, baseURL string) *BrowserProxyClient {
	return &BrowserProxyClient{
		sidecarURL: sidecarURL,
		baseURL:    baseURL,
		httpClient: &http.Client{
			// 不设置 Timeout；流式请求可能长时间运行，
			// 超时由调用方通过 context 管理。
		},
	}
}

// BuildRequest 构建发送到 Sidecar 的 HTTP 请求。
// 读取原始请求体，将其包装为 Sidecar 所需的 JSON 格式。
// 通过检测 JSON body 中的 stream 字段决定使用流式或非流式端点。
func (c *BrowserProxyClient) BuildRequest(ctx context.Context, method, path, tokenValue string, body io.Reader, contentType string) (*http.Request, error) {
	// 读取原始请求体。
	var bodyBytes []byte
	if body != nil {
		var err error
		bodyBytes, err = io.ReadAll(body)
		if err != nil {
			return nil, fmt.Errorf("读取请求体失败: %w", err)
		}
	}

	// ChatGPT's current /f/conversation endpoint always returns SSE even though
	// the web request body no longer carries a `stream` field.
	isStream := path == "/backend-api/f/conversation" || isStreamingRequest(bodyBytes)

	// 构建 Sidecar 代理请求 JSON。
	sidecarReq := SidecarProxyRequest{
		Method: method,
		Path:   path,
		Headers: map[string]string{
			"Content-Type": contentType,
		},
		Body: base64.StdEncoding.EncodeToString(bodyBytes),
	}
	if method == http.MethodPut && (strings.HasPrefix(path, "https://") || strings.HasPrefix(path, "http://")) {
		sidecarReq.Headers["x-ms-blob-type"] = "BlockBlob"
	}
	_ = tokenValue // Browser-profile mode authenticates with Chrome cookies/OAuth state, never env tokens.

	// sentinel token 获取已迁移至 Sidecar，由 Sidecar 通过 Chrome 自动注入。
	// Sidecar 在代理 /backend-api/f/conversation 请求时会自动获取 sentinel。

	sidecarReqBytes, err := json.Marshal(sidecarReq)
	if err != nil {
		return nil, fmt.Errorf("序列化 Sidecar 请求失败: %w", err)
	}

	// 根据是否为流式请求选择 Sidecar 端点。
	endpoint := c.sidecarURL + "/api/proxy"
	if isStream {
		endpoint += "?stream=true"
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(sidecarReqBytes))
	if err != nil {
		return nil, fmt.Errorf("构建 Sidecar 请求失败: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	return req, nil
}

// Do 执行请求（到 Sidecar）并返回响应。
// - 流式请求：Sidecar 返回 text/event-stream，直接将 resp.Body 透传。
// - 非流式请求：Sidecar 返回 JSON，解析后构建合成 *http.Response。
func (c *BrowserProxyClient) Do(req *http.Request) (*http.Response, error) {
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("Sidecar 请求执行失败: %w", err)
	}

	contentType := resp.Header.Get("Content-Type")

	// 流式响应：直接透传 Sidecar 的 SSE 流。
	if strings.Contains(contentType, "text/event-stream") {
		return resp, nil
	}

	sidecarRespBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("读取 Sidecar 响应失败: %w", err)
	}
	resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return &http.Response{
			Status:     resp.Status,
			StatusCode: resp.StatusCode,
			Proto:      resp.Proto,
			ProtoMajor: resp.ProtoMajor,
			ProtoMinor: resp.ProtoMinor,
			Header:     resp.Header.Clone(),
			Body:       io.NopCloser(bytes.NewReader(sidecarRespBytes)),
			Request:    req,
		}, nil
	}

	// 非流式响应：解析 Sidecar JSON 响应，构建 *http.Response。
	var sidecarResp SidecarProxyResponse
	if err := json.Unmarshal(sidecarRespBytes, &sidecarResp); err != nil {
		return nil, fmt.Errorf("解析 Sidecar 响应失败: %w", err)
	}
	if sidecarResp.Status == 0 {
		if sidecarResp.Error == "" {
			sidecarResp.Error = "Sidecar browser request failed"
		}
		body := []byte(fmt.Sprintf(`{"error":%q}`, sidecarResp.Error))
		headers := make(http.Header)
		headers.Set("Content-Type", "application/json")
		return &http.Response{
			Status:     http.StatusText(http.StatusBadGateway),
			StatusCode: http.StatusBadGateway,
			Proto:      "HTTP/1.1",
			ProtoMajor: 1,
			ProtoMinor: 1,
			Header:     headers,
			Body:       io.NopCloser(bytes.NewReader(body)),
			Request:    req,
		}, nil
	}

	// 解码响应 body。
	decodedBody, err := base64.StdEncoding.DecodeString(sidecarResp.Body)
	if err != nil {
		return nil, fmt.Errorf("解码 Sidecar 响应 body 失败: %w", err)
	}

	// 构建合成 *http.Response。
	syntheticResp := &http.Response{
		Status:     http.StatusText(sidecarResp.Status),
		StatusCode: sidecarResp.Status,
		Proto:      "HTTP/1.1",
		ProtoMajor: 1,
		ProtoMinor: 1,
		Header:     make(http.Header),
		Body:       io.NopCloser(bytes.NewReader(decodedBody)),
		Request:    req,
	}

	for k, v := range sidecarResp.Headers {
		syntheticResp.Header.Set(k, v)
	}

	return syntheticResp, nil
}

// OpenStream opens a response body without decoding it into the non-streaming
// Sidecar JSON envelope. Signed external URLs are fetched directly by Go;
// authenticated ChatGPT paths use Sidecar's raw binary stream bridge.
func (c *BrowserProxyClient) OpenStream(ctx context.Context, method, path, _ string, headers http.Header) (*http.Response, error) {
	if strings.HasPrefix(path, "https://") || strings.HasPrefix(path, "http://") {
		req, err := http.NewRequestWithContext(ctx, method, path, nil)
		if err != nil {
			return nil, err
		}
		copyStreamHeaders(req.Header, headers)
		return c.httpClient.Do(req)
	}

	sidecarReq := SidecarProxyRequest{
		Method: method,
		Path:   path,
		Headers: map[string]string{
			"Content-Type": "application/octet-stream",
		},
	}
	for _, name := range streamRequestHeaderNames {
		if value := headers.Get(name); value != "" {
			sidecarReq.Headers[name] = value
		}
	}
	payload, err := json.Marshal(sidecarReq)
	if err != nil {
		return nil, fmt.Errorf("序列化 Sidecar 流式请求失败: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.sidecarURL+"/api/proxy?stream=raw", bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("构建 Sidecar 流式请求失败: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("Sidecar 流式请求执行失败: %w", err)
	}
	return resp, nil
}

// isStreamingRequest 检测 JSON 请求体是否标记为流式。
func isStreamingRequest(body []byte) bool {
	var req struct {
		Stream bool `json:"stream"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		return false
	}
	return req.Stream
}

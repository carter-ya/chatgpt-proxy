package proxy

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"time"

	"chatgpt-proxy/internal/sentinel"

	"github.com/google/uuid"
)

// ProxyClient builds and executes HTTP requests to chatgpt.com.
type ProxyClient struct {
	baseURL       string
	httpClient    *http.Client
	sentinelCache *sentinel.TokenCache
}

// NewProxyClient creates a new ProxyClient.
func NewProxyClient(baseURL string, sentinelCache *sentinel.TokenCache) *ProxyClient {
	return &ProxyClient{
		baseURL:       baseURL,
		sentinelCache: sentinelCache,
		httpClient: &http.Client{
			Timeout: 60 * time.Second,
		},
	}
}

// BuildRequest builds an HTTP request to chatgpt.com with all required headers and sentinel tokens.
func (c *ProxyClient) BuildRequest(ctx context.Context, method, path, tokenValue string, body io.Reader, contentType string) (*http.Request, error) {
	url := c.baseURL + path
	req, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return nil, fmt.Errorf("构建代理请求失败: %w", err)
	}

	// Set core headers.
	req.Header.Set("Authorization", "Bearer "+tokenValue)
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
	req.Header.Set("oai-client-build-number", "4874")
	req.Header.Set("x-openai-target-path", path)
	req.Header.Set("x-openai-target-route", routeForPath(path))

	// Generate a new oai-session-id for each request.
	req.Header.Set("oai-session-id", uuid.New().String())

	// Inject sentinel tokens if available.
	if c.sentinelCache != nil {
		tokens, err := c.sentinelCache.GetOrFetch(ctx, c.baseURL, "")
		if err == nil && tokens != nil {
			req.Header.Set("openai-sentinel-chat-requirements-token", tokens.ChatRequirementsToken)
			req.Header.Set("openai-sentinel-proof-token", tokens.ProofToken)
			if tokens.TurnstileToken != "" {
				req.Header.Set("openai-sentinel-turnstile-token", tokens.TurnstileToken)
			}
		}
		// Sentinel fetch failure is non-fatal; the upstream may still accept the request.
	}

	// Set cf_clearance cookie if provided via context.
	if cf, ok := ctx.Value(cfClearanceKey{}).(string); ok && cf != "" {
		req.AddCookie(&http.Cookie{Name: "cf_clearance", Value: cf})
	}

	return req, nil
}

// cfClearanceKey is the context key for cf_clearance cookie value.
type cfClearanceKey struct{}

// WithCFClearance returns a context with the cf_clearance value set.
func WithCFClearance(ctx context.Context, cfClearance string) context.Context {
	return context.WithValue(ctx, cfClearanceKey{}, cfClearance)
}

// Do executes the given HTTP request and returns the response.
func (c *ProxyClient) Do(req *http.Request) (*http.Response, error) {
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("代理请求执行失败: %w", err)
	}
	return resp, nil
}

// routeForPath maps a path to the appropriate x-openai-target-route value.
func routeForPath(path string) string {
	switch {
	case len(path) >= 22 && path[:22] == "/backend-api/f/conversation":
		return "conversation"
	case len(path) >= 13 && path[:13] == "/backend-api/files":
		return "files"
	case len(path) >= 25 && path[:25] == "/backend-api/conversations":
		return "conversations"
	default:
		return "default"
	}
}

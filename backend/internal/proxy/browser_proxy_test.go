package proxy

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBrowserProxyClientDoPreservesSidecarHTTPError(t *testing.T) {
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		fmt.Fprint(w, `{"error":"Sidecar not ready"}`)
	}))
	defer sidecar.Close()

	client := NewBrowserProxyClient(sidecar.URL, "https://chatgpt.com")
	req, err := client.BuildRequest(context.Background(), http.MethodGet, "/backend-api/me", "", nil, "application/json")
	if err != nil {
		t.Fatalf("BuildRequest() error = %v", err)
	}

	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("Do() error = %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("StatusCode = %d, want %d", resp.StatusCode, http.StatusServiceUnavailable)
	}
}

func TestBrowserProxyClientDoMapsSidecarStatusZeroToBadGateway(t *testing.T) {
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"status":0,"headers":{},"body":"","error":"browser fetch failed"}`)
	}))
	defer sidecar.Close()

	client := NewBrowserProxyClient(sidecar.URL, "https://chatgpt.com")
	req, err := client.BuildRequest(context.Background(), http.MethodGet, "/backend-api/me", "", nil, "application/json")
	if err != nil {
		t.Fatalf("BuildRequest() error = %v", err)
	}

	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("Do() error = %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("StatusCode = %d, want %d", resp.StatusCode, http.StatusBadGateway)
	}
}

func TestBrowserProxyClientBuildRequestOmitsAuthorization(t *testing.T) {
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Headers map[string]string `json:"headers"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if _, ok := body.Headers["Authorization"]; ok {
			t.Fatal("Authorization header was set for empty token")
		}
		encoded := base64.StdEncoding.EncodeToString([]byte(`{"ok":true}`))
		fmt.Fprintf(w, `{"status":200,"headers":{"Content-Type":"application/json"},"body":%q}`, encoded)
	}))
	defer sidecar.Close()

	client := NewBrowserProxyClient(sidecar.URL, "https://chatgpt.com")
	req, err := client.BuildRequest(context.Background(), http.MethodPost, "/backend-api/me", "legacy-env-token", strings.NewReader(`{}`), "application/json")
	if err != nil {
		t.Fatalf("BuildRequest() error = %v", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("Do() error = %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("StatusCode = %d, want %d", resp.StatusCode, http.StatusOK)
	}
}

func TestBrowserProxyClientConversationUsesStreamEndpointWithoutStreamField(t *testing.T) {
	client := NewBrowserProxyClient("http://127.0.0.1:3100", "https://chatgpt.com")
	req, err := client.BuildRequest(
		context.Background(),
		http.MethodPost,
		"/backend-api/f/conversation",
		"",
		strings.NewReader(`{"action":"next"}`),
		"application/json",
	)
	if err != nil {
		t.Fatalf("BuildRequest() error = %v", err)
	}
	if got := req.URL.Query().Get("stream"); got != "true" {
		t.Fatalf("stream query = %q, want true", got)
	}
}

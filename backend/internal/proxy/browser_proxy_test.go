package proxy

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
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

func TestBrowserProxyClientAsyncStatusUsesNonStreamProxyAndPreservesResponse(t *testing.T) {
	const conversationID = "6a52f406-2fb0-83e8-a0b8-f0170fe24cb2"
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/proxy" || r.URL.Query().Get("stream") != "" {
			t.Fatalf("sidecar request URL = %s, want non-stream /api/proxy", r.URL.String())
		}
		var envelope SidecarProxyRequest
		if err := json.NewDecoder(r.Body).Decode(&envelope); err != nil {
			t.Fatalf("decode sidecar envelope: %v", err)
		}
		if envelope.Method != http.MethodPost {
			t.Fatalf("method = %q, want POST", envelope.Method)
		}
		wantPath := "/backend-api/conversation/" + conversationID + "/async-status"
		if envelope.Path != wantPath {
			t.Fatalf("path = %q, want %q", envelope.Path, wantPath)
		}
		decoded, err := base64.StdEncoding.DecodeString(envelope.Body)
		if err != nil || string(decoded) != `{}` {
			t.Fatalf("body = %q, err = %v, want {}", decoded, err)
		}
		encoded := base64.StdEncoding.EncodeToString([]byte(`{"status":"OK"}`))
		fmt.Fprintf(w, `{"status":200,"headers":{"Content-Type":"application/json"},"body":%q}`, encoded)
	}))
	defer sidecar.Close()

	client := NewBrowserProxyClient(sidecar.URL, "https://chatgpt.com")
	req, err := client.BuildRequest(
		context.Background(),
		http.MethodPost,
		"/backend-api/conversation/"+conversationID+"/async-status",
		"",
		strings.NewReader(`{}`),
		"application/json",
	)
	if err != nil {
		t.Fatalf("BuildRequest() error = %v", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("Do() error = %v", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	if resp.StatusCode != http.StatusOK || string(body) != `{"status":"OK"}` {
		t.Fatalf("response = %d %s, want 200 {status:OK}", resp.StatusCode, body)
	}
}

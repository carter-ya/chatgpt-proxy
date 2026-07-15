package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"chatgpt-proxy/backend/internal/db"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)

type sandboxDownloadClient struct {
	path     string
	metadata upstreamFileDownloadResponse
}

func (client *sandboxDownloadClient) BuildRequest(ctx context.Context, method, requestPath, _ string, body io.Reader, _ string) (*http.Request, error) {
	client.path = requestPath
	return http.NewRequestWithContext(ctx, method, "http://upstream"+requestPath, body)
}

func (client *sandboxDownloadClient) Do(request *http.Request) (*http.Response, error) {
	body, _ := json.Marshal(client.metadata)
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(bytes.NewReader(body)),
		Request:    request,
	}, nil
}

func sandboxDownloadContext(rawPath string) (*gin.Context, *httptest.ResponseRecorder) {
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Params = gin.Params{{Key: "id", Value: "conversation-1"}}
	ctx.Set("user_id", "user-a")
	query := url.Values{"message_id": {"message-1"}, "sandbox_path": {rawPath}}
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/conversations/conversation-1/files/download?"+query.Encode(), nil)
	return ctx, recorder
}

func TestDownloadSandboxFileProxiesInterpreterFile(t *testing.T) {
	gin.SetMode(gin.TestMode)
	fileServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation")
		_, _ = writer.Write([]byte("ppt-content"))
	}))
	defer fileServer.Close()

	mockDB := &mockDBTX{queryRowFn: func(context.Context, string, ...interface{}) pgx.Row {
		return ownedConversationRow("user-a")
	}}
	client := &sandboxDownloadClient{metadata: upstreamFileDownloadResponse{
		DownloadURL: fileServer.URL + "/signed-download",
		FileName:    "水循环演示.pptx",
		MIMEType:    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	}}
	handler := NewProxyHandler(client, nil, db.New(mockDB))
	ctx, recorder := sandboxDownloadContext("sandbox:/mnt/data/%E6%B0%B4%E5%BE%AA%E7%8E%AF%E6%BC%94%E7%A4%BA.pptx")

	handler.DownloadSandboxFile(ctx)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", recorder.Code, recorder.Body.String())
	}
	if recorder.Body.String() != "ppt-content" {
		t.Fatalf("body = %q", recorder.Body.String())
	}
	if contentType := recorder.Header().Get("Content-Type"); contentType != "application/vnd.openxmlformats-officedocument.presentationml.presentation" {
		t.Fatalf("content type = %q", contentType)
	}
	if disposition := recorder.Header().Get("Content-Disposition"); !strings.Contains(disposition, "filename*=") {
		t.Fatalf("content disposition = %q", disposition)
	}
	upstreamURL, err := url.Parse(client.path)
	if err != nil {
		t.Fatal(err)
	}
	if upstreamURL.Path != "/backend-api/conversation/conversation-1/interpreter/download" {
		t.Fatalf("upstream path = %q", upstreamURL.Path)
	}
	if upstreamURL.Query().Get("message_id") != "message-1" || upstreamURL.Query().Get("sandbox_path") != "/mnt/data/水循环演示.pptx" {
		t.Fatalf("upstream query = %q", upstreamURL.RawQuery)
	}
}

func TestDownloadSandboxFileRejectsUnsafePaths(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, rawPath := range []string{
		"https://example.com/file.pptx",
		"sandbox:/mnt/data",
		"sandbox:/mnt/data/../secret.pptx",
		"sandbox:/tmp/file.pptx",
	} {
		t.Run(rawPath, func(t *testing.T) {
			client := &sandboxDownloadClient{}
			handler := NewProxyHandler(client, nil, db.New(&mockDBTX{}))
			ctx, recorder := sandboxDownloadContext(rawPath)
			handler.DownloadSandboxFile(ctx)
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400: %s", recorder.Code, recorder.Body.String())
			}
			if client.path != "" {
				t.Fatalf("unsafe path was proxied to %q", client.path)
			}
		})
	}
}

func TestNormalizeSandboxPathRejectsNullByte(t *testing.T) {
	if _, ok := normalizeSandboxPath("sandbox:/mnt/data/file\x00.pptx"); ok {
		t.Fatal("sandbox path containing a null byte must be rejected")
	}
}

package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"chatgpt-proxy/backend/internal/db"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)

type captureProxyClient struct{ body []byte }

func (client *captureProxyClient) BuildRequest(ctx context.Context, method, path, _ string, body io.Reader, contentType string) (*http.Request, error) {
	client.body, _ = io.ReadAll(body)
	request, err := http.NewRequestWithContext(ctx, method, "http://upstream"+path, bytes.NewReader(client.body))
	if err == nil {
		request.Header.Set("Content-Type", contentType)
	}
	return request, err
}

func (client *captureProxyClient) Do(request *http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{}`)), Request: request}, nil
}

func (client *captureProxyClient) OpenStream(ctx context.Context, method, path, _ string, _ http.Header) (*http.Response, error) {
	request, err := client.BuildRequest(ctx, method, path, "", nil, "application/octet-stream")
	if err != nil {
		return nil, err
	}
	return client.Do(request)
}

func TestImageSelectionForwardsRequiredMessageIDs(t *testing.T) {
	const owner = "user-a"
	mockDB := &mockDBTX{queryRowFn: func(_ context.Context, sql string, args ...interface{}) pgx.Row {
		return &mockRow{scanFn: func(dest ...interface{}) error {
			*(dest[0].(*string)) = args[0].(string)
			*(dest[1].(*string)) = owner
			*(dest[2].(*string)) = "resource"
			*(dest[3].(*string)) = "chat"
			return nil
		}}
	}}
	client := &captureProxyClient{}
	handler := NewProxyHandler(client, nil, db.New(mockDB))
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Set("user_id", owner)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/api/images/select", strings.NewReader(`{"conversation_id":"conversation","file_id":"file","message_id":"group","selected_image_message_id":"candidate"}`))
	ctx.Request.Header.Set("Content-Type", "application/json")
	handler.ImageSelection(ctx)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", recorder.Code, recorder.Body.String())
	}
	var forwarded map[string]string
	if err := json.Unmarshal(client.body, &forwarded); err != nil {
		t.Fatal(err)
	}
	if forwarded["conversation_id"] != "conversation" || forwarded["message_id"] != "group" || forwarded["selected_image_message_id"] != "candidate" {
		t.Fatalf("forwarded body = %#v", forwarded)
	}
}

package handler

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"chatgpt-proxy/backend/internal/db"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type conversationMutationClient struct {
	method string
	path   string
	body   string
	status int
}

func (client *conversationMutationClient) BuildRequest(ctx context.Context, method, path, _ string, body io.Reader, _ string) (*http.Request, error) {
	client.method = method
	client.path = path
	if body != nil {
		content, _ := io.ReadAll(body)
		client.body = string(content)
	}
	return http.NewRequestWithContext(ctx, method, "http://upstream"+path, bytes.NewBufferString(client.body))
}

func (client *conversationMutationClient) Do(request *http.Request) (*http.Response, error) {
	status := client.status
	if status == 0 {
		status = http.StatusOK
	}
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(`{}`)), Request: request}, nil
}

func (client *conversationMutationClient) OpenStream(ctx context.Context, method, path, _ string, _ http.Header) (*http.Response, error) {
	request, err := client.BuildRequest(ctx, method, path, "", nil, "application/octet-stream")
	if err != nil {
		return nil, err
	}
	return client.Do(request)
}

func ownedConversationRow(owner string) pgx.Row {
	return &mockRow{scanFn: func(dest ...interface{}) error {
		*(dest[0].(*string)) = "conversation-1"
		*(dest[1].(*string)) = owner
		*(dest[2].(*string)) = "title"
		*(dest[3].(*string)) = "chat"
		*(dest[4].(*bool)) = false
		return nil
	}}
}

func mutationContext(method string, body io.Reader) (*gin.Context, *httptest.ResponseRecorder) {
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Params = gin.Params{{Key: "id", Value: "conversation-1"}}
	ctx.Set("user_id", "user-a")
	ctx.Request = httptest.NewRequest(method, "/api/conversations/conversation-1", body)
	return ctx, recorder
}

func TestDeleteConversationHidesUpstreamBeforeDeletingLocalRecord(t *testing.T) {
	deleted := false
	mockDB := &mockDBTX{
		queryRowFn: func(context.Context, string, ...interface{}) pgx.Row { return ownedConversationRow("user-a") },
		execFn: func(_ context.Context, sql string, _ ...interface{}) (pgconn.CommandTag, error) {
			if strings.HasPrefix(sql, "DELETE FROM conversations") {
				deleted = true
			}
			return pgconn.CommandTag{}, nil
		},
	}
	client := &conversationMutationClient{}
	handler := NewProxyHandler(client, nil, db.New(mockDB))
	ctx, recorder := mutationContext(http.MethodDelete, nil)
	handler.DeleteConversation(ctx)

	if ctx.Writer.Status() != http.StatusNoContent {
		t.Fatalf("status = %d, want 204: %s", ctx.Writer.Status(), recorder.Body.String())
	}
	if client.method != http.MethodPatch || client.path != "/backend-api/conversation/conversation-1" || client.body != `{"is_visible":false}` {
		t.Fatalf("upstream mutation = %s %s %s", client.method, client.path, client.body)
	}
	if !deleted {
		t.Fatal("local conversation record was not deleted")
	}
}

func TestArchiveDoesNotChangeLocalStateWhenUpstreamFails(t *testing.T) {
	updated := false
	mockDB := &mockDBTX{
		queryRowFn: func(context.Context, string, ...interface{}) pgx.Row { return ownedConversationRow("user-a") },
		execFn: func(context.Context, string, ...interface{}) (pgconn.CommandTag, error) {
			updated = true
			return pgconn.CommandTag{}, nil
		},
	}
	client := &conversationMutationClient{status: http.StatusBadGateway}
	handler := NewProxyHandler(client, nil, db.New(mockDB))
	ctx, recorder := mutationContext(http.MethodPatch, strings.NewReader(`{"is_archived":true}`))
	handler.UpdateConversation(ctx)

	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", recorder.Code)
	}
	if updated {
		t.Fatal("local archive state changed after upstream failure")
	}
}

func TestConversationAsyncStatusUsesOwnedUpstreamConversation(t *testing.T) {
	mockDB := &mockDBTX{
		queryRowFn: func(context.Context, string, ...interface{}) pgx.Row { return ownedConversationRow("user-a") },
	}
	client := &conversationMutationClient{}
	handler := NewProxyHandler(client, nil, db.New(mockDB))
	ctx, recorder := mutationContext(http.MethodPost, nil)
	handler.ConversationAsyncStatus(ctx)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", recorder.Code, recorder.Body.String())
	}
	if client.method != http.MethodPost || client.path != "/backend-api/conversation/conversation-1/async-status" || client.body != `{}` {
		t.Fatalf("upstream async status = %s %s %s", client.method, client.path, client.body)
	}
}

func TestListConversationsPreservesSidecarUnavailableStatus(t *testing.T) {
	queryCalled := false
	mockDB := &mockDBTX{queryFn: func(context.Context, string, ...interface{}) (pgx.Rows, error) {
		queryCalled = true
		return &mockRows{}, nil
	}}
	client := &conversationMutationClient{status: http.StatusServiceUnavailable}
	handler := NewProxyHandler(client, nil, db.New(mockDB))
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Set("user_id", "user-a")
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/conversations", nil)
	handler.ListConversations(ctx)

	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503: %s", recorder.Code, recorder.Body.String())
	}
	if queryCalled {
		t.Fatal("local conversation filter ran for a failed upstream response")
	}
}

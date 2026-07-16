package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"chatgpt-proxy/backend/internal/db"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type ownershipRows struct {
	ids []string
	idx int
}

func (r *ownershipRows) Close()                                       {}
func (r *ownershipRows) Err() error                                   { return nil }
func (r *ownershipRows) CommandTag() pgconn.CommandTag                { return pgconn.CommandTag{} }
func (r *ownershipRows) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (r *ownershipRows) Values() ([]interface{}, error)               { return nil, nil }
func (r *ownershipRows) RawValues() [][]byte                          { return nil }
func (r *ownershipRows) Conn() *pgx.Conn                              { return nil }
func (r *ownershipRows) Next() bool {
	return r.idx < len(r.ids)
}
func (r *ownershipRows) Scan(dest ...interface{}) error {
	*(dest[0].(*string)) = r.ids[r.idx]
	r.idx++
	return nil
}

func ownershipContext(path string) (*gin.Context, *httptest.ResponseRecorder) {
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodGet, path, nil)
	return ctx, recorder
}

func TestConversationAndFileOwnershipAreUserScoped(t *testing.T) {
	const owner = "00000000-0000-0000-0000-000000000001"
	mockDB := &mockDBTX{queryRowFn: func(_ context.Context, sql string, args ...interface{}) pgx.Row {
		id := args[0].(string)
		if id == "missing" {
			return &mockRow{scanFn: func(...interface{}) error { return pgx.ErrNoRows }}
		}
		return &mockRow{scanFn: func(dest ...interface{}) error {
			*(dest[0].(*string)) = id
			*(dest[1].(*string)) = owner
			*(dest[2].(*string)) = "resource"
			return nil
		}}
	}}
	handler := &ProxyHandler{queries: db.New(mockDB)}

	for _, test := range []struct {
		name       string
		resource   string
		userID     string
		want       bool
		wantStatus int
		file       bool
	}{
		{name: "conversation owner", resource: "conversation-1", userID: owner, want: true, wantStatus: http.StatusOK},
		{name: "conversation other user", resource: "conversation-1", userID: "user-b", wantStatus: http.StatusForbidden},
		{name: "conversation unknown", resource: "missing", userID: owner, wantStatus: http.StatusNotFound},
		{name: "file owner", resource: "file-1", userID: owner, want: true, wantStatus: http.StatusOK, file: true},
		{name: "file other user", resource: "file-1", userID: "user-b", wantStatus: http.StatusForbidden, file: true},
		{name: "file unknown", resource: "missing", userID: owner, wantStatus: http.StatusNotFound, file: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, recorder := ownershipContext("/resource")
			var got bool
			if test.file {
				got = handler.requireFileOwner(ctx, test.resource, test.userID)
			} else {
				got = handler.requireConversationOwner(ctx, test.resource, test.userID)
			}
			if got != test.want {
				t.Fatalf("ownership result = %v, want %v", got, test.want)
			}
			if recorder.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d", recorder.Code, test.wantStatus)
			}
		})
	}
}

func TestFilterConversationsByOwnerNeverAutoClaims(t *testing.T) {
	mockDB := &mockDBTX{queryFn: func(_ context.Context, sql string, _ ...interface{}) (pgx.Rows, error) {
		if !strings.Contains(sql, "FROM conversations") {
			t.Fatalf("unexpected query: %s", sql)
		}
		return &ownershipRows{ids: []string{"owned"}}, nil
	}}
	handler := &ProxyHandler{queries: db.New(mockDB)}
	upstream := []byte(`{"items":[{"id":"owned","title":"Mine","async_status":4},{"id":"unknown","title":"Shared"}],"total":2}`)
	filtered, err := handler.filterConversationsByOwner(context.Background(), upstream, "user-a")
	if err != nil {
		t.Fatal(err)
	}
	result := string(filtered)
	if !strings.Contains(result, `"id":"owned"`) {
		t.Fatalf("owned conversation missing: %s", result)
	}
	if strings.Contains(result, `"id":"unknown"`) {
		t.Fatalf("unknown conversation leaked: %s", result)
	}
	if !strings.Contains(result, `"async_status":4`) {
		t.Fatalf("upstream async status was not preserved: %s", result)
	}
}

func TestBindResourcesFromSSEPersistsConversationAndImageOwner(t *testing.T) {
	const owner = "user-a"
	execCount := 0
	mockDB := &mockDBTX{
		execFn: func(_ context.Context, _ string, _ ...interface{}) (pgconn.CommandTag, error) {
			execCount++
			return pgconn.CommandTag{}, nil
		},
		queryRowFn: func(_ context.Context, _ string, args ...interface{}) pgx.Row {
			id := args[0].(string)
			return &mockRow{scanFn: func(dest ...interface{}) error {
				*(dest[0].(*string)) = id
				*(dest[1].(*string)) = owner
				*(dest[2].(*string)) = "resource"
				return nil
			}}
		},
	}
	handler := &ProxyHandler{queries: db.New(mockDB)}
	line := `data: {"conversation_id":"conversation-1","images":[{"file_id":"file-1","file_name":"image.png"}]}`
	if err := handler.bindResourcesFromSSE(context.Background(), owner, line); err != nil {
		t.Fatal(err)
	}
	if execCount != 2 {
		t.Fatalf("ownership inserts = %d, want 2", execCount)
	}
	if err := handler.bindResourcesFromSSE(context.Background(), "user-b", line); err == nil {
		t.Fatal("expected ownership conflict for another user")
	}
}

func TestConversationValidatesEveryReferencedFile(t *testing.T) {
	const owner = "user-a"
	mockDB := &mockDBTX{queryRowFn: func(_ context.Context, sql string, args ...interface{}) pgx.Row {
		id := args[0].(string)
		resourceOwner := owner
		if id == "file-other" {
			resourceOwner = "user-b"
		}
		return &mockRow{scanFn: func(dest ...interface{}) error {
			*(dest[0].(*string)) = id
			*(dest[1].(*string)) = resourceOwner
			*(dest[2].(*string)) = "resource"
			return nil
		}}
	}}
	handler := &ProxyHandler{queries: db.New(mockDB)}
	ctx, recorder := ownershipContext("/api/conversation")
	ctx.Set("user_id", owner)
	handler.proxyConversation(ctx, conversationRequest{
		Message:        "edit",
		Stream:         true,
		OriginalFileID: "file-owned",
		Attachment:     &attachmentRequest{FileID: "file-other"},
	})
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", recorder.Code)
	}
}

func TestImageSourceRequiresMatchingGenerationID(t *testing.T) {
	mockDB := &mockDBTX{queryRowFn: func(_ context.Context, _ string, args ...interface{}) pgx.Row {
		return &mockRow{scanFn: func(dest ...interface{}) error {
			*(dest[0].(*string)) = args[0].(string)
			*(dest[1].(*string)) = "user-a"
			*(dest[2].(*string)) = "image.png"
			*(dest[3].(*string)) = "generation-a"
			return nil
		}}
	}}
	handler := &ProxyHandler{queries: db.New(mockDB)}
	ctx, recorder := ownershipContext("/api/images/generations")
	if handler.requireImageSource(ctx, "file-a", "generation-b", "user-a") {
		t.Fatal("mismatched generation ID must be rejected")
	}
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", recorder.Code)
	}
}

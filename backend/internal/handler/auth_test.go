package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"chatgpt-proxy/backend/internal/auth"
	"chatgpt-proxy/backend/internal/db"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/crypto/bcrypt"
)

// ── mock types for db.DBTX ──

// mockRow implements pgx.Row for test usage.
type mockRow struct {
	scanFn func(dest ...interface{}) error
}

func (m *mockRow) Scan(dest ...interface{}) error {
	if m.scanFn != nil {
		return m.scanFn(dest...)
	}
	return nil
}

// mockRows implements pgx.Rows for test usage.
type mockRows struct {
	rows [][]interface{}
	idx  int
}

func (m *mockRows) Close()                                         {}
func (m *mockRows) Err() error                                     { return nil }
func (m *mockRows) Next() bool                                     { m.idx++; return m.idx <= len(m.rows) }
func (m *mockRows) Scan(dest ...interface{}) error                 { return nil }
func (m *mockRows) CommandTag() pgconn.CommandTag                  { return pgconn.CommandTag{} }
func (m *mockRows) FieldDescriptions() []pgconn.FieldDescription   { return nil }
func (m *mockRows) Values() ([]interface{}, error)                 { return nil, nil }
func (m *mockRows) RawValues() [][]byte                            { return nil }
func (m *mockRows) Conn() *pgx.Conn                                { return nil }

// mockDBTX implements db.DBTX and delegates to user-supplied functions.
type mockDBTX struct {
	execFn  func(ctx context.Context, sql string, args ...interface{}) (pgconn.CommandTag, error)
	queryFn func(ctx context.Context, sql string, args ...interface{}) (pgx.Rows, error)
	queryRowFn func(ctx context.Context, sql string, args ...interface{}) pgx.Row
}

func (m *mockDBTX) Exec(ctx context.Context, sql string, args ...interface{}) (pgconn.CommandTag, error) {
	if m.execFn != nil {
		return m.execFn(ctx, sql, args...)
	}
	return pgconn.CommandTag{}, nil
}

func (m *mockDBTX) Query(ctx context.Context, sql string, args ...interface{}) (pgx.Rows, error) {
	if m.queryFn != nil {
		return m.queryFn(ctx, sql, args...)
	}
	return &mockRows{}, nil
}

func (m *mockDBTX) QueryRow(ctx context.Context, sql string, args ...interface{}) pgx.Row {
	if m.queryRowFn != nil {
		return m.queryRowFn(ctx, sql, args...)
	}
	return &mockRow{}
}

// ── helpers ──

func setupAuthHandler(t *testing.T) (*gin.Engine, *mockDBTX) {
	t.Helper()
	gin.SetMode(gin.TestMode)

	mockDB := &mockDBTX{}
	queries := db.New(mockDB)
	svc := auth.NewService(queries, "test-jwt-secret-for-tests-32b", 0) // 0 expr → 24h default
	h := NewAuthHandler(svc)

	r := gin.New()
	r.POST("/api/auth/register", h.Register)
	r.POST("/api/auth/login", h.Login)

	return r, mockDB
}

func jsonBody(obj interface{}) *strings.Reader {
	b, _ := json.Marshal(obj)
	return strings.NewReader(string(b))
}

// ── tests ──

func TestRegister_ValidationErrors(t *testing.T) {
	r, _ := setupAuthHandler(t)

	tests := []struct {
		name string
		body interface{}
	}{
		{"invalid email", auth.RegisterRequest{Email: "notanemail", Password: "password123"}},
		{"short password", auth.RegisterRequest{Email: "test@example.com", Password: "12345"}},
		{"missing fields", map[string]string{}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/auth/register", jsonBody(tt.body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)

			if w.Code == http.StatusCreated {
				t.Fatal("expected validation error, got 201")
			}
		})
	}
}

func TestRegister_Success(t *testing.T) {
	r, mockDB := setupAuthHandler(t)

	// mock CreateUser to return a new user row
	mockDB.queryRowFn = func(ctx context.Context, sql string, args ...interface{}) pgx.Row {
		return &mockRow{
			scanFn: func(dest ...interface{}) error {
				// dest: &id, &email, &password_hash
				*(dest[0].(*string)) = "00000000-0000-0000-0000-000000000001"
				*(dest[1].(*string)) = "test@example.com"
				// dest[2] is the hashed password — we don't care about its value
				return nil
			},
		}
	}

	body := auth.RegisterRequest{Email: "test@example.com", Password: "password123"}
	req := httptest.NewRequest(http.MethodPost, "/api/auth/register", jsonBody(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}

	var resp auth.LoginResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}
	if resp.User.Email != "test@example.com" {
		t.Errorf("expected email 'test@example.com', got '%s'", resp.User.Email)
	}
	if resp.User.ID != "00000000-0000-0000-0000-000000000001" {
		t.Errorf("expected ID '00000000-0000-0000-0000-000000000001', got '%s'", resp.User.ID)
	}
	if resp.Token == "" {
		t.Error("expected non-empty token in register response")
	}
}

func TestLogin_ValidationErrors(t *testing.T) {
	r, _ := setupAuthHandler(t)

	// missing fields → JSON bind failure
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", jsonBody(map[string]string{}))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for empty body, got %d", w.Code)
	}
}

func TestLogin_Success(t *testing.T) {
	r, mockDB := setupAuthHandler(t)

	// pre-compute a bcrypt hash for "password123"
	hashed, err := bcrypt.GenerateFromPassword([]byte("password123"), 12)
	if err != nil {
		t.Fatalf("bcrypt setup failed: %v", err)
	}

	mockDB.queryRowFn = func(ctx context.Context, sql string, args ...interface{}) pgx.Row {
		return &mockRow{
			scanFn: func(dest ...interface{}) error {
				// dest: &id, &email, &password_hash
				*(dest[0].(*string)) = "00000000-0000-0000-0000-000000000001"
				*(dest[1].(*string)) = "test@example.com"
				*(dest[2].(*string)) = string(hashed)
				return nil
			},
		}
	}

	body := auth.LoginRequest{Email: "test@example.com", Password: "password123"}
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", jsonBody(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp auth.LoginResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}
	if resp.User.Email != "test@example.com" {
		t.Errorf("expected email 'test@example.com', got '%s'", resp.User.Email)
	}
	if resp.Token == "" {
		t.Error("expected non-empty token")
	}
}

func TestLogin_InvalidCredentials(t *testing.T) {
	r, mockDB := setupAuthHandler(t)

	// wrong password → bcrypt mismatch
	hashed, err := bcrypt.GenerateFromPassword([]byte("correctpassword"), 12)
	if err != nil {
		t.Fatalf("bcrypt setup failed: %v", err)
	}

	mockDB.queryRowFn = func(ctx context.Context, sql string, args ...interface{}) pgx.Row {
		return &mockRow{
			scanFn: func(dest ...interface{}) error {
				*(dest[0].(*string)) = "00000000-0000-0000-0000-000000000001"
				*(dest[1].(*string)) = "test@example.com"
				*(dest[2].(*string)) = string(hashed)
				return nil
			},
		}
	}

	body := auth.LoginRequest{Email: "test@example.com", Password: "wrongpassword"}
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", jsonBody(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d: %s", w.Code, w.Body.String())
	}
}

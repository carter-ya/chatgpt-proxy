package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"chatgpt-proxy/backend/internal/middleware"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

func setupProtectedRouter(jwtSecret string) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	protected := r.Group("/api")
	protected.Use(middleware.AuthMiddleware(jwtSecret))
	protected.GET("/protected", func(c *gin.Context) {
		userID, _ := c.Get("user_id")
		c.JSON(http.StatusOK, gin.H{"user_id": userID})
	})
	return r
}

func generateValidToken(secret string, userID int32, email string) string {
	now := time.Now()
	claims := jwt.MapClaims{
		"user_id": userID,
		"email":   email,
		"exp":     now.Add(1 * time.Hour).Unix(),
		"iat":     now.Unix(),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	t, _ := token.SignedString([]byte(secret))
	return t
}

func TestProtectedRoute_NoAuthHeader(t *testing.T) {
	r := setupProtectedRouter("test-secret")

	req := httptest.NewRequest(http.MethodGet, "/api/protected", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for missing auth header, got %d", w.Code)
	}
}

func TestProtectedRoute_MalformedAuthHeader(t *testing.T) {
	r := setupProtectedRouter("test-secret")

	tests := []struct {
		name  string
		value string
	}{
		{"no bearer prefix", "some-random-token"},
		{"wrong prefix", "Basic dGVzdDp0ZXN0"},
		{"empty token", "Bearer "},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/protected", nil)
			req.Header.Set("Authorization", tt.value)
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)

			if w.Code != http.StatusUnauthorized {
				t.Fatalf("expected 401 for malformed header '%s', got %d", tt.value, w.Code)
			}
		})
	}
}

func TestProtectedRoute_InvalidToken(t *testing.T) {
	r := setupProtectedRouter("test-secret")

	tests := []struct {
		name  string
		token string
	}{
		{"expired token", generateExpiredToken("test-secret")},
		{"wrong secret", generateValidToken("wrong-secret", 1, "test@example.com")},
		{"garbage token", "eyJhbGciOiJIUzI1NiJ9.aaaa.bbbb"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/protected", nil)
			req.Header.Set("Authorization", "Bearer "+tt.token)
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)

			if w.Code != http.StatusUnauthorized {
				t.Fatalf("expected 401 for invalid token '%s', got %d", tt.name, w.Code)
			}
		})
	}
}

func TestProtectedRoute_ValidToken(t *testing.T) {
	secret := "test-secret"
	r := setupProtectedRouter(secret)

	token := generateValidToken(secret, 42, "user@example.com")
	req := httptest.NewRequest(http.MethodGet, "/api/protected", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

// generateExpiredToken creates a token that has already expired.
func generateExpiredToken(secret string) string {
	now := time.Now()
	claims := jwt.MapClaims{
		"user_id": 1,
		"email":   "expired@example.com",
		"exp":     now.Add(-1 * time.Hour).Unix(),
		"iat":     now.Add(-2 * time.Hour).Unix(),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	t, _ := token.SignedString([]byte(secret))
	return t
}

package session

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"chatgpt-proxy/backend/internal/db"
)

// SessionToken wraps a db.SessionToken for manager usage.
type SessionToken = db.SessionToken

// Manager manages multiple ChatGPT session tokens with round-robin selection.
type Manager struct {
	queries *db.Queries
	mu      sync.Mutex
	index   int // round-robin index for GetActiveToken
}

// NewManager creates a new session token Manager.
func NewManager(queries *db.Queries) *Manager {
	return &Manager{queries: queries}
}

// ErrNoActiveToken is returned when no active session token is available.
var ErrNoActiveToken = errors.New("没有可用的活跃 session token（所有 token 均已失效或未配置）")

// GetActiveToken returns the next active session token value using round-robin.
func (m *Manager) GetActiveToken(ctx context.Context) (string, error) {
	tokens, err := m.queries.GetActiveSessionTokens(ctx)
	if err != nil {
		return "", fmt.Errorf("获取活跃 session token 失败: %w", err)
	}
	if len(tokens) == 0 {
		return "", ErrNoActiveToken
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	// Round-robin through available tokens.
	if m.index >= len(tokens) {
		m.index = 0
	}
	token := tokens[m.index]
	m.index = (m.index + 1) % len(tokens)

	return token.TokenValue, nil
}

// MarkTokenExpired marks a specific session token as expired.
func (m *Manager) MarkTokenExpired(ctx context.Context, tokenID string) error {
	return m.queries.UpdateSessionTokenStatus(ctx, tokenID, "expired")
}

// GetAllActiveTokens returns all active session tokens.
func (m *Manager) GetAllActiveTokens(ctx context.Context) ([]SessionToken, error) {
	return m.queries.GetActiveSessionTokens(ctx)
}

// GetTokenByValue returns the session token matching the given token value.
func (m *Manager) GetTokenByValue(ctx context.Context, tokenValue string) (*SessionToken, error) {
	tokens, err := m.queries.GetActiveSessionTokens(ctx)
	if err != nil {
		return nil, fmt.Errorf("获取 session token 列表失败: %w", err)
	}
	for i := range tokens {
		if tokens[i].TokenValue == tokenValue {
			return &tokens[i], nil
		}
	}
	return nil, fmt.Errorf("未找到匹配的 session token")
}

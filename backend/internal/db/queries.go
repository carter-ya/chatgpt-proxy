package db

import (
	"context"
	"time"
)

// SessionToken represents a row in the session_tokens table.
type SessionToken struct {
	ID         string    `json:"id"`
	TokenValue string    `json:"token_value"`
	Status     string    `json:"status"` // "active" or "expired"
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

// NewQueries creates a new Queries instance with a nil DBTX (for stub usage).
func NewQueries() *Queries {
	return &Queries{}
}

// GetActiveSessionTokens returns all session tokens with status "active".
func (q *Queries) GetActiveSessionTokens(ctx context.Context) ([]SessionToken, error) {
	// Stub — Worker 2 will replace with real sqlc query.
	return nil, nil
}

// UpdateSessionTokenStatus updates the status of a session token.
func (q *Queries) UpdateSessionTokenStatus(ctx context.Context, id string, status string) error {
	// Stub — Worker 2 will replace with real sqlc query.
	return nil
}

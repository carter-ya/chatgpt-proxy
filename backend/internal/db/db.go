package db

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type User struct {
	ID             string
	Email          string
	HashedPassword string
}

// SessionToken represents a row in the session_tokens table.
type SessionToken struct {
	ID        string    `json:"id"`
	Token     string    `json:"token"`  // AES-256-GCM 加密存储，base64 编码
	Status    string    `json:"status"` // "active" or "expired"
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type DBTX interface {
	Exec(context.Context, string, ...interface{}) (pgconn.CommandTag, error)
	Query(context.Context, string, ...interface{}) (pgx.Rows, error)
	QueryRow(context.Context, string, ...interface{}) pgx.Row
}

type Queries struct {
	db DBTX
}

func New(db DBTX) *Queries {
	return &Queries{db: db}
}

// Conversation represents a row in the conversations table.
type Conversation struct {
	ID     string
	UserID string
	Title  string
}

type CreateUserParams struct {
	Email          string
	HashedPassword string
}

func (q *Queries) CreateUser(ctx context.Context, params CreateUserParams) (User, error) {
	const sql = `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, password_hash`
	var u User
	err := q.db.QueryRow(ctx, sql, params.Email, params.HashedPassword).Scan(&u.ID, &u.Email, &u.HashedPassword)
	return u, err
}

type GetUserByEmailParams struct {
	Email string
}

func (q *Queries) GetUserByEmail(ctx context.Context, email string) (User, error) {
	const sql = `SELECT id, email, password_hash FROM users WHERE email = $1`
	var u User
	err := q.db.QueryRow(ctx, sql, email).Scan(&u.ID, &u.Email, &u.HashedPassword)
	return u, err
}

// GetActiveSessionTokens returns all session tokens with status "active".
func (q *Queries) GetActiveSessionTokens(ctx context.Context) ([]SessionToken, error) {
	const sql = `SELECT id, token, status, created_at, updated_at FROM session_tokens WHERE status = 'active' ORDER BY created_at ASC`
	rows, err := q.db.Query(ctx, sql)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tokens []SessionToken
	for rows.Next() {
		var t SessionToken
		if err := rows.Scan(&t.ID, &t.Token, &t.Status, &t.CreatedAt, &t.UpdatedAt); err != nil {
			return nil, err
		}
		tokens = append(tokens, t)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return tokens, nil
}

// UpdateSessionTokenStatus updates the status of a session token.
func (q *Queries) UpdateSessionTokenStatus(ctx context.Context, id string, status string) error {
	const sql = `UPDATE session_tokens SET status = $1, updated_at = NOW() WHERE id = $2`
	_, err := q.db.Exec(ctx, sql, status, id)
	return err
}

// CreateSessionToken inserts a new session token with status "active".
func (q *Queries) CreateSessionToken(ctx context.Context, encryptedToken string) (SessionToken, error) {
	const sql = `INSERT INTO session_tokens (token, status) VALUES ($1, 'active') RETURNING id, token, status, created_at, updated_at`
	var t SessionToken
	err := q.db.QueryRow(ctx, sql, encryptedToken).Scan(&t.ID, &t.Token, &t.Status, &t.CreatedAt, &t.UpdatedAt)
	return t, err
}

// CreateConversation inserts a new conversation row. Uses ON CONFLICT DO NOTHING
// to safely handle cases where the conversation already exists.
func (q *Queries) CreateConversation(ctx context.Context, id, userID, title string) error {
	const sql = `INSERT INTO conversations (id, user_id, title) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`
	_, err := q.db.Exec(ctx, sql, id, userID, title)
	return err
}

// GetConversationByID returns a conversation by its id.
// Returns a zero-value Conversation and an error (pgx.ErrNoRows) if not found.
func (q *Queries) GetConversationByID(ctx context.Context, id string) (Conversation, error) {
	const sql = `SELECT id, user_id, title FROM conversations WHERE id = $1`
	var c Conversation
	err := q.db.QueryRow(ctx, sql, id).Scan(&c.ID, &c.UserID, &c.Title)
	return c, err
}

// ListConversationIDsByUser returns all conversation IDs owned by the given user.
func (q *Queries) ListConversationIDsByUser(ctx context.Context, userID string) ([]string, error) {
	const sql = `SELECT id FROM conversations WHERE user_id = $1`
	rows, err := q.db.Query(ctx, sql, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return ids, nil
}

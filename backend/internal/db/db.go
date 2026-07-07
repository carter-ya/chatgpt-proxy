package db

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type User struct {
	ID             int32
	Email          string
	HashedPassword string
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

type CreateUserParams struct {
	Email          string
	HashedPassword string
}

func (q *Queries) CreateUser(ctx context.Context, params CreateUserParams) (User, error) {
	const sql = `INSERT INTO users (email, hashed_password) VALUES ($1, $2) RETURNING id, email, hashed_password`
	var u User
	err := q.db.QueryRow(ctx, sql, params.Email, params.HashedPassword).Scan(&u.ID, &u.Email, &u.HashedPassword)
	return u, err
}

type GetUserByEmailParams struct {
	Email string
}

func (q *Queries) GetUserByEmail(ctx context.Context, email string) (User, error) {
	const sql = `SELECT id, email, hashed_password FROM users WHERE email = $1`
	var u User
	err := q.db.QueryRow(ctx, sql, email).Scan(&u.ID, &u.Email, &u.HashedPassword)
	return u, err
}

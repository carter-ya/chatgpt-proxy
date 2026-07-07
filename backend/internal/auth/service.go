package auth

import (
	"context"
	"regexp"
	"time"

	"chatgpt-proxy/backend/internal/db"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/crypto/bcrypt"
)

var emailRegex = regexp.MustCompile(`^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$`)

type Service struct {
	queries       *db.Queries
	jwtSecret     []byte
	jwtExpiration time.Duration
}

func NewService(queries *db.Queries, jwtSecret string, jwtExpiration time.Duration) *Service {
	return &Service{
		queries:       queries,
		jwtSecret:     []byte(jwtSecret),
		jwtExpiration: jwtExpiration,
	}
}

func (s *Service) Register(ctx context.Context, email, password string) (*UserResponse, error) {
	if !emailRegex.MatchString(email) {
		return nil, ErrInvalidInput
	}
	if len(password) < 6 {
		return nil, ErrInvalidInput
	}

	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(password), 12)
	if err != nil {
		return nil, err
	}

	user, err := s.queries.CreateUser(ctx, db.CreateUserParams{
		Email:          email,
		HashedPassword: string(hashedPassword),
	})
	if err != nil {
		if pgErr, ok := err.(*pgconn.PgError); ok && pgErr.Code == "23505" {
			return nil, ErrEmailExists
		}
		return nil, err
	}

	return &UserResponse{ID: user.ID, Email: user.Email}, nil
}

func (s *Service) Login(ctx context.Context, email, password string) (*LoginResponse, error) {
	user, err := s.queries.GetUserByEmail(ctx, email)
	if err != nil {
		return nil, ErrInvalidCredentials
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.HashedPassword), []byte(password)); err != nil {
		return nil, ErrInvalidCredentials
	}

	token, err := s.generateJWT(user.ID, user.Email)
	if err != nil {
		return nil, err
	}

	return &LoginResponse{
		Token: token,
		User:  UserResponse{ID: user.ID, Email: user.Email},
	}, nil
}

func (s *Service) generateJWT(userID string, email string) (string, error) {
	now := time.Now()
	claims := jwt.MapClaims{
		"user_id": userID,
		"email":   email,
		"exp":     now.Add(s.jwtExpiration).Unix(),
		"iat":     now.Unix(),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(s.jwtSecret)
}

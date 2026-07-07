package app

import (
	"context"
	"log"
	"time"

	"chatgpt-proxy/internal/auth"
	"chatgpt-proxy/internal/config"
	"chatgpt-proxy/internal/db"
	"chatgpt-proxy/internal/handler"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
)

type App struct {
	cfg    *config.Config
	engine *gin.Engine
	pool   *pgxpool.Pool
}

func New(cfg *config.Config) (*App, error) {
	pool, err := pgxpool.New(context.Background(), "")
	if err != nil {
		return nil, err
	}

	queries := db.New(pool)

	authSvc := auth.NewService(queries, cfg.JWTSecret, cfg.JWTExpiration)
	if cfg.JWTExpiration == 0 {
		authSvc = auth.NewService(queries, cfg.JWTSecret, 24*time.Hour)
	}

	authHandler := handler.NewAuthHandler(authSvc)

	engine := gin.Default()

	api := engine.Group("/api")
	RegisterAuthRoutes(api, authHandler)
	RegisterProtectedRoutes(api, cfg.JWTSecret)

	return &App{
		cfg:    cfg,
		engine: engine,
		pool:   pool,
	}, nil
}

func (a *App) Engine() *gin.Engine {
	return a.engine
}

func (a *App) Close() {
	if a.pool != nil {
		a.pool.Close()
	}
}

var (
	Version   = "dev"
	BuildTime = "unknown"
)

func PrintBanner() {
	log.Printf("chatgpt-proxy %s (built at %s)", Version, BuildTime)
}

package app

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"chatgpt-proxy/internal/auth"
	"chatgpt-proxy/internal/config"
	"chatgpt-proxy/internal/db"
	"chatgpt-proxy/internal/handler"
	"chatgpt-proxy/internal/httpresp"

	"github.com/gin-contrib/cors"
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

	engine := gin.New()
	engine.Use(gin.Recovery(), gin.Logger())
	engine.Use(cors.Default())

	api := engine.Group("/api")
	api.GET("/health", health)
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

func (a *App) Run() error {
	addr := fmt.Sprintf(":%d", a.cfg.ServerPort)
	srv := &http.Server{
		Addr:    addr,
		Handler: a.engine,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		srv.Shutdown(shutdownCtx)
	}()

	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return fmt.Errorf("app: 服务启动失败: %w", err)
	}
	return nil
}

func (a *App) Close() {
	if a.pool != nil {
		a.pool.Close()
	}
}

func health(c *gin.Context) {
	httpresp.StatusOK(c, gin.H{"status": "ok"})
}

var (
	Version   = "dev"
	BuildTime = "unknown"
)

func PrintBanner() {
	log.Printf("chatgpt-proxy %s (built at %s)", Version, BuildTime)
}

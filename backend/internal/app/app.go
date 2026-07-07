package app

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"chatgpt-proxy/backend/internal/auth"
	"chatgpt-proxy/backend/internal/config"
	"chatgpt-proxy/backend/internal/db"
	"chatgpt-proxy/backend/internal/handler"
	"chatgpt-proxy/backend/internal/httpresp"
	"chatgpt-proxy/backend/internal/proxy"
	"chatgpt-proxy/backend/internal/sentinel"
	"chatgpt-proxy/backend/internal/session"

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
	pool, err := db.NewPool(context.Background(), cfg.DatabaseURL)
	if err != nil {
		return nil, err
	}

	queries := db.New(pool)

	authSvc := auth.NewService(queries, cfg.JWTSecret, cfg.JWTExpiration)
	if cfg.JWTExpiration == 0 {
		authSvc = auth.NewService(queries, cfg.JWTSecret, 24*time.Hour)
	}

	authHandler := handler.NewAuthHandler(authSvc)

	sentinelCache := sentinel.NewTokenCache(cfg.SentinelCacheTTL)
	sessionManager := session.NewManager(queries)
	proxyClient := proxy.NewProxyClient(cfg.ChatGPTBaseURL, sentinelCache)
	proxyHandler := handler.NewProxyHandler(proxyClient, sessionManager)

	engine := gin.New()
	engine.Use(gin.Recovery(), gin.Logger())
	engine.Use(cors.Default())

	api := engine.Group("/api")
	api.GET("/health", health)
	RegisterAuthRoutes(api, authHandler)
	protected := RegisterProtectedRoutes(api, cfg.JWTSecret)
	protected.POST("/conversation", proxyHandler.Conversation)
	protected.POST("/files", proxyHandler.UploadFile)
	protected.GET("/conversations", proxyHandler.ListConversations)
	protected.GET("/conversations/:id", proxyHandler.GetConversation)
	protected.PATCH("/conversations/:id", proxyHandler.UpdateConversation)

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

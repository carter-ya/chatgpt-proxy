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
	"chatgpt-proxy/backend/internal/download"
	"chatgpt-proxy/backend/internal/handler"
	"chatgpt-proxy/backend/internal/httpresp"
	"chatgpt-proxy/backend/internal/proxy"
	"chatgpt-proxy/backend/internal/session"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"github.com/go-co-op/gocron/v2"
	"github.com/jackc/pgx/v5/pgxpool"
)

type App struct {
	cfg          *config.Config
	engine       *gin.Engine
	pool         *pgxpool.Pool
	scheduler    gocron.Scheduler
	proxyHandler *handler.ProxyHandler
}

func New(cfg *config.Config) (*App, error) {
	if err := db.RunMigrations(cfg.DatabaseURL); err != nil {
		return nil, fmt.Errorf("run migrations: %w", err)
	}

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

	sessionManager, err := session.NewManager(queries, cfg.EncryptionKey)
	if err != nil {
		return nil, fmt.Errorf("初始化 session manager 失败: %w", err)
	}

	if hasConfiguredSessionTokens(cfg.SessionTokens) {
		log.Printf("[app] CHATGPT_PROXY_SESSION_TOKENS 已忽略：当前默认认证链路使用 sidecar Chrome 登录态")
	}

	proxyClient := proxy.NewBrowserProxyClient(cfg.SidecarURL, cfg.ChatGPTBaseURL)
	ticketCodec, err := download.NewCodec(cfg.EncryptionKey, 10*time.Minute)
	if err != nil {
		return nil, fmt.Errorf("初始化下载票据: %w", err)
	}
	proxyHandler := handler.NewProxyHandler(proxyClient, sessionManager, queries, ticketCodec)

	engine := gin.New()
	engine.Use(gin.Recovery(), gin.Logger())
	engine.Use(cors.Default())

	api := engine.Group("/api")
	api.GET("/health", health)
	api.GET("/downloads/:ticket", proxyHandler.DownloadWithTicket)
	RegisterAuthRoutes(api, authHandler)
	protected := RegisterProtectedRoutes(api, cfg.JWTSecret)
	protected.POST("/conversation", proxyHandler.Conversation)
	protected.POST("/conversations/:id/retry", proxyHandler.RetryConversation)
	protected.GET("/models", proxyHandler.Models)
	protected.POST("/images/generations", proxyHandler.ImageGeneration)
	protected.POST("/images/select", proxyHandler.ImageSelection)
	protected.POST("/files", proxyHandler.UploadFile)
	protected.POST("/download-tickets", proxyHandler.CreateDownloadTicket)
	protected.GET("/files/:id/download", proxyHandler.DownloadFile)
	protected.GET("/conversations", proxyHandler.ListConversations)
	protected.GET("/conversations/:id/files/download", proxyHandler.DownloadSandboxFile)
	protected.GET("/conversations/:id", proxyHandler.GetConversation)
	protected.POST("/conversations/:id/async-status", proxyHandler.ConversationAsyncStatus)
	protected.PATCH("/conversations/:id", proxyHandler.UpdateConversation)
	protected.DELETE("/conversations/:id", proxyHandler.DeleteConversation)

	return &App{
		cfg:          cfg,
		engine:       engine,
		pool:         pool,
		proxyHandler: proxyHandler,
	}, nil
}

func (a *App) Engine() *gin.Engine {
	return a.engine
}

func hasConfiguredSessionTokens(tokens []string) bool {
	for _, token := range tokens {
		if token != "" {
			return true
		}
	}
	return false
}

func (a *App) Run() error {
	addr := fmt.Sprintf(":%d", a.cfg.ServerPort)
	srv := &http.Server{
		Addr:    addr,
		Handler: a.engine,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go a.proxyHandler.RunModelCatalogRefresh(ctx, 4*time.Minute, 8*time.Minute)

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
	if a.scheduler != nil {
		if err := a.scheduler.Shutdown(); err != nil {
			log.Printf("app: 关闭 cron 调度器失败: %v", err)
		}
	}
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

package app

import (
	"context"
	"encoding/base64"
	"fmt"
	"log"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"chatgpt-proxy/backend/internal/auth"
	"chatgpt-proxy/backend/internal/config"
	"chatgpt-proxy/backend/internal/cron"
	"chatgpt-proxy/backend/internal/crypto"
	"chatgpt-proxy/backend/internal/db"
	"chatgpt-proxy/backend/internal/handler"
	"chatgpt-proxy/backend/internal/httpresp"
	"chatgpt-proxy/backend/internal/proxy"
	"chatgpt-proxy/backend/internal/sentinel"
	"chatgpt-proxy/backend/internal/session"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"github.com/go-co-op/gocron/v2"
	"github.com/jackc/pgx/v5/pgxpool"
)

type App struct {
	cfg       *config.Config
	engine    *gin.Engine
	pool      *pgxpool.Pool
	scheduler gocron.Scheduler
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

	sentinelCache := sentinel.NewTokenCache(cfg.SentinelCacheTTL)
	sessionManager, err := session.NewManager(queries, cfg.EncryptionKey)
	if err != nil {
		return nil, fmt.Errorf("初始化 session manager 失败: %w", err)
	}

	// 播种 session token：将配置文件中的 token 加密后写入数据库，重复启动不重复插入。
	seedSessionTokens(context.Background(), cfg.SessionTokens, queries, sessionManager, cfg.EncryptionKey)

	proxyClient := proxy.NewProxyClient(cfg.ChatGPTBaseURL, sentinelCache)
	proxyHandler := handler.NewProxyHandler(proxyClient, sessionManager, queries)

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

	scheduler, err := cron.StartTokenHealthCheck(sessionManager, cfg.TokenCheckInterval)
	if err != nil {
		return nil, fmt.Errorf("启动 token 健康检查失败: %w", err)
	}

	return &App{
		cfg:       cfg,
		engine:    engine,
		pool:      pool,
		scheduler: scheduler,
	}, nil
}

// seedSessionTokens 将配置中的 session token 加密后写入数据库。
// 通过解密现有 token 对比明文实现去重，重复启动不重复插入。
// 播种失败仅打印警告日志，不会阻止应用启动。
func seedSessionTokens(ctx context.Context, tokens []string, queries *db.Queries, mgr *session.Manager, encryptionKey string) {
	keyBytes, err := base64.StdEncoding.DecodeString(encryptionKey)
	if err != nil {
		log.Printf("[app] 播种 session token 失败: 解码加密密钥错误: %v", err)
		return
	}

	// 获取所有 active token，解密后构建明文集合用于去重。
	existingTokens, err := mgr.GetAllActiveTokens(ctx)
	if err != nil {
		log.Printf("[app] 播种 session token 失败: 获取现有 token 出错: %v", err)
		return
	}

	existing := make(map[string]bool)
	for _, t := range existingTokens {
		plaintext, decErr := crypto.Decrypt(t.Token, keyBytes)
		if decErr != nil {
			// 无法解密的 token 跳过，不影响播种流程。
			log.Printf("[app] 播种: 解密现有 token 失败，跳过: %v", decErr)
			continue
		}
		existing[plaintext] = true
	}

	for _, token := range tokens {
		if token == "" {
			continue
		}
		if existing[token] {
			continue
		}

		encrypted, encErr := crypto.Encrypt(token, keyBytes)
		if encErr != nil {
			log.Printf("[app] 播种 session token 失败: 加密错误: %v", encErr)
			continue
		}

		if _, insErr := queries.CreateSessionToken(ctx, encrypted); insErr != nil {
			log.Printf("[app] 播种 session token 失败: 插入数据库出错: %v", insErr)
			continue
		}

		log.Printf("[app] session token 已播种 prefix=%.8s...", token)
	}
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

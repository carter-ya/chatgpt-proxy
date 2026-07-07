// Package app 提供应用装配：路由注册、中间件挂载、服务启动。
package app

import (
	"context"
	"fmt"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"chatgpt-proxy/backend/internal/config"
	"chatgpt-proxy/backend/internal/httpresp"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

// App 持有 gin 引擎和配置。
type App struct {
	engine *gin.Engine
	cfg    *config.Config
}

// New 创建 App 实例，注册基础路由和中间件。
func New(cfg *config.Config) *App {
	engine := gin.New()

	// 中间件：panic recovery、请求日志、CORS
	engine.Use(gin.Recovery(), gin.Logger())
	engine.Use(cors.Default())

	app := &App{engine: engine, cfg: cfg}

	// 健康检查
	engine.GET("/api/health", app.health)

	// 预留路由注册点，后续 worker 在此挂载路由组
	// auth := engine.Group("/api/auth")
	// proxy := engine.Group("/api")

	return app
}

// Run 启动 HTTP 服务，监听配置端口，支持优雅关闭。
func (a *App) Run() error {
	addr := fmt.Sprintf(":%d", a.cfg.ServerPort)
	srv := &http.Server{
		Addr:    addr,
		Handler: a.engine,
	}

	// 优雅关闭：监听 SIGINT / SIGTERM
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

func (a *App) health(c *gin.Context) {
	httpresp.StatusText(c, "ok")
}

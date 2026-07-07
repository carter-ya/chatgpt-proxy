package internal

import (
	"time"

	"chatgpt-proxy/internal/auth"
	"chatgpt-proxy/internal/config"
	"chatgpt-proxy/internal/db"
	"chatgpt-proxy/internal/handler"
	"chatgpt-proxy/internal/proxy"
	"chatgpt-proxy/internal/sentinel"
	"chatgpt-proxy/internal/session"

	"github.com/gin-gonic/gin"
)

// SetupRouter initializes and returns the gin router with all routes registered.
func SetupRouter(cfg *config.Config) *gin.Engine {
	r := gin.Default()

	// Initialize dependencies.
	queries := db.NewQueries()
	sentinelCache := sentinel.NewTokenCache(cfg.SentinelCacheTTL)
	sessionManager := session.NewManager(queries)
	proxyClient := proxy.NewProxyClient(cfg.ChatGPTBaseURL, sentinelCache)
	proxyHandler := handler.NewProxyHandler(proxyClient, sessionManager)

	// Protected routes (auth required).
	protected := r.Group("/api")
	protected.Use(auth.AuthMiddleware())
	{
		protected.POST("/conversation", proxyHandler.Conversation)
		protected.POST("/files", proxyHandler.UploadFile)
		protected.GET("/conversations", proxyHandler.ListConversations)
		protected.GET("/conversations/:id", proxyHandler.GetConversation)
		protected.PATCH("/conversations/:id", proxyHandler.UpdateConversation)
	}

	return r
}

// DefaultConfig returns a default Config suitable for development.
func DefaultConfig() *config.Config {
	return &config.Config{
		ChatGPTBaseURL:   "https://chatgpt.com",
		SentinelCacheTTL: 10 * time.Minute,
	}
}

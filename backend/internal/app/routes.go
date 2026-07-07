package app

import (
	"chatgpt-proxy/backend/internal/handler"
	"chatgpt-proxy/backend/internal/middleware"

	"github.com/gin-gonic/gin"
)

func RegisterAuthRoutes(r *gin.RouterGroup, h *handler.AuthHandler) {
	r.POST("/auth/register", h.Register)
	r.POST("/auth/login", h.Login)
}

func RegisterProtectedRoutes(r *gin.RouterGroup, jwtSecret string) *gin.RouterGroup {
	protected := r.Group("")
	protected.Use(middleware.AuthMiddleware(jwtSecret))
	return protected
}

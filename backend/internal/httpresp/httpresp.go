// Package httpresp 提供统一的 HTTP JSON 响应工具函数。
package httpresp

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// Success 返回 JSON 成功响应。
func Success(c *gin.Context, status int, data interface{}) {
	c.JSON(status, data)
}

// Error 返回 JSON 错误响应，格式为 {"error": "message"}。
func Error(c *gin.Context, status int, message string) {
	c.AbortWithStatusJSON(status, gin.H{"error": message})
}

// StatusText 返回 {"status": s} 格式的 JSON 响应。
func StatusText(c *gin.Context, s string) {
	c.JSON(http.StatusOK, gin.H{"status": s})
}

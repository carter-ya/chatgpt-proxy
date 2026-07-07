package httpresp

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

func Success(c *gin.Context, status int, data interface{}) {
	c.JSON(status, data)
}

func Error(c *gin.Context, status int, message string) {
	c.JSON(status, gin.H{"error": message})
}

func StatusOK(c *gin.Context, data interface{}) {
	Success(c, http.StatusOK, data)
}

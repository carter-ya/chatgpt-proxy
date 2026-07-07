package auth

import (
	"github.com/gin-gonic/gin"
)

// AuthMiddleware returns a gin middleware that authenticates requests
// and injects the user_id into the gin context.
func AuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		// Stub — Worker 3 will replace with real JWT/session validation.
		// For now, inject a placeholder user_id so downstream handlers work.
		c.Set("user_id", "placeholder-user")
		c.Next()
	}
}

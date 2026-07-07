package handler

import (
	"net/http"

	"chatgpt-proxy/backend/internal/auth"
	"chatgpt-proxy/backend/internal/httpresp"

	"github.com/gin-gonic/gin"
)

type AuthHandler struct {
	svc *auth.Service
}

func NewAuthHandler(svc *auth.Service) *AuthHandler {
	return &AuthHandler{svc: svc}
}

func (h *AuthHandler) Register(c *gin.Context) {
	var req auth.RegisterRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpresp.Error(c, http.StatusBadRequest, "输入参数无效")
		return
	}

	resp, err := h.svc.Register(c.Request.Context(), req.Email, req.Password)
	if err != nil {
		if authErr, ok := err.(*auth.AuthError); ok {
			httpresp.Error(c, authErr.Code, authErr.Message)
			return
		}
		httpresp.Error(c, http.StatusInternalServerError, "服务器内部错误")
		return
	}

	httpresp.Success(c, http.StatusCreated, resp)
}

func (h *AuthHandler) Login(c *gin.Context) {
	var req auth.LoginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpresp.Error(c, http.StatusBadRequest, "输入参数无效")
		return
	}

	resp, err := h.svc.Login(c.Request.Context(), req.Email, req.Password)
	if err != nil {
		if authErr, ok := err.(*auth.AuthError); ok {
			httpresp.Error(c, authErr.Code, authErr.Message)
			return
		}
		httpresp.Error(c, http.StatusInternalServerError, "服务器内部错误")
		return
	}

	httpresp.Success(c, http.StatusOK, resp)
}

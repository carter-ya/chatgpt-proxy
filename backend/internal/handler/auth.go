package handler

import (
	"errors"
	"net/http"

	"chatgpt-proxy/backend/internal/auth"
	"chatgpt-proxy/backend/internal/httpresp"

	"github.com/gin-gonic/gin"
	"github.com/go-playground/validator/v10"
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
		httpresp.Error(c, http.StatusBadRequest, validationErrorMessage(err))
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
		httpresp.Error(c, http.StatusBadRequest, validationErrorMessage(err))
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

// validationErrorMessage converts a validator.ValidationErrors to a
// user-readable Chinese error message specific to the failing field and rule.
// fe.Field() returns the Go struct field name (e.g. "Email", "Password"),
// and fe.Tag() returns the failing validation rule (e.g. "required", "email", "min").
func validationErrorMessage(err error) string {
	var valErrs validator.ValidationErrors
	if errors.As(err, &valErrs) {
		for _, fe := range valErrs {
			switch fe.Field() {
			case "Email":
				switch fe.Tag() {
				case "required":
					return "邮箱不能为空"
				case "email":
					return "邮箱格式无效"
				}
			case "Password":
				switch fe.Tag() {
				case "required":
					return "密码不能为空"
				case "min":
					return "密码长度不足，至少需要6个字符"
				}
			}
		}
	}
	return "输入参数无效"
}

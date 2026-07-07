package auth

import "net/http"

type AuthError struct {
	Code    int
	Message string
}

func (e *AuthError) Error() string {
	return e.Message
}

var (
	ErrEmailExists        = &AuthError{Code: http.StatusConflict, Message: "该邮箱已被注册"}
	ErrInvalidCredentials = &AuthError{Code: http.StatusUnauthorized, Message: "邮箱或密码错误"}
	ErrUserNotFound       = &AuthError{Code: http.StatusUnauthorized, Message: "用户不存在"}
	ErrInvalidInput       = &AuthError{Code: http.StatusBadRequest, Message: "输入参数无效"}
)

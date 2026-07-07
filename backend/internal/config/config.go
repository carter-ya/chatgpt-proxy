// Package config 提供应用配置的加载和管理。
// 使用 viper 从环境变量读取配置，通过 go-default 注入默认值，validator 进行校验。
package config

import (
	"fmt"
	"time"

	go_default "github.com/exc-works/go-default"
	"github.com/go-playground/validator/v10"
	"github.com/spf13/viper"
)

// Config 包含所有应用配置项。
// 字段使用 mapstructure tag 供 viper 绑定环境变量，
// default tag 供 go-default 注入默认值，
// validate tag 供 validator 做校验。
type Config struct {
	// ServerPort 服务监听端口
	ServerPort int `mapstructure:"server_port" default:"8080" validate:"required,min=1,max=65535"`
	// DatabaseURL PostgreSQL 连接字符串
	DatabaseURL string `mapstructure:"database_url" default:""`
	// SessionTokens ChatGPT session token 列表
	SessionTokens []string `mapstructure:"session_tokens" default:""`
	// SentinelCacheTTL sentinel token 缓存 TTL（秒）
	SentinelCacheTTL int `mapstructure:"sentinel_cache_ttl" default:"300" validate:"min=1"`
	// JWTSecret JWT 签名密钥
	JWTSecret string `mapstructure:"jwt_secret" default:"" validate:"required"`
	// JWTExpiration JWT 过期时间（小时）
	JWTExpiration time.Duration `mapstructure:"jwt_expiration" default:"24h" validate:"min=1h"`
	// ChatGPTBaseURL chatgpt.com 的基础 URL
	ChatGPTBaseURL string `mapstructure:"chatgpt_base_url" default:"https://chatgpt.com" validate:"required,url"`
}

// Load 从环境变量加载配置，注入默认值并校验。
func Load() (*Config, error) {
	v := viper.New()
	v.SetEnvPrefix("XIAOMING")
	v.AutomaticEnv()

	var cfg Config
	if err := v.Unmarshal(&cfg); err != nil {
		return nil, fmt.Errorf("config: unmarshal 失败: %w", err)
	}

	if err := go_default.Struct(&cfg); err != nil {
		return nil, fmt.Errorf("config: 默认值注入失败: %w", err)
	}

	validate := validator.New()
	if err := validate.Struct(&cfg); err != nil {
		return nil, fmt.Errorf("config: 校验失败: %w", err)
	}

	return &cfg, nil
}

// Package config 提供应用配置的加载和管理。
// 使用 viper 从环境变量读取配置，通过 go-default 注入默认值，validator 进行校验。
package config

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	go_default "github.com/exc-works/go-default"
	"github.com/go-playground/validator/v10"
	"github.com/joho/godotenv"
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
	// SentinelCacheTTL sentinel token 缓存 TTL
	SentinelCacheTTL time.Duration `mapstructure:"sentinel_cache_ttl" default:"5m"`
	// JWTSecret JWT 签名密钥
	JWTSecret string `mapstructure:"jwt_secret" default:"" validate:"required"`
	// JWTExpiration JWT 过期时间（小时）
	JWTExpiration time.Duration `mapstructure:"jwt_expiration" default:"24h" validate:"min=1h"`
	// EncryptionKey AES-256 加密密钥（32字节 base64 编码）
	EncryptionKey string `mapstructure:"encryption_key" default:"" validate:"required,base64"`
	// ChatGPTBaseURL chatgpt.com 的基础 URL
	ChatGPTBaseURL string `mapstructure:"chatgpt_base_url" default:"https://chatgpt.com" validate:"required,url"`
	// SidecarURL Playwright Sidecar 服务地址
	SidecarURL string `mapstructure:"sidecar_url" default:"http://127.0.0.1:3100" validate:"required,url"`
	// SidecarPort Sidecar 端口（备用，当 SidecarURL 未配置时使用）
	SidecarPort int `mapstructure:"sidecar_port" default:"3100" validate:"min=1,max=65535"`
	// TokenCheckInterval session token 健康检查间隔
	TokenCheckInterval time.Duration `mapstructure:"token_check_interval" default:"5m" validate:"min=30s"`
}

// Load 从环境变量加载配置，注入默认值并校验。
func Load() (*Config, error) {
	// 自动加载项目根目录的 .env 文件。
	// godotenv.Load 在变量已存在时不会覆盖，因此显式设置的环境变量（如 targets.json 的 env 块）
	// 优先于 .env 中的值，.env 仅作为回退默认值。
	loadEnvFile()

	v := viper.New()
	v.SetEnvPrefix("XIAOMING")
	v.AutomaticEnv()

	// 显式绑定每个 Config 字段的环境变量，确保 AutomaticEnv + SetEnvPrefix
	// 在 Unmarshal 时能正确将 XIAOMING_* 环境变量映射到 mapstructure 字段。
	// 仅靠 AutomaticEnv 在某些 viper 版本中不会自动绑定带前缀的 key。
	v.BindEnv("server_port")
	v.BindEnv("database_url")
	v.BindEnv("session_tokens")
	v.BindEnv("sentinel_cache_ttl")
	v.BindEnv("jwt_secret")
	v.BindEnv("jwt_expiration")
	v.BindEnv("encryption_key")
	v.BindEnv("chatgpt_base_url")
	v.BindEnv("sidecar_url")
	v.BindEnv("sidecar_port")
	v.BindEnv("token_check_interval")

	// 调试：在 Unmarshal 前确认关键环境变量已通过 godotenv 注入。
	log.Printf("[config] Unmarshal 前 XIAOMING_SESSION_TOKENS len=%d (os.Getenv)", len(os.Getenv("XIAOMING_SESSION_TOKENS")))
	log.Printf("[config] Unmarshal 前 XIAOMING_DATABASE_URL len=%d", len(os.Getenv("XIAOMING_DATABASE_URL")))

	var cfg Config
	if err := v.Unmarshal(&cfg); err != nil {
		return nil, fmt.Errorf("config: unmarshal 失败: %w", err)
	}

	if err := go_default.Struct(&cfg); err != nil {
		return nil, fmt.Errorf("config: 默认值注入失败: %w", err)
	}

	// viper 的 Unmarshal（底层使用 mapstructure）无法将环境变量中的单个字符串值
	// 自动转换为 []string。因此对于 []string 类型的字段，在 Unmarshal 之后
	// 手动从 os.Getenv 读取并回填。
	if len(cfg.SessionTokens) == 0 {
		if tokenEnv := os.Getenv("XIAOMING_SESSION_TOKENS"); tokenEnv != "" {
			// 按逗号分割以支持多个 token，同时过滤空字符串。
			rawTokens := strings.Split(tokenEnv, ",")
			var tokens []string
			for _, t := range rawTokens {
				t = strings.TrimSpace(t)
				if t != "" {
					tokens = append(tokens, t)
				}
			}
			cfg.SessionTokens = tokens
			log.Printf("[config] 手动回填 session_tokens: 共 %d 个 token", len(tokens))
		}
	}

	validate := validator.New()
	if err := validate.Struct(&cfg); err != nil {
		return nil, fmt.Errorf("config: 校验失败: %w", err)
	}

		// 显式检查必需配置项的空值。
	// validator 的 required tag 对 string 类型的零值（空字符串）有效，
	// 但 DatabaseURL 没有 required tag，且使用 default:"" 仅为语义占位。
	// 显式检查确保缺失关键配置时输出清晰的错误信息。
	if cfg.DatabaseURL == "" {
		return nil, fmt.Errorf("config: 配置项 XIAOMING_DATABASE_URL 不能为空")
	}
	if cfg.JWTSecret == "" {
		return nil, fmt.Errorf("config: 配置项 XIAOMING_JWT_SECRET 不能为空")
	}

	return &cfg, nil
}

// loadEnvFile 尝试从项目根目录加载 .env 文件。
// 使用 godotenv.Load 在变量未设置时注入，已存在的环境变量不会被覆盖。
// .env 文件路径固定为 ../.env（相对于 backend/ 工作目录）。
func loadEnvFile() {
	// 定位项目根目录的 .env 文件
	envPath := filepath.Join("..", ".env")
	if _, err := os.Stat(envPath); err == nil {
		if err := godotenv.Load(envPath); err != nil {
			log.Printf("警告: 无法加载 .env 文件 (%s): %v", envPath, err)
			return
		}
		log.Printf("[config] .env 文件加载成功 (%s)", envPath)
	} else {
		log.Printf("未找到 .env 文件 (%s)，跳过自动加载", envPath)
	}
}

// Package main 是 chatgpt-proxy 后端的入口。
// 负责 CLI 参数解析、配置加载、应用装配和进程生命周期管理。
package main

import (
	"log"

	"chatgpt-proxy/backend/internal/app"
	"chatgpt-proxy/backend/internal/config"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("配置加载失败: %v", err)
	}

	a := app.New(cfg)
	if err := a.Run(); err != nil {
		log.Fatalf("服务运行失败: %v", err)
	}
}

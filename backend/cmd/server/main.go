// Package main 是 chatgpt-proxy 后端的入口。
// 负责 CLI 参数解析、配置加载、应用装配和进程生命周期管理。
package main

import (
	"log"
	"os"
	"strconv"

	"chatgpt-proxy/backend/internal/app"
	"chatgpt-proxy/backend/internal/config"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("配置加载失败: %v", err)
	}

	// 将实际监听端口写入 .port-server 文件，供前端 Vite 代理发现后端端口
	if err := os.WriteFile(".port-server", []byte(strconv.Itoa(cfg.ServerPort)), 0644); err != nil {
		log.Printf("警告: 无法写入 .port-server 文件: %v", err)
	}

	a, err := app.New(cfg)
	if err != nil {
		log.Fatalf("应用初始化失败: %v", err)
	}
	defer a.Close()

	if err := a.Run(); err != nil {
		log.Fatalf("服务运行失败: %v", err)
	}
}

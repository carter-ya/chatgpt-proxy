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

	a, err := app.New(cfg)
	if err != nil {
		log.Fatalf("应用初始化失败: %v", err)
	}
	defer a.Close()

	log.Println("ChatGPT Proxy 服务启动")
	if err := a.Run(); err != nil {
		log.Fatalf("服务运行失败: %v", err)
	}
}

package main

import (
	"log"

	"chatgpt-proxy/internal"
)

func main() {
	cfg := internal.DefaultConfig()
	r := internal.SetupRouter(cfg)

	log.Println("ChatGPT Proxy 服务启动在 :8080")
	if err := r.Run(":8080"); err != nil {
		log.Fatalf("服务启动失败: %v", err)
	}
}

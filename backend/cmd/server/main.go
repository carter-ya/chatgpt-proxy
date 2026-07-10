// Package main 是 chatgpt-proxy 后端的入口。
// 负责 CLI 参数解析、配置加载、应用装配和进程生命周期管理。
package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"

	"chatgpt-proxy/backend/internal/app"
	"chatgpt-proxy/backend/internal/config"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("配置加载失败: %v", err)
	}

	// 将实际监听端口写入项目根目录 .port-server 文件，供前端 Vite 代理发现后端端口。
	portFile := ".port-server"
	if root, err := findProjectRoot(); err == nil {
		portFile = filepath.Join(root, ".port-server")
	}
	if err := os.WriteFile(portFile, []byte(strconv.Itoa(cfg.ServerPort)), 0644); err != nil {
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

func findProjectRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}

	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir, nil
		}

		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("go.mod not found from %s upward", dir)
		}
		dir = parent
	}
}

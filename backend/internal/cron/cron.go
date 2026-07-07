// Package cron 提供基于 go-co-op/gocron 的定时任务调度。
package cron

import (
	"context"
	"log"
	"time"

	"chatgpt-proxy/backend/internal/session"

	"github.com/go-co-op/gocron/v2"
)

// StartTokenHealthCheck 启动 session token 健康检查定时任务。
// 使用 fluent API 模式 s.Every(...).Do(...) 注册定时任务，
// 定期调用 SessionManager 检查活跃 token 数量。
func StartTokenHealthCheck(mgr *session.Manager, interval time.Duration) (gocron.Scheduler, error) {
	s, err := gocron.NewScheduler()
	if err != nil {
		return nil, err
	}

	checkFn := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		tokens, err := mgr.GetAllActiveTokens(ctx)
		if err != nil {
			log.Printf("[cron] token 健康检查失败: %v", err)
			return
		}
		log.Printf("[cron] token 健康检查完成: 当前活跃 token 数量=%d", len(tokens))
	}

	_, err = s.NewJob(
		gocron.DurationJob(interval),
		gocron.NewTask(checkFn),
		gocron.WithName("token-health-check"),
	)
	if err != nil {
		return nil, err
	}

	s.Start()
	log.Printf("[cron] token 健康检查已启动 (间隔=%s)", interval)
	return s, nil
}

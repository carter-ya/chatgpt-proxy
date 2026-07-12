package config

import (
	"os"
	"testing"
)

// TestSessionTokensLoaded 验证 CHATGPT_PROXY_SESSION_TOKENS 能正确加载到 Config.SessionTokens。
func TestSessionTokensLoaded(t *testing.T) {
	// 设置测试所需的环境变量（模拟 .env 加载后的状态）。
	os.Setenv("CHATGPT_PROXY_DATABASE_URL", "postgres://test:test@localhost:5432/testdb")
	os.Setenv("CHATGPT_PROXY_JWT_SECRET", "test-jwt-secret")
	os.Setenv("CHATGPT_PROXY_ENCRYPTION_KEY", "Z4ss+pkQgRg5xMvj+fkNsB2JD4z7hvQFrORtllXf4Wc=")
	os.Setenv("CHATGPT_PROXY_SESSION_TOKENS", "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0.test-token-payload")
	os.Setenv("CHATGPT_PROXY_JWT_EXPIRATION", "24h")
	defer func() {
		os.Unsetenv("CHATGPT_PROXY_DATABASE_URL")
		os.Unsetenv("CHATGPT_PROXY_JWT_SECRET")
		os.Unsetenv("CHATGPT_PROXY_ENCRYPTION_KEY")
		os.Unsetenv("CHATGPT_PROXY_SESSION_TOKENS")
		os.Unsetenv("CHATGPT_PROXY_JWT_EXPIRATION")
	}()

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() 失败: %v", err)
	}

	if len(cfg.SessionTokens) == 0 {
		t.Fatal("SessionTokens 为空，预期至少 1 个 token")
	}

	t.Logf("SessionTokens 已加载: 共 %d 个 token", len(cfg.SessionTokens))
	for i, token := range cfg.SessionTokens {
		t.Logf("  token[%d] prefix=%.10s... len=%d", i, token[:minInt(10, len(token))], len(token))
	}
}

// TestOtherEnvVarsStillWork 验证其他环境变量在修复后仍正常加载。
func TestOtherEnvVarsStillWork(t *testing.T) {
	os.Setenv("CHATGPT_PROXY_DATABASE_URL", "postgres://user:pass@localhost:5432/mydb")
	os.Setenv("CHATGPT_PROXY_JWT_SECRET", "my-jwt-secret")
	os.Setenv("CHATGPT_PROXY_ENCRYPTION_KEY", "Z4ss+pkQgRg5xMvj+fkNsB2JD4z7hvQFrORtllXf4Wc=")
	os.Setenv("CHATGPT_PROXY_CHATGPT_BASE_URL", "https://chat.openai.com")
	os.Setenv("CHATGPT_PROXY_SESSION_TOKENS", "token1,token2,token3")
	os.Setenv("CHATGPT_PROXY_JWT_EXPIRATION", "24h")
	defer func() {
		os.Unsetenv("CHATGPT_PROXY_DATABASE_URL")
		os.Unsetenv("CHATGPT_PROXY_JWT_SECRET")
		os.Unsetenv("CHATGPT_PROXY_ENCRYPTION_KEY")
		os.Unsetenv("CHATGPT_PROXY_CHATGPT_BASE_URL")
		os.Unsetenv("CHATGPT_PROXY_SESSION_TOKENS")
		os.Unsetenv("CHATGPT_PROXY_JWT_EXPIRATION")
	}()

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() 失败: %v", err)
	}

	if cfg.DatabaseURL != "postgres://user:pass@localhost:5432/mydb" {
		t.Errorf("DatabaseURL = %q, 预期 %q", cfg.DatabaseURL, "postgres://user:pass@localhost:5432/mydb")
	}
	if cfg.JWTSecret != "my-jwt-secret" {
		t.Errorf("JWTSecret = %q, 预期 %q", cfg.JWTSecret, "my-jwt-secret")
	}
	if cfg.ChatGPTBaseURL != "https://chat.openai.com" {
		t.Errorf("ChatGPTBaseURL = %q, 预期 %q", cfg.ChatGPTBaseURL, "https://chat.openai.com")
	}

	// 验证多 token 逗号分割
	if len(cfg.SessionTokens) != 3 {
		t.Errorf("SessionTokens 长度 = %d, 预期 3", len(cfg.SessionTokens))
	} else {
		if cfg.SessionTokens[0] != "token1" {
			t.Errorf("SessionTokens[0] = %q, 预期 %q", cfg.SessionTokens[0], "token1")
		}
		if cfg.SessionTokens[1] != "token2" {
			t.Errorf("SessionTokens[1] = %q, 预期 %q", cfg.SessionTokens[1], "token2")
		}
		if cfg.SessionTokens[2] != "token3" {
			t.Errorf("SessionTokens[2] = %q, 预期 %q", cfg.SessionTokens[2], "token3")
		}
	}

	t.Logf("DatabaseURL: %s", cfg.DatabaseURL)
	t.Logf("JWTSecret: %s", cfg.JWTSecret)
	t.Logf("ChatGPTBaseURL: %s", cfg.ChatGPTBaseURL)
	t.Logf("SessionTokens: %v", cfg.SessionTokens)
}

// TestSessionTokensSingleToken 验证单个 token（无逗号）的加载。
func TestSessionTokensSingleToken(t *testing.T) {
	os.Setenv("CHATGPT_PROXY_DATABASE_URL", "postgres://test:test@localhost:5432/testdb")
	os.Setenv("CHATGPT_PROXY_JWT_SECRET", "test-jwt-secret")
	os.Setenv("CHATGPT_PROXY_ENCRYPTION_KEY", "Z4ss+pkQgRg5xMvj+fkNsB2JD4z7hvQFrORtllXf4Wc=")
	os.Setenv("CHATGPT_PROXY_SESSION_TOKENS", "single-token-without-commas")
	os.Setenv("CHATGPT_PROXY_JWT_EXPIRATION", "24h")
	defer func() {
		os.Unsetenv("CHATGPT_PROXY_DATABASE_URL")
		os.Unsetenv("CHATGPT_PROXY_JWT_SECRET")
		os.Unsetenv("CHATGPT_PROXY_ENCRYPTION_KEY")
		os.Unsetenv("CHATGPT_PROXY_SESSION_TOKENS")
		os.Unsetenv("CHATGPT_PROXY_JWT_EXPIRATION")
	}()

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() 失败: %v", err)
	}

	if len(cfg.SessionTokens) != 1 {
		t.Fatalf("SessionTokens 长度 = %d, 预期 1", len(cfg.SessionTokens))
	}
	if cfg.SessionTokens[0] != "single-token-without-commas" {
		t.Errorf("SessionTokens[0] = %q, 预期 %q", cfg.SessionTokens[0], "single-token-without-commas")
	}
	t.Logf("SessionTokens[0] = %s", cfg.SessionTokens[0])
}

func TestJWTExpirationRequiresDurationUnit(t *testing.T) {
	os.Setenv("CHATGPT_PROXY_DATABASE_URL", "postgres://test:test@localhost:5432/testdb")
	os.Setenv("CHATGPT_PROXY_JWT_SECRET", "test-jwt-secret")
	os.Setenv("CHATGPT_PROXY_ENCRYPTION_KEY", "Z4ss+pkQgRg5xMvj+fkNsB2JD4z7hvQFrORtllXf4Wc=")
	os.Setenv("CHATGPT_PROXY_JWT_EXPIRATION", "24")
	defer func() {
		os.Unsetenv("CHATGPT_PROXY_DATABASE_URL")
		os.Unsetenv("CHATGPT_PROXY_JWT_SECRET")
		os.Unsetenv("CHATGPT_PROXY_ENCRYPTION_KEY")
		os.Unsetenv("CHATGPT_PROXY_JWT_EXPIRATION")
	}()

	if _, err := Load(); err == nil {
		t.Fatal("Load() 成功，预期缺少 duration 单位时失败")
	}
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

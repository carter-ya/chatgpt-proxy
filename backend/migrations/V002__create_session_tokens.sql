-- +migrate Up
CREATE TABLE session_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired')),
    last_used_at TIMESTAMPTZ,
    expired_at TIMESTAMPTZ,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE session_tokens IS 'ChatGPT session token 表，存储用于代理转发的 access token（AES-256-GCM 加密存储）';
COMMENT ON COLUMN session_tokens.id IS 'Token 记录唯一标识';
COMMENT ON COLUMN session_tokens.token IS 'ChatGPT access token 值（AES-256-GCM 加密，base64 编码）';
COMMENT ON COLUMN session_tokens.status IS 'Token 状态：active=活跃、expired=已过期';
COMMENT ON COLUMN session_tokens.last_used_at IS '最后一次使用时间';
COMMENT ON COLUMN session_tokens.expired_at IS '过期检测时间';
COMMENT ON COLUMN session_tokens.version IS '乐观锁版本号';
COMMENT ON COLUMN session_tokens.created_at IS '创建时间';
COMMENT ON COLUMN session_tokens.updated_at IS '最后更新时间';

-- +migrate Down
DROP TABLE IF EXISTS session_tokens;

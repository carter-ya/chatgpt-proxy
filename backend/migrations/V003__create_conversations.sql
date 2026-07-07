-- +migrate Up
CREATE TABLE conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL DEFAULT '',
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE conversations IS '对话表，存储用户与 ChatGPT 的会话记录';
COMMENT ON COLUMN conversations.id IS '对话唯一标识，UUID';
COMMENT ON COLUMN conversations.user_id IS '所属用户 ID，引用 users 表';
COMMENT ON COLUMN conversations.title IS '对话标题';
COMMENT ON COLUMN conversations.version IS '乐观锁版本号';
COMMENT ON COLUMN conversations.created_at IS '创建时间';
COMMENT ON COLUMN conversations.updated_at IS '最后更新时间';

-- +migrate Down
DROP TABLE IF EXISTS conversations;

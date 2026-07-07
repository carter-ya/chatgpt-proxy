-- +migrate Up
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_users_email ON users(email);
COMMENT ON TABLE users IS '用户表，存储注册用户的基本信息';
COMMENT ON COLUMN users.id IS '用户唯一标识，UUID';
COMMENT ON COLUMN users.email IS '用户邮箱，唯一';
COMMENT ON COLUMN users.password_hash IS '密码哈希值，bcrypt 格式';
COMMENT ON COLUMN users.version IS '乐观锁版本号';
COMMENT ON COLUMN users.created_at IS '创建时间';
COMMENT ON COLUMN users.updated_at IS '最后更新时间';

-- +migrate Down
DROP TABLE IF EXISTS users;

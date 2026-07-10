-- +migrate Up
ALTER TABLE conversations
    ALTER COLUMN id TYPE TEXT USING id::text;

COMMENT ON COLUMN conversations.id IS '对话唯一标识，使用 ChatGPT 上游 conversation id 原值';

-- +migrate Down
ALTER TABLE conversations
    ALTER COLUMN id TYPE UUID USING id::uuid;

COMMENT ON COLUMN conversations.id IS '对话唯一标识，UUID';

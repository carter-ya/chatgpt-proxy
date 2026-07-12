-- +migrate Up
ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat';

-- +migrate Down
ALTER TABLE conversations DROP COLUMN kind;

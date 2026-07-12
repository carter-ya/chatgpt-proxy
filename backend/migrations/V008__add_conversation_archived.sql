-- +migrate Up
ALTER TABLE conversations ADD COLUMN archived BOOLEAN NOT NULL DEFAULT FALSE;

-- +migrate Down
ALTER TABLE conversations DROP COLUMN archived;

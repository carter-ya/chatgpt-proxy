-- +migrate Up
ALTER TABLE files ADD COLUMN generation_id TEXT NOT NULL DEFAULT '';

-- +migrate Down
ALTER TABLE files DROP COLUMN generation_id;

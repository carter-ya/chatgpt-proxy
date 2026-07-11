-- +migrate Up
CREATE TABLE files (
    id TEXT PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX files_user_id_idx ON files(user_id);

COMMENT ON TABLE files IS '上游文件与本地用户的归属关系';

-- +migrate Down
DROP TABLE IF EXISTS files;

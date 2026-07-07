-- name: CreateSessionToken :one
INSERT INTO session_tokens (token, status)
VALUES ($1, 'active')
RETURNING id, token, status, last_used_at, expired_at, version, created_at, updated_at;

-- name: GetActiveTokens :many
SELECT id, token, status, last_used_at, expired_at, version, created_at, updated_at
FROM session_tokens
WHERE status = 'active'
ORDER BY created_at ASC;

-- name: UpdateTokenStatus :exec
UPDATE session_tokens
SET status = $2, expired_at = CASE WHEN $2 = 'expired' THEN now() ELSE expired_at END, updated_at = now(), version = version + 1
WHERE id = $1;

-- name: UpdateTokenLastUsed :exec
UPDATE session_tokens
SET last_used_at = now(), updated_at = now()
WHERE id = $1;

-- name: GetTokenByID :one
SELECT id, token, status, last_used_at, expired_at, version, created_at, updated_at
FROM session_tokens
WHERE id = $1;

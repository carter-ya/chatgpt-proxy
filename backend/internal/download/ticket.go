package download

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"
)

const (
	ticketVersion = 1
	ticketPurpose = "download"
)

var (
	ErrInvalidTicket = errors.New("invalid download ticket")
	ErrExpiredTicket = errors.New("download ticket expired")
)

type Resource struct {
	Kind           string `json:"kind"`
	UserID         string `json:"user_id"`
	FileID         string `json:"file_id,omitempty"`
	ConversationID string `json:"conversation_id,omitempty"`
	MessageID      string `json:"message_id,omitempty"`
	SandboxPath    string `json:"sandbox_path,omitempty"`
}

type payload struct {
	Version   int      `json:"version"`
	Purpose   string   `json:"purpose"`
	ExpiresAt int64    `json:"expires_at"`
	Resource  Resource `json:"resource"`
}

type Codec struct {
	aead cipher.AEAD
	ttl  time.Duration
	now  func() time.Time
}

func NewCodec(encodedKey string, ttl time.Duration) (*Codec, error) {
	key, err := base64.StdEncoding.DecodeString(encodedKey)
	if err != nil {
		return nil, fmt.Errorf("decode download ticket key: %w", err)
	}
	if len(key) != 32 {
		return nil, errors.New("download ticket key must decode to 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("create download ticket cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create download ticket AEAD: %w", err)
	}
	return &Codec{aead: aead, ttl: ttl, now: time.Now}, nil
}

func (c *Codec) Issue(resource Resource) (string, time.Time, error) {
	if !validResource(resource) {
		return "", time.Time{}, ErrInvalidTicket
	}
	expiresAt := c.now().Add(c.ttl).UTC()
	plaintext, err := json.Marshal(payload{
		Version:   ticketVersion,
		Purpose:   ticketPurpose,
		ExpiresAt: expiresAt.Unix(),
		Resource:  resource,
	})
	if err != nil {
		return "", time.Time{}, err
	}
	nonce := make([]byte, c.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", time.Time{}, err
	}
	sealed := c.aead.Seal(nonce, nonce, plaintext, []byte(ticketPurpose))
	return base64.RawURLEncoding.EncodeToString(sealed), expiresAt, nil
}

func (c *Codec) Parse(token string) (Resource, error) {
	encoded, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(encoded) < c.aead.NonceSize() {
		return Resource{}, ErrInvalidTicket
	}
	nonce, ciphertext := encoded[:c.aead.NonceSize()], encoded[c.aead.NonceSize():]
	plaintext, err := c.aead.Open(nil, nonce, ciphertext, []byte(ticketPurpose))
	if err != nil {
		return Resource{}, ErrInvalidTicket
	}
	var decoded payload
	if err := json.Unmarshal(plaintext, &decoded); err != nil || decoded.Version != ticketVersion || decoded.Purpose != ticketPurpose || !validResource(decoded.Resource) {
		return Resource{}, ErrInvalidTicket
	}
	if !c.now().Before(time.Unix(decoded.ExpiresAt, 0)) {
		return Resource{}, ErrExpiredTicket
	}
	return decoded.Resource, nil
}

func validResource(resource Resource) bool {
	if resource.UserID == "" {
		return false
	}
	switch resource.Kind {
	case "file":
		return resource.FileID != "" && resource.ConversationID == "" && resource.MessageID == "" && resource.SandboxPath == ""
	case "sandbox":
		return resource.FileID == "" && resource.ConversationID != "" && resource.MessageID != "" && resource.SandboxPath != ""
	default:
		return false
	}
}

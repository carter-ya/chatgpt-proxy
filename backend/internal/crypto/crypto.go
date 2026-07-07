// Package crypto 提供 AES-256-GCM 加密/解密功能，用于保护数据库中存储的敏感 token。
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io"
)

// ErrInvalidKeyLength 表示加密密钥长度不是 32 字节。
var ErrInvalidKeyLength = errors.New("encryption key must be 32 bytes for AES-256")

// Encrypt 使用 AES-256-GCM 加密 plaintext，返回 base64 编码的密文（包含 nonce）。
func Encrypt(plaintext string, key []byte) (string, error) {
	if len(key) != 32 {
		return "", ErrInvalidKeyLength
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	ciphertext := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return base64.StdEncoding.EncodeToString(ciphertext), nil
}

// Decrypt 解密 base64 编码的 AES-256-GCM 密文，返回明文。
func Decrypt(encoded string, key []byte) (string, error) {
	if len(key) != 32 {
		return "", ErrInvalidKeyLength
	}
	ciphertext, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonceSize := gcm.NonceSize()
	if len(ciphertext) < nonceSize {
		return "", errors.New("ciphertext too short")
	}
	nonce, ciphertext := ciphertext[:nonceSize], ciphertext[nonceSize:]
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", err
	}
	return string(plaintext), nil
}

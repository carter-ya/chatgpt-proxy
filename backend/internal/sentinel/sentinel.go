package sentinel

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// SentinelTokens holds the cached sentinel tokens.
type SentinelTokens struct {
	ChatRequirementsToken string `json:"chat_requirements_token"`
	ProofToken            string `json:"proof_token"`
	TurnstileToken        string `json:"turnstile_token,omitempty"`
}

// tokenCacheEntry is the internal cache entry with expiry.
type tokenCacheEntry struct {
	tokens    *SentinelTokens
	expiresAt time.Time
}

// TokenCache caches sentinel tokens with a TTL.
type TokenCache struct {
	mu    sync.RWMutex
	entry *tokenCacheEntry
	ttl   time.Duration
}

// NewTokenCache creates a new TokenCache with the given TTL.
func NewTokenCache(ttl time.Duration) *TokenCache {
	return &TokenCache{ttl: ttl}
}

// GetOrFetch returns cached tokens if valid, otherwise fetches new ones.
func (c *TokenCache) GetOrFetch(ctx context.Context, baseURL string, cfClearance string) (*SentinelTokens, error) {
	c.mu.RLock()
	if c.entry != nil && time.Now().Before(c.entry.expiresAt) {
		tokens := c.entry.tokens
		c.mu.RUnlock()
		return tokens, nil
	}
	c.mu.RUnlock()

	tokens, err := fetchSentinelTokens(ctx, baseURL, cfClearance)
	if err != nil {
		return nil, err
	}

	c.mu.Lock()
	c.entry = &tokenCacheEntry{
		tokens:    tokens,
		expiresAt: time.Now().Add(c.ttl),
	}
	c.mu.Unlock()

	return tokens, nil
}

// prepareRequest is the request body for the prepare step.
type prepareRequest struct {
	Persona string `json:"persona"`
}

// prepareResponse is the response from the prepare step.
type prepareResponse struct {
	ProofOfWork struct {
		Seed       string `json:"seed"`
		Difficulty string `json:"difficulty"`
	} `json:"proofofwork"`
	Turnstile struct {
		Required bool `json:"required"`
	} `json:"turnstile"`
	PrepareToken string `json:"prepare_token"`
}

// finalizeRequest is the request body for the finalize step.
type finalizeRequest struct {
	PrepareToken string          `json:"prepare_token"`
	ProofOfWork  proofOfWorkBody `json:"proofofwork"`
	Turnstile    turnstileBody   `json:"turnstile"`
}

type proofOfWorkBody struct {
	Seed       string `json:"seed"`
	Difficulty string `json:"difficulty"`
	Answer     string `json:"answer"`
}

type turnstileBody struct {
	Token     string `json:"token"`
	Iframe    bool   `json:"iframe"`
	Challenge string `json:"challenge"`
	Response  string `json:"response"`
	Action    string `json:"action"`
	Theme     string `json:"theme"`
}

// finalizeResponse is the response from the finalize step.
type finalizeResponse struct {
	Token string `json:"token"`
}

// fetchSentinelTokens executes the full sentinel flow: prepare → PoW → finalize.
func fetchSentinelTokens(ctx context.Context, baseURL string, cfClearance string) (*SentinelTokens, error) {
	client := &http.Client{Timeout: 30 * time.Second}

	// Step 1: prepare
	prepBody := prepareRequest{Persona: "chatgpt-freeaccount"}
	prepJSON, err := json.Marshal(prepBody)
	if err != nil {
		return nil, fmt.Errorf("sentinel prepare: marshal request: %w", err)
	}

	prepURL := baseURL + "/backend-api/sentinel/chat-requirements/prepare"
	prepReq, err := http.NewRequestWithContext(ctx, http.MethodPost, prepURL, bytes.NewReader(prepJSON))
	if err != nil {
		return nil, fmt.Errorf("sentinel prepare: create request: %w", err)
	}
	prepReq.Header.Set("Content-Type", "application/json")
	if cfClearance != "" {
		prepReq.AddCookie(&http.Cookie{Name: "cf_clearance", Value: cfClearance})
	}

	prepResp, err := client.Do(prepReq)
	if err != nil {
		return nil, fmt.Errorf("sentinel prepare: send request: %w", err)
	}
	defer prepResp.Body.Close()

	if prepResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(prepResp.Body)
		return nil, fmt.Errorf("sentinel prepare: unexpected status %d: %s", prepResp.StatusCode, string(body))
	}

	var prepData prepareResponse
	if err := json.NewDecoder(prepResp.Body).Decode(&prepData); err != nil {
		return nil, fmt.Errorf("sentinel prepare: decode response: %w", err)
	}

	// Step 2: compute PoW answer
	difficulty, err := strconv.Atoi(prepData.ProofOfWork.Difficulty)
	if err != nil {
		return nil, fmt.Errorf("sentinel PoW: invalid difficulty %q: %w", prepData.ProofOfWork.Difficulty, err)
	}
	nonce, answer := solvePoW(prepData.ProofOfWork.Seed, difficulty)

	// Step 3: finalize
	finBody := finalizeRequest{
		PrepareToken: prepData.PrepareToken,
		ProofOfWork: proofOfWorkBody{
			Seed:       prepData.ProofOfWork.Seed,
			Difficulty: prepData.ProofOfWork.Difficulty,
			Answer:     answer,
		},
		Turnstile: turnstileBody{
			Token:     "cftoken",
			Iframe:    false,
			Challenge: "",
			Response:  "AAAA",
			Action:    "response",
			Theme:     "dark",
		},
	}
	finJSON, err := json.Marshal(finBody)
	if err != nil {
		return nil, fmt.Errorf("sentinel finalize: marshal request: %w", err)
	}

	finURL := baseURL + "/backend-api/sentinel/chat-requirements/finalize"
	finReq, err := http.NewRequestWithContext(ctx, http.MethodPost, finURL, bytes.NewReader(finJSON))
	if err != nil {
		return nil, fmt.Errorf("sentinel finalize: create request: %w", err)
	}
	finReq.Header.Set("Content-Type", "application/json")
	if cfClearance != "" {
		finReq.AddCookie(&http.Cookie{Name: "cf_clearance", Value: cfClearance})
	}

	finResp, err := client.Do(finReq)
	if err != nil {
		return nil, fmt.Errorf("sentinel finalize: send request: %w", err)
	}
	defer finResp.Body.Close()

	if finResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(finResp.Body)
		return nil, fmt.Errorf("sentinel finalize: unexpected status %d: %s", finResp.StatusCode, string(body))
	}

	var finData finalizeResponse
	if err := json.NewDecoder(finResp.Body).Decode(&finData); err != nil {
		return nil, fmt.Errorf("sentinel finalize: decode response: %w", err)
	}

	_ = nonce // nonce is embedded in answer (hex-encoded seed+nonce hash)
	return &SentinelTokens{
		ChatRequirementsToken: finData.Token,
		ProofToken:            answer,
		TurnstileToken:        "",
	}, nil
}

// solvePoW finds a nonce such that SHA256(seed+nonce) has the first difficulty bits set to 0.
// It returns the nonce and the hex-encoded hash as the answer.
func solvePoW(seed string, difficulty int) (int64, string) {
	seedBytes := []byte(seed)
	var nonce int64

	for nonce = 0; nonce < math.MaxInt64; nonce++ {
		nonceStr := strconv.FormatInt(nonce, 10)
		input := append(seedBytes, []byte(nonceStr)...)
		hash := sha256.Sum256(input)

		if checkDifficulty(hash[:], difficulty) {
			return nonce, hex.EncodeToString(hash[:])
		}
	}

	// Fallback — should not happen for reasonable difficulty.
	return 0, ""
}

// checkDifficulty verifies that the first difficulty bits of hash are all 0.
func checkDifficulty(hash []byte, difficulty int) bool {
	fullBytes := difficulty / 8
	remBits := difficulty % 8

	for i := 0; i < fullBytes; i++ {
		if hash[i] != 0 {
			return false
		}
	}

	if remBits > 0 && fullBytes < len(hash) {
		// Check the remaining bits: shift right by (8-remBits), must be 0.
		if hash[fullBytes]>>(8-remBits) != 0 {
			return false
		}
	}

	return true
}

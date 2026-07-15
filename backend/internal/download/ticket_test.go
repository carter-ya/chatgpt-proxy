package download

import (
	"encoding/base64"
	"errors"
	"testing"
	"time"
)

func testCodec(t *testing.T) *Codec {
	t.Helper()
	codec, err := NewCodec(base64.StdEncoding.EncodeToString(make([]byte, 32)), 10*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	return codec
}

func TestTicketRoundTripAndExpiry(t *testing.T) {
	codec := testCodec(t)
	now := time.Unix(1_800_000_000, 0)
	codec.now = func() time.Time { return now }
	resource := Resource{Kind: "sandbox", UserID: "user", ConversationID: "conversation", MessageID: "message", SandboxPath: "/mnt/data/report.pptx"}
	token, expiresAt, err := codec.Issue(resource)
	if err != nil {
		t.Fatal(err)
	}
	if expiresAt.Sub(now) != 10*time.Minute {
		t.Fatalf("ticket ttl = %s", expiresAt.Sub(now))
	}
	decoded, err := codec.Parse(token)
	if err != nil || decoded != resource {
		t.Fatalf("decoded = %#v, err = %v", decoded, err)
	}
	codec.now = func() time.Time { return expiresAt }
	if _, err := codec.Parse(token); !errors.Is(err, ErrExpiredTicket) {
		t.Fatalf("expired ticket error = %v", err)
	}
}

func TestTicketRejectsTamperingAndInvalidResources(t *testing.T) {
	codec := testCodec(t)
	if _, _, err := codec.Issue(Resource{Kind: "file", UserID: "user"}); !errors.Is(err, ErrInvalidTicket) {
		t.Fatalf("invalid resource error = %v", err)
	}
	token, _, err := codec.Issue(Resource{Kind: "file", UserID: "user", FileID: "file"})
	if err != nil {
		t.Fatal(err)
	}
	replacement := "A"
	if token[len(token)-1:] == replacement {
		replacement = "B"
	}
	tampered := token[:len(token)-1] + replacement
	if _, err := codec.Parse(tampered); !errors.Is(err, ErrInvalidTicket) {
		t.Fatalf("tampered ticket error = %v", err)
	}
}

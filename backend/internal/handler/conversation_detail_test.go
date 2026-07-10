package handler

import (
	"encoding/json"
	"testing"
)

func TestNormalizeConversationDetailPreservesAttachmentsAndGeneratedImages(t *testing.T) {
	raw := map[string]interface{}{
		"title":        "file test",
		"current_node": "tool",
		"mapping": map[string]interface{}{
			"user": map[string]interface{}{
				"parent": nil,
				"message": map[string]interface{}{
					"author":  map[string]interface{}{"role": "user"},
					"content": map[string]interface{}{"content_type": "text", "parts": []interface{}{"read it"}},
					"metadata": map[string]interface{}{
						"attachments": []interface{}{map[string]interface{}{
							"id": "file_input", "name": "input.txt", "mimeType": "text/plain", "size": float64(12),
						}},
					},
				},
			},
			"tool": map[string]interface{}{
				"parent": "user",
				"message": map[string]interface{}{
					"author": map[string]interface{}{"role": "tool"},
					"content": map[string]interface{}{
						"content_type": "multimodal_text",
						"parts": []interface{}{map[string]interface{}{
							"content_type":  "image_asset_pointer",
							"asset_pointer": "sediment://file_output",
							"mime_type":     "image/png",
							"size_bytes":    float64(99),
							"width":         float64(20),
							"height":        float64(10),
							"metadata":      map[string]interface{}{"generation": map[string]interface{}{"gen_id": "gen"}},
						}},
					},
					"metadata": map[string]interface{}{},
				},
			},
		},
	}
	body, err := json.Marshal(raw)
	if err != nil {
		t.Fatal(err)
	}

	result, err := normalizeConversationDetail(body, "conversation-id")
	if err != nil {
		t.Fatalf("normalizeConversationDetail() error = %v", err)
	}
	messages, ok := result["messages"].([]apiMessage)
	if !ok || len(messages) != 2 {
		t.Fatalf("messages = %#v, want two normalized messages", result["messages"])
	}
	if got := messages[0].Attachments[0].DownloadURL; got != "/api/files/file_input/download" {
		t.Fatalf("attachment download URL = %q", got)
	}
	if got := messages[1].Images[0].FileID; got != "file_output" {
		t.Fatalf("generated image ID = %q", got)
	}
}

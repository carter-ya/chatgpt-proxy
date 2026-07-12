package handler

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
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

func TestNormalizeConversationDetailPreservesReasoningSourcesAndCandidateIDs(t *testing.T) {
	raw := map[string]interface{}{
		"title": "rich response", "create_time": float64(1_720_000_000), "update_time": float64(1_720_000_010), "current_node": "answer",
		"mapping": map[string]interface{}{
			"user":    map[string]interface{}{"parent": nil, "message": map[string]interface{}{"id": "user", "author": map[string]interface{}{"role": "user"}, "content": map[string]interface{}{"content_type": "text", "parts": []interface{}{"question"}}, "metadata": map[string]interface{}{}}},
			"thought": map[string]interface{}{"parent": "user", "message": map[string]interface{}{"id": "thought", "author": map[string]interface{}{"role": "assistant"}, "content": map[string]interface{}{"content_type": "reasoning_recap", "parts": []interface{}{"核实多个来源"}}, "metadata": map[string]interface{}{}}},
			"group": map[string]interface{}{"parent": "thought", "message": map[string]interface{}{"id": "group-message", "author": map[string]interface{}{"role": "tool"}, "content": map[string]interface{}{"content_type": "multimodal_text", "parts": []interface{}{
				map[string]interface{}{"content_type": "image_asset_pointer", "asset_pointer": "sediment://file-a", "metadata": map[string]interface{}{"generation": map[string]interface{}{"gen_id": "gen-a"}}},
				map[string]interface{}{"content_type": "image_asset_pointer", "asset_pointer": "sediment://file-b", "metadata": map[string]interface{}{"generation": map[string]interface{}{"gen_id": "gen-b"}}},
			}}, "metadata": map[string]interface{}{}}},
			"candidate": map[string]interface{}{"parent": "group", "message": map[string]interface{}{"id": "candidate-a", "author": map[string]interface{}{"role": "tool"}, "content": map[string]interface{}{"content_type": "multimodal_text", "parts": []interface{}{map[string]interface{}{"content_type": "image_asset_pointer", "asset_pointer": "sediment://file-a", "metadata": map[string]interface{}{"generation": map[string]interface{}{"gen_id": "gen-a"}}}}}, "metadata": map[string]interface{}{}}},
			"answer":    map[string]interface{}{"parent": "candidate", "message": map[string]interface{}{"id": "answer", "author": map[string]interface{}{"role": "assistant"}, "content": map[string]interface{}{"content_type": "text", "parts": []interface{}{"价格 citeturn0search0"}}, "metadata": map[string]interface{}{"search_result_groups": []interface{}{map[string]interface{}{"domain": "example.com", "entries": []interface{}{map[string]interface{}{"url": "https://example.com/a", "title": "Example"}}}}}}},
		},
	}
	body, _ := json.Marshal(raw)
	result, err := normalizeConversationDetail(body, "conversation-id")
	if err != nil {
		t.Fatal(err)
	}
	messages := result["messages"].([]apiMessage)
	if result["conversation"].(gin.H)["created_at"] == "" {
		t.Fatal("timestamp was not normalized")
	}
	var imageMessage, answer apiMessage
	for _, message := range messages {
		if len(message.Images) > 0 {
			imageMessage = message
		}
		if message.ID == "answer" {
			answer = message
		}
	}
	if len(imageMessage.Images) != 2 {
		t.Fatalf("images = %#v", imageMessage.Images)
	}
	if imageMessage.Reasoning != "核实多个来源" {
		t.Fatalf("reasoning = %q", imageMessage.Reasoning)
	}
	if imageMessage.Images[0].CandidateGroupMessageID != "group-message" || imageMessage.Images[0].MessageID != "candidate-a" {
		t.Fatalf("candidate ids = %#v", imageMessage.Images[0])
	}
	if strings.Contains(answer.Content, "cite") || !strings.Contains(answer.Content, "[来源]") {
		t.Fatalf("citation was not sanitized: %q", answer.Content)
	}
	if answer.Reasoning != "" {
		t.Fatalf("reasoning should attach to the image response, got %q", answer.Reasoning)
	}
	if len(answer.Sources) != 1 || answer.Sources[0].URL != "https://example.com/a" {
		t.Fatalf("sources = %#v", answer.Sources)
	}
}

func TestNormalizeConversationDetailExtractsImageGroups(t *testing.T) {
	marker := "image_group{\"aspect_ratio\":\"16:9\",\"query\":[\"water cycle\"]}"
	raw := map[string]interface{}{
		"title": "water", "current_node": "answer",
		"mapping": map[string]interface{}{
			"answer": map[string]interface{}{
				"parent": nil,
				"message": map[string]interface{}{
					"id":      "answer",
					"author":  map[string]interface{}{"role": "assistant"},
					"content": map[string]interface{}{"content_type": "text", "parts": []interface{}{marker + "\nExplanation"}},
					"metadata": map[string]interface{}{"content_references": []interface{}{
						map[string]interface{}{
							"type": "image_group", "matched_text": marker, "aspect_ratio": "16:9",
							"images": []interface{}{
								map[string]interface{}{"image_result": map[string]interface{}{
									"thumbnail_url": "https://images.openai.com/thumb", "content_url": "https://images.openai.com/full",
									"url": "https://example.com/source", "title": "Water cycle", "thumbnail_size": map[string]interface{}{"width": float64(640), "height": float64(360)},
								}},
							},
						},
					}},
				},
			},
		},
	}
	body, _ := json.Marshal(raw)
	result, err := normalizeConversationDetail(body, "conversation-id")
	if err != nil {
		t.Fatal(err)
	}
	messages := result["messages"].([]apiMessage)
	if len(messages) != 1 || len(messages[0].ImageGroups) != 1 {
		t.Fatalf("image groups = %#v", messages)
	}
	group := messages[0].ImageGroups[0]
	if group.MatchedText != marker || group.AspectRatio != "16:9" || len(group.Images) != 1 {
		t.Fatalf("image group = %#v", group)
	}
	if group.Images[0].ThumbnailURL != "https://images.openai.com/thumb" || group.Images[0].Width != 640 {
		t.Fatalf("image = %#v", group.Images[0])
	}
}

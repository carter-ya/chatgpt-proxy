package handler

import (
	"context"
	"encoding/json"
	"testing"
)

func TestNormalizeModelCatalogKeepsEveryEnabledVersion(t *testing.T) {
	body := []byte(`{
		"title":"ChatGPT Pro",
		"default_model_slug":"gpt-5.6-sol-wm",
		"model_picker_version":2,
		"models":[
			{"slug":"gpt-5.6-sol-wm","title":"GPT-5.6 Sol","default_thinking_effort":"min","thinking_efforts":[{"thinking_effort":"min","short_label":"快速","description":"快速回复"},{"thinking_effort":"standard","short_label":"标准","description":"平衡速度"}]},
			{"slug":"gpt-5.6-terra-wm","title":"GPT-5.6 Terra","default_thinking_effort":"standard","thinking_efforts":[{"thinking_effort":"standard","short_label":"标准","description":"平衡速度"}]}
		],
		"versions":[
			{"id":"5.6 Sol","display_text":"最新 • 5.6 Sol","display_text_full":"最新 • 5.6 Sol","display_text_for_intelligence":"GPT-5.6 Sol","short_display_text_for_intelligence":"5.6 Sol","slugs":["gpt-5.6-sol-wm"],"enabled":true,"intelligence_presets":[
				{"title":"轻度","selected_display_title":"5.6 Sol 轻度","model_slug":"gpt-5.6-sol-wm","thinking_effort":"min","lane":"thinking_plus_plus","preset_type":"available"},
				{"title":"中","selected_display_title":"5.6 Sol 中","model_slug":"gpt-5.6-sol-wm","thinking_effort":"standard","lane":"thinking_plus_plus","preset_type":"available"}
			]},
			{"id":"5.6 Terra","display_text":"5.6 Terra","display_text_full":"传统模型 • 5.6 Terra","display_text_for_intelligence":"GPT-5.6 Terra","short_display_text_for_intelligence":"5.6 Terra","slugs":["gpt-5.6-terra-wm"],"enabled":true,"intelligence_presets":[
				{"title":"中","selected_display_title":"5.6 Terra 中","model_slug":"gpt-5.6-terra-wm","thinking_effort":"standard","lane":"thinking_plus_plus","preset_type":"available"}
			]}
		]
	}`)

	catalog, err := normalizeModelCatalog(body)
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog.Versions) != 2 || len(catalog.Options) != 3 {
		t.Fatalf("versions/options = %d/%d, want 2/3", len(catalog.Versions), len(catalog.Options))
	}
	if catalog.Versions[0].Badge != "最新" || catalog.Versions[1].Badge != "传统模型" {
		t.Fatalf("badges = %q/%q", catalog.Versions[0].Badge, catalog.Versions[1].Badge)
	}
	if catalog.Versions[0].DefaultThinkingEffort != "min" {
		t.Fatalf("default effort = %q", catalog.Versions[0].DefaultThinkingEffort)
	}
	if catalog.Versions[0].Options[0].Description != "快速回复" {
		t.Fatalf("effort description = %q", catalog.Versions[0].Options[0].Description)
	}
}

func TestWorkModeConversationForwardsThinkingEffort(t *testing.T) {
	client := &captureProxyClient{}
	handler := NewProxyHandler(client, nil, nil)
	resp, _, err := handler.doConversationWithRetry(context.Background(), conversationRequest{
		Message:        "分析问题",
		Model:          "gpt-5.6-sol-wm",
		ThinkingEffort: "ultra",
	})
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	var forwarded map[string]interface{}
	if err := json.Unmarshal(client.body, &forwarded); err != nil {
		t.Fatal(err)
	}
	if forwarded["thinking_effort"] != "ultra" {
		t.Fatalf("thinking_effort = %#v, want ultra", forwarded["thinking_effort"])
	}
}

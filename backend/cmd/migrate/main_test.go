package main

import "testing"

func TestParseCommand(t *testing.T) {
	tests := []struct {
		name      string
		args      []string
		action    string
		version   string
		all       bool
		wantError bool
	}{
		{name: "up", args: []string{"up"}, action: "up"},
		{name: "down to version", args: []string{"down", "007"}, action: "down", version: "007"},
		{name: "down all", args: []string{"down", "--all"}, action: "down", all: true},
		{name: "down requires target", args: []string{"down"}, wantError: true},
		{name: "reject both targets", args: []string{"down", "007", "--all"}, wantError: true},
		{name: "reject unknown command", args: []string{"status"}, wantError: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseCommand(tt.args)
			if tt.wantError {
				if err == nil {
					t.Fatal("expected an error")
				}
				return
			}
			if err != nil {
				t.Fatalf("parseCommand() error = %v", err)
			}
			if got.action != tt.action || got.toVersion != tt.version || got.all != tt.all {
				t.Fatalf("parseCommand() = %#v", got)
			}
		})
	}
}

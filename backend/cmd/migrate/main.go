// Command migrate applies or rolls back the project's embedded SQL migrations.
package main

import (
	"errors"
	"fmt"
	"log"
	"os"
	"strings"

	"chatgpt-proxy/backend/internal/config"
	"chatgpt-proxy/backend/internal/db"
)

type migrationCommand struct {
	action    string
	toVersion string
	all       bool
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		log.Fatal(err)
	}
}

func run(args []string) error {
	command, err := parseCommand(args)
	if err != nil {
		return err
	}

	config.LoadEnvFile()
	databaseURL := strings.TrimSpace(os.Getenv("CHATGPT_PROXY_DATABASE_URL"))
	if databaseURL == "" {
		return errors.New("CHATGPT_PROXY_DATABASE_URL is required")
	}

	switch command.action {
	case "up":
		if err := db.RunMigrations(databaseURL); err != nil {
			return err
		}
		fmt.Println("migrations applied")
	case "down":
		if err := db.RollbackMigrations(databaseURL, command.toVersion, command.all); err != nil {
			return err
		}
		if command.all {
			fmt.Println("all migrations rolled back")
		} else {
			fmt.Printf("migrations newer than version %s rolled back\n", command.toVersion)
		}
	}

	return nil
}

func parseCommand(args []string) (migrationCommand, error) {
	const usage = "usage: migrate up | migrate down <to-version> | migrate down --all"

	if len(args) == 1 && args[0] == "up" {
		return migrationCommand{action: "up"}, nil
	}
	if len(args) == 2 && args[0] == "down" {
		if args[1] == "--all" {
			return migrationCommand{action: "down", all: true}, nil
		}
		if strings.HasPrefix(args[1], "-") || strings.TrimSpace(args[1]) == "" {
			return migrationCommand{}, errors.New(usage)
		}
		return migrationCommand{action: "down", toVersion: args[1]}, nil
	}

	return migrationCommand{}, errors.New(usage)
}

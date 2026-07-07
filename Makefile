.PHONY: build run generate test vet migrate-up migrate-down

build:
	go build -o bin/server ./backend/cmd/server

run:
	go run ./backend/cmd/server

generate:
	go generate ./...

test:
	go test ./...

vet:
	go vet ./...

migrate-up:
	@echo "migrate-up 将在后续 worker 中实现"

migrate-down:
	@echo "migrate-down 将在后续 worker 中实现"

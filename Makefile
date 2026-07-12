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
	go run ./backend/cmd/migrate up

migrate-down:
	go run ./backend/cmd/migrate down $(VERSION) $(if $(filter true,$(ALL)),--all,)

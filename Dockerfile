# 构建阶段
FROM golang:1.25 AS builder

WORKDIR /build

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 go build -o server ./backend/cmd/server

# 运行阶段
FROM alpine:latest

WORKDIR /app

COPY --from=builder /build/server .

EXPOSE ${PORT}

CMD ["./server"]

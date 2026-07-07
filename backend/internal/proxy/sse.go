package proxy

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// ErrSSEAbnormalTermination is returned when the SSE stream terminates
// abnormally (EOF without receiving the data: [DONE] marker).
var ErrSSEAbnormalTermination = errors.New("SSE 流非正常终止：未收到 data: [DONE] 即到达 EOF")

// StreamSSE transparently streams SSE (Server-Sent Events) from an upstream HTTP response
// to the gin client. It flushes each chunk immediately for real-time delivery.
func StreamSSE(c *gin.Context, resp *http.Response) error {
	defer resp.Body.Close()

	// Set SSE response headers.
	c.Writer.Header().Set("Content-Type", "text/event-stream")
	c.Writer.Header().Set("Cache-Control", "no-cache")
	c.Writer.Header().Set("Connection", "keep-alive")
	c.Writer.Header().Set("X-Accel-Buffering", "no")
	c.Writer.WriteHeader(http.StatusOK)

	flusher, ok := c.Writer.(http.Flusher)
	if !ok {
		return errors.New("gin writer 不支持 http.Flusher，无法启用 SSE 流式传输")
	}

	scanner := bufio.NewScanner(resp.Body)
	// Increase buffer size for large SSE chunks.
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	// Per-chunk read timeout: 5 minutes without data triggers timeout.
	readTimeout := 5 * time.Minute

	for {
		// Set a per-line read deadline.
		done := make(chan bool, 1)
		var line string
		var scanErr error

		go func() {
			if scanner.Scan() {
				line = scanner.Text()
			}
			scanErr = scanner.Err()
			done <- true
		}()

		select {
		case <-done:
			if scanErr != nil {
				if errors.Is(scanErr, io.EOF) {
					return ErrSSEAbnormalTermination
				}
				// Send SSE error event to client before closing.
				fmt.Fprintf(c.Writer, "event: error\ndata: SSE 流读取中断\n\n")
				flusher.Flush()
				log.Printf("[SSE] 上游流读取中断 (非 EOF): %v", scanErr)
				return fmt.Errorf("SSE 流读取错误: %w", scanErr)
			}

			// Write the line to the client.
			if _, err := fmt.Fprintf(c.Writer, "%s\n", line); err != nil {
				return fmt.Errorf("SSE 写入客户端失败: %w", err)
			}
			flusher.Flush()

			// Check for [DONE] marker.
			if line == "data: [DONE]" {
				return nil
			}

		case <-time.After(readTimeout):
			// Send error event to client and terminate.
			fmt.Fprintf(c.Writer, "event: error\ndata: SSE 流读取超时\n\n")
			flusher.Flush()
			return errors.New("SSE 流读取超时（5 分钟内无数据）")

		case <-c.Request.Context().Done():
			// Client disconnected.
			return nil
		}
	}
}

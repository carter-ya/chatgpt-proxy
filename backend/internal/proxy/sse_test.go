package proxy

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestStreamSSEObserverFailureIsReportedWithoutForwardingResource(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodGet, "/stream", nil)
	response := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
		Body:       io.NopCloser(strings.NewReader("data: {\"conversation_id\":\"foreign\"}\n\ndata: [DONE]\n\n")),
	}
	err := StreamSSEWithObserver(ctx, response, func(line string) error {
		if strings.Contains(line, "foreign") {
			return errors.New("ownership conflict")
		}
		return nil
	})
	if err == nil {
		t.Fatal("expected observer error")
	}
	body := recorder.Body.String()
	if !strings.Contains(body, "event: error") {
		t.Fatalf("missing SSE error event: %q", body)
	}
	if strings.Contains(body, "foreign") {
		t.Fatalf("rejected resource was forwarded: %q", body)
	}
}

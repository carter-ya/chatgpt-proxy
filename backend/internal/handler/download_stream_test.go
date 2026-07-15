package handler

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"chatgpt-proxy/backend/internal/db"
	"chatgpt-proxy/backend/internal/download"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)

type streamingDownloadClient struct {
	reader        io.ReadCloser
	streamHeaders http.Header
	streamCalls   int
}

func (client *streamingDownloadClient) BuildRequest(ctx context.Context, method, path, _ string, body io.Reader, _ string) (*http.Request, error) {
	return http.NewRequestWithContext(ctx, method, "http://upstream"+path, body)
}

func (client *streamingDownloadClient) Do(request *http.Request) (*http.Response, error) {
	metadata := `{"download_url":"https://storage.example/file","file_name":"large.bin","mime_type":"application/octet-stream","file_size_bytes":10}`
	return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(metadata)), Request: request}, nil
}

func (client *streamingDownloadClient) OpenStream(_ context.Context, _ string, _ string, _ string, headers http.Header) (*http.Response, error) {
	client.streamCalls++
	client.streamHeaders = headers.Clone()
	return &http.Response{
		StatusCode:    http.StatusPartialContent,
		Header:        http.Header{"Content-Type": []string{"application/octet-stream"}, "Content-Length": []string{"5"}, "Content-Range": []string{"bytes 0-4/10"}, "Accept-Ranges": []string{"bytes"}},
		Body:          client.reader,
		ContentLength: 5,
	}, nil
}

func TestDownloadTicketRevalidatesOwnership(t *testing.T) {
	codec, err := download.NewCodec(base64.StdEncoding.EncodeToString(make([]byte, 32)), 10*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	ticket, _, err := codec.Issue(download.Resource{Kind: "file", FileID: "file-a", UserID: "former-owner"})
	if err != nil {
		t.Fatal(err)
	}
	client := &streamingDownloadClient{}
	handler := NewProxyHandler(client, nil, ownedFileDB("current-owner"), codec)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Params = gin.Params{{Key: "ticket", Value: ticket}}
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/downloads/"+ticket, nil)

	handler.DownloadWithTicket(ctx)

	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d: %s", recorder.Code, recorder.Body.String())
	}
	if client.streamCalls != 0 {
		t.Fatalf("stream opened %d times after ownership changed", client.streamCalls)
	}
}

func TestDownloadTicketRejectsInvalidToken(t *testing.T) {
	codec, err := download.NewCodec(base64.StdEncoding.EncodeToString(make([]byte, 32)), 10*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	handler := NewProxyHandler(&streamingDownloadClient{}, nil, ownedFileDB("user-a"), codec)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Params = gin.Params{{Key: "ticket", Value: "not-a-ticket"}}
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/downloads/not-a-ticket", nil)

	handler.DownloadWithTicket(ctx)

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d: %s", recorder.Code, recorder.Body.String())
	}
}

func ownedFileDB(owner string) *db.Queries {
	return db.New(&mockDBTX{queryRowFn: func(_ context.Context, _ string, args ...interface{}) pgx.Row {
		return &mockRow{scanFn: func(dest ...interface{}) error {
			*(dest[0].(*string)) = args[0].(string)
			*(dest[1].(*string)) = owner
			*(dest[2].(*string)) = "large.bin"
			return nil
		}}
	}})
}

func TestDownloadFileStreamsBeforeUpstreamCompletesAndPreservesRange(t *testing.T) {
	gin.SetMode(gin.TestMode)
	pipeReader, pipeWriter := io.Pipe()
	client := &streamingDownloadClient{reader: pipeReader}
	handler := NewProxyHandler(client, nil, ownedFileDB("user-a"))
	router := gin.New()
	router.GET("/api/files/:id/download", func(c *gin.Context) {
		c.Set("user_id", "user-a")
		handler.DownloadFile(c)
	})
	server := httptest.NewServer(router)
	defer server.Close()

	request, _ := http.NewRequest(http.MethodGet, server.URL+"/api/files/file-a/download", nil)
	request.Header.Set("Range", "bytes=0-4")
	responseCh := make(chan *http.Response, 1)
	errorCh := make(chan error, 1)
	go func() {
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			errorCh <- err
			return
		}
		responseCh <- response
	}()

	var response *http.Response
	select {
	case response = <-responseCh:
	case err := <-errorCh:
		t.Fatal(err)
	case <-time.After(time.Second):
		t.Fatal("response headers were buffered until the upstream body completed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusPartialContent || response.Header.Get("Content-Range") != "bytes 0-4/10" {
		t.Fatalf("status = %d, headers = %#v", response.StatusCode, response.Header)
	}
	if client.streamHeaders.Get("Range") != "bytes=0-4" {
		t.Fatalf("forwarded range = %q", client.streamHeaders.Get("Range"))
	}

	writeDone := make(chan error, 1)
	go func() {
		_, err := pipeWriter.Write([]byte("hello"))
		_ = pipeWriter.Close()
		writeDone <- err
	}()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if err := <-writeDone; err != nil {
		t.Fatal(err)
	}
	if string(body) != "hello" {
		t.Fatalf("body = %q", body)
	}
}

func TestCreateDownloadTicketBindsOwnedResource(t *testing.T) {
	codec, err := download.NewCodec(base64.StdEncoding.EncodeToString(make([]byte, 32)), 10*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	handler := NewProxyHandler(&streamingDownloadClient{}, nil, ownedFileDB("user-a"), codec)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Set("user_id", "user-a")
	ctx.Request = httptest.NewRequest(http.MethodPost, "/api/download-tickets", bytes.NewBufferString(`{"kind":"file","file_id":"file-a"}`))
	ctx.Request.Header.Set("Content-Type", "application/json")
	handler.CreateDownloadTicket(ctx)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		DownloadURL string `json:"download_url"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	token := strings.TrimPrefix(response.DownloadURL, "downloads/")
	resource, err := codec.Parse(token)
	if err != nil {
		t.Fatal(err)
	}
	if resource.Kind != "file" || resource.FileID != "file-a" || resource.UserID != "user-a" {
		t.Fatalf("ticket resource = %#v", resource)
	}
}

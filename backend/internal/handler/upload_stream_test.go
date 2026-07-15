package handler

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"strconv"
	"strings"
	"testing"
	"time"

	"chatgpt-proxy/backend/internal/db"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type uploadControlClient struct {
	uploadURL    string
	createCalls  int
	confirmCalls int
	createdSize  int64
}

func (client *uploadControlClient) BuildRequest(ctx context.Context, method, path, _ string, body io.Reader, contentType string) (*http.Request, error) {
	request, err := http.NewRequestWithContext(ctx, method, "http://control.local"+path, body)
	if err == nil {
		request.Header.Set("Content-Type", contentType)
	}
	return request, err
}

func (client *uploadControlClient) Do(request *http.Request) (*http.Response, error) {
	responseBody := `{}`
	switch {
	case request.URL.Path == "/backend-api/files":
		client.createCalls++
		body, _ := io.ReadAll(request.Body)
		var payload struct {
			FileSize int64 `json:"file_size"`
		}
		_ = json.Unmarshal(body, &payload)
		client.createdSize = payload.FileSize
		responseBody = `{"file_id":"file-stream","upload_url":` + strconv.Quote(client.uploadURL) + `}`
	case strings.HasSuffix(request.URL.Path, "/uploaded"):
		client.confirmCalls++
	}
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(responseBody)),
		Request:    request,
	}, nil
}

func (client *uploadControlClient) OpenStream(context.Context, string, string, string, http.Header) (*http.Response, error) {
	panic("unexpected stream request")
}

func uploadTestQueries(bindCalls *int) *db.Queries {
	return db.New(&mockDBTX{
		execFn: func(context.Context, string, ...interface{}) (pgconn.CommandTag, error) {
			(*bindCalls)++
			return pgconn.CommandTag{}, nil
		},
		queryRowFn: func(context.Context, string, ...interface{}) pgx.Row {
			return &mockRow{scanFn: func(dest ...interface{}) error {
				*(dest[0].(*string)) = "file-stream"
				*(dest[1].(*string)) = "user-a"
				*(dest[2].(*string)) = "upload.bin"
				*(dest[3].(*string)) = ""
				return nil
			}}
		},
	})
}

func uploadTestServer(client *uploadControlClient, bindCalls *int) *httptest.Server {
	gin.SetMode(gin.TestMode)
	handler := NewProxyHandler(client, nil, uploadTestQueries(bindCalls))
	router := gin.New()
	router.POST("/api/files", func(c *gin.Context) {
		c.Set("user_id", "user-a")
		handler.UploadFile(c)
	})
	return httptest.NewServer(router)
}

func multipartUploadBody(t *testing.T, fileName, contentType string, content []byte) (*bytes.Buffer, string) {
	t.Helper()
	body := new(bytes.Buffer)
	writer := multipart.NewWriter(body)
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", `form-data; name="file"; filename="`+fileName+`"`)
	header.Set("Content-Type", contentType)
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return body, writer.FormDataContentType()
}

func TestUploadFileStreamsBeforeClientFinishes(t *testing.T) {
	payload := bytes.Repeat([]byte("stream-data-"), 256)
	upstreamStarted := make(chan struct{})
	var upstreamBody []byte
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		first := make([]byte, 1)
		if _, err := io.ReadFull(request.Body, first); err != nil {
			t.Errorf("read first upstream byte: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		close(upstreamStarted)
		rest, _ := io.ReadAll(request.Body)
		upstreamBody = append(first, rest...)
		w.WriteHeader(http.StatusCreated)
	}))
	defer upstream.Close()

	control := &uploadControlClient{uploadURL: upstream.URL}
	bindCalls := 0
	server := uploadTestServer(control, &bindCalls)
	defer server.Close()

	pipeReader, pipeWriter := io.Pipe()
	multipartWriter := multipart.NewWriter(pipeWriter)
	contentType := multipartWriter.FormDataContentType()
	releaseClient := make(chan struct{})
	writerDone := make(chan error, 1)
	go func() {
		part, err := multipartWriter.CreateFormFile("file", "large.txt")
		if err == nil {
			_, err = part.Write(payload[:1024])
		}
		if err == nil {
			<-releaseClient
			_, err = part.Write(payload[1024:])
		}
		if closeErr := multipartWriter.Close(); err == nil {
			err = closeErr
		}
		_ = pipeWriter.CloseWithError(err)
		writerDone <- err
	}()

	request, _ := http.NewRequest(http.MethodPost, server.URL+"/api/files?size_bytes="+strconv.Itoa(len(payload)), pipeReader)
	request.Header.Set("Content-Type", contentType)
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

	select {
	case <-upstreamStarted:
	case err := <-errorCh:
		t.Fatal(err)
	case <-time.After(2 * time.Second):
		t.Fatal("upstream did not receive bytes before the client completed the multipart body")
	}
	close(releaseClient)
	if err := <-writerDone; err != nil {
		t.Fatal(err)
	}

	var response *http.Response
	select {
	case response = <-responseCh:
	case err := <-errorCh:
		t.Fatal(err)
	case <-time.After(2 * time.Second):
		t.Fatal("upload response timed out")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(response.Body)
		t.Fatalf("status = %d: %s", response.StatusCode, body)
	}
	var result struct {
		MIMEType  string `json:"mime_type"`
		SizeBytes int64  `json:"size_bytes"`
	}
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(upstreamBody, payload) {
		t.Fatalf("upstream received %d bytes, want %d", len(upstreamBody), len(payload))
	}
	if !strings.HasPrefix(result.MIMEType, "text/plain") || result.SizeBytes != int64(len(payload)) {
		t.Fatalf("mime=%q size=%d", result.MIMEType, result.SizeBytes)
	}
	if control.createdSize != int64(len(payload)) || control.confirmCalls != 1 || bindCalls != 1 {
		t.Fatalf("created size=%d confirm=%d bind=%d", control.createdSize, control.confirmCalls, bindCalls)
	}
}

func TestUploadFilePreservesImageDimensionsWithoutBuffering(t *testing.T) {
	png, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
	if err != nil {
		t.Fatal(err)
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		if !bytes.Equal(body, png) {
			t.Errorf("upstream image differs")
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	control := &uploadControlClient{uploadURL: upstream.URL}
	bindCalls := 0
	server := uploadTestServer(control, &bindCalls)
	defer server.Close()
	body, contentType := multipartUploadBody(t, "像素.png", "image/png", png)
	request, _ := http.NewRequest(http.MethodPost, server.URL+"/api/files?size_bytes="+strconv.Itoa(len(png)), body)
	request.Header.Set("Content-Type", contentType)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var result struct {
		FileName string `json:"file_name"`
		Width    int    `json:"width"`
		Height   int    `json:"height"`
	}
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || result.FileName != "像素.png" || result.Width != 1 || result.Height != 1 {
		t.Fatalf("status=%d filename=%q dimensions=%dx%d", response.StatusCode, result.FileName, result.Width, result.Height)
	}
}

func TestUploadFileRejectsInvalidDeclaredSizes(t *testing.T) {
	control := &uploadControlClient{}
	bindCalls := 0
	server := uploadTestServer(control, &bindCalls)
	defer server.Close()

	tests := []struct {
		name   string
		query  string
		status int
	}{
		{name: "missing", status: http.StatusBadRequest},
		{name: "zero", query: "?size_bytes=0", status: http.StatusBadRequest},
		{name: "over limit", query: "?size_bytes=" + strconv.FormatInt(maxUploadSize+1, 10), status: http.StatusRequestEntityTooLarge},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request, _ := http.NewRequest(http.MethodPost, server.URL+"/api/files"+test.query, nil)
			response, err := http.DefaultClient.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if response.StatusCode != test.status {
				t.Fatalf("status=%d want=%d", response.StatusCode, test.status)
			}
		})
	}
	if control.createCalls != 0 || bindCalls != 0 {
		t.Fatalf("create=%d bind=%d", control.createCalls, bindCalls)
	}
}

func TestUploadFileRejectsActualSizeMismatchWithoutConfirming(t *testing.T) {
	payload := []byte("one-byte-too-many")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		_, _ = io.Copy(io.Discard, request.Body)
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	control := &uploadControlClient{uploadURL: upstream.URL}
	bindCalls := 0
	server := uploadTestServer(control, &bindCalls)
	defer server.Close()
	body, contentType := multipartUploadBody(t, "mismatch.txt", "text/plain", payload)
	request, _ := http.NewRequest(http.MethodPost, server.URL+"/api/files?size_bytes="+strconv.Itoa(len(payload)-1), body)
	request.Header.Set("Content-Type", contentType)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusBadRequest {
		body, _ := io.ReadAll(response.Body)
		t.Fatalf("status=%d: %s", response.StatusCode, body)
	}
	if control.confirmCalls != 0 || bindCalls != 0 {
		t.Fatalf("confirm=%d bind=%d", control.confirmCalls, bindCalls)
	}
}

func TestUploadFileRejectsShorterBodyWithoutConfirming(t *testing.T) {
	payload := []byte("short")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		_, _ = io.Copy(io.Discard, request.Body)
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	control := &uploadControlClient{uploadURL: upstream.URL}
	bindCalls := 0
	server := uploadTestServer(control, &bindCalls)
	defer server.Close()
	body, contentType := multipartUploadBody(t, "short.txt", "text/plain", payload)
	request, _ := http.NewRequest(http.MethodPost, server.URL+"/api/files?size_bytes="+strconv.Itoa(len(payload)+1), body)
	request.Header.Set("Content-Type", contentType)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusBadRequest {
		body, _ := io.ReadAll(response.Body)
		t.Fatalf("status=%d: %s", response.StatusCode, body)
	}
	if control.confirmCalls != 0 || bindCalls != 0 {
		t.Fatalf("confirm=%d bind=%d", control.confirmCalls, bindCalls)
	}
}

func TestUploadFileDoesNotBindAfterUpstreamFailure(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		_, _ = io.Copy(io.Discard, request.Body)
		http.Error(w, "storage unavailable", http.StatusServiceUnavailable)
	}))
	defer upstream.Close()
	control := &uploadControlClient{uploadURL: upstream.URL}
	bindCalls := 0
	server := uploadTestServer(control, &bindCalls)
	defer server.Close()
	payload := []byte("content")
	body, contentType := multipartUploadBody(t, "failure.txt", "text/plain", payload)
	request, _ := http.NewRequest(http.MethodPost, server.URL+"/api/files?size_bytes="+strconv.Itoa(len(payload)), body)
	request.Header.Set("Content-Type", contentType)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusBadGateway {
		t.Fatalf("status=%d", response.StatusCode)
	}
	if control.confirmCalls != 0 || bindCalls != 0 {
		t.Fatalf("confirm=%d bind=%d", control.confirmCalls, bindCalls)
	}
}

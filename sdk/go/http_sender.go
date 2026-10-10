package omniswitch

import (
	"crypto/rand"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// HttpResult is the normalized result of an HTTP call — status code plus
// raw response body, regardless of whether the status was 2xx or not
// (unlike Go's own http.Client, which doesn't treat a non-2xx status as
// an error at all — this type exists so Client's own status-code
// branching, e.g. the 401-retry-once path, has one shape to work with).
type HttpResult struct {
	StatusCode int
	Body       string
}

// HttpSender is the one seam Client depends on for making HTTP calls —
// injectable so tests can supply a mock without a real network call, the
// same role `fetch` plays in the Node SDK. The default implementation
// (NewHTTPClientSender) uses net/http.
type HttpSender interface {
	Send(method, url string, headers map[string]string, body *string, timeoutMs int) (HttpResult, error)
}

type httpClientSender struct {
	client *http.Client
}

// No external HTTP dependency.
func NewHTTPClientSender() HttpSender {
	return &httpClientSender{client: &http.Client{}}
}

func (s *httpClientSender) Send(method, url string, headers map[string]string, body *string, timeoutMs int) (HttpResult, error) {
	var reader io.Reader
	if body != nil {
		reader = strings.NewReader(*body)
	}

	req, err := http.NewRequest(method, url, reader)
	if err != nil {
		return HttpResult{}, err
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}

	client := s.client
	client.Timeout = time.Duration(timeoutMs) * time.Millisecond

	resp, err := client.Do(req)
	if err != nil {
		return HttpResult{}, err
	}
	defer resp.Body.Close()

	responseBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return HttpResult{}, err
	}

	return HttpResult{StatusCode: resp.StatusCode, Body: string(responseBody)}, nil
}

// No external dependency for something this small.
func newUUIDv4() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand failing is not a recoverable condition
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

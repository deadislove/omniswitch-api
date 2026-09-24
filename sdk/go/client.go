// Package omniswitch is deliberately merchant-credential-only in this
// first cut — an AGENT-delegation client is real future scope this
// package doesn't cover yet.
package omniswitch

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"
)

const tokenRefreshSkewSeconds = 30
const defaultTimeoutMs = 30_000

type ClientOptions struct {
	// BaseURL, e.g. "https://api.example.com/api/v1" — no trailing slash.
	BaseURL      string
	APIKeyID     string
	APIKeySecret string
	// HmacSecret is this merchant's HMAC signing key (from POST
	// /admin/merchants or a rotation call) — never the JWT.
	HmacSecret string
	// MerchantID is the business-facing merchant id, sent as
	// X-Merchant-Id on every signed request.
	MerchantID string
	// HttpSender is injectable for tests/non-standard runtimes —
	// defaults to a net/http-backed sender.
	HttpSender HttpSender
	// TimeoutMs is the request timeout, milliseconds. Default 30000.
	TimeoutMs int
}

type cachedToken struct {
	accessToken     string
	expiresAtUnixMs int64
}

// Safe for concurrent use.
type Client struct {
	baseURL      string
	apiKeyID     string
	apiKeySecret string
	hmacSecret   string
	merchantID   string
	httpSender   HttpSender
	timeoutMs    int

	tokenMu sync.Mutex
	token   *cachedToken
}

func NewClient(options ClientOptions) *Client {
	timeoutMs := options.TimeoutMs
	if timeoutMs == 0 {
		timeoutMs = defaultTimeoutMs
	}
	sender := options.HttpSender
	if sender == nil {
		sender = NewHTTPClientSender()
	}
	return &Client{
		baseURL:      strings.TrimRight(options.BaseURL, "/"),
		apiKeyID:     options.APIKeyID,
		apiKeySecret: options.APIKeySecret,
		hmacSecret:   options.HmacSecret,
		merchantID:   options.MerchantID,
		httpSender:   sender,
		timeoutMs:    timeoutMs,
	}
}

func nowUnixMs() int64 {
	return time.Now().UnixMilli()
}

// Pass "" for idempotencyKey to have the SDK generate a fresh UUID v4.
func (c *Client) Charge(params ChargeParams, idempotencyKey string) (*ChargeResponse, error) {
	var out ChargeResponse
	if err := c.request("POST", "/payments/charge", params, true, idempotencyKey, false, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) GetPayment(paymentID string) (*PaymentDetail, error) {
	var out PaymentDetail
	path := "/payments/" + url.PathEscape(paymentID)
	if err := c.request("GET", path, nil, false, "", false, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) Refund(paymentID string, params RefundParams, idempotencyKey string) (*RefundResponse, error) {
	var out RefundResponse
	path := "/payments/" + url.PathEscape(paymentID) + "/refund"
	if err := c.request("POST", path, params, true, idempotencyKey, false, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) Capture(paymentID string, params CaptureParams, idempotencyKey string) (*CaptureResponse, error) {
	var out CaptureResponse
	path := "/payments/" + url.PathEscape(paymentID) + "/capture"
	if err := c.request("POST", path, params, true, idempotencyKey, false, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) Cancel(paymentID string, idempotencyKey string) (*CancelResponse, error) {
	var out CancelResponse
	path := "/payments/" + url.PathEscape(paymentID) + "/cancel"
	if err := c.request("POST", path, struct{}{}, true, idempotencyKey, false, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Exported so a caller can pre-warm the token or check credentials without making a payments call.
func (c *Client) Authenticate() (string, error) {
	c.tokenMu.Lock()
	defer c.tokenMu.Unlock()

	if c.token != nil && c.token.expiresAtUnixMs-tokenRefreshSkewSeconds*1000 > nowUnixMs() {
		return c.token.accessToken, nil
	}

	bodyBytes, err := json.Marshal(map[string]string{"apiKeyId": c.apiKeyID, "apiKeySecret": c.apiKeySecret})
	if err != nil {
		return "", err
	}
	bodyStr := string(bodyBytes)

	result, err := c.httpSender.Send(
		"POST", c.baseURL+"/auth/token", map[string]string{"Content-Type": "application/json"}, &bodyStr, c.timeoutMs,
	)
	if err != nil {
		return "", err
	}
	if result.StatusCode < 200 || result.StatusCode >= 300 {
		return "", newAPIErrorFromResponse(result.StatusCode, result.Body)
	}

	var parsed map[string]interface{}
	if err := json.Unmarshal([]byte(result.Body), &parsed); err != nil {
		return "", fmt.Errorf("malformed auth response: %w", err)
	}

	if mfaRequired, _ := parsed["mfaRequired"].(bool); mfaRequired {
		// A pending, MFA-restricted token — this SDK is for server-side
		// integrations authenticating with an API key/secret pair,
		// which shouldn't have MFA enabled on that credential in the
		// first place (MFA guards the human dashboard login path).
		// Surfacing this as a clear error is more useful than silently
		// returning a token every subsequent call would then fail
		// against anyway.
		return "", &ApiError{
			StatusCode: 401,
			Message:    "This merchant has MFA enabled — this SDK does not support the MFA challenge flow. Use a credential without MFA enabled for server-side integrations.",
			Code:       "MFA_NOT_SUPPORTED",
		}
	}

	accessToken, _ := parsed["accessToken"].(string)
	expiresIn, _ := parsed["expiresIn"].(float64)
	c.token = &cachedToken{accessToken: accessToken, expiresAtUnixMs: nowUnixMs() + int64(expiresIn*1000)}
	return accessToken, nil
}

func (c *Client) request(
	method, path string, bodyObj interface{}, signed bool, idempotencyKey string, isRetry bool, out interface{},
) error {
	accessToken, err := c.Authenticate()
	if err != nil {
		return err
	}

	var bodyStr *string
	if bodyObj != nil {
		bodyBytes, err := json.Marshal(bodyObj)
		if err != nil {
			return err
		}
		s := string(bodyBytes)
		bodyStr = &s
	}
	fullPath := "/api/v1" + path

	headers := map[string]string{
		"Content-Type":  "application/json",
		"Authorization": "Bearer " + accessToken,
	}

	if signed {
		bodyForSigning := ""
		if bodyStr != nil {
			bodyForSigning = *bodyStr
		}
		sig := SignRequest(c.hmacSecret, method, fullPath, bodyForSigning)
		headers["X-Signature"] = sig.Signature
		headers["X-Timestamp"] = sig.Timestamp
		headers["X-Merchant-Id"] = c.merchantID
		// Generate a fresh UUID v4 per logical call unless the caller
		// is deliberately retrying the same one — this SDK doesn't
		// retry on its own, so "per call to this method" and "per
		// logical operation" already coincide for a single call.
		if idempotencyKey != "" {
			headers["Idempotency-Key"] = idempotencyKey
		} else {
			headers["Idempotency-Key"] = newUUIDv4()
		}
	}

	c.tokenMu.Lock()
	hadCachedToken := c.token != nil
	c.tokenMu.Unlock()

	result, err := c.httpSender.Send(method, c.baseURL+path, headers, bodyStr, c.timeoutMs)
	if err != nil {
		return err
	}

	if result.StatusCode == 401 && hadCachedToken && !isRetry {
		// The cached token may have been revoked server-side (rotation,
		// deactivation) even though it hasn't hit its own expiry yet —
		// exactly one retry with a forced re-authentication, guarded by
		// isRetry so a resource endpoint that 401s even against a
		// freshly issued token can't recurse unboundedly.
		c.tokenMu.Lock()
		c.token = nil
		c.tokenMu.Unlock()
		return c.request(method, path, bodyObj, signed, idempotencyKey, true, out)
	}

	if result.StatusCode < 200 || result.StatusCode >= 300 {
		return newAPIErrorFromResponse(result.StatusCode, result.Body)
	}

	if out != nil {
		if err := json.Unmarshal([]byte(result.Body), out); err != nil {
			return fmt.Errorf("malformed response body: %w", err)
		}
	}
	return nil
}

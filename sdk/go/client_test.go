package omniswitch

import (
	"errors"
	"regexp"
	"strings"
	"sync"
	"testing"
)

// recordingHttpSender records every call, replays queued canned
// responses in order — the mock-HTTP-layer role fetchMock plays in the
// Node test suite.
type recordingCall struct {
	Method  string
	URL     string
	Headers map[string]string
	Body    *string
}

type recordingHttpSender struct {
	mu        sync.Mutex
	calls     []recordingCall
	responses []HttpResult
}

func (s *recordingHttpSender) enqueue(statusCode int, jsonBody string) {
	s.responses = append(s.responses, HttpResult{StatusCode: statusCode, Body: jsonBody})
}

func (s *recordingHttpSender) Send(method, url string, headers map[string]string, body *string, timeoutMs int) (HttpResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	headersCopy := make(map[string]string, len(headers))
	for k, v := range headers {
		headersCopy[k] = v
	}
	s.calls = append(s.calls, recordingCall{Method: method, URL: url, Headers: headersCopy, Body: body})
	if len(s.responses) == 0 {
		return HttpResult{}, errors.New("no more canned responses queued")
	}
	next := s.responses[0]
	s.responses = s.responses[1:]
	return next, nil
}

func makeTestClient(sender *recordingHttpSender) *Client {
	return NewClient(ClientOptions{
		BaseURL:      "https://api.example.com/api/v1",
		APIKeyID:     "ak_test",
		APIKeySecret: "sk_test",
		HmacSecret:   strings.Repeat("h", 64),
		MerchantID:   "merchant_acme",
		HttpSender:   sender,
	})
}

func TestAuthenticatesOnceThenReusesTheCachedTokenForASecondCall(t *testing.T) {
	sender := &recordingHttpSender{}
	sender.enqueue(200, `{"accessToken":"jwt_1","tokenType":"Bearer","expiresIn":3600}`)
	sender.enqueue(200, `{"paymentId":"pay_1","status":"SUCCEEDED"}`)
	sender.enqueue(200, `{"paymentId":"pay_1","status":"SUCCEEDED"}`)
	client := makeTestClient(sender)

	if _, err := client.GetPayment("pay_1"); err != nil {
		t.Fatal(err)
	}
	if _, err := client.GetPayment("pay_1"); err != nil {
		t.Fatal(err)
	}

	if len(sender.calls) != 3 { // 1 auth + 2 resource calls, no re-auth
		t.Fatalf("expected 3 calls, got %d", len(sender.calls))
	}
	if sender.calls[0].URL != "https://api.example.com/api/v1/auth/token" {
		t.Errorf("unexpected first call URL: %s", sender.calls[0].URL)
	}
}

func TestSendsSignatureHeadersOnASignedCallCharge(t *testing.T) {
	sender := &recordingHttpSender{}
	sender.enqueue(200, `{"accessToken":"jwt_1","tokenType":"Bearer","expiresIn":3600}`)
	sender.enqueue(201, `{"paymentId":"pay_1","status":"SUCCEEDED","requiresAction":false,"usedFallback":false}`)
	client := makeTestClient(sender)

	if _, err := client.Charge(NewChargeParams(10, "USD"), ""); err != nil {
		t.Fatal(err)
	}

	chargeCall := sender.calls[1]
	if chargeCall.URL != "https://api.example.com/api/v1/payments/charge" {
		t.Errorf("unexpected URL: %s", chargeCall.URL)
	}
	if chargeCall.Headers["X-Signature"] == "" {
		t.Error("expected X-Signature header")
	}
	if chargeCall.Headers["X-Timestamp"] == "" {
		t.Error("expected X-Timestamp header")
	}
	if chargeCall.Headers["X-Merchant-Id"] != "merchant_acme" {
		t.Errorf("unexpected X-Merchant-Id: %s", chargeCall.Headers["X-Merchant-Id"])
	}
	if !regexp.MustCompile(`^[0-9a-f-]{36}$`).MatchString(chargeCall.Headers["Idempotency-Key"]) {
		t.Errorf("unexpected Idempotency-Key: %s", chargeCall.Headers["Idempotency-Key"])
	}
	if chargeCall.Headers["Authorization"] != "Bearer jwt_1" {
		t.Errorf("unexpected Authorization: %s", chargeCall.Headers["Authorization"])
	}
}

func TestDoesNotSignAGetRequestGetPayment(t *testing.T) {
	sender := &recordingHttpSender{}
	sender.enqueue(200, `{"accessToken":"jwt_1","tokenType":"Bearer","expiresIn":3600}`)
	sender.enqueue(200, `{"paymentId":"pay_1"}`)
	client := makeTestClient(sender)

	if _, err := client.GetPayment("pay_1"); err != nil {
		t.Fatal(err)
	}

	getCall := sender.calls[1]
	if _, ok := getCall.Headers["X-Signature"]; ok {
		t.Error("did not expect X-Signature header")
	}
	if _, ok := getCall.Headers["Idempotency-Key"]; ok {
		t.Error("did not expect Idempotency-Key header")
	}
}

func TestReusesACallerSuppliedIdempotencyKeyAcrossAnExplicitRetry(t *testing.T) {
	sender := &recordingHttpSender{}
	sender.enqueue(200, `{"accessToken":"jwt_1","tokenType":"Bearer","expiresIn":3600}`)
	sender.enqueue(201, `{"paymentId":"pay_1"}`)
	client := makeTestClient(sender)

	if _, err := client.Charge(NewChargeParams(10, "USD"), "my-fixed-key"); err != nil {
		t.Fatal(err)
	}

	if sender.calls[1].Headers["Idempotency-Key"] != "my-fixed-key" {
		t.Errorf("unexpected Idempotency-Key: %s", sender.calls[1].Headers["Idempotency-Key"])
	}
}

func TestRetriesExactlyOnceWithAFreshTokenOnA401ThenSucceeds(t *testing.T) {
	sender := &recordingHttpSender{}
	sender.enqueue(200, `{"accessToken":"jwt_1","tokenType":"Bearer","expiresIn":3600}`)
	sender.enqueue(401, `{"statusCode":401,"error":"Invalid or expired token","code":"INVALID_TOKEN"}`)
	sender.enqueue(200, `{"accessToken":"jwt_2","tokenType":"Bearer","expiresIn":3600}`)
	sender.enqueue(200, `{"paymentId":"pay_1"}`)
	client := makeTestClient(sender)

	result, err := client.GetPayment("pay_1")
	if err != nil {
		t.Fatal(err)
	}

	if result.PaymentID != "pay_1" {
		t.Errorf("unexpected paymentId: %s", result.PaymentID)
	}
	if len(sender.calls) != 4 { // auth, 401, re-auth, success
		t.Fatalf("expected 4 calls, got %d", len(sender.calls))
	}
	if sender.calls[3].Headers["Authorization"] != "Bearer jwt_2" {
		t.Errorf("unexpected Authorization: %s", sender.calls[3].Headers["Authorization"])
	}
}

func TestThrowsOmniSwitchApiErrorWithStatusCodeCodeErrorFromTheResponseBody(t *testing.T) {
	sender := &recordingHttpSender{}
	sender.enqueue(200, `{"accessToken":"jwt_1","tokenType":"Bearer","expiresIn":3600}`)
	sender.enqueue(422, `{"statusCode":422,"error":"Charge of $50.00 USD exceeds this delegation's per-transaction limit","code":"DELEGATION_PER_TRANSACTION_LIMIT_EXCEEDED"}`)
	client := makeTestClient(sender)

	_, err := client.Charge(NewChargeParams(50, "USD"), "")
	if err == nil {
		t.Fatal("expected an error")
	}
	var apiErr *ApiError
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected *ApiError, got %T", err)
	}
	if apiErr.StatusCode != 422 {
		t.Errorf("unexpected status code: %d", apiErr.StatusCode)
	}
	if apiErr.Code != "DELEGATION_PER_TRANSACTION_LIMIT_EXCEEDED" {
		t.Errorf("unexpected code: %s", apiErr.Code)
	}
}

func TestThrowsAClearMfaNotSupportedErrorInsteadOfSilentlyReturningARestrictedToken(t *testing.T) {
	sender := &recordingHttpSender{}
	sender.enqueue(200, `{"accessToken":"jwt_pending","tokenType":"Bearer","expiresIn":300,"mfaRequired":true}`)
	client := makeTestClient(sender)

	_, err := client.GetPayment("pay_1")
	if err == nil {
		t.Fatal("expected an error")
	}
	var apiErr *ApiError
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected *ApiError, got %T", err)
	}
	if apiErr.Code != "MFA_NOT_SUPPORTED" {
		t.Errorf("unexpected code: %s", apiErr.Code)
	}
}

func TestRefundCaptureCancelAllSignAndHitTheExpectedPaths(t *testing.T) {
	sender := &recordingHttpSender{}
	sender.enqueue(200, `{"accessToken":"jwt_1","tokenType":"Bearer","expiresIn":3600}`)
	sender.enqueue(200, `{"paymentId":"pay_1","status":"REFUNDED"}`)
	sender.enqueue(200, `{"paymentId":"pay_1","status":"SUCCEEDED"}`)
	sender.enqueue(200, `{"paymentId":"pay_1","status":"CANCELLED"}`)
	client := makeTestClient(sender)

	amount := 5.0
	if _, err := client.Refund("pay_1", RefundParams{Amount: &amount}, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Capture("pay_1", CaptureParams{}, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Cancel("pay_1", ""); err != nil {
		t.Fatal(err)
	}

	if sender.calls[1].URL != "https://api.example.com/api/v1/payments/pay_1/refund" {
		t.Errorf("unexpected refund URL: %s", sender.calls[1].URL)
	}
	if sender.calls[2].URL != "https://api.example.com/api/v1/payments/pay_1/capture" {
		t.Errorf("unexpected capture URL: %s", sender.calls[2].URL)
	}
	if sender.calls[3].URL != "https://api.example.com/api/v1/payments/pay_1/cancel" {
		t.Errorf("unexpected cancel URL: %s", sender.calls[3].URL)
	}
	for _, call := range sender.calls[1:] {
		if call.Headers["X-Signature"] == "" {
			t.Error("expected X-Signature header on every write call")
		}
	}
}

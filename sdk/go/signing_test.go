package omniswitch

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestProducesTheExactSignatureHmacSignatureGuardVerifies(t *testing.T) {
	secret := strings.Repeat("a", 64)
	result := SignRequest(secret, "post", "/api/v1/payments/charge", `{"amount":10}`)

	expected := hmacSHA256Hex(secret, fmt.Sprintf("%s.POST./api/v1/payments/charge.{\"amount\":10}", result.Timestamp))
	if result.Signature != expected {
		t.Errorf("expected %s, got %s", expected, result.Signature)
	}
}

func TestUppercasesTheMethodRegardlessOfCallerCasing(t *testing.T) {
	secret := strings.Repeat("a", 64)
	lower := SignRequest(secret, "get", "/api/v1/payments/pay_1", "")
	recomputed := hmacSHA256Hex(secret, fmt.Sprintf("%s.GET./api/v1/payments/pay_1.", lower.Timestamp))
	if lower.Signature != recomputed {
		t.Errorf("expected %s, got %s", recomputed, lower.Signature)
	}
}

func TestReturnsAUnixSecondsTimestampAsAString(t *testing.T) {
	result := SignRequest("secret", "POST", "/api/v1/payments/charge", "{}")
	if !regexp.MustCompile(`^\d+$`).MatchString(result.Timestamp) {
		t.Errorf("timestamp %q is not all digits", result.Timestamp)
	}
	ts, _ := strconv.ParseInt(result.Timestamp, 10, 64)
	now := time.Now().Unix()
	diff := now - ts
	if diff < 0 {
		diff = -diff
	}
	if diff >= 5 {
		t.Errorf("timestamp too far from now: diff=%d", diff)
	}
}

func TestProducesADifferentSignatureForADifferentBody(t *testing.T) {
	secret := strings.Repeat("a", 64)
	a := SignRequest(secret, "POST", "/api/v1/payments/charge", `{"amount":10}`)
	b := SignRequest(secret, "POST", "/api/v1/payments/charge", `{"amount":20}`)
	if a.Signature == b.Signature {
		t.Error("expected different signatures for different bodies")
	}
}

package omniswitch

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

const testSecret64 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const testBody = `{"event":"dispute.created","paymentId":"pay_1"}`

func signWebhook(secret, body string, timestamp int64) string {
	signature := hmacSHA256Hex(secret, fmt.Sprintf("%d.%s", timestamp, body))
	return fmt.Sprintf("t=%d,v1=%s", timestamp, signature)
}

func TestAcceptsACorrectlySignedFreshPayload(t *testing.T) {
	header := signWebhook(testSecret64, testBody, time.Now().Unix())
	if !VerifyWebhookSignature(testSecret64, testBody, header) {
		t.Error("expected true")
	}
}

func TestRejectsAPayloadSignedWithTheWrongSecret(t *testing.T) {
	header := signWebhook(strings.Repeat("b", 64), testBody, time.Now().Unix())
	if VerifyWebhookSignature(testSecret64, testBody, header) {
		t.Error("expected false")
	}
}

func TestRejectsAMutatedBodyAgainstASignatureComputedForTheOriginal(t *testing.T) {
	header := signWebhook(testSecret64, testBody, time.Now().Unix())
	if VerifyWebhookSignature(testSecret64, testBody+"tampered", header) {
		t.Error("expected false")
	}
}

func TestRejectsAMissingSignatureHeader(t *testing.T) {
	if VerifyWebhookSignature(testSecret64, testBody, "") {
		t.Error("expected false for empty header")
	}
}

func TestRejectsAMalformedHeader(t *testing.T) {
	cases := []string{"v1=deadbeef", "t=1700000000", "garbage"}
	for _, c := range cases {
		if VerifyWebhookSignature(testSecret64, testBody, c) {
			t.Errorf("expected false for header %q", c)
		}
	}
}

func TestRejectsATimestampOutsideTheToleranceWindow(t *testing.T) {
	staleTimestamp := time.Now().Unix() - 10*60
	header := signWebhook(testSecret64, testBody, staleTimestamp)
	if VerifyWebhookSignature(testSecret64, testBody, header) {
		t.Error("expected false")
	}
}

func TestAcceptsACustomToleranceWindow(t *testing.T) {
	timestamp := time.Now().Unix() - 60
	header := signWebhook(testSecret64, testBody, timestamp)
	if VerifyWebhookSignatureWithTolerance(testSecret64, testBody, header, 30) {
		t.Error("expected false with 30s tolerance")
	}
	if !VerifyWebhookSignatureWithTolerance(testSecret64, testBody, header, 120) {
		t.Error("expected true with 120s tolerance")
	}
}

func TestRejectsANonHexV1ValueWithoutPanicking(t *testing.T) {
	header := "t=1700000000,v1=not-hex!!"
	if VerifyWebhookSignature(testSecret64, testBody, header) {
		t.Error("expected false")
	}
}

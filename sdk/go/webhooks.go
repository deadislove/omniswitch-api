package omniswitch

import (
	"crypto/subtle"
	"encoding/hex"
	"strconv"
	"strings"
	"time"
)

const defaultToleranceSeconds = 5 * 60

// VerifyWebhookSignature verifies the X-OmniSwitch-Signature header
// OmniSwitch signs its own outbound webhooks with (dispute/subscription/
// AML-review/sanctions-screening notifications) — t=<unix seconds>,v1=<hex
// HMAC-SHA256 digest> over "${timestamp}.${rawBody}", keyed by the same
// merchant HMAC secret SignRequest uses. This is the verify-side mirror
// of the server's own signing function.
//
// rawBody must be the exact bytes received on the wire — verifying
// against a re-serialized payload can silently fail for payloads whose
// key order or number formatting changes on parse-then-restringify.
//
// Returns false for a malformed header, an expired timestamp, or a
// mismatched signature — never panics, so a caller can gate a 401
// response on a single boolean check.
func VerifyWebhookSignature(secret, rawBody, signatureHeader string) bool {
	return VerifyWebhookSignatureWithTolerance(secret, rawBody, signatureHeader, defaultToleranceSeconds)
}

func VerifyWebhookSignatureWithTolerance(secret, rawBody, signatureHeader string, toleranceSeconds int64) bool {
	if signatureHeader == "" {
		return false
	}

	parts := make(map[string]string)
	for _, part := range strings.Split(signatureHeader, ",") {
		kv := strings.SplitN(part, "=", 2)
		if len(kv) == 2 && kv[0] != "" && kv[1] != "" {
			parts[kv[0]] = kv[1]
		}
	}

	timestamp, hasTimestamp := parts["t"]
	providedSignature, hasSignature := parts["v1"]
	if !hasTimestamp || !hasSignature {
		return false
	}

	requestTimeSeconds, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil {
		return false
	}
	now := time.Now().Unix()
	delta := now - requestTimeSeconds
	if delta < 0 {
		delta = -delta
	}
	if delta > toleranceSeconds {
		return false
	}

	expectedSignature := hmacSHA256Hex(secret, timestamp+"."+rawBody)

	expectedBytes, err1 := hex.DecodeString(expectedSignature)
	providedBytes, err2 := hex.DecodeString(providedSignature)
	if err1 != nil || err2 != nil {
		return false
	}

	return len(expectedBytes) == len(providedBytes) && subtle.ConstantTimeCompare(expectedBytes, providedBytes) == 1
}

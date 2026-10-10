package omniswitch

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"time"
)

type SignResult struct {
	Signature string
	Timestamp string
}

// SignRequest computes the X-Signature/X-Timestamp pair HmacSignatureGuard
// verifies server-side: HMAC-SHA256(secret, "${timestamp}.${method}.${path}.${rawBody}"),
// hex digest. path must be the exact request path the server sees,
// including the /api/v1 prefix and query string if any — the guard signs
// request.originalUrl, not a normalized or query-stripped version. body
// must be the exact bytes sent on the wire — [Client] always signs the
// same JSON string it then sends, never a value re-serialized afterward.
func SignRequest(secret, method, path, body string) SignResult {
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	signedPayload := fmt.Sprintf("%s.%s.%s.%s", timestamp, strings.ToUpper(method), path, body)
	signature := hmacSHA256Hex(secret, signedPayload)
	return SignResult{Signature: signature, Timestamp: timestamp}
}

func hmacSHA256Hex(secret, payload string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	return hex.EncodeToString(mac.Sum(nil))
}

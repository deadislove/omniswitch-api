//! HMAC request signing — mirrors sdk/node's signing.ts exactly.

use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::time::{SystemTime, UNIX_EPOCH};

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignResult {
    pub signature: String,
    pub timestamp: String,
}

/// Computes the `X-Signature`/`X-Timestamp` pair `HmacSignatureGuard`
/// verifies server-side:
/// `HMAC-SHA256(secret, "${timestamp}.${method}.${path}.${rawBody}")`,
/// hex digest. `path` must be the exact request path the server sees,
/// including the `/api/v1` prefix and query string if any — the guard
/// signs `request.originalUrl`, not a normalized or query-stripped
/// version. `body` must be the exact bytes sent on the wire —
/// [`crate::client::OmniSwitchClient`] always signs the same JSON string
/// it then sends, never a value re-serialized afterward.
pub fn sign_request(secret: &str, method: &str, path: &str, body: &str) -> SignResult {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before UNIX epoch")
        .as_secs()
        .to_string();
    let signed_payload = format!("{}.{}.{}.{}", timestamp, method.to_uppercase(), path, body);
    let signature = hmac_sha256_hex(secret, &signed_payload);
    SignResult { signature, timestamp }
}

pub(crate) fn hmac_sha256_hex(secret: &str, payload: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(payload.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn produces_the_exact_signature_hmac_signature_guard_verifies() {
        let secret = "a".repeat(64);
        let result = sign_request(&secret, "post", "/api/v1/payments/charge", "{\"amount\":10}");

        let expected = hmac_sha256_hex(
            &secret,
            &format!("{}.POST./api/v1/payments/charge.{{\"amount\":10}}", result.timestamp),
        );
        assert_eq!(result.signature, expected);
    }

    #[test]
    fn uppercases_the_method_regardless_of_caller_casing() {
        let secret = "a".repeat(64);
        let lower = sign_request(&secret, "get", "/api/v1/payments/pay_1", "");
        let recomputed = hmac_sha256_hex(&secret, &format!("{}.GET./api/v1/payments/pay_1.", lower.timestamp));
        assert_eq!(lower.signature, recomputed);
    }

    #[test]
    fn returns_a_unix_seconds_timestamp_as_a_string() {
        let result = sign_request("secret", "POST", "/api/v1/payments/charge", "{}");
        assert!(result.timestamp.chars().all(|c| c.is_ascii_digit()));
        let now: i64 = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64;
        let ts: i64 = result.timestamp.parse().unwrap();
        assert!((now - ts).abs() < 5);
    }

    #[test]
    fn produces_a_different_signature_for_a_different_body() {
        let secret = "a".repeat(64);
        let a = sign_request(&secret, "POST", "/api/v1/payments/charge", "{\"amount\":10}");
        let b = sign_request(&secret, "POST", "/api/v1/payments/charge", "{\"amount\":20}");
        assert_ne!(a.signature, b.signature);
    }
}

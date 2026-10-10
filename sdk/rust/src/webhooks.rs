//! Outbound webhook signature verification — mirrors sdk/node's webhooks.ts exactly.

use crate::signing::hmac_sha256_hex;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};
use subtle::ConstantTimeEq;

const DEFAULT_TOLERANCE_SECONDS: i64 = 5 * 60;

/// Verifies the `X-OmniSwitch-Signature` header OmniSwitch signs its own
/// outbound webhooks with (dispute/subscription/AML-review/sanctions-
/// screening notifications) — `t=<unix seconds>,v1=<hex HMAC-SHA256
/// digest>` over `"${timestamp}.${rawBody}"`, keyed by the same merchant
/// HMAC secret [`crate::signing::sign_request`] uses. This is the
/// verify-side mirror of the server's own signing function.
///
/// `raw_body` must be the exact bytes received on the wire — verifying
/// against a re-serialized payload can silently fail for payloads whose
/// key order or number formatting changes on parse-then-restringify.
///
/// Returns `false` for a malformed header, an expired timestamp, or a
/// mismatched signature — never panics, so a caller can gate a `401`
/// response on a single boolean check.
pub fn verify_webhook_signature(secret: &str, raw_body: &str, signature_header: Option<&str>) -> bool {
    verify_webhook_signature_with_tolerance(secret, raw_body, signature_header, DEFAULT_TOLERANCE_SECONDS)
}

pub fn verify_webhook_signature_with_tolerance(
    secret: &str,
    raw_body: &str,
    signature_header: Option<&str>,
    tolerance_seconds: i64,
) -> bool {
    let header = match signature_header {
        Some(h) if !h.is_empty() => h,
        _ => return false,
    };

    let parts: HashMap<&str, &str> = header
        .split(',')
        .filter_map(|part| {
            let (key, value) = part.split_once('=')?;
            if key.is_empty() || value.is_empty() {
                None
            } else {
                Some((key, value))
            }
        })
        .collect();

    let timestamp = match parts.get("t") {
        Some(t) => *t,
        None => return false,
    };
    let provided_signature = match parts.get("v1") {
        Some(v) => *v,
        None => return false,
    };

    let timestamp_seconds: i64 = match timestamp.parse() {
        Ok(t) => t,
        Err(_) => return false,
    };
    let now_seconds = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64;
    if (now_seconds - timestamp_seconds).abs() > tolerance_seconds {
        return false;
    }

    let expected_signature = hmac_sha256_hex(secret, &format!("{}.{}", timestamp, raw_body));

    let (expected_bytes, provided_bytes) = match (hex::decode(&expected_signature), hex::decode(provided_signature)) {
        (Ok(e), Ok(p)) => (e, p),
        _ => return false,
    };

    expected_bytes.len() == provided_bytes.len() && bool::from(expected_bytes.ct_eq(&provided_bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secret() -> String {
        "a".repeat(64)
    }

    fn body() -> String {
        "{\"event\":\"dispute.created\",\"paymentId\":\"pay_1\"}".to_string()
    }

    fn sign(secret: &str, body: &str, timestamp: i64) -> String {
        let signature = hmac_sha256_hex(secret, &format!("{}.{}", timestamp, body));
        format!("t={},v1={}", timestamp, signature)
    }

    fn now() -> i64 {
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64
    }

    #[test]
    fn accepts_a_correctly_signed_fresh_payload() {
        let header = sign(&secret(), &body(), now());
        assert!(verify_webhook_signature(&secret(), &body(), Some(&header)));
    }

    #[test]
    fn rejects_a_payload_signed_with_the_wrong_secret() {
        let header = sign(&"b".repeat(64), &body(), now());
        assert!(!verify_webhook_signature(&secret(), &body(), Some(&header)));
    }

    #[test]
    fn rejects_a_mutated_body_against_a_signature_computed_for_the_original() {
        let header = sign(&secret(), &body(), now());
        let mutated = format!("{}tampered", body());
        assert!(!verify_webhook_signature(&secret(), &mutated, Some(&header)));
    }

    #[test]
    fn rejects_a_missing_signature_header() {
        assert!(!verify_webhook_signature(&secret(), &body(), None));
        assert!(!verify_webhook_signature(&secret(), &body(), Some("")));
    }

    #[test]
    fn rejects_a_malformed_header() {
        assert!(!verify_webhook_signature(&secret(), &body(), Some("v1=deadbeef")));
        assert!(!verify_webhook_signature(&secret(), &body(), Some("t=1700000000")));
        assert!(!verify_webhook_signature(&secret(), &body(), Some("garbage")));
    }

    #[test]
    fn rejects_a_timestamp_outside_the_tolerance_window() {
        let stale_timestamp = now() - 10 * 60;
        let header = sign(&secret(), &body(), stale_timestamp);
        assert!(!verify_webhook_signature(&secret(), &body(), Some(&header)));
    }

    #[test]
    fn accepts_a_custom_tolerance_window() {
        let timestamp = now() - 60;
        let header = sign(&secret(), &body(), timestamp);
        assert!(!verify_webhook_signature_with_tolerance(&secret(), &body(), Some(&header), 30));
        assert!(verify_webhook_signature_with_tolerance(&secret(), &body(), Some(&header), 120));
    }

    #[test]
    fn rejects_a_non_hex_v1_value_without_panicking() {
        let header = "t=1700000000,v1=not-hex!!";
        assert!(!verify_webhook_signature(&secret(), &body(), Some(header)));
    }
}

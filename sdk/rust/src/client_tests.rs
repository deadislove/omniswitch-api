//! Records every call, replays queued canned responses in order — the
//! mock-HTTP-layer role fetchMock plays in the Node test suite.

use crate::client::{OmniSwitchClient, OmniSwitchClientOptions};
use crate::http_sender::{HttpResult, HttpSender};
use crate::types::{CaptureParams, ChargeParams, RefundParams};
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Debug, Clone)]
struct Call {
    #[allow(dead_code)]
    method: String,
    url: String,
    headers: HashMap<String, String>,
    #[allow(dead_code)]
    body: Option<String>,
}

struct RecordingHttpSender {
    calls: Mutex<Vec<Call>>,
    responses: Mutex<Vec<HttpResult>>,
}

impl RecordingHttpSender {
    fn new() -> Self {
        Self { calls: Mutex::new(Vec::new()), responses: Mutex::new(Vec::new()) }
    }

    fn enqueue(&self, status_code: u16, json_body: &str) {
        self.responses.lock().unwrap().push(HttpResult { status_code, body: json_body.to_string() });
    }

    fn calls_snapshot(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }
}

impl HttpSender for RecordingHttpSender {
    fn send(
        &self,
        method: &str,
        url: &str,
        headers: &HashMap<String, String>,
        body: Option<&str>,
        _timeout_ms: u64,
    ) -> Result<HttpResult, Box<dyn std::error::Error>> {
        self.calls.lock().unwrap().push(Call {
            method: method.to_string(),
            url: url.to_string(),
            headers: headers.clone(),
            body: body.map(|s| s.to_string()),
        });
        let mut responses = self.responses.lock().unwrap();
        if responses.is_empty() {
            return Err("No more canned responses queued".into());
        }
        Ok(responses.remove(0))
    }
}

fn make_client(sender: RecordingHttpSender) -> (OmniSwitchClient, std::sync::Arc<RecordingHttpSenderHandle>) {
    // Wrap so the test can still enqueue/inspect after the client takes ownership of the Box<dyn HttpSender>.
    let handle = std::sync::Arc::new(RecordingHttpSenderHandle(sender));
    let handle_for_client = handle.clone();
    let mut options = OmniSwitchClientOptions::new(
        "https://api.example.com/api/v1",
        "ak_test",
        "sk_test",
        "h".repeat(64),
        "merchant_acme",
    );
    options.http_sender = Some(Box::new(ForwardingSender(handle_for_client)));
    (OmniSwitchClient::new(options), handle)
}

struct RecordingHttpSenderHandle(RecordingHttpSender);

struct ForwardingSender(std::sync::Arc<RecordingHttpSenderHandle>);

impl HttpSender for ForwardingSender {
    fn send(
        &self,
        method: &str,
        url: &str,
        headers: &HashMap<String, String>,
        body: Option<&str>,
        timeout_ms: u64,
    ) -> Result<HttpResult, Box<dyn std::error::Error>> {
        self.0 .0.send(method, url, headers, body, timeout_ms)
    }
}

#[test]
fn authenticates_once_then_reuses_the_cached_token_for_a_second_call() {
    let sender = RecordingHttpSender::new();
    sender.enqueue(200, r#"{"accessToken":"jwt_1","tokenType":"Bearer","expiresIn":3600}"#);
    sender.enqueue(200, r#"{"paymentId":"pay_1","status":"SUCCEEDED"}"#);
    sender.enqueue(200, r#"{"paymentId":"pay_1","status":"SUCCEEDED"}"#);
    let (client, handle) = make_client(sender);

    client.get_payment("pay_1").unwrap();
    client.get_payment("pay_1").unwrap();

    let calls = handle.0.calls_snapshot();
    assert_eq!(calls.len(), 3); // 1 auth + 2 resource calls, no re-auth
    assert_eq!(calls[0].url, "https://api.example.com/api/v1/auth/token");
}

#[test]
fn sends_signature_headers_on_a_signed_call_charge() {
    let sender = RecordingHttpSender::new();
    sender.enqueue(200, r#"{"accessToken":"jwt_1","tokenType":"Bearer","expiresIn":3600}"#);
    sender.enqueue(
        201,
        r#"{"paymentId":"pay_1","status":"SUCCEEDED","requiresAction":false,"usedFallback":false}"#,
    );
    let (client, handle) = make_client(sender);

    client.charge(&ChargeParams::new(10.0, "USD"), None).unwrap();

    let calls = handle.0.calls_snapshot();
    let charge_call = &calls[1];
    assert_eq!(charge_call.url, "https://api.example.com/api/v1/payments/charge");
    assert!(charge_call.headers.contains_key("X-Signature"));
    assert!(charge_call.headers.contains_key("X-Timestamp"));
    assert_eq!(charge_call.headers["X-Merchant-Id"], "merchant_acme");
    let idempotency_key = &charge_call.headers["Idempotency-Key"];
    assert_eq!(idempotency_key.len(), 36);
    assert_eq!(charge_call.headers["Authorization"], "Bearer jwt_1");
}

#[test]
fn does_not_sign_a_get_request_get_payment() {
    let sender = RecordingHttpSender::new();
    sender.enqueue(200, r#"{"accessToken":"jwt_1","tokenType":"Bearer","expiresIn":3600}"#);
    sender.enqueue(200, r#"{"paymentId":"pay_1"}"#);
    let (client, handle) = make_client(sender);

    client.get_payment("pay_1").unwrap();

    let calls = handle.0.calls_snapshot();
    let get_call = &calls[1];
    assert!(!get_call.headers.contains_key("X-Signature"));
    assert!(!get_call.headers.contains_key("Idempotency-Key"));
}

#[test]
fn reuses_a_caller_supplied_idempotency_key_across_an_explicit_retry() {
    let sender = RecordingHttpSender::new();
    sender.enqueue(200, r#"{"accessToken":"jwt_1","tokenType":"Bearer","expiresIn":3600}"#);
    sender.enqueue(201, r#"{"paymentId":"pay_1"}"#);
    let (client, handle) = make_client(sender);

    client.charge(&ChargeParams::new(10.0, "USD"), Some("my-fixed-key")).unwrap();

    let calls = handle.0.calls_snapshot();
    assert_eq!(calls[1].headers["Idempotency-Key"], "my-fixed-key");
}

#[test]
fn retries_exactly_once_with_a_fresh_token_on_a_401_then_succeeds() {
    let sender = RecordingHttpSender::new();
    sender.enqueue(200, r#"{"accessToken":"jwt_1","tokenType":"Bearer","expiresIn":3600}"#);
    sender.enqueue(401, r#"{"statusCode":401,"error":"Invalid or expired token","code":"INVALID_TOKEN"}"#);
    sender.enqueue(200, r#"{"accessToken":"jwt_2","tokenType":"Bearer","expiresIn":3600}"#);
    sender.enqueue(200, r#"{"paymentId":"pay_1"}"#);
    let (client, handle) = make_client(sender);

    let result = client.get_payment("pay_1").unwrap();

    assert_eq!(result.payment_id, "pay_1");
    let calls = handle.0.calls_snapshot();
    assert_eq!(calls.len(), 4); // auth, 401, re-auth, success
    assert_eq!(calls[3].headers["Authorization"], "Bearer jwt_2");
}

#[test]
fn throws_omniswitch_api_error_with_status_code_code_error_from_the_response_body() {
    let sender = RecordingHttpSender::new();
    sender.enqueue(200, r#"{"accessToken":"jwt_1","tokenType":"Bearer","expiresIn":3600}"#);
    sender.enqueue(
        422,
        r#"{"statusCode":422,"error":"Charge of $50.00 USD exceeds this delegation's per-transaction limit","code":"DELEGATION_PER_TRANSACTION_LIMIT_EXCEEDED"}"#,
    );
    let (client, _handle) = make_client(sender);

    let err = client.charge(&ChargeParams::new(50.0, "USD"), None).unwrap_err();
    let api_err = err.downcast_ref::<crate::errors::OmniSwitchApiError>().unwrap();
    assert_eq!(api_err.status_code, 422);
    assert_eq!(api_err.code.as_deref(), Some("DELEGATION_PER_TRANSACTION_LIMIT_EXCEEDED"));
}

#[test]
fn throws_a_clear_mfa_not_supported_error_instead_of_silently_returning_a_restricted_token() {
    let sender = RecordingHttpSender::new();
    sender.enqueue(
        200,
        r#"{"accessToken":"jwt_pending","tokenType":"Bearer","expiresIn":300,"mfaRequired":true}"#,
    );
    let (client, _handle) = make_client(sender);

    let err = client.get_payment("pay_1").unwrap_err();
    let api_err = err.downcast_ref::<crate::errors::OmniSwitchApiError>().unwrap();
    assert_eq!(api_err.code.as_deref(), Some("MFA_NOT_SUPPORTED"));
}

#[test]
fn refund_capture_cancel_all_sign_and_hit_the_expected_paths() {
    let sender = RecordingHttpSender::new();
    sender.enqueue(200, r#"{"accessToken":"jwt_1","tokenType":"Bearer","expiresIn":3600}"#);
    sender.enqueue(200, r#"{"paymentId":"pay_1","status":"REFUNDED"}"#);
    sender.enqueue(200, r#"{"paymentId":"pay_1","status":"SUCCEEDED"}"#);
    sender.enqueue(200, r#"{"paymentId":"pay_1","status":"CANCELLED"}"#);
    let (client, handle) = make_client(sender);

    client.refund("pay_1", Some(&RefundParams::new(Some(5.0), None)), None).unwrap();
    client.capture("pay_1", None::<&CaptureParams>, None).unwrap();
    client.cancel("pay_1", None).unwrap();

    let calls = handle.0.calls_snapshot();
    assert_eq!(calls[1].url, "https://api.example.com/api/v1/payments/pay_1/refund");
    assert_eq!(calls[2].url, "https://api.example.com/api/v1/payments/pay_1/capture");
    assert_eq!(calls[3].url, "https://api.example.com/api/v1/payments/pay_1/cancel");
    for call in &calls[1..] {
        assert!(call.headers.contains_key("X-Signature"));
    }
}

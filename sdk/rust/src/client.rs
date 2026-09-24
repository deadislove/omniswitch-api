//! Deliberately merchant-credential-only in this first cut — an
//! AGENT-delegation client is real future scope this struct doesn't
//! cover yet.

use crate::errors::OmniSwitchApiError;
use crate::http_sender::{HttpSender, UreqHttpSender};
use crate::signing::sign_request;
use crate::types::{
    CancelResponse, CaptureParams, CaptureResponse, ChargeParams, ChargeResponse, PaymentDetail, RefundParams,
    RefundResponse,
};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::error::Error;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const TOKEN_REFRESH_SKEW_SECONDS: i64 = 30;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;

pub struct OmniSwitchClientOptions {
    /// e.g. "https://api.example.com/api/v1" — no trailing slash.
    pub base_url: String,
    pub api_key_id: String,
    pub api_key_secret: String,
    /// This merchant's HMAC signing key (from POST /admin/merchants or a rotation call) — never the JWT.
    pub hmac_secret: String,
    /// Business-facing merchant id, sent as X-Merchant-Id on every signed request.
    pub merchant_id: String,
    /// Injectable for tests/non-standard runtimes — defaults to a ureq-backed sender.
    pub http_sender: Option<Box<dyn HttpSender>>,
    /// Request timeout, milliseconds. Default 30000.
    pub timeout_ms: u64,
}

impl OmniSwitchClientOptions {
    pub fn new(
        base_url: impl Into<String>,
        api_key_id: impl Into<String>,
        api_key_secret: impl Into<String>,
        hmac_secret: impl Into<String>,
        merchant_id: impl Into<String>,
    ) -> Self {
        Self {
            base_url: base_url.into(),
            api_key_id: api_key_id.into(),
            api_key_secret: api_key_secret.into(),
            hmac_secret: hmac_secret.into(),
            merchant_id: merchant_id.into(),
            http_sender: None,
            timeout_ms: DEFAULT_TIMEOUT_MS,
        }
    }
}

struct CachedToken {
    access_token: String,
    expires_at_seconds: i64,
}

pub struct OmniSwitchClient {
    base_url: String,
    api_key_id: String,
    api_key_secret: String,
    hmac_secret: String,
    merchant_id: String,
    http_sender: Box<dyn HttpSender>,
    timeout_ms: u64,
    token: Mutex<Option<CachedToken>>,
}

fn now_seconds() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64
}

impl OmniSwitchClient {
    pub fn new(options: OmniSwitchClientOptions) -> Self {
        Self {
            base_url: options.base_url.trim_end_matches('/').to_string(),
            api_key_id: options.api_key_id,
            api_key_secret: options.api_key_secret,
            hmac_secret: options.hmac_secret,
            merchant_id: options.merchant_id,
            http_sender: options.http_sender.unwrap_or_else(|| Box::new(UreqHttpSender)),
            timeout_ms: options.timeout_ms,
            token: Mutex::new(None),
        }
    }

    pub fn charge(&self, params: &ChargeParams, idempotency_key: Option<&str>) -> Result<ChargeResponse, Box<dyn Error>> {
        let body = self.request("POST", "/payments/charge", Some(params), true, idempotency_key, false)?;
        Ok(serde_json::from_value(body)?)
    }

    pub fn get_payment(&self, payment_id: &str) -> Result<PaymentDetail, Box<dyn Error>> {
        let path = format!("/payments/{}", urlencoding::encode(payment_id));
        let body = self.request::<()>("GET", &path, None, false, None, false)?;
        Ok(serde_json::from_value(body)?)
    }

    pub fn refund(
        &self,
        payment_id: &str,
        params: Option<&RefundParams>,
        idempotency_key: Option<&str>,
    ) -> Result<RefundResponse, Box<dyn Error>> {
        let path = format!("/payments/{}/refund", urlencoding::encode(payment_id));
        let default_params = RefundParams::default();
        let params = params.unwrap_or(&default_params);
        let body = self.request("POST", &path, Some(params), true, idempotency_key, false)?;
        Ok(serde_json::from_value(body)?)
    }

    pub fn capture(
        &self,
        payment_id: &str,
        params: Option<&CaptureParams>,
        idempotency_key: Option<&str>,
    ) -> Result<CaptureResponse, Box<dyn Error>> {
        let path = format!("/payments/{}/capture", urlencoding::encode(payment_id));
        let default_params = CaptureParams::default();
        let params = params.unwrap_or(&default_params);
        let body = self.request("POST", &path, Some(params), true, idempotency_key, false)?;
        Ok(serde_json::from_value(body)?)
    }

    pub fn cancel(&self, payment_id: &str, idempotency_key: Option<&str>) -> Result<CancelResponse, Box<dyn Error>> {
        let path = format!("/payments/{}/cancel", urlencoding::encode(payment_id));
        let empty = serde_json::json!({});
        let body = self.request("POST", &path, Some(&empty), true, idempotency_key, false)?;
        Ok(serde_json::from_value(body)?)
    }

    /// Public so a caller can pre-warm the token or check credentials without making a payments call.
    pub fn authenticate(&self) -> Result<String, Box<dyn Error>> {
        {
            let guard = self.token.lock().unwrap();
            if let Some(ref cached) = *guard {
                if cached.expires_at_seconds - TOKEN_REFRESH_SKEW_SECONDS > now_seconds() {
                    return Ok(cached.access_token.clone());
                }
            }
        }

        let mut guard = self.token.lock().unwrap();
        if let Some(ref cached) = *guard {
            if cached.expires_at_seconds - TOKEN_REFRESH_SKEW_SECONDS > now_seconds() {
                return Ok(cached.access_token.clone());
            }
        }

        let body = serde_json::json!({ "apiKeyId": self.api_key_id, "apiKeySecret": self.api_key_secret });
        let headers = HashMap::from([("Content-Type".to_string(), "application/json".to_string())]);
        let result = self.http_sender.send(
            "POST",
            &format!("{}/auth/token", self.base_url),
            &headers,
            Some(&body.to_string()),
            self.timeout_ms,
        )?;

        if !(200..300).contains(&result.status_code) {
            return Err(Box::new(OmniSwitchApiError::from_response(result.status_code, &result.body)));
        }

        let parsed: Value = serde_json::from_str(&result.body)?;
        if parsed.get("mfaRequired").and_then(Value::as_bool).unwrap_or(false) {
            // A pending, MFA-restricted token — this SDK is for
            // server-side integrations authenticating with an API
            // key/secret pair, which shouldn't have MFA enabled on that
            // credential in the first place (MFA guards the human
            // dashboard login path). Surfacing this as a clear error is
            // more useful than silently returning a token every
            // subsequent call would then fail against anyway.
            return Err(Box::new(OmniSwitchApiError::new(
                401,
                "This merchant has MFA enabled — this SDK does not support the MFA challenge flow. Use a credential without MFA enabled for server-side integrations.",
                Some("MFA_NOT_SUPPORTED".to_string()),
            )));
        }

        let access_token = parsed["accessToken"].as_str().unwrap_or_default().to_string();
        let expires_in = parsed["expiresIn"].as_i64().unwrap_or(0);
        *guard = Some(CachedToken { access_token: access_token.clone(), expires_at_seconds: now_seconds() + expires_in });
        Ok(access_token)
    }

    fn request<B: Serialize>(
        &self,
        method: &str,
        path: &str,
        body_obj: Option<&B>,
        signed: bool,
        idempotency_key: Option<&str>,
        is_retry: bool,
    ) -> Result<Value, Box<dyn Error>> {
        let access_token = self.authenticate()?;
        let body_str = match body_obj {
            Some(b) => Some(serde_json::to_string(b)?),
            None => None,
        };
        let full_path = format!("/api/v1{}", path);

        let mut headers = HashMap::from([
            ("Content-Type".to_string(), "application/json".to_string()),
            ("Authorization".to_string(), format!("Bearer {}", access_token)),
        ]);

        if signed {
            let sig = sign_request(&self.hmac_secret, method, &full_path, body_str.as_deref().unwrap_or(""));
            headers.insert("X-Signature".to_string(), sig.signature);
            headers.insert("X-Timestamp".to_string(), sig.timestamp);
            headers.insert("X-Merchant-Id".to_string(), self.merchant_id.clone());
            // Generate a fresh UUID v4 per logical call unless the
            // caller is deliberately retrying the same one — this SDK
            // doesn't retry on its own, so "per call to this method" and
            // "per logical operation" already coincide for a single
            // call.
            headers.insert(
                "Idempotency-Key".to_string(),
                idempotency_key.map(|s| s.to_string()).unwrap_or_else(|| Uuid::new_v4().to_string()),
            );
        }

        let had_cached_token = self.token.lock().unwrap().is_some();
        let result = self.http_sender.send(
            method,
            &format!("{}{}", self.base_url, path),
            &headers,
            body_str.as_deref(),
            self.timeout_ms,
        )?;

        if result.status_code == 401 && had_cached_token && !is_retry {
            // The cached token may have been revoked server-side
            // (rotation, deactivation) even though it hasn't hit its own
            // expiry yet — exactly one retry with a forced
            // re-authentication, guarded by is_retry so a resource
            // endpoint that 401s even against a freshly issued token
            // can't recurse unboundedly.
            *self.token.lock().unwrap() = None;
            return self.request(method, path, body_obj, signed, idempotency_key, true);
        }

        if !(200..300).contains(&result.status_code) {
            return Err(Box::new(OmniSwitchApiError::from_response(result.status_code, &result.body)));
        }

        Ok(serde_json::from_str(&result.body)?)
    }
}

//! Mirrors sdk/node's errors.ts exactly.

use serde_json::Value;
use std::fmt;

/// Every non-2xx OmniSwitch response is shaped `{statusCode, error,
/// code}` (validation failures add a `message` array instead of
/// `error`). `code` is the stable, machine-readable field meant to be
/// branched on; `error`/`message` are for logging, not string-matching.
#[derive(Debug, Clone)]
pub struct OmniSwitchApiError {
    pub status_code: u16,
    pub message: String,
    pub code: Option<String>,
    pub details: Option<Value>,
}

impl OmniSwitchApiError {
    pub fn new(status_code: u16, message: impl Into<String>, code: Option<String>) -> Self {
        Self { status_code, message: message.into(), code, details: None }
    }

    pub fn from_response(status_code: u16, raw_body: &str) -> Self {
        let body: Option<Value> = if raw_body.is_empty() { None } else { serde_json::from_str(raw_body).ok() };

        let mut message: Option<String> = None;
        let mut code: Option<String> = None;

        if let Some(ref value) = body {
            if let Some(error) = value.get("error").and_then(Value::as_str) {
                message = Some(error.to_string());
            } else if let Some(message_field) = value.get("message") {
                message = if let Some(arr) = message_field.as_array() {
                    Some(
                        arr.iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join("; "),
                    )
                } else {
                    message_field.as_str().map(|s| s.to_string())
                };
            }
            code = value.get("code").and_then(Value::as_str).map(|s| s.to_string());
        }

        let message = message.unwrap_or_else(|| format!("OmniSwitch API request failed with HTTP {}", status_code));

        Self { status_code, message, code, details: body }
    }
}

impl fmt::Display for OmniSwitchApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "OmniSwitchApiError({}): {}", self.status_code, self.message)
    }
}

impl std::error::Error for OmniSwitchApiError {}

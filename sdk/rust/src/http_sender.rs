//! The one seam `OmniSwitchClient` depends on for making HTTP calls —
//! injectable so tests can supply a mock without a real network call,
//! the same role `fetch` plays in the Node SDK.

use std::collections::HashMap;
use std::error::Error;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct HttpResult {
    pub status_code: u16,
    pub body: String,
}

pub trait HttpSender: Send + Sync {
    fn send(
        &self,
        method: &str,
        url: &str,
        headers: &HashMap<String, String>,
        body: Option<&str>,
        timeout_ms: u64,
    ) -> Result<HttpResult, Box<dyn Error>>;
}

/// Default [`HttpSender`] — `ureq` (synchronous, minimal dependency
/// surface — no async runtime forced on callers), not tied to any one
/// async executor.
pub struct UreqHttpSender;

impl HttpSender for UreqHttpSender {
    fn send(
        &self,
        method: &str,
        url: &str,
        headers: &HashMap<String, String>,
        body: Option<&str>,
        timeout_ms: u64,
    ) -> Result<HttpResult, Box<dyn Error>> {
        let agent = ureq::AgentBuilder::new().timeout(Duration::from_millis(timeout_ms)).build();
        let mut request = agent.request(method, url);
        for (key, value) in headers {
            request = request.set(key, value);
        }

        let result = match body {
            Some(b) => request.send_string(b),
            None => request.call(),
        };

        match result {
            Ok(response) => {
                let status_code = response.status();
                let body_text = response.into_string()?;
                Ok(HttpResult { status_code, body: body_text })
            }
            Err(ureq::Error::Status(status_code, response)) => {
                // ureq treats any non-2xx as an Err — normalize back to a
                // plain HttpResult so the client's own status-code
                // branching (401 retry, non-2xx -> OmniSwitchApiError)
                // doesn't need two different code paths.
                let body_text = response.into_string().unwrap_or_default();
                Ok(HttpResult { status_code, body: body_text })
            }
            Err(e) => Err(Box::new(e)),
        }
    }
}

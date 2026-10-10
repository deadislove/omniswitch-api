"""Deliberately merchant-credential-only in this first cut — an
AGENT-delegation client is real future scope this class doesn't cover
yet.
"""

import json
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Any, Dict, Optional
from urllib.parse import quote

from .errors import OmniSwitchApiError
from .http_sender import HttpSender, urllib_http_sender
from .signing import sign_request
from .types import (
    CancelResponse,
    CaptureParams,
    CaptureResponse,
    ChargeParams,
    ChargeResponse,
    PaymentDetail,
    RefundParams,
    RefundResponse,
)

_TOKEN_REFRESH_SKEW_SECONDS = 30
_DEFAULT_TIMEOUT_MS = 30_000


@dataclass
class OmniSwitchClientOptions:
    """``base_url``: e.g. "https://api.example.com/api/v1" — no trailing slash."""

    base_url: str
    api_key_id: str
    api_key_secret: str
    # This merchant's HMAC signing key (from POST /admin/merchants or a rotation call) — never the JWT.
    hmac_secret: str
    # Business-facing merchant id, sent as X-Merchant-Id on every signed request.
    merchant_id: str
    # Injectable for tests/non-standard runtimes — defaults to a urllib-backed sender.
    http_sender: Optional[HttpSender] = None
    # Request timeout, milliseconds. Default 30000.
    timeout_ms: int = _DEFAULT_TIMEOUT_MS


@dataclass
class _CachedToken:
    access_token: str
    expires_at_seconds: float


class OmniSwitchClient:
    def __init__(self, options: OmniSwitchClientOptions) -> None:
        self._options = options
        self._base_url = options.base_url.rstrip("/")
        self._http_sender: HttpSender = options.http_sender or urllib_http_sender
        self._token: Optional[_CachedToken] = None
        self._auth_lock = threading.Lock()

    def charge(self, params: ChargeParams, idempotency_key: Optional[str] = None) -> ChargeResponse:
        body = self._request("POST", "/payments/charge", params.to_json_dict(), signed=True, idempotency_key=idempotency_key)
        return ChargeResponse.from_dict(body)

    def get_payment(self, payment_id: str) -> PaymentDetail:
        body = self._request("GET", f"/payments/{quote(payment_id, safe='')}", None, signed=False, idempotency_key=None)
        return PaymentDetail.from_dict(body)

    def refund(
        self, payment_id: str, params: Optional[RefundParams] = None, idempotency_key: Optional[str] = None
    ) -> RefundResponse:
        body = self._request(
            "POST",
            f"/payments/{quote(payment_id, safe='')}/refund",
            (params or RefundParams()).to_json_dict(),
            signed=True,
            idempotency_key=idempotency_key,
        )
        return RefundResponse.from_dict(body)

    def capture(
        self, payment_id: str, params: Optional[CaptureParams] = None, idempotency_key: Optional[str] = None
    ) -> CaptureResponse:
        body = self._request(
            "POST",
            f"/payments/{quote(payment_id, safe='')}/capture",
            (params or CaptureParams()).to_json_dict(),
            signed=True,
            idempotency_key=idempotency_key,
        )
        return CaptureResponse.from_dict(body)

    def cancel(self, payment_id: str, idempotency_key: Optional[str] = None) -> CancelResponse:
        body = self._request(
            "POST",
            f"/payments/{quote(payment_id, safe='')}/cancel",
            {},
            signed=True,
            idempotency_key=idempotency_key,
        )
        return CancelResponse.from_dict(body)

    def authenticate(self) -> str:
        """Public so a caller can pre-warm the token or check credentials without making a payments call."""
        current = self._token
        if current is not None and current.expires_at_seconds - _TOKEN_REFRESH_SKEW_SECONDS > time.time():
            return current.access_token

        with self._auth_lock:
            current = self._token
            if current is not None and current.expires_at_seconds - _TOKEN_REFRESH_SKEW_SECONDS > time.time():
                return current.access_token

            body_str = json.dumps(
                {"apiKeyId": self._options.api_key_id, "apiKeySecret": self._options.api_key_secret}
            )
            result = self._http_sender(
                "POST",
                f"{self._base_url}/auth/token",
                {"Content-Type": "application/json"},
                body_str,
                self._options.timeout_ms,
            )
            if not (200 <= result.status_code < 300):
                raise OmniSwitchApiError.from_response(result.status_code, result.body)

            parsed = json.loads(result.body)
            if parsed.get("mfaRequired"):
                # A pending, MFA-restricted token — this SDK is for
                # server-side integrations authenticating with an API
                # key/secret pair, which shouldn't have MFA enabled on
                # that credential in the first place (MFA guards the
                # human dashboard login path). Surfacing this as a clear
                # error is more useful than silently returning a token
                # every subsequent call would then fail against anyway.
                raise OmniSwitchApiError(
                    401,
                    "This merchant has MFA enabled — this SDK does not support the MFA challenge flow. "
                    "Use a credential without MFA enabled for server-side integrations.",
                    "MFA_NOT_SUPPORTED",
                )

            access_token = parsed["accessToken"]
            expires_in = parsed["expiresIn"]
            self._token = _CachedToken(access_token=access_token, expires_at_seconds=time.time() + expires_in)
            return access_token

    def _request(
        self,
        method: str,
        path: str,
        body_obj: Optional[Dict[str, Any]],
        signed: bool,
        idempotency_key: Optional[str],
        is_retry: bool = False,
    ) -> Dict[str, Any]:
        access_token = self.authenticate()
        body_str = json.dumps(body_obj) if body_obj is not None else None
        full_path = f"/api/v1{path}"

        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {access_token}"}

        if signed:
            sig = sign_request(self._options.hmac_secret, method, full_path, body_str or "")
            headers["X-Signature"] = sig.signature
            headers["X-Timestamp"] = sig.timestamp
            headers["X-Merchant-Id"] = self._options.merchant_id
            # Generate a fresh UUID v4 per logical call unless the caller
            # is deliberately retrying the same one — this SDK doesn't
            # retry on its own, so "per call to this method" and "per
            # logical operation" already coincide for a single call.
            headers["Idempotency-Key"] = idempotency_key or str(uuid.uuid4())

        result = self._http_sender(method, f"{self._base_url}{path}", headers, body_str, self._options.timeout_ms)

        if result.status_code == 401 and self._token is not None and not is_retry:
            # The cached token may have been revoked server-side
            # (rotation, deactivation) even though it hasn't hit its own
            # expiry yet — exactly one retry with a forced
            # re-authentication, guarded by is_retry so a resource
            # endpoint that 401s even against a freshly issued token
            # can't recurse unboundedly.
            self._token = None
            return self._request(method, path, body_obj, signed, idempotency_key, is_retry=True)

        if not (200 <= result.status_code < 300):
            raise OmniSwitchApiError.from_response(result.status_code, result.body)

        return json.loads(result.body)

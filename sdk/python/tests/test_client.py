import json
import re
from typing import Dict, List, Optional

import pytest
from omniswitch_sdk.client import OmniSwitchClient, OmniSwitchClientOptions
from omniswitch_sdk.errors import OmniSwitchApiError
from omniswitch_sdk.http_sender import HttpResult
from omniswitch_sdk.types import ChargeParams, RefundParams


class RecordingHttpSender:
    """Records every call, replays queued canned responses in order — the mock-HTTP-layer role fetchMock plays in the Node test suite."""

    def __init__(self) -> None:
        self.calls: List[dict] = []
        self._responses: List[HttpResult] = []

    def enqueue(self, status: int, json_body: str) -> None:
        self._responses.append(HttpResult(status_code=status, body=json_body))

    def __call__(self, method: str, url: str, headers: Dict[str, str], body: Optional[str], timeout_ms: int) -> HttpResult:
        self.calls.append({"method": method, "url": url, "headers": dict(headers), "body": body})
        if not self._responses:
            raise AssertionError("No more canned responses queued")
        return self._responses.pop(0)


def make_client(sender: RecordingHttpSender) -> OmniSwitchClient:
    return OmniSwitchClient(
        OmniSwitchClientOptions(
            base_url="https://api.example.com/api/v1",
            api_key_id="ak_test",
            api_key_secret="sk_test",
            hmac_secret="h" * 64,
            merchant_id="merchant_acme",
            http_sender=sender,
        )
    )


def test_authenticates_once_then_reuses_the_cached_token_for_a_second_call():
    sender = RecordingHttpSender()
    sender.enqueue(200, json.dumps({"accessToken": "jwt_1", "tokenType": "Bearer", "expiresIn": 3600}))
    sender.enqueue(200, json.dumps({"paymentId": "pay_1", "status": "SUCCEEDED"}))
    sender.enqueue(200, json.dumps({"paymentId": "pay_1", "status": "SUCCEEDED"}))
    client = make_client(sender)

    client.get_payment("pay_1")
    client.get_payment("pay_1")

    assert len(sender.calls) == 3  # 1 auth + 2 resource calls, no re-auth
    assert sender.calls[0]["url"] == "https://api.example.com/api/v1/auth/token"


def test_sends_signature_headers_on_a_signed_call_charge():
    sender = RecordingHttpSender()
    sender.enqueue(200, json.dumps({"accessToken": "jwt_1", "tokenType": "Bearer", "expiresIn": 3600}))
    sender.enqueue(
        201,
        json.dumps({"paymentId": "pay_1", "status": "SUCCEEDED", "requiresAction": False, "usedFallback": False}),
    )
    client = make_client(sender)

    client.charge(ChargeParams(amount=10, currency="USD"))

    charge_call = sender.calls[1]
    assert charge_call["url"] == "https://api.example.com/api/v1/payments/charge"
    assert charge_call["headers"]["X-Signature"]
    assert charge_call["headers"]["X-Timestamp"]
    assert charge_call["headers"]["X-Merchant-Id"] == "merchant_acme"
    assert re.match(r"^[0-9a-f-]{36}$", charge_call["headers"]["Idempotency-Key"])
    assert charge_call["headers"]["Authorization"] == "Bearer jwt_1"


def test_does_not_sign_a_get_request_get_payment():
    sender = RecordingHttpSender()
    sender.enqueue(200, json.dumps({"accessToken": "jwt_1", "tokenType": "Bearer", "expiresIn": 3600}))
    sender.enqueue(200, json.dumps({"paymentId": "pay_1"}))
    client = make_client(sender)

    client.get_payment("pay_1")

    get_call = sender.calls[1]
    assert "X-Signature" not in get_call["headers"]
    assert "Idempotency-Key" not in get_call["headers"]


def test_reuses_a_caller_supplied_idempotency_key_across_an_explicit_retry():
    sender = RecordingHttpSender()
    sender.enqueue(200, json.dumps({"accessToken": "jwt_1", "tokenType": "Bearer", "expiresIn": 3600}))
    sender.enqueue(201, json.dumps({"paymentId": "pay_1"}))
    client = make_client(sender)

    client.charge(ChargeParams(amount=10, currency="USD"), idempotency_key="my-fixed-key")

    assert sender.calls[1]["headers"]["Idempotency-Key"] == "my-fixed-key"


def test_retries_exactly_once_with_a_fresh_token_on_a_401_then_succeeds():
    sender = RecordingHttpSender()
    sender.enqueue(200, json.dumps({"accessToken": "jwt_1", "tokenType": "Bearer", "expiresIn": 3600}))
    sender.enqueue(401, json.dumps({"statusCode": 401, "error": "Invalid or expired token", "code": "INVALID_TOKEN"}))
    sender.enqueue(200, json.dumps({"accessToken": "jwt_2", "tokenType": "Bearer", "expiresIn": 3600}))
    sender.enqueue(200, json.dumps({"paymentId": "pay_1"}))
    client = make_client(sender)

    result = client.get_payment("pay_1")

    assert result.paymentId == "pay_1"
    assert len(sender.calls) == 4  # auth, 401, re-auth, success
    assert sender.calls[3]["headers"]["Authorization"] == "Bearer jwt_2"


def test_throws_omniswitch_api_error_with_status_code_code_error_from_the_response_body():
    sender = RecordingHttpSender()
    sender.enqueue(200, json.dumps({"accessToken": "jwt_1", "tokenType": "Bearer", "expiresIn": 3600}))
    sender.enqueue(
        422,
        json.dumps(
            {
                "statusCode": 422,
                "error": "Charge of $50.00 USD exceeds this delegation's per-transaction limit",
                "code": "DELEGATION_PER_TRANSACTION_LIMIT_EXCEEDED",
            }
        ),
    )
    client = make_client(sender)

    with pytest.raises(OmniSwitchApiError) as exc_info:
        client.charge(ChargeParams(amount=50, currency="USD"))
    assert exc_info.value.status_code == 422
    assert exc_info.value.code == "DELEGATION_PER_TRANSACTION_LIMIT_EXCEEDED"


def test_throws_a_clear_mfa_not_supported_error_instead_of_silently_returning_a_restricted_token():
    sender = RecordingHttpSender()
    sender.enqueue(
        200, json.dumps({"accessToken": "jwt_pending", "tokenType": "Bearer", "expiresIn": 300, "mfaRequired": True})
    )
    client = make_client(sender)

    with pytest.raises(OmniSwitchApiError) as exc_info:
        client.get_payment("pay_1")
    assert exc_info.value.code == "MFA_NOT_SUPPORTED"


def test_refund_capture_cancel_all_sign_and_hit_the_expected_paths():
    sender = RecordingHttpSender()
    sender.enqueue(200, json.dumps({"accessToken": "jwt_1", "tokenType": "Bearer", "expiresIn": 3600}))
    sender.enqueue(200, json.dumps({"paymentId": "pay_1", "status": "REFUNDED"}))
    sender.enqueue(200, json.dumps({"paymentId": "pay_1", "status": "SUCCEEDED"}))
    sender.enqueue(200, json.dumps({"paymentId": "pay_1", "status": "CANCELLED"}))
    client = make_client(sender)

    client.refund("pay_1", RefundParams(amount=5))
    client.capture("pay_1")
    client.cancel("pay_1")

    assert sender.calls[1]["url"] == "https://api.example.com/api/v1/payments/pay_1/refund"
    assert sender.calls[2]["url"] == "https://api.example.com/api/v1/payments/pay_1/capture"
    assert sender.calls[3]["url"] == "https://api.example.com/api/v1/payments/pay_1/cancel"
    for call in sender.calls[1:]:
        assert call["headers"]["X-Signature"]

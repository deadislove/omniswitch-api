import time
from typing import Optional

from omniswitch_sdk.signing import hmac_sha256_hex
from omniswitch_sdk.webhooks import verify_webhook_signature

SECRET = "a" * 64
BODY = '{"event":"dispute.created","paymentId":"pay_1"}'


def sign(secret: str, body: str, timestamp: Optional[int] = None) -> str:
    ts = timestamp if timestamp is not None else int(time.time())
    signature = hmac_sha256_hex(secret, f"{ts}.{body}")
    return f"t={ts},v1={signature}"


def test_accepts_a_correctly_signed_fresh_payload():
    assert verify_webhook_signature(SECRET, BODY, sign(SECRET, BODY)) is True


def test_rejects_a_payload_signed_with_the_wrong_secret():
    assert verify_webhook_signature(SECRET, BODY, sign("b" * 64, BODY)) is False


def test_rejects_a_mutated_body_against_a_signature_computed_for_the_original():
    header = sign(SECRET, BODY)
    assert verify_webhook_signature(SECRET, BODY + "tampered", header) is False


def test_rejects_a_missing_signature_header():
    assert verify_webhook_signature(SECRET, BODY, None) is False
    assert verify_webhook_signature(SECRET, BODY, "") is False


def test_rejects_a_malformed_header():
    assert verify_webhook_signature(SECRET, BODY, "v1=deadbeef") is False
    assert verify_webhook_signature(SECRET, BODY, "t=1700000000") is False
    assert verify_webhook_signature(SECRET, BODY, "garbage") is False


def test_rejects_a_timestamp_outside_the_tolerance_window():
    stale_timestamp = int(time.time()) - 10 * 60
    header = sign(SECRET, BODY, stale_timestamp)
    assert verify_webhook_signature(SECRET, BODY, header) is False


def test_accepts_a_custom_tolerance_window():
    timestamp = int(time.time()) - 60
    header = sign(SECRET, BODY, timestamp)
    assert verify_webhook_signature(SECRET, BODY, header, 30) is False
    assert verify_webhook_signature(SECRET, BODY, header, 120) is True


def test_rejects_a_non_hex_v1_value_without_throwing():
    header = "t=1700000000,v1=not-hex!!"
    # Should not raise.
    result = verify_webhook_signature(SECRET, BODY, header)
    assert result is False

import time

from omniswitch_sdk.signing import hmac_sha256_hex, sign_request


def test_produces_the_exact_signature_hmac_signature_guard_verifies():
    secret = "a" * 64
    result = sign_request(secret, "post", "/api/v1/payments/charge", '{"amount":10}')

    expected = hmac_sha256_hex(secret, f'{result.timestamp}.POST./api/v1/payments/charge.{{"amount":10}}')
    assert result.signature == expected


def test_uppercases_the_method_regardless_of_caller_casing():
    secret = "a" * 64
    lower = sign_request(secret, "get", "/api/v1/payments/pay_1", "")
    recomputed = hmac_sha256_hex(secret, f"{lower.timestamp}.GET./api/v1/payments/pay_1.")
    assert lower.signature == recomputed


def test_returns_a_unix_seconds_timestamp_as_a_string():
    result = sign_request("secret", "POST", "/api/v1/payments/charge", "{}")
    assert result.timestamp.isdigit()
    assert abs(time.time() - int(result.timestamp)) < 5


def test_produces_a_different_signature_for_a_different_body():
    secret = "a" * 64
    a = sign_request(secret, "POST", "/api/v1/payments/charge", '{"amount":10}')
    b = sign_request(secret, "POST", "/api/v1/payments/charge", '{"amount":20}')
    assert a.signature != b.signature

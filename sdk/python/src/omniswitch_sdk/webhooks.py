"""Outbound webhook signature verification — mirrors sdk/node's webhooks.ts exactly."""

import hmac
import time

from .signing import hmac_sha256_hex

DEFAULT_TOLERANCE_SECONDS = 5 * 60


def verify_webhook_signature(
    secret: str,
    raw_body: str,
    signature_header: "str | None",
    tolerance_seconds: int = DEFAULT_TOLERANCE_SECONDS,
) -> bool:
    """Verifies the ``X-OmniSwitch-Signature`` header OmniSwitch signs its
    own outbound webhooks with (dispute/subscription/AML-review/sanctions-
    screening notifications) — ``t=<unix seconds>,v1=<hex HMAC-SHA256
    digest>`` over ``"${timestamp}.${rawBody}"``, keyed by the same
    merchant HMAC secret :func:`~omniswitch_sdk.signing.sign_request`
    uses. This is the verify-side mirror of the server's own signing
    function.

    ``raw_body`` must be the exact bytes received on the wire — verifying
    against a re-serialized payload can silently fail for payloads whose
    key order or number formatting changes on parse-then-restringify.

    Returns ``False`` for a malformed header, an expired timestamp, or a
    mismatched signature — never raises, so a caller can gate a ``401``
    response on a single boolean check.
    """
    if not signature_header:
        return False

    parts: dict[str, str] = {}
    for part in signature_header.split(","):
        kv = part.split("=", 1)
        if len(kv) == 2 and kv[0] and kv[1]:
            parts[kv[0]] = kv[1]

    timestamp = parts.get("t")
    provided_signature = parts.get("v1")
    if not timestamp or not provided_signature:
        return False

    try:
        request_time_seconds = int(timestamp)
    except ValueError:
        return False

    if abs(time.time() - request_time_seconds) > tolerance_seconds:
        return False

    expected_signature = hmac_sha256_hex(secret, f"{timestamp}.{raw_body}")

    try:
        expected_bytes = bytes.fromhex(expected_signature)
        provided_bytes = bytes.fromhex(provided_signature)
    except ValueError:
        return False

    return len(expected_bytes) == len(provided_bytes) and hmac.compare_digest(expected_bytes, provided_bytes)

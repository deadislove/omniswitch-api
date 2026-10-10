"""HMAC request signing — mirrors sdk/node's signing.ts exactly."""

import hashlib
import hmac
import time
from dataclasses import dataclass


@dataclass(frozen=True)
class SignResult:
    signature: str
    timestamp: str


def sign_request(secret: str, method: str, path: str, body: str) -> SignResult:
    """Computes the ``X-Signature``/``X-Timestamp`` pair ``HmacSignatureGuard``
    verifies server-side: ``HMAC-SHA256(secret, "${timestamp}.${method}.${path}.${rawBody}")``,
    hex digest. ``path`` must be the exact request path the server sees,
    including the ``/api/v1`` prefix and query string if any — the guard
    signs ``request.originalUrl``, not a normalized or query-stripped
    version. ``body`` must be the exact bytes sent on the wire —
    :class:`~omniswitch_sdk.client.OmniSwitchClient` always signs the
    same JSON string it then sends, never a value re-serialized
    afterward.
    """
    timestamp = str(int(time.time()))
    signed_payload = f"{timestamp}.{method.upper()}.{path}.{body}"
    signature = hmac_sha256_hex(secret, signed_payload)
    return SignResult(signature=signature, timestamp=timestamp)


def hmac_sha256_hex(secret: str, payload: str) -> str:
    return hmac.new(secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()

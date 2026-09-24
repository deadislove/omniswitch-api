"""Mirrors sdk/node's errors.ts exactly."""

import json
from typing import Any, Optional


class OmniSwitchApiError(Exception):
    """Every non-2xx OmniSwitch response is shaped ``{statusCode, error,
    code}`` (validation failures add a ``message`` array instead of
    ``error``). ``code`` is the stable, machine-readable field meant to
    be branched on; ``error``/``message`` are for logging, not
    string-matching.
    """

    def __init__(
        self,
        status_code: int,
        message: str,
        code: Optional[str] = None,
        details: Optional[Any] = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.message = message
        self.code = code
        self.details = details

    @staticmethod
    def from_response(status_code: int, raw_body: str) -> "OmniSwitchApiError":
        body: Optional[dict] = None
        if raw_body:
            try:
                body = json.loads(raw_body)
            except (json.JSONDecodeError, TypeError):
                body = None

        message = None
        code = None
        if isinstance(body, dict):
            if body.get("error") is not None:
                message = body["error"]
            elif body.get("message") is not None:
                raw_message = body["message"]
                message = "; ".join(raw_message) if isinstance(raw_message, list) else raw_message
            code = body.get("code")

        if message is None:
            message = f"OmniSwitch API request failed with HTTP {status_code}"

        return OmniSwitchApiError(status_code, message, code, body)

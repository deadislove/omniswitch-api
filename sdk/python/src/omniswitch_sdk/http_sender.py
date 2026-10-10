"""The one seam OmniSwitchClient depends on for making HTTP calls —
injectable so tests can supply a mock without a real network call, the
same role `fetch` plays in the Node SDK.
"""

import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Callable, Dict, Optional

@dataclass
class HttpResult:
    status_code: int
    body: str


HttpSender = Callable[[str, str, Dict[str, str], Optional[str], int], HttpResult]


def urllib_http_sender(method: str, url: str, headers: Dict[str, str], body: Optional[str], timeout_ms: int) -> HttpResult:
    """Default :data:`HttpSender` — ``urllib.request``, part of the standard library, no external HTTP dependency."""
    data = body.encode("utf-8") if body is not None else None
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout_ms / 1000) as response:
            return HttpResult(status_code=response.status, body=response.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        # urllib raises on any non-2xx status instead of returning it —
        # normalize back to a plain HttpResult so the client's own
        # status-code branching (401 retry, non-2xx -> OmniSwitchApiError)
        # doesn't need two different code paths.
        return HttpResult(status_code=e.code, body=e.read().decode("utf-8"))

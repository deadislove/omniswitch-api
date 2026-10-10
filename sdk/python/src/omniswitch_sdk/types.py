"""Request/response shapes for the wrapped endpoints — mirrors sdk/node's
types.ts. Field names deliberately match the wire JSON (camelCase)
directly rather than translating to snake_case — this API is
consistently camelCase, and a translation layer is one more place a
field could silently drift from what the server actually sends/expects.
"""

from dataclasses import dataclass, fields, is_dataclass
from typing import Any, Dict, List, Optional, Type, TypeVar

T = TypeVar("T")


def _to_json_dict(obj: Any) -> Any:
    """Omits any field left as ``None`` — the same behavior ``JSON.stringify`` gives the Node SDK for an ``undefined`` field."""
    if is_dataclass(obj) and not isinstance(obj, type):
        result = {}
        for f in fields(obj):
            value = getattr(obj, f.name)
            if value is not None:
                result[f.name] = _to_json_dict(value)
        return result
    if isinstance(obj, list):
        return [_to_json_dict(v) for v in obj]
    return obj


def _from_dict(cls: Type[T], data: Dict[str, Any]) -> T:
    """Ignores unknown keys — the server may add fields this SDK doesn't wrap yet."""
    known_fields = {f.name for f in fields(cls)}
    return cls(**{k: v for k, v in data.items() if k in known_fields})


@dataclass
class BinInfo:
    bin: str
    country: str
    cardBrand: Optional[str] = None
    cardType: Optional[str] = None
    issuingBank: Optional[str] = None


@dataclass
class ChargeSplit:
    merchantId: str
    amount: float


@dataclass
class ChargeParams:
    """``amount`` is in major currency units, e.g. 99.99."""

    amount: float
    currency: str
    customerId: Optional[str] = None
    paymentMethodId: Optional[str] = None
    cardToken: Optional[str] = None
    orderId: Optional[str] = None
    description: Optional[str] = None
    statementDescriptor: Optional[str] = None
    binInfo: Optional[BinInfo] = None
    preferredProvider: Optional[str] = None  # STRIPE / ADYEN / PAYPAL / CHASE
    metadata: Optional[Dict[str, str]] = None
    category: Optional[str] = None
    captureMethod: Optional[str] = None  # "automatic" or "manual"
    presentmentCurrency: Optional[str] = None
    splits: Optional[List[ChargeSplit]] = None

    def to_json_dict(self) -> Dict[str, Any]:
        return _to_json_dict(self)


@dataclass
class RefundParams:
    """``amount`` omitted (``None``) means a full refund of the remaining refundable balance."""

    amount: Optional[float] = None
    reason: Optional[str] = None

    def to_json_dict(self) -> Dict[str, Any]:
        return _to_json_dict(self)


@dataclass
class CaptureParams:
    """``amount`` omitted (``None``) means a full capture of the remaining authorized amount."""

    amount: Optional[float] = None

    def to_json_dict(self) -> Dict[str, Any]:
        return _to_json_dict(self)


@dataclass
class EstimatedFee:
    amount: float
    currency: str


@dataclass
class ChargeResponse:
    paymentId: str = ""
    status: str = ""  # SUCCEEDED / REQUIRES_ACTION / REQUIRES_CAPTURE / FAILED / AMBIGUOUS / PENDING_APPROVAL
    requiresAction: bool = False
    usedFallback: bool = False
    pspTransactionId: Optional[str] = None
    pspProvider: Optional[str] = None  # STRIPE / ADYEN / PAYPAL / CHASE
    actionUrl: Optional[str] = None
    riskScore: Optional[float] = None
    estimatedFee: Optional[Dict[str, Any]] = None
    presentmentAmount: Optional[float] = None
    presentmentCurrency: Optional[str] = None
    createdAt: Optional[str] = None
    approvalId: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ChargeResponse":
        return _from_dict(cls, data)


@dataclass
class PaymentDetail:
    paymentId: str = ""
    status: str = ""
    amount: float = 0
    currency: str = ""
    merchantId: str = ""
    requiresAction: bool = False
    usedFallback: bool = False
    customerId: Optional[str] = None
    orderId: Optional[str] = None
    pspTransactionId: Optional[str] = None
    pspProvider: Optional[str] = None
    actionUrl: Optional[str] = None
    riskScore: Optional[float] = None
    estimatedFee: Optional[Dict[str, Any]] = None
    presentmentAmount: Optional[float] = None
    presentmentCurrency: Optional[str] = None
    createdAt: Optional[str] = None
    approvalId: Optional[str] = None
    metadata: Optional[Dict[str, str]] = None
    refunds: Optional[List[Any]] = None
    captures: Optional[List[Any]] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "PaymentDetail":
        return _from_dict(cls, data)


@dataclass
class RefundResponse:
    paymentId: str = ""
    status: str = ""
    totalRefunded: float = 0
    remainingRefundable: float = 0
    currency: str = ""
    refunds: Optional[List[Any]] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "RefundResponse":
        return _from_dict(cls, data)


@dataclass
class CaptureResponse:
    paymentId: str = ""
    status: str = ""
    pspTransactionId: str = ""
    amount: float = 0
    totalCaptured: float = 0
    remainingCapturable: float = 0
    currency: str = ""
    captures: Optional[List[Any]] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "CaptureResponse":
        return _from_dict(cls, data)


@dataclass
class CancelResponse:
    paymentId: str = ""
    status: str = ""

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "CancelResponse":
        return _from_dict(cls, data)

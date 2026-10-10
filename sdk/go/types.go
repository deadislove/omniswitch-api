package omniswitch

type BinInfo struct {
	Bin         string `json:"bin"`
	Country     string `json:"country"`
	CardBrand   string `json:"cardBrand,omitempty"`
	CardType    string `json:"cardType,omitempty"`
	IssuingBank string `json:"issuingBank,omitempty"`
}

type ChargeSplit struct {
	MerchantID string  `json:"merchantId"`
	Amount     float64 `json:"amount"`
}

// Amount is in major currency units, e.g. 99.99.
type ChargeParams struct {
	Amount              float64           `json:"amount"`
	Currency            string            `json:"currency"`
	CustomerID          string            `json:"customerId,omitempty"`
	PaymentMethodID     string            `json:"paymentMethodId,omitempty"`
	CardToken           string            `json:"cardToken,omitempty"`
	OrderID             string            `json:"orderId,omitempty"`
	Description         string            `json:"description,omitempty"`
	StatementDescriptor string            `json:"statementDescriptor,omitempty"`
	BinInfo             *BinInfo          `json:"binInfo,omitempty"`
	PreferredProvider   string            `json:"preferredProvider,omitempty"` // STRIPE / ADYEN / PAYPAL / CHASE
	Metadata            map[string]string `json:"metadata,omitempty"`
	Category            string            `json:"category,omitempty"`
	CaptureMethod       string            `json:"captureMethod,omitempty"` // "automatic" or "manual"
	PresentmentCurrency string            `json:"presentmentCurrency,omitempty"`
	Splits              []ChargeSplit     `json:"splits,omitempty"`
}

func NewChargeParams(amount float64, currency string) ChargeParams {
	return ChargeParams{Amount: amount, Currency: currency}
}

type EstimatedFee struct {
	Amount   float64 `json:"amount"`
	Currency string  `json:"currency"`
}

type ChargeResponse struct {
	PaymentID           string        `json:"paymentId"`
	Status              string        `json:"status"` // SUCCEEDED / REQUIRES_ACTION / REQUIRES_CAPTURE / FAILED / AMBIGUOUS / PENDING_APPROVAL
	PspTransactionID    string        `json:"pspTransactionId,omitempty"`
	PspProvider         string        `json:"pspProvider,omitempty"` // STRIPE / ADYEN / PAYPAL / CHASE
	ActionURL           string        `json:"actionUrl,omitempty"`
	RequiresAction      bool          `json:"requiresAction"`
	RiskScore           *float64      `json:"riskScore,omitempty"`
	UsedFallback        bool          `json:"usedFallback"`
	EstimatedFee        *EstimatedFee `json:"estimatedFee,omitempty"`
	PresentmentAmount   *float64      `json:"presentmentAmount,omitempty"`
	PresentmentCurrency string        `json:"presentmentCurrency,omitempty"`
	CreatedAt           string        `json:"createdAt,omitempty"`
	// ApprovalID is only present when an AGENT charge exceeded its delegation's requireApprovalAboveAmount.
	ApprovalID string `json:"approvalId,omitempty"`
}

type PaymentDetail struct {
	ChargeResponse
	Amount     float64           `json:"amount"`
	Currency   string            `json:"currency"`
	MerchantID string            `json:"merchantId"`
	CustomerID string            `json:"customerId,omitempty"`
	OrderID    string            `json:"orderId,omitempty"`
	Metadata   map[string]string `json:"metadata,omitempty"`
	Refunds    []interface{}     `json:"refunds,omitempty"`
	Captures   []interface{}     `json:"captures,omitempty"`
}

// RefundParams: Amount left nil means a full refund of the remaining refundable balance.
type RefundParams struct {
	Amount *float64 `json:"amount,omitempty"`
	Reason string   `json:"reason,omitempty"`
}

type RefundResponse struct {
	PaymentID           string        `json:"paymentId"`
	Status              string        `json:"status"`
	TotalRefunded       float64       `json:"totalRefunded"`
	RemainingRefundable float64       `json:"remainingRefundable"`
	Currency            string        `json:"currency"`
	Refunds             []interface{} `json:"refunds,omitempty"`
}

// CaptureParams: Amount left nil means a full capture of the remaining authorized amount.
type CaptureParams struct {
	Amount *float64 `json:"amount,omitempty"`
}

type CaptureResponse struct {
	PaymentID           string        `json:"paymentId"`
	Status              string        `json:"status"`
	PspTransactionID    string        `json:"pspTransactionId"`
	Amount              float64       `json:"amount"`
	TotalCaptured       float64       `json:"totalCaptured"`
	RemainingCapturable float64       `json:"remainingCapturable"`
	Currency            string        `json:"currency"`
	Captures            []interface{} `json:"captures,omitempty"`
}

type CancelResponse struct {
	PaymentID string `json:"paymentId"`
	Status    string `json:"status"`
}

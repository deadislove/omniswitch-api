namespace OmniSwitch.Sdk;

public class BinInfo
{
    public string? Bin { get; set; }
    public string? Country { get; set; }
    public string? CardBrand { get; set; }
    public string? CardType { get; set; }
    public string? IssuingBank { get; set; }
}

public class ChargeSplit
{
    public string MerchantId { get; set; } = "";
    public double Amount { get; set; }
}

public class ChargeParams
{
    /// <summary>Major currency units, e.g. 99.99.</summary>
    public double Amount { get; set; }
    public string Currency { get; set; } = "";
    public string? CustomerId { get; set; }
    public string? PaymentMethodId { get; set; }
    public string? CardToken { get; set; }
    public string? OrderId { get; set; }
    public string? Description { get; set; }
    public string? StatementDescriptor { get; set; }
    public BinInfo? BinInfo { get; set; }
    /// <summary>One of STRIPE / ADYEN / PAYPAL / CHASE.</summary>
    public string? PreferredProvider { get; set; }
    public Dictionary<string, string>? Metadata { get; set; }
    public string? Category { get; set; }
    /// <summary>"automatic" or "manual".</summary>
    public string? CaptureMethod { get; set; }
    public string? PresentmentCurrency { get; set; }
    public List<ChargeSplit>? Splits { get; set; }

    public ChargeParams() { }

    public ChargeParams(double amount, string currency)
    {
        Amount = amount;
        Currency = currency;
    }
}

public class EstimatedFee
{
    public double Amount { get; set; }
    public string Currency { get; set; } = "";
}

public class ChargeResponse
{
    public string PaymentId { get; set; } = "";
    /// <summary>SUCCEEDED / REQUIRES_ACTION / REQUIRES_CAPTURE / FAILED / AMBIGUOUS / PENDING_APPROVAL.</summary>
    public string Status { get; set; } = "";
    public string? PspTransactionId { get; set; }
    /// <summary>STRIPE / ADYEN / PAYPAL / CHASE.</summary>
    public string? PspProvider { get; set; }
    public string? ActionUrl { get; set; }
    public bool RequiresAction { get; set; }
    public double? RiskScore { get; set; }
    public bool UsedFallback { get; set; }
    public EstimatedFee? EstimatedFee { get; set; }
    public double? PresentmentAmount { get; set; }
    public string? PresentmentCurrency { get; set; }
    public string? CreatedAt { get; set; }
    /// <summary>Only present when an AGENT charge exceeded its delegation's requireApprovalAboveAmount.</summary>
    public string? ApprovalId { get; set; }
}

public class PaymentDetail : ChargeResponse
{
    public double Amount { get; set; }
    public string Currency { get; set; } = "";
    public string MerchantId { get; set; } = "";
    public string? CustomerId { get; set; }
    public string? OrderId { get; set; }
    public Dictionary<string, string>? Metadata { get; set; }
    public List<object>? Refunds { get; set; }
    public List<object>? Captures { get; set; }
}

public class RefundParams
{
    /// <summary>Major currency units — omit (null) for a full refund of the remaining refundable balance.</summary>
    public double? Amount { get; set; }
    public string? Reason { get; set; }

    public RefundParams() { }

    public RefundParams(double? amount, string? reason)
    {
        Amount = amount;
        Reason = reason;
    }
}

public class RefundResponse
{
    public string PaymentId { get; set; } = "";
    public string Status { get; set; } = "";
    public double TotalRefunded { get; set; }
    public double RemainingRefundable { get; set; }
    public string Currency { get; set; } = "";
    public List<object>? Refunds { get; set; }
}

public class CaptureParams
{
    /// <summary>Major currency units — omit (null) for a full capture of the remaining authorized amount.</summary>
    public double? Amount { get; set; }

    public CaptureParams() { }

    public CaptureParams(double? amount)
    {
        Amount = amount;
    }
}

public class CaptureResponse
{
    public string PaymentId { get; set; } = "";
    public string Status { get; set; } = "";
    public string PspTransactionId { get; set; } = "";
    public double Amount { get; set; }
    public double TotalCaptured { get; set; }
    public double RemainingCapturable { get; set; }
    public string Currency { get; set; } = "";
    public List<object>? Captures { get; set; }
}

public class CancelResponse
{
    public string PaymentId { get; set; } = "";
    public string Status { get; set; } = "";
}

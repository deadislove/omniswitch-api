package io.omniswitch.sdk;

public class ChargeResponse {
  public String paymentId;
  /** SUCCEEDED / REQUIRES_ACTION / REQUIRES_CAPTURE / FAILED / AMBIGUOUS / PENDING_APPROVAL. */
  public String status;
  public String pspTransactionId;
  /** STRIPE / ADYEN / PAYPAL / CHASE. */
  public String pspProvider;
  public String actionUrl;
  public boolean requiresAction;
  public Double riskScore;
  public boolean usedFallback;
  public EstimatedFee estimatedFee;
  public Double presentmentAmount;
  public String presentmentCurrency;
  public String createdAt;
  /** Only present when an AGENT charge exceeded its delegation's requireApprovalAboveAmount. */
  public String approvalId;

  public static class EstimatedFee {
    public double amount;
    public String currency;
  }
}

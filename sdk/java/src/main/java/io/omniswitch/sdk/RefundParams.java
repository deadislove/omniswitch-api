package io.omniswitch.sdk;

import com.fasterxml.jackson.annotation.JsonInclude;

@JsonInclude(JsonInclude.Include.NON_NULL)
public class RefundParams {
  /** Major currency units — omit (leave null) for a full refund of the remaining refundable balance. */
  public Double amount;
  public String reason;

  public RefundParams() {}

  public RefundParams(Double amount, String reason) {
    this.amount = amount;
    this.reason = reason;
  }
}

package io.omniswitch.sdk;

import com.fasterxml.jackson.annotation.JsonInclude;

@JsonInclude(JsonInclude.Include.NON_NULL)
public class CaptureParams {
  /** Major currency units — omit (leave null) for a full capture of the remaining authorized amount. */
  public Double amount;

  public CaptureParams() {}

  public CaptureParams(Double amount) {
    this.amount = amount;
  }
}

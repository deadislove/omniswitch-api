package io.omniswitch.sdk;

import java.util.List;

public class RefundResponse {
  public String paymentId;
  public String status;
  public double totalRefunded;
  public double remainingRefundable;
  public String currency;
  public List<Object> refunds;
}

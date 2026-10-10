package io.omniswitch.sdk;

import java.util.List;

public class CaptureResponse {
  public String paymentId;
  public String status;
  public String pspTransactionId;
  public double amount;
  public double totalCaptured;
  public double remainingCapturable;
  public String currency;
  public List<Object> captures;
}

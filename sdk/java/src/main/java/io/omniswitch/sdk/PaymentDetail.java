package io.omniswitch.sdk;

import java.util.List;
import java.util.Map;

public class PaymentDetail extends ChargeResponse {
  public double amount;
  public String currency;
  public String merchantId;
  public String customerId;
  public String orderId;
  public Map<String, String> metadata;
  public List<Object> refunds;
  public List<Object> captures;
}

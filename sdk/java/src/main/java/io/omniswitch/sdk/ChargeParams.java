package io.omniswitch.sdk;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;
import java.util.Map;

@JsonInclude(JsonInclude.Include.NON_NULL)
public class ChargeParams {
  /** Major currency units, e.g. 99.99. */
  public double amount;
  public String currency;
  public String customerId;
  public String paymentMethodId;
  public String cardToken;
  public String orderId;
  public String description;
  public String statementDescriptor;
  public BinInfo binInfo;
  /** One of STRIPE / ADYEN / PAYPAL / CHASE. */
  public String preferredProvider;
  public Map<String, String> metadata;
  public String category;
  /** "automatic" or "manual". */
  public String captureMethod;
  public String presentmentCurrency;
  public List<Split> splits;

  public ChargeParams() {}

  public ChargeParams(double amount, String currency) {
    this.amount = amount;
    this.currency = currency;
  }

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public static class Split {
    public String merchantId;
    public double amount;

    public Split() {}

    public Split(String merchantId, double amount) {
      this.merchantId = merchantId;
      this.amount = amount;
    }
  }
}

package io.omniswitch.sdk;

public class OmniSwitchClientOptions {
  /** e.g. "https://api.example.com/api/v1" — no trailing slash. */
  public final String baseUrl;
  public final String apiKeyId;
  public final String apiKeySecret;
  /** This merchant's HMAC signing key (from POST /admin/merchants or a rotation call) — never the JWT. */
  public final String hmacSecret;
  /** Business-facing merchant id, sent as X-Merchant-Id on every signed request. */
  public final String merchantId;
  /** Injectable for tests/non-standard runtimes — defaults to a java.net.http.HttpClient-backed sender. */
  public final HttpSender httpSender;
  /** Request timeout, milliseconds. Default 30000. */
  public final int timeoutMs;

  private OmniSwitchClientOptions(Builder b) {
    this.baseUrl = b.baseUrl;
    this.apiKeyId = b.apiKeyId;
    this.apiKeySecret = b.apiKeySecret;
    this.hmacSecret = b.hmacSecret;
    this.merchantId = b.merchantId;
    this.httpSender = b.httpSender != null ? b.httpSender : new JdkHttpSender();
    this.timeoutMs = b.timeoutMs;
  }

  public static Builder builder() {
    return new Builder();
  }

  public static class Builder {
    private String baseUrl;
    private String apiKeyId;
    private String apiKeySecret;
    private String hmacSecret;
    private String merchantId;
    private HttpSender httpSender;
    private int timeoutMs = 30_000;

    public Builder baseUrl(String baseUrl) {
      this.baseUrl = baseUrl;
      return this;
    }

    public Builder apiKeyId(String apiKeyId) {
      this.apiKeyId = apiKeyId;
      return this;
    }

    public Builder apiKeySecret(String apiKeySecret) {
      this.apiKeySecret = apiKeySecret;
      return this;
    }

    public Builder hmacSecret(String hmacSecret) {
      this.hmacSecret = hmacSecret;
      return this;
    }

    public Builder merchantId(String merchantId) {
      this.merchantId = merchantId;
      return this;
    }

    public Builder httpSender(HttpSender httpSender) {
      this.httpSender = httpSender;
      return this;
    }

    public Builder timeoutMs(int timeoutMs) {
      this.timeoutMs = timeoutMs;
      return this;
    }

    public OmniSwitchClientOptions build() {
      if (baseUrl == null || apiKeyId == null || apiKeySecret == null || hmacSecret == null || merchantId == null) {
        throw new IllegalStateException(
            "baseUrl, apiKeyId, apiKeySecret, hmacSecret, and merchantId are all required");
      }
      return new OmniSwitchClientOptions(this);
    }
  }
}

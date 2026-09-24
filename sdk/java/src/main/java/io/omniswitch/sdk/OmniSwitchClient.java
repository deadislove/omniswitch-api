package io.omniswitch.sdk;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.PropertyAccessor;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Deliberately merchant-credential-only in this first cut — an
 * AGENT-delegation client is real future scope this class doesn't cover
 * yet.
 */
public class OmniSwitchClient {

  private static final int TOKEN_REFRESH_SKEW_MS = 30_000;

  private final OmniSwitchClientOptions options;
  private final String baseUrl;
  private final ObjectMapper mapper;
  private volatile CachedToken token;

  public OmniSwitchClient(OmniSwitchClientOptions options) {
    this.options = options;
    this.baseUrl = options.baseUrl.replaceAll("/+$", "");
    this.mapper = new ObjectMapper();
    this.mapper.setVisibility(PropertyAccessor.FIELD, com.fasterxml.jackson.annotation.JsonAutoDetect.Visibility.ANY);
    this.mapper.setVisibility(PropertyAccessor.GETTER, com.fasterxml.jackson.annotation.JsonAutoDetect.Visibility.NONE);
    this.mapper.setVisibility(PropertyAccessor.IS_GETTER, com.fasterxml.jackson.annotation.JsonAutoDetect.Visibility.NONE);
    this.mapper.setSerializationInclusion(JsonInclude.Include.NON_NULL);
    this.mapper.configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);
  }

  public ChargeResponse charge(ChargeParams params) {
    return charge(params, null);
  }

  public ChargeResponse charge(ChargeParams params, String idempotencyKey) {
    return request("POST", "/payments/charge", params, true, idempotencyKey, ChargeResponse.class);
  }

  public PaymentDetail getPayment(String paymentId) {
    return request(
        "GET", "/payments/" + urlEncode(paymentId), null, false, null, PaymentDetail.class);
  }

  public RefundResponse refund(String paymentId, RefundParams params) {
    return refund(paymentId, params, null);
  }

  public RefundResponse refund(String paymentId, RefundParams params, String idempotencyKey) {
    return request(
        "POST",
        "/payments/" + urlEncode(paymentId) + "/refund",
        params != null ? params : new RefundParams(),
        true,
        idempotencyKey,
        RefundResponse.class);
  }

  public CaptureResponse capture(String paymentId, CaptureParams params) {
    return capture(paymentId, params, null);
  }

  public CaptureResponse capture(String paymentId, CaptureParams params, String idempotencyKey) {
    return request(
        "POST",
        "/payments/" + urlEncode(paymentId) + "/capture",
        params != null ? params : new CaptureParams(),
        true,
        idempotencyKey,
        CaptureResponse.class);
  }

  public CancelResponse cancel(String paymentId) {
    return cancel(paymentId, null);
  }

  public CancelResponse cancel(String paymentId, String idempotencyKey) {
    return request(
        "POST",
        "/payments/" + urlEncode(paymentId) + "/cancel",
        new LinkedHashMap<String, Object>(),
        true,
        idempotencyKey,
        CancelResponse.class);
  }

  /** Public so a caller can pre-warm the token or check credentials without making a payments call. */
  public synchronized String authenticate() {
    CachedToken current = this.token;
    if (current != null && current.expiresAt - TOKEN_REFRESH_SKEW_MS > System.currentTimeMillis()) {
      return current.accessToken;
    }

    Map<String, String> headers = new LinkedHashMap<>();
    headers.put("Content-Type", "application/json");
    String body;
    try {
      Map<String, String> creds = new LinkedHashMap<>();
      creds.put("apiKeyId", options.apiKeyId);
      creds.put("apiKeySecret", options.apiKeySecret);
      body = mapper.writeValueAsString(creds);
    } catch (IOException e) {
      throw new IllegalStateException(e);
    }

    HttpResult response = send("POST", baseUrl + "/auth/token", headers, body);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw OmniSwitchApiError.fromResponse(response.statusCode, response.body, mapper);
    }

    JsonNode parsed;
    try {
      parsed = mapper.readTree(response.body);
    } catch (IOException e) {
      throw new IllegalStateException("Malformed auth response: " + e.getMessage(), e);
    }

    if (parsed.path("mfaRequired").asBoolean(false)) {
      // A pending, MFA-restricted token — this SDK is for server-side
      // integrations authenticating with an API key/secret pair, which
      // shouldn't have MFA enabled on that credential in the first place
      // (MFA guards the human dashboard login path). Surfacing this as a
      // clear error is more useful than silently returning a token every
      // subsequent call would then fail against anyway.
      throw new OmniSwitchApiError(
          401,
          "This merchant has MFA enabled — this SDK does not support the MFA challenge flow. Use a credential without MFA enabled for server-side integrations.",
          "MFA_NOT_SUPPORTED");
    }

    String accessToken = parsed.path("accessToken").asText();
    long expiresInSeconds = parsed.path("expiresIn").asLong();
    this.token = new CachedToken(accessToken, System.currentTimeMillis() + expiresInSeconds * 1000);
    return accessToken;
  }

  private <T> T request(
      String method, String path, Object bodyObj, boolean signed, String idempotencyKey, Class<T> responseType) {
    return request(method, path, bodyObj, signed, idempotencyKey, responseType, false);
  }

  private <T> T request(
      String method,
      String path,
      Object bodyObj,
      boolean signed,
      String idempotencyKey,
      Class<T> responseType,
      boolean isRetry) {
    String accessToken = authenticate();
    String bodyStr;
    try {
      bodyStr = bodyObj != null ? mapper.writeValueAsString(bodyObj) : null;
    } catch (IOException e) {
      throw new IllegalStateException(e);
    }
    String fullPath = "/api/v1" + path;

    Map<String, String> headers = new LinkedHashMap<>();
    headers.put("Content-Type", "application/json");
    headers.put("Authorization", "Bearer " + accessToken);

    if (signed) {
      Signing.Result sig = Signing.signRequest(options.hmacSecret, method, fullPath, bodyStr != null ? bodyStr : "");
      headers.put("X-Signature", sig.signature);
      headers.put("X-Timestamp", sig.timestamp);
      headers.put("X-Merchant-Id", options.merchantId);
      // Generate a fresh UUID v4 per logical call unless the caller is
      // deliberately retrying the same one — this SDK doesn't retry on
      // its own, so "per call to this method" and "per logical
      // operation" already coincide for a single call.
      headers.put("Idempotency-Key", idempotencyKey != null ? idempotencyKey : UUID.randomUUID().toString());
    }

    HttpResult response = send(method, baseUrl + path, headers, bodyStr);

    if (response.statusCode == 401 && this.token != null && !isRetry) {
      // The cached token may have been revoked server-side (rotation,
      // deactivation) even though it hasn't hit its own expiry yet —
      // exactly one retry with a forced re-authentication, guarded by
      // isRetry so a resource endpoint that 401s even against a freshly
      // issued token can't recurse unboundedly.
      this.token = null;
      return request(method, path, bodyObj, signed, idempotencyKey, responseType, true);
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw OmniSwitchApiError.fromResponse(response.statusCode, response.body, mapper);
    }

    try {
      return mapper.readValue(response.body, responseType);
    } catch (IOException e) {
      throw new IllegalStateException("Malformed response body: " + e.getMessage(), e);
    }
  }

  private HttpResult send(String method, String url, Map<String, String> headers, String body) {
    try {
      return options.httpSender.send(method, url, headers, body, options.timeoutMs);
    } catch (IOException | InterruptedException e) {
      if (e instanceof InterruptedException) {
        Thread.currentThread().interrupt();
      }
      throw new RuntimeException("OmniSwitch request failed: " + e.getMessage(), e);
    }
  }

  private static String urlEncode(String value) {
    return URLEncoder.encode(value, StandardCharsets.UTF_8);
  }

  private static final class CachedToken {
    final String accessToken;
    final long expiresAt;

    CachedToken(String accessToken, long expiresAt) {
      this.accessToken = accessToken;
      this.expiresAt = expiresAt;
    }
  }
}

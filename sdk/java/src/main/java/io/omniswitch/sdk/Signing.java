package io.omniswitch.sdk;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.InvalidKeyException;
import java.security.NoSuchAlgorithmException;

/**
 * Computes the {@code X-Signature}/{@code X-Timestamp} pair
 * {@code HmacSignatureGuard} verifies server-side:
 * {@code HMAC-SHA256(secret, "${timestamp}.${method}.${path}.${rawBody}")},
 * hex digest. {@code path} must be the exact request path the server
 * sees, including the {@code /api/v1} prefix and query string if any —
 * the guard signs {@code request.originalUrl}, not a normalized or
 * query-stripped version. {@code body} must be the exact bytes sent on
 * the wire — {@link OmniSwitchClient} always signs the same JSON string
 * it then sends, never a value re-serialized afterward.
 */
public final class Signing {

  private Signing() {}

  public static final class Result {
    public final String signature;
    public final String timestamp;

    public Result(String signature, String timestamp) {
      this.signature = signature;
      this.timestamp = timestamp;
    }
  }

  public static Result signRequest(String secret, String method, String path, String body) {
    String timestamp = String.valueOf(System.currentTimeMillis() / 1000);
    String signedPayload = timestamp + "." + method.toUpperCase() + "." + path + "." + body;
    String signature = hmacSha256Hex(secret, signedPayload);
    return new Result(signature, timestamp);
  }

  static String hmacSha256Hex(String secret, String payload) {
    try {
      Mac mac = Mac.getInstance("HmacSHA256");
      mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
      byte[] raw = mac.doFinal(payload.getBytes(StandardCharsets.UTF_8));
      return toHex(raw);
    } catch (NoSuchAlgorithmException | InvalidKeyException e) {
      throw new IllegalStateException("HmacSHA256 unavailable", e);
    }
  }

  static String toHex(byte[] bytes) {
    StringBuilder sb = new StringBuilder(bytes.length * 2);
    for (byte b : bytes) {
      sb.append(String.format("%02x", b));
    }
    return sb.toString();
  }
}

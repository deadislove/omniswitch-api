package io.omniswitch.sdk;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.Map;

/**
 * Verifies the {@code X-OmniSwitch-Signature} header OmniSwitch signs its
 * own outbound webhooks with (dispute/subscription/AML-review/sanctions-
 * screening notifications) — {@code t=<unix seconds>,v1=<hex HMAC-SHA256
 * digest>} over {@code "${timestamp}.${rawBody}"}, keyed by the same
 * merchant HMAC secret {@link Signing#signRequest} uses. This is the
 * verify-side mirror of the server's own signing function.
 *
 * <p>{@code rawBody} must be the exact bytes received on the wire —
 * verifying against a re-serialized payload can silently fail for
 * payloads whose key order or number formatting changes on
 * parse-then-restringify.
 *
 * <p>Returns {@code false} for a malformed header, an expired timestamp,
 * or a mismatched signature — never throws, so a caller can gate a
 * {@code 401} response on a single boolean check.
 */
public final class Webhooks {

  private static final long DEFAULT_TOLERANCE_SECONDS = 5 * 60;

  private Webhooks() {}

  public static boolean verifyWebhookSignature(String secret, String rawBody, String signatureHeader) {
    return verifyWebhookSignature(secret, rawBody, signatureHeader, DEFAULT_TOLERANCE_SECONDS);
  }

  public static boolean verifyWebhookSignature(
      String secret, String rawBody, String signatureHeader, long toleranceSeconds) {
    if (signatureHeader == null || signatureHeader.isEmpty()) {
      return false;
    }

    Map<String, String> parts = new HashMap<>();
    for (String part : signatureHeader.split(",")) {
      String[] kv = part.split("=", 2);
      if (kv.length == 2 && !kv[0].isEmpty() && !kv[1].isEmpty()) {
        parts.put(kv[0], kv[1]);
      }
    }

    String timestamp = parts.get("t");
    String providedSignature = parts.get("v1");
    if (timestamp == null || providedSignature == null) {
      return false;
    }

    long requestTimeMillis;
    try {
      requestTimeMillis = Long.parseLong(timestamp) * 1000L;
    } catch (NumberFormatException e) {
      return false;
    }
    if (Math.abs(System.currentTimeMillis() - requestTimeMillis) > toleranceSeconds * 1000L) {
      return false;
    }

    String expectedSignature = Signing.hmacSha256Hex(secret, timestamp + "." + rawBody);

    try {
      byte[] expectedBytes = hexToBytes(expectedSignature);
      byte[] providedBytes = hexToBytes(providedSignature);
      return expectedBytes.length == providedBytes.length && MessageDigest.isEqual(expectedBytes, providedBytes);
    } catch (IllegalArgumentException e) {
      return false;
    }
  }

  static byte[] hexToBytes(String hex) {
    if (hex.length() % 2 != 0) {
      throw new IllegalArgumentException("odd-length hex string");
    }
    byte[] out = new byte[hex.length() / 2];
    for (int i = 0; i < out.length; i++) {
      int hi = Character.digit(hex.charAt(i * 2), 16);
      int lo = Character.digit(hex.charAt(i * 2 + 1), 16);
      if (hi < 0 || lo < 0) {
        throw new IllegalArgumentException("non-hex character");
      }
      out[i] = (byte) ((hi << 4) + lo);
    }
    return out;
  }
}

package io.omniswitch.sdk;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class SigningTest {

  @Test
  void producesTheExactSignatureHmacSignatureGuardVerifies() {
    String secret = "a".repeat(64);
    Signing.Result result = Signing.signRequest(secret, "post", "/api/v1/payments/charge", "{\"amount\":10}");

    String expected =
        Signing.hmacSha256Hex(secret, result.timestamp + ".POST./api/v1/payments/charge.{\"amount\":10}");
    assertEquals(expected, result.signature);
  }

  @Test
  void uppercasesTheMethodRegardlessOfCallerCasing() {
    String secret = "a".repeat(64);
    Signing.Result lower = Signing.signRequest(secret, "get", "/api/v1/payments/pay_1", "");
    String recomputed = Signing.hmacSha256Hex(secret, lower.timestamp + ".GET./api/v1/payments/pay_1.");
    assertEquals(recomputed, lower.signature);
  }

  @Test
  void returnsAUnixSecondsTimestampAsAString() {
    Signing.Result result = Signing.signRequest("secret", "POST", "/api/v1/payments/charge", "{}");
    assertTrue(result.timestamp.matches("\\d+"));
    long nowSeconds = System.currentTimeMillis() / 1000;
    assertTrue(Math.abs(nowSeconds - Long.parseLong(result.timestamp)) < 5);
  }

  @Test
  void producesADifferentSignatureForADifferentBody() {
    String secret = "a".repeat(64);
    Signing.Result a = Signing.signRequest(secret, "POST", "/api/v1/payments/charge", "{\"amount\":10}");
    Signing.Result b = Signing.signRequest(secret, "POST", "/api/v1/payments/charge", "{\"amount\":20}");
    assertNotEquals(a.signature, b.signature);
  }
}

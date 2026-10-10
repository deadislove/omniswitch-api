package io.omniswitch.sdk;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;

import org.junit.jupiter.api.Test;

class WebhooksTest {

  private static final String SECRET = "a".repeat(64);
  private static final String BODY = "{\"event\":\"dispute.created\",\"paymentId\":\"pay_1\"}";

  private static String sign(String secret, String body) {
    return sign(secret, body, System.currentTimeMillis() / 1000);
  }

  private static String sign(String secret, String body, long timestamp) {
    String signature = Signing.hmacSha256Hex(secret, timestamp + "." + body);
    return "t=" + timestamp + ",v1=" + signature;
  }

  @Test
  void acceptsACorrectlySignedFreshPayload() {
    assertTrue(Webhooks.verifyWebhookSignature(SECRET, BODY, sign(SECRET, BODY)));
  }

  @Test
  void rejectsAPayloadSignedWithTheWrongSecret() {
    assertFalse(Webhooks.verifyWebhookSignature(SECRET, BODY, sign("b".repeat(64), BODY)));
  }

  @Test
  void rejectsAMutatedBodyAgainstASignatureComputedForTheOriginal() {
    String header = sign(SECRET, BODY);
    assertFalse(Webhooks.verifyWebhookSignature(SECRET, BODY + "tampered", header));
  }

  @Test
  void rejectsAMissingSignatureHeader() {
    assertFalse(Webhooks.verifyWebhookSignature(SECRET, BODY, null));
    assertFalse(Webhooks.verifyWebhookSignature(SECRET, BODY, ""));
  }

  @Test
  void rejectsAMalformedHeader() {
    assertFalse(Webhooks.verifyWebhookSignature(SECRET, BODY, "v1=deadbeef"));
    assertFalse(Webhooks.verifyWebhookSignature(SECRET, BODY, "t=1700000000"));
    assertFalse(Webhooks.verifyWebhookSignature(SECRET, BODY, "garbage"));
  }

  @Test
  void rejectsATimestampOutsideTheToleranceWindow() {
    long staleTimestamp = System.currentTimeMillis() / 1000 - 10 * 60;
    String header = sign(SECRET, BODY, staleTimestamp);
    assertFalse(Webhooks.verifyWebhookSignature(SECRET, BODY, header));
  }

  @Test
  void acceptsACustomToleranceWindow() {
    long timestamp = System.currentTimeMillis() / 1000 - 60;
    String header = sign(SECRET, BODY, timestamp);
    assertFalse(Webhooks.verifyWebhookSignature(SECRET, BODY, header, 30));
    assertTrue(Webhooks.verifyWebhookSignature(SECRET, BODY, header, 120));
  }

  @Test
  void rejectsANonHexV1ValueWithoutThrowing() {
    String header = "t=1700000000,v1=not-hex!!";
    assertDoesNotThrow(() -> Webhooks.verifyWebhookSignature(SECRET, BODY, header));
    assertFalse(Webhooks.verifyWebhookSignature(SECRET, BODY, header));
  }
}

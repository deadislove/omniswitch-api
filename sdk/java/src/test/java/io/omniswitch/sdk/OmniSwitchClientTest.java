package io.omniswitch.sdk;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class OmniSwitchClientTest {

  /** Records every call, replays queued canned responses in order — the mock-HTTP-layer role fetchMock plays in the Node test suite. */
  static class RecordingHttpSender implements HttpSender {
    final List<Call> calls = new ArrayList<>();
    final Deque<HttpResult> responses = new ArrayDeque<>();

    static class Call {
      final String method;
      final String url;
      final Map<String, String> headers;
      final String body;

      Call(String method, String url, Map<String, String> headers, String body) {
        this.method = method;
        this.url = url;
        this.headers = headers;
        this.body = body;
      }
    }

    void enqueue(int status, String jsonBody) {
      responses.add(new HttpResult(status, jsonBody));
    }

    @Override
    public HttpResult send(String method, String url, Map<String, String> headers, String body, int timeoutMs) {
      calls.add(new Call(method, url, headers, body));
      HttpResult next = responses.poll();
      if (next == null) {
        throw new IllegalStateException("No more canned responses queued");
      }
      return next;
    }
  }

  private OmniSwitchClient makeClient(RecordingHttpSender sender) {
    OmniSwitchClientOptions options =
        OmniSwitchClientOptions.builder()
            .baseUrl("https://api.example.com/api/v1")
            .apiKeyId("ak_test")
            .apiKeySecret("sk_test")
            .hmacSecret("h".repeat(64))
            .merchantId("merchant_acme")
            .httpSender(sender)
            .build();
    return new OmniSwitchClient(options);
  }

  @Test
  void authenticatesOnceThenReusesTheCachedTokenForASecondCall() {
    RecordingHttpSender sender = new RecordingHttpSender();
    sender.enqueue(200, "{\"accessToken\":\"jwt_1\",\"tokenType\":\"Bearer\",\"expiresIn\":3600}");
    sender.enqueue(200, "{\"paymentId\":\"pay_1\",\"status\":\"SUCCEEDED\"}");
    sender.enqueue(200, "{\"paymentId\":\"pay_1\",\"status\":\"SUCCEEDED\"}");
    OmniSwitchClient client = makeClient(sender);

    client.getPayment("pay_1");
    client.getPayment("pay_1");

    assertEquals(3, sender.calls.size()); // 1 auth + 2 resource calls, no re-auth
    assertEquals("https://api.example.com/api/v1/auth/token", sender.calls.get(0).url);
  }

  @Test
  void sendsSignatureHeadersOnASignedCallCharge() {
    RecordingHttpSender sender = new RecordingHttpSender();
    sender.enqueue(200, "{\"accessToken\":\"jwt_1\",\"tokenType\":\"Bearer\",\"expiresIn\":3600}");
    sender.enqueue(
        201,
        "{\"paymentId\":\"pay_1\",\"status\":\"SUCCEEDED\",\"requiresAction\":false,\"usedFallback\":false}");
    OmniSwitchClient client = makeClient(sender);

    client.charge(new ChargeParams(10, "USD"));

    RecordingHttpSender.Call chargeCall = sender.calls.get(1);
    assertEquals("https://api.example.com/api/v1/payments/charge", chargeCall.url);
    assertNotNull(chargeCall.headers.get("X-Signature"));
    assertNotNull(chargeCall.headers.get("X-Timestamp"));
    assertEquals("merchant_acme", chargeCall.headers.get("X-Merchant-Id"));
    assertTrue(chargeCall.headers.get("Idempotency-Key").matches("^[0-9a-f-]{36}$"));
    assertEquals("Bearer jwt_1", chargeCall.headers.get("Authorization"));
  }

  @Test
  void doesNotSignAGetRequestGetPayment() {
    RecordingHttpSender sender = new RecordingHttpSender();
    sender.enqueue(200, "{\"accessToken\":\"jwt_1\",\"tokenType\":\"Bearer\",\"expiresIn\":3600}");
    sender.enqueue(200, "{\"paymentId\":\"pay_1\"}");
    OmniSwitchClient client = makeClient(sender);

    client.getPayment("pay_1");

    RecordingHttpSender.Call getCall = sender.calls.get(1);
    assertFalse(getCall.headers.containsKey("X-Signature"));
    assertFalse(getCall.headers.containsKey("Idempotency-Key"));
  }

  @Test
  void reusesACallerSuppliedIdempotencyKeyAcrossAnExplicitRetry() {
    RecordingHttpSender sender = new RecordingHttpSender();
    sender.enqueue(200, "{\"accessToken\":\"jwt_1\",\"tokenType\":\"Bearer\",\"expiresIn\":3600}");
    sender.enqueue(201, "{\"paymentId\":\"pay_1\"}");
    OmniSwitchClient client = makeClient(sender);

    client.charge(new ChargeParams(10, "USD"), "my-fixed-key");

    assertEquals("my-fixed-key", sender.calls.get(1).headers.get("Idempotency-Key"));
  }

  @Test
  void retriesExactlyOnceWithAFreshTokenOnA401ThenSucceeds() {
    RecordingHttpSender sender = new RecordingHttpSender();
    sender.enqueue(200, "{\"accessToken\":\"jwt_1\",\"tokenType\":\"Bearer\",\"expiresIn\":3600}");
    sender.enqueue(401, "{\"statusCode\":401,\"error\":\"Invalid or expired token\",\"code\":\"INVALID_TOKEN\"}");
    sender.enqueue(200, "{\"accessToken\":\"jwt_2\",\"tokenType\":\"Bearer\",\"expiresIn\":3600}");
    sender.enqueue(200, "{\"paymentId\":\"pay_1\"}");
    OmniSwitchClient client = makeClient(sender);

    PaymentDetail result = client.getPayment("pay_1");

    assertEquals("pay_1", result.paymentId);
    assertEquals(4, sender.calls.size()); // auth, 401, re-auth, success
    assertEquals("Bearer jwt_2", sender.calls.get(3).headers.get("Authorization"));
  }

  @Test
  void throwsOmniSwitchApiErrorWithStatusCodeCodeErrorFromTheResponseBody() {
    RecordingHttpSender sender = new RecordingHttpSender();
    sender.enqueue(200, "{\"accessToken\":\"jwt_1\",\"tokenType\":\"Bearer\",\"expiresIn\":3600}");
    sender.enqueue(
        422,
        "{\"statusCode\":422,\"error\":\"Charge of $50.00 USD exceeds this delegation's per-transaction limit\",\"code\":\"DELEGATION_PER_TRANSACTION_LIMIT_EXCEEDED\"}");
    OmniSwitchClient client = makeClient(sender);

    OmniSwitchApiError error =
        assertThrows(OmniSwitchApiError.class, () -> client.charge(new ChargeParams(50, "USD")));
    assertEquals(422, error.getStatusCode());
    assertEquals("DELEGATION_PER_TRANSACTION_LIMIT_EXCEEDED", error.getCode());
  }

  @Test
  void throwsAClearMfaNotSupportedErrorInsteadOfSilentlyReturningARestrictedToken() {
    RecordingHttpSender sender = new RecordingHttpSender();
    sender.enqueue(
        200, "{\"accessToken\":\"jwt_pending\",\"tokenType\":\"Bearer\",\"expiresIn\":300,\"mfaRequired\":true}");
    OmniSwitchClient client = makeClient(sender);

    OmniSwitchApiError error = assertThrows(OmniSwitchApiError.class, () -> client.getPayment("pay_1"));
    assertInstanceOf(OmniSwitchApiError.class, error);
    assertEquals("MFA_NOT_SUPPORTED", error.getCode());
  }

  @Test
  void refundCaptureCancelAllSignAndHitTheExpectedPaths() {
    RecordingHttpSender sender = new RecordingHttpSender();
    sender.enqueue(200, "{\"accessToken\":\"jwt_1\",\"tokenType\":\"Bearer\",\"expiresIn\":3600}");
    sender.enqueue(200, "{\"paymentId\":\"pay_1\",\"status\":\"REFUNDED\"}");
    sender.enqueue(200, "{\"paymentId\":\"pay_1\",\"status\":\"SUCCEEDED\"}");
    sender.enqueue(200, "{\"paymentId\":\"pay_1\",\"status\":\"CANCELLED\"}");
    OmniSwitchClient client = makeClient(sender);

    client.refund("pay_1", new RefundParams(5.0, null));
    client.capture("pay_1", null);
    client.cancel("pay_1");

    assertEquals("https://api.example.com/api/v1/payments/pay_1/refund", sender.calls.get(1).url);
    assertEquals("https://api.example.com/api/v1/payments/pay_1/capture", sender.calls.get(2).url);
    assertEquals("https://api.example.com/api/v1/payments/pay_1/cancel", sender.calls.get(3).url);
    for (int i = 1; i < sender.calls.size(); i++) {
      assertNotNull(sender.calls.get(i).headers.get("X-Signature"));
    }
  }
}

package io.omniswitch.sdk;

import java.util.Map;

/**
 * The one seam {@link OmniSwitchClient} depends on for making HTTP calls
 * — injectable so tests can supply a mock without a real network call,
 * the same role {@code fetch} plays in the Node SDK. The default
 * implementation ({@link JdkHttpSender}) uses {@code java.net.http.HttpClient}.
 */
public interface HttpSender {
  HttpResult send(String method, String url, Map<String, String> headers, String body, int timeoutMs)
      throws java.io.IOException, InterruptedException;
}

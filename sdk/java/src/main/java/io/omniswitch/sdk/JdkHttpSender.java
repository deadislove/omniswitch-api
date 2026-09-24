package io.omniswitch.sdk;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;

/** Default {@link HttpSender} — {@code java.net.http.HttpClient}, no external HTTP dependency. */
public class JdkHttpSender implements HttpSender {

  private final HttpClient httpClient = HttpClient.newHttpClient();

  @Override
  public HttpResult send(String method, String url, Map<String, String> headers, String body, int timeoutMs)
      throws IOException, InterruptedException {
    HttpRequest.Builder builder =
        HttpRequest.newBuilder().uri(URI.create(url)).timeout(Duration.ofMillis(timeoutMs));
    for (Map.Entry<String, String> header : headers.entrySet()) {
      builder.header(header.getKey(), header.getValue());
    }
    HttpRequest.BodyPublisher bodyPublisher =
        body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body);
    builder.method(method, bodyPublisher);

    HttpResponse<String> response = httpClient.send(builder.build(), HttpResponse.BodyHandlers.ofString());
    return new HttpResult(response.statusCode(), response.body());
  }
}

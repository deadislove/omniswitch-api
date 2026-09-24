package io.omniswitch.sdk;

public class HttpResult {
  public final int statusCode;
  public final String body;

  public HttpResult(int statusCode, String body) {
    this.statusCode = statusCode;
    this.body = body;
  }
}

package io.omniswitch.sdk;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * Every non-2xx OmniSwitch response is shaped {@code {statusCode, error,
 * code}} (validation failures add a {@code message} array instead of
 * {@code error}). {@code code} is the stable, machine-readable field
 * meant to be branched on; {@code error}/{@code message} are for
 * logging, not string-matching.
 */
public class OmniSwitchApiError extends RuntimeException {

  private final int statusCode;
  private final String code;
  private final JsonNode details;

  public OmniSwitchApiError(int statusCode, String message, String code, JsonNode details) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  public OmniSwitchApiError(int statusCode, String message, String code) {
    this(statusCode, message, code, null);
  }

  public int getStatusCode() {
    return statusCode;
  }

  public String getCode() {
    return code;
  }

  public JsonNode getDetails() {
    return details;
  }

  static OmniSwitchApiError fromResponse(int statusCode, String rawBody, ObjectMapper mapper) {
    JsonNode body = null;
    if (rawBody != null && !rawBody.isEmpty()) {
      try {
        body = mapper.readTree(rawBody);
      } catch (Exception e) {
        body = null;
      }
    }

    String message = null;
    String code = null;
    if (body != null) {
      if (body.hasNonNull("error")) {
        message = body.get("error").asText();
      } else if (body.hasNonNull("message")) {
        JsonNode messageNode = body.get("message");
        if (messageNode.isArray()) {
          StringBuilder sb = new StringBuilder();
          for (int i = 0; i < messageNode.size(); i++) {
            if (i > 0) sb.append("; ");
            sb.append(messageNode.get(i).asText());
          }
          message = sb.toString();
        } else {
          message = messageNode.asText();
        }
      }
      if (body.hasNonNull("code")) {
        code = body.get("code").asText();
      }
    }
    if (message == null) {
      message = "OmniSwitch API request failed with HTTP " + statusCode;
    }
    return new OmniSwitchApiError(statusCode, message, code, body);
  }
}

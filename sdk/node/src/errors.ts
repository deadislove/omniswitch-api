/**
 * Every non-2xx OmniSwitch response is shaped
 * `{ statusCode, error, code }` (validation failures add a `message`
 * array instead of `error`) — see
 * docs/guide/api/README.md#error-format. `code` is the stable,
 * machine-readable field meant to be branched on; `error`/`message` are
 * for logging, not string-matching.
 */
export class OmniSwitchApiError extends Error {
  readonly statusCode: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(statusCode: number, message: string, code?: string, details?: unknown) {
    super(message);
    this.name = 'OmniSwitchApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  static async fromResponse(response: Response): Promise<OmniSwitchApiError> {
    let body: any;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const message =
      body?.error ??
      (Array.isArray(body?.message) ? body.message.join('; ') : body?.message) ??
      `OmniSwitch API request failed with HTTP ${response.status}`;
    return new OmniSwitchApiError(response.status, message, body?.code, body);
  }
}

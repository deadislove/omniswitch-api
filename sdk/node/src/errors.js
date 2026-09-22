"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OmniSwitchApiError = void 0;
class OmniSwitchApiError extends Error {
    constructor(statusCode, message, code, details) {
        super(message);
        this.name = 'OmniSwitchApiError';
        this.statusCode = statusCode;
        this.code = code;
        this.details = details;
    }
    static async fromResponse(response) {
        let body;
        try {
            body = await response.json();
        }
        catch {
            body = undefined;
        }
        const message = body?.error ??
            (Array.isArray(body?.message) ? body.message.join('; ') : body?.message) ??
            `OmniSwitch API request failed with HTTP ${response.status}`;
        return new OmniSwitchApiError(response.status, message, body?.code, body);
    }
}
exports.OmniSwitchApiError = OmniSwitchApiError;
//# sourceMappingURL=errors.js.map
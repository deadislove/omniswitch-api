"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyWebhookSignature = verifyWebhookSignature;
const crypto_1 = require("crypto");
const DEFAULT_TOLERANCE_SECONDS = 5 * 60;
function verifyWebhookSignature(secret, rawBody, signatureHeader, toleranceSeconds = DEFAULT_TOLERANCE_SECONDS) {
    if (!signatureHeader)
        return false;
    const parts = signatureHeader.split(',').reduce((acc, part) => {
        const [key, value] = part.split('=');
        if (key && value)
            acc[key] = value;
        return acc;
    }, {});
    const timestamp = parts['t'];
    const providedSignature = parts['v1'];
    if (!timestamp || !providedSignature)
        return false;
    const requestTime = parseInt(timestamp, 10) * 1000;
    if (!Number.isFinite(requestTime) || Math.abs(Date.now() - requestTime) > toleranceSeconds * 1000) {
        return false;
    }
    const expectedSignature = (0, crypto_1.createHmac)('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
    try {
        const expectedBuffer = Buffer.from(expectedSignature, 'hex');
        const providedBuffer = Buffer.from(providedSignature, 'hex');
        return expectedBuffer.length === providedBuffer.length && (0, crypto_1.timingSafeEqual)(expectedBuffer, providedBuffer);
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=webhooks.js.map
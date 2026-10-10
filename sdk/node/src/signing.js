"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.signRequest = signRequest;
const crypto_1 = require("crypto");
function signRequest(secret, method, path, body) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signedPayload = `${timestamp}.${method.toUpperCase()}.${path}.${body}`;
    const signature = (0, crypto_1.createHmac)('sha256', secret).update(signedPayload).digest('hex');
    return { signature, timestamp };
}
//# sourceMappingURL=signing.js.map
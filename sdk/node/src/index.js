"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OmniSwitchApiError = exports.signRequest = exports.verifyWebhookSignature = exports.OmniSwitchClient = void 0;
var client_1 = require("./client");
Object.defineProperty(exports, "OmniSwitchClient", { enumerable: true, get: function () { return client_1.OmniSwitchClient; } });
var webhooks_1 = require("./webhooks");
Object.defineProperty(exports, "verifyWebhookSignature", { enumerable: true, get: function () { return webhooks_1.verifyWebhookSignature; } });
var signing_1 = require("./signing");
Object.defineProperty(exports, "signRequest", { enumerable: true, get: function () { return signing_1.signRequest; } });
var errors_1 = require("./errors");
Object.defineProperty(exports, "OmniSwitchApiError", { enumerable: true, get: function () { return errors_1.OmniSwitchApiError; } });
__exportStar(require("./types"), exports);
//# sourceMappingURL=index.js.map
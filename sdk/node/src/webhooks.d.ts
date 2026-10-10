export declare function verifyWebhookSignature(secret: string, rawBody: string, signatureHeader: string | undefined | null, toleranceSeconds?: number): boolean;

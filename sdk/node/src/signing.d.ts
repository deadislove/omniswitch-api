export declare function signRequest(secret: string, method: string, path: string, body: string): {
    signature: string;
    timestamp: string;
};

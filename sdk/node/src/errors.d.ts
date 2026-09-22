export declare class OmniSwitchApiError extends Error {
    readonly statusCode: number;
    readonly code?: string;
    readonly details?: unknown;
    constructor(statusCode: number, message: string, code?: string, details?: unknown);
    static fromResponse(response: Response): Promise<OmniSwitchApiError>;
}

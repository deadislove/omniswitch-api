import { OmniSwitchClientOptions, ChargeParams, ChargeResponse, PaymentDetail, RefundParams, RefundResponse, CaptureParams, CaptureResponse, CancelResponse, IdempotentCallOptions } from './types';
export declare class OmniSwitchClient {
    private readonly options;
    private readonly baseUrl;
    private readonly fetchImpl;
    private readonly timeoutMs;
    private token;
    constructor(options: OmniSwitchClientOptions);
    charge(params: ChargeParams, opts?: IdempotentCallOptions): Promise<ChargeResponse>;
    getPayment(paymentId: string): Promise<PaymentDetail>;
    refund(paymentId: string, params?: RefundParams, opts?: IdempotentCallOptions): Promise<RefundResponse>;
    capture(paymentId: string, params?: CaptureParams, opts?: IdempotentCallOptions): Promise<CaptureResponse>;
    cancel(paymentId: string, opts?: IdempotentCallOptions): Promise<CancelResponse>;
    authenticate(): Promise<string>;
    private request;
    private fetchWithTimeout;
}

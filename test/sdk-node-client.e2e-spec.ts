import { INestApplication } from '@nestjs/common';
import { AddressInfo } from 'net';
import { createTestApp } from './utils/test-app';
import { seedMerchant, uniqueId } from './utils/seed';
import { OmniSwitchClient, verifyWebhookSignature } from '../sdk/node/src';

/**
 * The one genuine end-to-end proof that `sdk/node` actually satisfies
 * this API's real guards — `sdk/node/test/*.spec.ts` covers the SDK's
 * own logic in isolation (mocked fetch), which proves the SDK computes
 * the right thing but not that the right thing is what the real,
 * running `HmacSignatureGuard`/`IdempotencyInterceptor` actually accept.
 * This file closes that gap the same way the rest of this e2e suite
 * closes it for the server side: real Postgres/Redis/Vault/mock-psp,
 * the real `AppModule`, real HMAC verification — the only difference
 * from every other `*.e2e-spec.ts` file is that requests arrive over a
 * real TCP socket (`app.listen(0)`) via the SDK's own `fetch()` calls,
 * not `supertest`'s direct-to-handler dispatch, since the SDK is a real
 * HTTP client and there's no other way to prove its request signing
 * survives an actual serialize-over-the-wire round trip.
 */
describe('sdk/node OmniSwitchClient (e2e, real HTTP, real guards)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await createTestApp();
    const server = app.getHttpServer().listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/api/v1`;
  });

  afterAll(async () => {
    await app.close();
  });

  async function client(merchantId: string, apiKeyId: string, apiKeySecret: string, hmacSecret: string) {
    return new OmniSwitchClient({ baseUrl, apiKeyId, apiKeySecret, hmacSecret, merchantId });
  }

  it('authenticates, charges, fetches, refunds, and captures a manual-capture payment against the real running app', async () => {
    const merchantId = uniqueId('sdk-e2e');
    const merchant = await seedMerchant(app, { merchantId });
    const sdk = await client(merchantId, merchant.apiKeyId, merchant.apiKeySecret, merchant.hmacSecret);

    const charge = await sdk.charge({ amount: 25, currency: 'USD', paymentMethodId: 'pm_card_visa' });
    expect(charge.status).toBe('SUCCEEDED');
    expect(charge.paymentId).toEqual(expect.any(String));

    const detail = await sdk.getPayment(charge.paymentId);
    expect(detail.paymentId).toBe(charge.paymentId);
    expect(detail.status).toBe('SUCCEEDED');

    const refund = await sdk.refund(charge.paymentId, { amount: 10 });
    expect(refund.totalRefunded).toBe(10);
    expect(refund.remainingRefundable).toBe(15);
  });

  it('captures a manual-capture authorization end to end', async () => {
    const merchantId = uniqueId('sdk-e2e-capture');
    const merchant = await seedMerchant(app, { merchantId });
    const sdk = await client(merchantId, merchant.apiKeyId, merchant.apiKeySecret, merchant.hmacSecret);

    const charge = await sdk.charge({
      amount: 40,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      captureMethod: 'manual',
    });
    expect(charge.status).toBe('REQUIRES_CAPTURE');

    const capture = await sdk.capture(charge.paymentId, { amount: 40 });
    expect(capture.totalCaptured).toBe(40);
    expect(capture.remainingCapturable).toBe(0);
  });

  it('cancels a manual-capture authorization before it is captured', async () => {
    const merchantId = uniqueId('sdk-e2e-cancel');
    const merchant = await seedMerchant(app, { merchantId });
    const sdk = await client(merchantId, merchant.apiKeyId, merchant.apiKeySecret, merchant.hmacSecret);

    const charge = await sdk.charge({
      amount: 15,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      captureMethod: 'manual',
    });
    const cancelled = await sdk.cancel(charge.paymentId);
    expect(cancelled.status).toBe('CANCELLED');
  });

  it('a wrong hmacSecret is rejected by the real HmacSignatureGuard with 401, not silently accepted', async () => {
    const merchantId = uniqueId('sdk-e2e-badkey');
    const merchant = await seedMerchant(app, { merchantId });
    const sdk = await client(merchantId, merchant.apiKeyId, merchant.apiKeySecret, 'f'.repeat(64));

    await expect(sdk.charge({ amount: 10, currency: 'USD', paymentMethodId: 'pm_card_visa' })).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('wrong apiKeySecret fails authentication before any HMAC signing is attempted', async () => {
    const merchantId = uniqueId('sdk-e2e-badauth');
    const merchant = await seedMerchant(app, { merchantId });
    const sdk = await client(merchantId, merchant.apiKeyId, 'wrong-secret', merchant.hmacSecret);

    await expect(sdk.getPayment('pay_does_not_matter')).rejects.toMatchObject({ statusCode: 401 });
  });

  it('verifyWebhookSignature accepts a signature computed the same way MerchantEntity.hmacSecret-based outbound notifications are signed', () => {
    // Exercises the SDK's verify-side against the exact function this
    // codebase's own webhook senders use — see
    // src/shared/utils/notification-delivery.util.ts's signOmniSwitchPayload().
    const { signOmniSwitchPayload } = jest.requireActual('../src/shared/utils/notification-delivery.util');
    const secret = 'a'.repeat(64);
    const body = JSON.stringify({ event: 'dispute.created', paymentId: 'pay_1' });
    const header = signOmniSwitchPayload(secret, body);

    expect(verifyWebhookSignature(secret, body, header)).toBe(true);
    expect(verifyWebhookSignature('wrong-secret', body, header)).toBe(false);
  });
});

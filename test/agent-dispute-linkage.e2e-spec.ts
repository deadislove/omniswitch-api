import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, seedAdminMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest, signStripeWebhook } from './utils/signing';

const USD_BIN = { bin: '424242', country: 'US', cardBrand: 'VISA', cardType: 'CREDIT' };
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;

/**
 * Phase 1 item 6: `delegationId`/`initiatedBy` promoted from the old
 * `paymentMetadata` jsonb bag to real `PaymentEntity` columns (see
 * PaymentEntity.delegationId's docblock), and snapshotted onto
 * `DisputeEntity` at `DisputeService.recordDispute()` time. Data-capture
 * only — this doesn't decide liability, it just makes "was this an
 * agent-initiated charge" an actually-queryable fact on a dispute. See
 * agentic-payments.e2e-spec.ts for the underlying delegation/charge
 * mechanism this reuses, and dispute-notification.e2e-spec.ts for the
 * webhook-firing mechanism.
 */
describe('Agent/dispute attribution linkage (e2e)', () => {
  let app: INestApplication;
  let adminToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    ({ adminToken } = await seedAdminMerchant(app, uniqueId('admin')));
  });

  afterAll(async () => {
    await app.close();
  });

  async function createDelegation(token: string, body: object) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/delegations')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(201);
    return res.body;
  }

  function agentCharge(agentToken: string, signingKey: string, body: object) {
    const path = '/api/v1/payments/charge';
    const bodyStr = JSON.stringify(body);
    const { signature, timestamp } = signHmacRequest(signingKey, 'post', path, bodyStr);
    return request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${agentToken}`)
      .set('Idempotency-Key', randomUUID())
      .set('X-Signature', signature)
      .set('X-Timestamp', timestamp)
      .set('Content-Type', 'application/json')
      .send(body);
  }

  function merchantCharge(m: SeededMerchant, token: string, body: object) {
    const path = '/api/v1/payments/charge';
    const bodyStr = JSON.stringify(body);
    const { signature, timestamp } = signHmacRequest(m.hmacSecret, 'post', path, bodyStr);
    return request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .set('X-Signature', signature)
      .set('X-Timestamp', timestamp)
      .set('X-Merchant-Id', m.merchantId)
      .set('Content-Type', 'application/json')
      .send(body);
  }

  async function fireDisputeCreated(pspTransactionId: string): Promise<void> {
    const body = JSON.stringify({
      id: 'evt_' + uniqueId('agentdispute'),
      type: 'charge.dispute.created',
      data: {
        object: { id: 'dp_' + uniqueId('agentdispute'), payment_intent: pspTransactionId, reason: 'fraudulent' },
      },
    });
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/stripe')
      .set('Stripe-Signature', signStripeWebhook(STRIPE_WEBHOOK_SECRET, body))
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(200);
  }

  async function getDisputeByPaymentId(merchantId: string, paymentId: string) {
    const res = await request(app.getHttpServer())
      .get('/api/v1/admin/disputes')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ merchantId })
      .expect(200);
    return res.body.find((d: any) => d.paymentId === paymentId);
  }

  it('a dispute against an agent-initiated charge records the delegationId and initiatedBy=agent', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('agentdisputelink') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const created = await createDelegation(token, {
      agentName: 'Dispute Test Agent',
      perTransactionLimit: 50,
      monthlyLimit: 200,
      currency: 'USD',
    });

    const chargeRes = await agentCharge(created.agentToken, created.agentSigningKey, {
      amount: 20,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    }).expect(201);
    expect(chargeRes.body.status).toBe('SUCCEEDED');

    await fireDisputeCreated(chargeRes.body.pspTransactionId);

    const dispute = await getDisputeByPaymentId(merchant.merchantId, chargeRes.body.paymentId);
    expect(dispute).toBeTruthy();
    expect(dispute.delegationId).toBe(created.delegation.id);
    expect(dispute.initiatedBy).toBe('agent');
  });

  it('a dispute against a human-initiated charge has no delegationId and initiatedBy=human', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('humandisputelink') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const chargeRes = await merchantCharge(merchant, token, {
      amount: 20,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    }).expect(201);
    expect(chargeRes.body.status).toBe('SUCCEEDED');

    await fireDisputeCreated(chargeRes.body.pspTransactionId);

    const dispute = await getDisputeByPaymentId(merchant.merchantId, chargeRes.body.paymentId);
    expect(dispute).toBeTruthy();
    expect(dispute.delegationId == null).toBe(true);
    expect(dispute.initiatedBy).toBe('human');
  });
});

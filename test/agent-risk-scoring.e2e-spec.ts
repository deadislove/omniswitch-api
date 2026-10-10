import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest } from './utils/signing';

const USD_BIN = { bin: '424242', country: 'US', cardBrand: 'VISA', cardType: 'CREDIT' };

/**
 * Phase 1 item 7: PaymentAggregate.calculateRiskScore() gained two
 * agent-context signals (see its own docblock) — computed only for an
 * agent-initiated charge (PaymentCheckoutSaga's Step 2), never for a
 * human one. Both tests below use amounts <=1000 major units and a
 * non-European BinInfo specifically so the existing amount/SCA bumps
 * stay at 0 and every asserted score is exactly `10 (baseline) + agent
 * bumps` — precise numbers, not just "higher than" comparisons.
 */
describe('Agent-specific risk scoring signals (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
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

  it("an agent's first-ever charge to a merchant scores higher than its second charge to the same merchant, all else equal", async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('riskfirst') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    const created = await createDelegation(token, {
      agentName: 'Risk Test Agent',
      perTransactionLimit: 100,
      monthlyLimit: 1000,
      currency: 'USD',
    });

    const orderId = uniqueId('order');
    const first = await agentCharge(created.agentToken, created.agentSigningKey, {
      amount: 20,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId,
      binInfo: USD_BIN,
    }).expect(201);
    // baseline 10 + isFirstChargeToMerchant 15, no budget-pressure bump
    // (20/(1000-0) = 2% remaining budget, well under the 50% threshold).
    expect(first.body.riskScore).toBe(25);

    const second = await agentCharge(created.agentToken, created.agentSigningKey, {
      amount: 20,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    }).expect(201);
    // Same merchant, same delegation, same amount — no longer "first",
    // so only the baseline 10 applies.
    expect(second.body.riskScore).toBe(10);
    expect(first.body.riskScore).toBeGreaterThan(second.body.riskScore);
  });

  it("a charge consuming most of a delegation's remaining monthly budget scores higher than an equivalent charge with plenty of budget left, all else equal", async () => {
    const tightMerchant = await seedMerchant(app, { merchantId: uniqueId('risktight') });
    const tightToken = await login(app, tightMerchant.apiKeyId, tightMerchant.apiKeySecret);
    const tightDelegation = await createDelegation(tightToken, {
      agentName: 'Tight Budget Agent',
      perTransactionLimit: 100,
      monthlyLimit: 100,
      currency: 'USD',
    });

    const roomyMerchant = await seedMerchant(app, { merchantId: uniqueId('riskroomy') });
    const roomyToken = await login(app, roomyMerchant.apiKeyId, roomyMerchant.apiKeySecret);
    const roomyDelegation = await createDelegation(roomyToken, {
      agentName: 'Roomy Budget Agent',
      perTransactionLimit: 100,
      monthlyLimit: 1000,
      currency: 'USD',
    });

    // A $1 charge to each merchant first, purely to make the *second*
    // charge to that same merchant "not first" for both delegations —
    // isolates the budget-pressure signal from the first-charge one.
    await agentCharge(tightDelegation.agentToken, tightDelegation.agentSigningKey, {
      amount: 1,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    }).expect(201);
    await agentCharge(roomyDelegation.agentToken, roomyDelegation.agentSigningKey, {
      amount: 1,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    }).expect(201);

    const tightSecond = await agentCharge(tightDelegation.agentToken, tightDelegation.agentSigningKey, {
      amount: 60,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    }).expect(201);
    // Not first (already charged this merchant above). Remaining budget
    // before this charge: 100 - 1 = 99; 60/99 ≈ 60.6% >= 50% threshold.
    expect(tightSecond.body.riskScore).toBe(25);

    const roomySecond = await agentCharge(roomyDelegation.agentToken, roomyDelegation.agentSigningKey, {
      amount: 60,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    }).expect(201);
    // Not first. Remaining budget before this charge: 1000 - 1 = 999;
    // 60/999 ≈ 6%, well under the threshold.
    expect(roomySecond.body.riskScore).toBe(10);

    expect(tightSecond.body.riskScore).toBeGreaterThan(roomySecond.body.riskScore);
  });

  it('a human-initiated charge is completely unaffected by the new agent-context logic (backward compatible)', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('riskhuman') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const orderId = uniqueId('order');
    // Same merchant, twice — an agent would score its first of these
    // higher; a human charge must not, regardless of repetition.
    const first = await merchantCharge(merchant, token, {
      amount: 20,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId,
      binInfo: USD_BIN,
    }).expect(201);
    const second = await merchantCharge(merchant, token, {
      amount: 20,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    }).expect(201);

    expect(first.body.riskScore).toBe(10);
    expect(second.body.riskScore).toBe(10);
  });
});

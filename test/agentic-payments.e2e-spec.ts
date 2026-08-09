import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, login, uniqueId } from './utils/seed';
import { PaymentEntity } from '../src/modules/payment/adapters/persistence/entities/payment.entity';
import { DelegationEntity } from '../src/modules/payment/adapters/persistence/entities/delegation.entity';

/**
 * Agentic payments: a merchant can authorize an autonomous agent to charge
 * on its behalf via a Delegation — a narrower, revocable credential with
 * its own spend policy (per-transaction limit, rolling monthly limit,
 * optional category allowlist), distinct from the merchant's own
 * full-access JWT. See delegation.aggregate.ts and
 * docs/business-domain/future-directions.md#agentic-payments.
 *
 * An agent charges through the exact same POST /payments/charge every
 * other caller uses (see PaymentController.charge()'s AGENT branch) — it
 * is exempt from the HMAC signature requirement (an agent never holds the
 * merchant's own HMAC secret — see HmacSignatureGuard's docblock) but has
 * its charge amount/category checked against, and atomically reserved
 * from, its delegation's spend policy before the saga ever runs.
 */
describe('Agentic payments — delegated agent credentials & spend policy (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    app = await createTestApp();
    dataSource = app.get(DataSource);
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

  /** Deliberately no HMAC/idempotency-signature headers — only Idempotency-Key, which every charge caller needs regardless of auth method. */
  function agentCharge(agentToken: string, body: object) {
    return request(app.getHttpServer())
      .post('/api/v1/payments/charge')
      .set('Authorization', `Bearer ${agentToken}`)
      .set('Idempotency-Key', randomUUID())
      .send(body);
  }

  it('creating a delegation returns an ACTIVE delegation and an agent token that can charge within policy, with no HMAC headers required', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('agentbasic') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const created = await createDelegation(token, {
      agentName: 'Shopping Assistant',
      perTransactionLimit: 50,
      monthlyLimit: 200,
      currency: 'USD',
    });
    expect(created.delegation.status).toBe('ACTIVE');
    expect(created.delegation.currentMonthSpent).toBe(0);
    expect(created.tokenType).toBe('Bearer');
    expect(typeof created.agentToken).toBe('string');

    const chargeRes = await agentCharge(created.agentToken, {
      amount: 20,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
    }).expect(201);
    expect(chargeRes.body.status).toBe('SUCCEEDED');

    // The audit trail (who/what actually initiated this charge) isn't on
    // the response DTO — verify it directly against the DB, same posture
    // as this codebase's other "verified via a fresh DB read" reserve/
    // payout assertions.
    const payment = await dataSource.getRepository(PaymentEntity).findOne({ where: { id: chargeRes.body.paymentId } });
    expect(payment?.paymentMetadata).toEqual({ delegationId: created.delegation.id, initiatedBy: 'agent' });

    const afterRes = await request(app.getHttpServer())
      .get(`/api/v1/delegations/${created.delegation.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(afterRes.body.currentMonthSpent).toBe(20);
  });

  it('a charge exceeding the per-transaction limit is rejected with 422 and no payment is created at all', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('agentpertx') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    const created = await createDelegation(token, { agentName: 'A', perTransactionLimit: 30, monthlyLimit: 1000, currency: 'USD' });

    const res = await agentCharge(created.agentToken, {
      amount: 50, currency: 'USD', paymentMethodId: 'pm_card_visa', orderId: uniqueId('order'),
    }).expect(422);
    expect(res.body.code).toBe('DELEGATION_PER_TRANSACTION_LIMIT_EXCEEDED');

    const count = await dataSource.getRepository(PaymentEntity).count({ where: { merchantId: merchant.merchantId } });
    expect(count).toBe(0);
  });

  it('cumulative charges exceeding the rolling monthly limit are rejected on the one that would cross it, without disturbing the already-reserved spend', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('agentmonthly') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    const created = await createDelegation(token, { agentName: 'A', perTransactionLimit: 50, monthlyLimit: 90, currency: 'USD' });

    await agentCharge(created.agentToken, { amount: 40, currency: 'USD', paymentMethodId: 'pm_card_visa', orderId: uniqueId('order') }).expect(201);
    await agentCharge(created.agentToken, { amount: 40, currency: 'USD', paymentMethodId: 'pm_card_visa', orderId: uniqueId('order') }).expect(201);
    // 80 spent so far; a 3rd charge of 40 would reach 120 > 90.
    const res = await agentCharge(created.agentToken, { amount: 40, currency: 'USD', paymentMethodId: 'pm_card_visa', orderId: uniqueId('order') }).expect(422);
    expect(res.body.code).toBe('DELEGATION_MONTHLY_LIMIT_EXCEEDED');

    const delegation = await dataSource.getRepository(DelegationEntity).findOne({ where: { id: created.delegation.id } });
    expect(delegation?.currentMonthSpentMinorUnits).toBe('8000');
  });

  it('a category outside allowedCategories is rejected with 422; an allowed one succeeds', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('agentcategory') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    const created = await createDelegation(token, {
      agentName: 'A', perTransactionLimit: 50, monthlyLimit: 500, currency: 'USD', allowedCategories: ['groceries'],
    });

    const rejected = await agentCharge(created.agentToken, {
      amount: 10, currency: 'USD', paymentMethodId: 'pm_card_visa', orderId: uniqueId('order'), category: 'electronics',
    }).expect(422);
    expect(rejected.body.code).toBe('DELEGATION_CATEGORY_NOT_ALLOWED');

    await agentCharge(created.agentToken, {
      amount: 10, currency: 'USD', paymentMethodId: 'pm_card_visa', orderId: uniqueId('order'), category: 'groceries',
    }).expect(201);
  });

  it('a charge in a currency other than the delegation\'s spend-policy currency is rejected with 422', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('agentcurrency') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    const created = await createDelegation(token, { agentName: 'A', perTransactionLimit: 50, monthlyLimit: 500, currency: 'USD' });

    const res = await agentCharge(created.agentToken, {
      amount: 10, currency: 'EUR', paymentMethodId: 'pm_card_visa', orderId: uniqueId('order'),
    }).expect(422);
    expect(res.body.code).toBe('DELEGATION_CURRENCY_MISMATCH');
  });

  it('revoking a delegation takes effect immediately — its still-unexpired agent token is rejected on the very next request, not just once it naturally expires', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('agentrevoke') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    const created = await createDelegation(token, { agentName: 'A', perTransactionLimit: 50, monthlyLimit: 500, currency: 'USD' });

    await agentCharge(created.agentToken, { amount: 10, currency: 'USD', paymentMethodId: 'pm_card_visa', orderId: uniqueId('order') }).expect(201);

    const revokeRes = await request(app.getHttpServer())
      .post(`/api/v1/delegations/${created.delegation.id}/revoke`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(revokeRes.body.status).toBe('REVOKED');

    const res = await agentCharge(created.agentToken, {
      amount: 10, currency: 'USD', paymentMethodId: 'pm_card_visa', orderId: uniqueId('order'),
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_REVOKED');

    // Revoking a second time is rejected, not silently accepted again.
    await request(app.getHttpServer())
      .post(`/api/v1/delegations/${created.delegation.id}/revoke`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
  });

  it('a PSP decline releases the reserved spend — a subsequent charge that would otherwise exceed the monthly limit still succeeds', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('agentdecline') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    const created = await createDelegation(token, { agentName: 'A', perTransactionLimit: 50, monthlyLimit: 50, currency: 'USD' });

    // "carddeclined" is the mock PSP's decline-code marker in
    // paymentMethodId (scripts/mock-psp/server.js's DECLINE_CODE_MARKERS)
    // — a real PSP-returned decline, so the saga completes normally with
    // status FAILED (HTTP 201), not a thrown routing exception.
    const declineRes = await agentCharge(created.agentToken, {
      amount: 50, currency: 'USD', paymentMethodId: 'pm_card_carddeclined', orderId: uniqueId('order'),
    }).expect(201);
    expect(declineRes.body.status).toBe('FAILED');

    // If the $50 reservation from the declined attempt weren't released,
    // this would push the delegation to $100 against a $50 monthly cap.
    const successRes = await agentCharge(created.agentToken, {
      amount: 50, currency: 'USD', paymentMethodId: 'pm_card_visa', orderId: uniqueId('order'),
    }).expect(201);
    expect(successRes.body.status).toBe('SUCCEEDED');
  });

  it('an agent token cannot call endpoints outside its narrow scope — only POST /payments/charge accepts the AGENT role', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('agentscope') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    const created = await createDelegation(token, { agentName: 'A', perTransactionLimit: 50, monthlyLimit: 500, currency: 'USD' });

    await request(app.getHttpServer())
      .get('/api/v1/subscriptions')
      .set('Authorization', `Bearer ${created.agentToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .get('/api/v1/delegations')
      .set('Authorization', `Bearer ${created.agentToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .post('/api/v1/plans')
      .set('Authorization', `Bearer ${created.agentToken}`)
      .send({ name: 'x', amount: 10, currency: 'USD', interval: 'month' })
      .expect(403);
  });

  it('a merchant cannot view, list, or revoke another merchant\'s delegation', async () => {
    const owner = await seedMerchant(app, { merchantId: uniqueId('agentowner') });
    const ownerToken = await login(app, owner.apiKeyId, owner.apiKeySecret);
    const intruder = await seedMerchant(app, { merchantId: uniqueId('agentintruder') });
    const intruderToken = await login(app, intruder.apiKeyId, intruder.apiKeySecret);

    const created = await createDelegation(ownerToken, { agentName: 'Private Agent', perTransactionLimit: 50, monthlyLimit: 500, currency: 'USD' });

    await request(app.getHttpServer())
      .get(`/api/v1/delegations/${created.delegation.id}`)
      .set('Authorization', `Bearer ${intruderToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .post(`/api/v1/delegations/${created.delegation.id}/revoke`)
      .set('Authorization', `Bearer ${intruderToken}`)
      .expect(403);

    const listRes = await request(app.getHttpServer())
      .get('/api/v1/delegations')
      .set('Authorization', `Bearer ${intruderToken}`)
      .expect(200);
    expect(listRes.body.some((d: any) => d.id === created.delegation.id)).toBe(false);
  });
});

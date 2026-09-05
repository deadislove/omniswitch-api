import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, seedAdminMerchant, login, uniqueId } from './utils/seed';
import { signHmacRequest } from './utils/signing';
import { PaymentEntity } from '../src/modules/payment/adapters/persistence/entities/payment.entity';

const USD_BIN = { bin: '424242', country: 'US', cardBrand: 'VISA', cardType: 'CREDIT' };

/**
 * The `PENDING_APPROVAL` hold state for an agent-initiated charge above
 * its delegation's `requireApprovalAboveAmount` — the durable mechanism
 * the original agentic-payments framing ("ask me first for anything
 * above $200") needed and didn't have. See
 * ChargeApproval.aggregate.ts and
 * docs/business-domain/future-directions.md#agentic-payments.
 * agentic-payments.e2e-spec.ts already covers the ungated spend-policy
 * path (per-transaction/monthly limits, categories) — this file is only
 * about the approval gate layered on top of it.
 */
describe('Agentic payments: human-approval hold state (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    dataSource = app.get(DataSource);
    ({ adminToken } = await seedAdminMerchant(app, uniqueId('admin')));
  });

  afterAll(async () => {
    await app.close();
  });

  // Same replica-lag reasoning as agentic-payments.e2e-spec.ts's
  // findOneOnMaster() — a read immediately following its own write races
  // the ambient replica-routed DataSource.
  async function findOneOnMaster<T extends object>(entityClass: new () => T, where: object): Promise<T | null> {
    const queryRunner = dataSource.createQueryRunner('master');
    try {
      return await queryRunner.manager.findOne(entityClass, { where });
    } finally {
      await queryRunner.release();
    }
  }

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

  async function merchantWithGatedDelegation(requireApprovalAboveAmount = 200) {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    const merchantToken = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    const delegation = await createDelegation(merchantToken, {
      agentName: 'Shopping Assistant',
      perTransactionLimit: 1000,
      monthlyLimit: 5000,
      currency: 'USD',
      requireApprovalAboveAmount,
    });
    return { merchant, merchantToken, delegation };
  }

  it('a charge at or below requireApprovalAboveAmount auto-executes exactly as before — no approval created', async () => {
    const { delegation } = await merchantWithGatedDelegation();
    const res = await agentCharge(delegation.agentToken, delegation.agentSigningKey, {
      amount: 50,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    }).expect(201);
    expect(res.body.status).toBe('SUCCEEDED');
    expect(res.body.approvalId).toBeUndefined();
  });

  it('a charge above requireApprovalAboveAmount (but within perTransactionLimit) returns PENDING_APPROVAL, with no Payment created yet', async () => {
    const { delegation } = await merchantWithGatedDelegation();
    const res = await agentCharge(delegation.agentToken, delegation.agentSigningKey, {
      amount: 300,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    }).expect(201);
    expect(res.body.status).toBe('PENDING_APPROVAL');
    expect(res.body.approvalId).toEqual(expect.any(String));
    expect(res.body.pspTransactionId).toBeUndefined();

    const payment = await findOneOnMaster(PaymentEntity, { id: res.body.paymentId });
    expect(payment).toBeNull();
  });

  it('a charge above requireApprovalAboveAmount already reserves spend against the delegation, before any approval decision', async () => {
    const { delegation, merchantToken } = await merchantWithGatedDelegation();
    await agentCharge(delegation.agentToken, delegation.agentSigningKey, {
      amount: 300,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    }).expect(201);

    const getRes = await request(app.getHttpServer())
      .get(`/api/v1/delegations/${delegation.delegation.id}`)
      .set('Authorization', `Bearer ${merchantToken}`)
      .expect(200);
    expect(getRes.body.currentMonthSpent).toBe(300);
  });

  it('approving a pending charge actually executes it — a real Payment now exists, SUCCEEDED', async () => {
    const { delegation, merchantToken } = await merchantWithGatedDelegation();
    const chargeRes = await agentCharge(delegation.agentToken, delegation.agentSigningKey, {
      amount: 300,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    }).expect(201);
    const approvalId = chargeRes.body.approvalId;
    const paymentId = chargeRes.body.paymentId;

    const approveRes = await request(app.getHttpServer())
      .post(`/api/v1/charge-approvals/${approvalId}/approve`)
      .set('Authorization', `Bearer ${merchantToken}`)
      .expect(200);
    expect(approveRes.body.status).toBe('SUCCEEDED');
    expect(approveRes.body.paymentId).toBe(paymentId);
    expect(approveRes.body.pspTransactionId).toEqual(expect.any(String));

    const payment = await findOneOnMaster(PaymentEntity, { id: paymentId });
    expect(payment).not.toBeNull();
    expect(payment!.status).toBe('SUCCEEDED');

    const approvalGetRes = await request(app.getHttpServer())
      .get(`/api/v1/charge-approvals/${approvalId}`)
      .set('Authorization', `Bearer ${merchantToken}`)
      .expect(200);
    expect(approvalGetRes.body.status).toBe('APPROVED');
    expect(approvalGetRes.body.decidedBy).toBe(delegation.delegation.merchantId);
  });

  it('a second approval attempt on the same approval is rejected with 409', async () => {
    const { delegation, merchantToken } = await merchantWithGatedDelegation();
    const chargeRes = await agentCharge(delegation.agentToken, delegation.agentSigningKey, {
      amount: 300,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    }).expect(201);
    const approvalId = chargeRes.body.approvalId;

    await request(app.getHttpServer())
      .post(`/api/v1/charge-approvals/${approvalId}/approve`)
      .set('Authorization', `Bearer ${merchantToken}`)
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/charge-approvals/${approvalId}/approve`)
      .set('Authorization', `Bearer ${merchantToken}`)
      .expect(409);
    expect(res.body.code).toBe('CHARGE_APPROVAL_ALREADY_DECIDED');
  });

  it('denying a pending charge releases the reserved spend and never attempts the charge', async () => {
    const { delegation, merchantToken } = await merchantWithGatedDelegation();
    const chargeRes = await agentCharge(delegation.agentToken, delegation.agentSigningKey, {
      amount: 300,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    }).expect(201);
    const approvalId = chargeRes.body.approvalId;
    const paymentId = chargeRes.body.paymentId;

    const denyRes = await request(app.getHttpServer())
      .post(`/api/v1/charge-approvals/${approvalId}/deny`)
      .set('Authorization', `Bearer ${merchantToken}`)
      .send({ reason: 'Looks like a duplicate order' })
      .expect(200);
    expect(denyRes.body.status).toBe('DENIED');
    expect(denyRes.body.denialReason).toBe('Looks like a duplicate order');

    const payment = await findOneOnMaster(PaymentEntity, { id: paymentId });
    expect(payment).toBeNull();

    const getRes = await request(app.getHttpServer())
      .get(`/api/v1/delegations/${delegation.delegation.id}`)
      .set('Authorization', `Bearer ${merchantToken}`)
      .expect(200);
    expect(getRes.body.currentMonthSpent).toBe(0);
  });

  it('a charge above perTransactionLimit is still rejected outright with 422 — never routed to approval', async () => {
    const { delegation } = await merchantWithGatedDelegation();
    const res = await agentCharge(delegation.agentToken, delegation.agentSigningKey, {
      amount: 1500, // above perTransactionLimit (1000)
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    }).expect(422);
    expect(res.body.code).toBe('DELEGATION_PER_TRANSACTION_LIMIT_EXCEEDED');
  });

  it('a delegation with no requireApprovalAboveAmount configured never creates an approval, regardless of amount', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    const merchantToken = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    const delegation = await createDelegation(merchantToken, {
      agentName: 'Ungated Assistant',
      perTransactionLimit: 1000,
      monthlyLimit: 5000,
      currency: 'USD',
      // requireApprovalAboveAmount omitted entirely
    });
    const res = await agentCharge(delegation.agentToken, delegation.agentSigningKey, {
      amount: 900,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    }).expect(201);
    expect(res.body.status).toBe('SUCCEEDED');
    expect(res.body.approvalId).toBeUndefined();
  });

  it("a different merchant cannot approve or even view another merchant's charge approval", async () => {
    const { delegation } = await merchantWithGatedDelegation();
    const chargeRes = await agentCharge(delegation.agentToken, delegation.agentSigningKey, {
      amount: 300,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    }).expect(201);
    const approvalId = chargeRes.body.approvalId;

    const otherMerchant = await seedMerchant(app, { merchantId: uniqueId('other-merchant') });
    const otherToken = await login(app, otherMerchant.apiKeyId, otherMerchant.apiKeySecret);

    await request(app.getHttpServer())
      .get(`/api/v1/charge-approvals/${approvalId}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(403);
    await request(app.getHttpServer())
      .post(`/api/v1/charge-approvals/${approvalId}/approve`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(403);
  });

  it("ADMIN can list, view, and approve any merchant's pending charge approvals", async () => {
    const { delegation } = await merchantWithGatedDelegation();
    const chargeRes = await agentCharge(delegation.agentToken, delegation.agentSigningKey, {
      amount: 300,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    }).expect(201);
    const approvalId = chargeRes.body.approvalId;

    const listRes = await request(app.getHttpServer())
      .get(`/api/v1/charge-approvals?delegationId=${delegation.delegation.id}&status=PENDING`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(listRes.body.find((a: any) => a.id === approvalId)).toBeTruthy();

    const approveRes = await request(app.getHttpServer())
      .post(`/api/v1/charge-approvals/${approvalId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(approveRes.body.status).toBe('SUCCEEDED');
  });
});

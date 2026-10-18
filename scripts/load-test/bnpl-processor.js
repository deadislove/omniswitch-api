'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Same signing scheme as processor.js's signCharge — see that file's own
// comment for why a load test that can't pass HmacSignatureGuard would
// just be measuring 401s.
function signRequest(method, reqPath, bodyStr, hmacSecret) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signedPayload = `${timestamp}.${method}.${reqPath}.${bodyStr}`;
  const signature = crypto.createHmac('sha256', hmacSecret).update(signedPayload).digest('hex');
  return { signature, timestamp };
}

let merchants = [];
try {
  merchants = JSON.parse(fs.readFileSync(path.join(__dirname, '.merchants.json'), 'utf8'));
} catch (e) {
  merchants = [
    {
      merchantId: process.env.LOAD_TEST_MERCHANT_ID,
      hmacSecret: process.env.LOAD_TEST_HMAC_SECRET,
      jwt: process.env.LOAD_TEST_JWT,
    },
  ];
}

function pickMerchant() {
  return merchants[Math.floor(Math.random() * merchants.length)];
}

// Unlike signCharge, a BNPL order has no manual-capture split — createOrder()
// and the Klarna capture call both happen inside this one request (see
// BnplService.createOrder()'s own docblock), so this is measuring a
// request that makes two sequential outbound calls to mock-psp, not one.
function signBnplCreate(requestParams, context, ee, next) {
  const merchant = pickMerchant();
  context.vars.__merchant = merchant;

  const body = {
    amount: Number((Math.random() * 490 + 10).toFixed(2)),
    currency: 'USD',
    description: 'loadtest_' + crypto.randomUUID(),
  };
  const bodyStr = JSON.stringify(body);
  const { signature, timestamp } = signRequest('POST', '/api/v1/bnpl/orders', bodyStr, merchant.hmacSecret);

  requestParams.headers = {
    ...requestParams.headers,
    Authorization: `Bearer ${merchant.jwt}`,
    'Idempotency-Key': crypto.randomUUID(),
    'X-Signature': signature,
    'X-Timestamp': timestamp,
    'X-Merchant-Id': merchant.merchantId,
    'Content-Type': 'application/json',
  };
  requestParams.json = body;
  return next();
}

function addAuthHeader(requestParams, context, ee, next) {
  const merchant = context.vars.__merchant || pickMerchant();
  requestParams.headers = {
    ...requestParams.headers,
    Authorization: `Bearer ${merchant.jwt}`,
  };
  return next();
}

module.exports = { signBnplCreate, addAuthHeader };

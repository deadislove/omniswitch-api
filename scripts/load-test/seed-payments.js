'use strict';

// Seeds a pool of real payments (well under the charge endpoint's
// hardcoded 100 req/min cap — see docs/technical/load-testing.md) so the
// read-path capacity test has real paymentIds to fetch, spread across all
// seeded merchants (a payment is only readable by its owning merchant).

const http = require('http');
const crypto = require('crypto');

const TARGET = process.env.TARGET_URL || 'http://localhost:3000';
const PER_MERCHANT = Number(process.env.LOAD_TEST_PAYMENTS_PER_MERCHANT || 2);

function post(path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(TARGET + path);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          if (res.statusCode >= 400) return reject(new Error(`${path} -> ${res.statusCode}: ${raw}`));
          resolve(JSON.parse(raw));
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function chargeOnce(merchant, i) {
  const body = {
    amount: Number((Math.random() * 90 + 10).toFixed(2)),
    currency: 'USD',
    paymentMethodId: 'pm_card_visa',
    orderId: `seed_${merchant.merchantId}_${i}`,
    binInfo: { bin: '424242', country: 'US', cardBrand: 'VISA', cardType: 'CREDIT' },
  };
  const bodyStr = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac('sha256', merchant.hmacSecret).update(`${ts}.POST./api/v1/payments/charge.${bodyStr}`).digest('hex');
  const res = await post('/api/v1/payments/charge', body, {
    Authorization: `Bearer ${merchant.jwt}`,
    'Idempotency-Key': crypto.randomUUID(),
    'X-Signature': sig,
    'X-Timestamp': ts,
    'X-Merchant-Id': merchant.merchantId,
  });
  return res.paymentId;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const merchants = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '.merchants.json'), 'utf8'));
  const pool = [];
  // Paced well under the charge endpoint's hardcoded 100/min cap (which,
  // as documented in docs/technical/load-testing.md, applies per source
  // IP regardless of merchant identity when all traffic comes from one
  // machine) — this is fixture seeding, not the thing being measured.
  for (const merchant of merchants) {
    for (let i = 0; i < PER_MERCHANT; i++) {
      const paymentId = await chargeOnce(merchant, i);
      pool.push({ merchantId: merchant.merchantId, jwt: merchant.jwt, paymentId });
      if (pool.length % 20 === 0) process.stdout.write(`${pool.length}`);
      else process.stdout.write('.');
      await sleep(700);
    }
  }
  require('fs').writeFileSync(require('path').join(__dirname, '.payments.json'), JSON.stringify(pool, null, 2));
  console.log(`\nSeeded ${pool.length} payments across ${merchants.length} merchants`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

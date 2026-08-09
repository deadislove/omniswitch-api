'use strict';

const fs = require('fs');
const path = require('path');

// Pre-seeded real payments (scripts/load-test/seed-payments.js) — one per
// merchant, so each read is a real DB lookup for a real row, and ownership
// (assertOwnership) is satisfied by using that payment's own merchant JWT.
const pool = JSON.parse(fs.readFileSync(path.join(__dirname, '.payments.json'), 'utf8'));

function pickAndAuth(requestParams, context, ee, next) {
  const entry = pool[Math.floor(Math.random() * pool.length)];
  requestParams.url = `/api/v1/payments/${entry.paymentId}`;
  requestParams.headers = {
    ...requestParams.headers,
    Authorization: `Bearer ${entry.jwt}`,
  };
  return next();
}

module.exports = { pickAndAuth };

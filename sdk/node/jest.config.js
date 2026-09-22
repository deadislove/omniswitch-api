/** Unit tests for this package only (signing/webhook logic + mocked-fetch client behavior) — see ../../test/sdk-node-client.e2e-spec.ts for the real end-to-end proof against a running app instance, run via the main repo's own e2e suite. */
const path = require('path');

module.exports = {
  testEnvironment: 'node',
  rootDir: '.',
  testRegex: 'test/.*\\.spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: path.join(__dirname, 'tsconfig.test.json') }] },
};

// Dedicated, blocking security-lint config — separate from eslint.config.cjs
// (the general lint/format config, which is currently report-only in CI;
// see .github/workflows/ci.yml for why). This one only loads
// eslint-plugin-security's rules against src/**, with no type-aware
// parserOptions.project (these rules don't need type info, and src/'s
// tsconfig.json doesn't cover test/ anyway — see ci.yml's lint step
// comment for that pre-existing gap). Run with `--max-warnings=0`: every
// rule in eslint-plugin-security's recommended config defaults to 'warn',
// and a warning alone doesn't fail `eslint`'s exit code otherwise.
const tsParser = require('@typescript-eslint/parser');
const securityPlugin = require('eslint-plugin-security');

module.exports = [
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  {
    // ESLint's flat config defaults reportUnusedDisableDirectives to
    // 'warn' (the eslintrc-based CLI this repo used before never checked
    // this). Keeping it off preserves this config's pre-migration
    // behavior instead of newly failing on unrelated pre-existing
    // eslint-disable comments.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      sourceType: 'module',
      ecmaVersion: 2021,
    },
    plugins: {
      security: securityPlugin,
    },
    rules: {
      ...securityPlugin.configs.recommended.rules,
      // Disabled, not suppressed per-site: this rule flags every dynamic
      // bracket-access (`obj[x]`) regardless of whether `x` is actually
      // attacker-controlled. Verified against this codebase's own hits —
      // e.g. VALID_TRANSITIONS[from] (from: PaymentStatus, a closed TS
      // enum) and req.headers[CORRELATION_ID_HEADER] (a fixed constant
      // key) — both false positives, not real injection sinks. The
      // plugin's own docs acknowledge this rule "100% will have false
      // positives." The other 13 rules here (eval, child_process,
      // non-literal-fs-filename, unsafe-regex, timing attacks, etc.) have
      // a much lower false-positive rate and stay enabled.
      'security/detect-object-injection': 'off',
    },
  },
];

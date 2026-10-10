const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');
const prettierRecommended = require('eslint-plugin-prettier/recommended');
const securityPlugin = require('eslint-plugin-security');
const globals = require('globals');

module.exports = [
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  ...tsPlugin.configs['flat/recommended'],
  {
    // Registering the `security` plugin below (with no rules enabled)
    // makes the cross-referenced disable comments resolve as real
    // directives instead of erroring — but since none of that plugin's
    // rules run here, every one of those directives now suppresses
    // nothing *in this config*, which flat config's default
    // reportUnusedDisableDirectives would otherwise flag as its own
    // warning. Off for the same reason eslint.security.config.cjs turns
    // it off for its own cross-references back the other way: these
    // comments are real and load-bearing in the config they're actually
    // meant for.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        // tsconfig.json itself excludes `test/` — `rootDir: "./src"` means
        // `nest build` would otherwise try to compile test files into
        // `dist/` too, so that exclusion is load-bearing for the actual
        // build, not something to change just for linting (see
        // ci-cd.md's lint section). tsconfig.eslint.json extends it with
        // `test/**/*.ts` included instead, so type-aware lint rules can
        // parse test files without touching the build config.
        project: 'tsconfig.eslint.json',
        tsconfigRootDir: __dirname,
      },
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    // `security` is registered (plugin only, no rules enabled below) so
    // that the `eslint-disable-next-line security/detect-non-literal-fs-filename`
    // comments a few files carry — meant for the sibling
    // eslint.security.config.cjs run, the actual place that rule is
    // enforced — resolve as real, inert directives instead of ESLint's
    // flat config erroring with "Definition for rule ... was not found"
    // for a plugin this config never loaded.
    plugins: {
      security: securityPlugin,
    },
    rules: {
      '@typescript-eslint/interface-name-prefix': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  prettierRecommended,
];

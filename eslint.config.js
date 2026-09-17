import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'artifacts/**', 'web/public/**', 'playwright-report/**', 'test-results/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['**/*.mjs', '**/*.js'], languageOptions: { globals: { process: 'readonly', console: 'readonly' } } },
  {
    // Test-only: structured MCP results are asserted field by field; typing every shape adds noise.
    files: ['tests/mcp/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      // Money never goes through floating point.
      'no-restricted-globals': ['error', { name: 'parseFloat', message: 'No floating-point money arithmetic.' }],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Number'][callee.property.name='parseFloat']",
          message: 'No floating-point money arithmetic.',
        },
      ],
    },
  },
);

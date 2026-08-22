import { config, configs } from 'typescript-eslint';

export default config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '*.vsix'],
  },
  ...configs.recommended,
  {
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  }
);

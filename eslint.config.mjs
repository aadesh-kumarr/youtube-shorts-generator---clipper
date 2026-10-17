import eslint from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-async-promise-executor': 'off',
    },
  },
  globalIgnores(['.next/**', 'public/output/**', 'public/workspace/**', 'tmp/**', 'bin/**', 'next-env.d.ts']),
]);

import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import importPlugin from 'eslint-plugin-import'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.wrangler/**', '**/build/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    plugins: { import: importPlugin },
    settings: {
      'import/resolver': {
        typescript: { project: ['apps/*/tsconfig.json', 'packages/*/tsconfig.json'] },
      },
    },
    rules: {
      'import/no-cycle': ['error', { maxDepth: 10 }],
      'import/no-restricted-paths': ['error', {
        zones: [
          // data-plane ⊥ control-plane
          { target: './apps/gateway/src/data-plane', from: './apps/gateway/src/control-plane' },
          { target: './apps/gateway/src/control-plane', from: './apps/gateway/src/data-plane' },
          // packages 单向依赖：protocols ← translate ← apps
          { target: './packages/protocols/src', from: './packages/translate/src' },
          { target: './packages/protocols/src', from: './apps' },
          { target: './packages/translate/src', from: './apps' },
        ],
      }],
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
)

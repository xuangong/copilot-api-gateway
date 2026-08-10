import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import importPlugin from 'eslint-plugin-import'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.wrangler/**', '**/build/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    plugins: { import: importPlugin, 'react-hooks': reactHooks },
    settings: {
      'import/resolver': {
        typescript: { project: ['apps/*/tsconfig.json', 'packages/*/tsconfig.json'] },
      },
    },
    rules: {
      'import/no-cycle': ['error', { maxDepth: 10 }],
      'import/no-restricted-paths': ['error', {
        zones: [
          // 单向：data-plane 永远不得 import control-plane。反向是允许的 ——
          // 控制面的 upstream 探活 / 列模型端点必须能构造 provider，那是数据面
          // 的 registry。禁止反向只会逼出一层没有第二个调用方的中转接口。
          { target: './packages/gateway/src/data-plane', from: './packages/gateway/src/control-plane' },
          // packages 单向依赖：protocols-llm ← translate ← gateway
          { target: './packages/protocols-llm/src', from: './packages/translate/src' },
          { target: './packages/protocols-llm/src', from: './packages/gateway/src' },
          { target: './packages/translate/src', from: './packages/gateway/src' },
        ],
      }],
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-useless-assignment': 'warn',
      'preserve-caught-error': 'warn',
      'require-yield': 'warn',
    },
  },
)

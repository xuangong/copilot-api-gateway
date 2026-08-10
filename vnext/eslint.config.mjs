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
          // repo/ 是两个平面共同的底座，它自己不得知道任何一个平面的存在。
          { target: './packages/gateway/src/repo', from: './packages/gateway/src/data-plane' },
          { target: './packages/gateway/src/repo', from: './packages/gateway/src/control-plane' },
          // shared/ 现在只剩 7 项，全部是双平面或 app 级公用物。它同样不得
          // 反向依赖任一平面 —— 这条规则是上一轮 shared/ 膨胀成豁免区的解药。
          { target: './packages/gateway/src/shared', from: './packages/gateway/src/data-plane' },
          { target: './packages/gateway/src/shared', from: './packages/gateway/src/control-plane' },
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
  {
    // 库不得反向依赖宿主。packages/ 是可移植的库，apps/ 是把它绑到某个运行时
    // 上的宿主；源码里出现 platform-bun / platform-cloudflare 就意味着某段逻辑
    // 只能在一个运行时上跑。今天零违例，这条规则是防回归的哨兵。
    //
    // 深导入同理：包与包之间只走包名入口。今天 packages/*/src 之间零深导入,
    // 规则把这个状态钉住。apps/ 与 tests/ 不受约束 —— 前者是最终装配点，
    // 后者需要真实适配器（见 tests/_setup-platform.ts）而非 mock。
    files: ['packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['@vibe-llm/platform-*'], message: 'packages/ 是运行时无关的库层，不得依赖 apps/ 里的宿主适配器。' },
          { group: ['@vibe-llm/*/src/*', '@vibe-core/*/src/*'], message: '跨包只允许从包名入口导入，不得深入他人 src/。' },
        ],
      }],
    },
  },
)

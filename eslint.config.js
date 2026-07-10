import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'src-tauri/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Underscore prefix marks deliberately unused params (adapter
      // signatures often ignore arguments the contract requires).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Invariant I9: src/core is pure logic — no DOM, no Tauri, no React.
    // Mechanically enforced here so it cannot silently regress.
    files: ['src/core/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@tauri-apps/*'],
              message: 'core/ must stay Tauri-free (invariant I9). IPC belongs in src/ipc.',
            },
            {
              group: ['react', 'react-dom', 'zustand/react'],
              message: 'core/ must stay framework-free (invariant I9). Use zustand/vanilla.',
            },
            {
              group: ['../ipc/*', '../editors/*', '../preview/*', '../ui/*'],
              message: 'core/ is the bottom layer — it must not import from sibling layers.',
            },
          ],
        },
      ],
    },
  },
);

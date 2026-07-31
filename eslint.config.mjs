import tseslint from 'typescript-eslint';

const unusedOptions = {
  args: 'after-used',
  argsIgnorePattern: '^_',
  caughtErrors: 'none',
  ignoreRestSiblings: true,
  varsIgnorePattern: '^_',
};

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  {
    files: ['scripts/**/*.mjs', 'tests/**/*.mjs'],
    rules: {
      'no-duplicate-imports': 'error',
      'no-unused-vars': ['error', unusedOptions],
    },
  },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', '*.ts'],
    languageOptions: {
      parser: tseslint.parser,
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', unusedOptions],
      'no-duplicate-imports': 'error',
    },
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
];

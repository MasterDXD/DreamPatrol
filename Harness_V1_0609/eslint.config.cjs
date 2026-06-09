const globals = require('globals');

module.exports = [
  {
    ignores: ['src/web/public/app.js', 'src/web/public/styles.css', 'scripts/src/'],
  },
  {
    files: ['src/**/*.js', 'test/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-constant-condition': 'warn',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
      'no-unsafe-negation': 'error',
      'valid-typeof': 'error',
      'no-var': 'error',
      'prefer-const': 'warn',
      'no-multiple-empty-lines': ['warn', { max: 2 }],
      'no-trailing-spaces': 'warn',
      'semi': ['error', 'always'],
      'quotes': ['warn', 'single', { avoidEscape: true }],
      'comma-dangle': ['warn', 'always-multiline'],
      'eol-last': ['warn', 'always'],
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'curly': ['error', 'multi-line'],
      'no-throw-literal': 'error',
      'no-return-await': 'error',
      'no-shadow': ['warn', { hoist: 'never' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'error',
      'no-unmodified-loop-condition': 'warn',
      'no-unneeded-ternary': 'warn',
      'no-useless-return': 'warn',
      'yoda': 'error',
      'indent': ['warn', 2, { SwitchCase: 1, flatTernaryExpressions: true }],
      'max-lines-per-function': ['warn', { max: 200, skipComments: true, skipBlankLines: true }],
      'complexity': ['warn', { max: 20 }],
      'one-var': ['warn', { initialized: 'never' }],
    },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'strict': 'off',
      'no-console': 'off',
    },
  },
  {
    files: ['scripts/**/*.js'],
    rules: {
      'no-console': 'off',
    },
  },
];

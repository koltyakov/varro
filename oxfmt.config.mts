import { defineConfig } from 'oxfmt';

export default defineConfig({
  ignorePatterns: ['**/*.md', 'assets/**', 'dist/**', '*.vsix'],
  tabWidth: 2,
  semi: true,
  singleQuote: true,
  trailingComma: 'es5',
});

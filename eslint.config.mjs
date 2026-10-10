import { defineConfig, globalIgnores } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default defineConfig([
  globalIgnores(['node_modules/', 'main.js', 'styles.css', 'coverage/']),
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.mjs', 'esbuild.config.mjs', 'scripts/*.mjs'],
        },
      },
    },
  },
  {
    // Тесты и мок не попадают в плагин: Node API и вольности допустимы.
    files: ['tests/**/*.ts', 'vitest.config.ts', 'esbuild.config.mjs', 'scripts/**/*.mjs'],
    rules: {
      'obsidianmd/no-nodejs-modules': 'off',
      'obsidianmd/prefer-window-timers': 'off',
      'obsidianmd/no-tfile-tfolder-cast': 'off',
      'import/no-nodejs-modules': 'off',
    },
  },
]);

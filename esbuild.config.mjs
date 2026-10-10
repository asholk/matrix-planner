import esbuild from 'esbuild';
import { builtinModules } from 'node:module';

const banner = `/*
Matrix planner — сгенерированный файл. Исходники: src/.
*/`;

const production = process.argv[2] === 'production';

const context = await esbuild.context({
  banner: { js: banner },
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@codemirror/*',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr',
    '@lezer/*',
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
  ],
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  logLevel: 'info',
  sourcemap: production ? false : 'inline',
  treeShaking: true,
  minify: production,
  outfile: 'main.js',
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}

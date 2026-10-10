import process from 'node:process';
// Склеивает styles/*.css по алфавиту в styles.css (артефакт сборки).
// Без файлов в styles/ создаёт пустой styles.css.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(root, 'styles');
const outFile = path.join(root, 'styles.css');

const names = existsSync(sourceDir)
  ? (await readdir(sourceDir)).filter((name) => name.endsWith('.css')).sort()
  : [];

const parts = [];
for (const name of names) {
  const css = await readFile(path.join(sourceDir, name), 'utf8');
  parts.push(`/* ${name} */\n${css.trim()}\n`);
}

const header = '/* Matrix planner — сгенерировано scripts/build-styles.mjs из styles/*.css. Не редактировать. */\n';
await writeFile(outFile, names.length ? header + '\n' + parts.join('\n') : '', 'utf8');
process.stdout.write(`styles.css: ${names.length} file(s)
`);

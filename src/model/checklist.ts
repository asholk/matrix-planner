/**
 * Чек-лист внутри задачи (доработка 008): пункты — обычные задачи Markdown в теле заметки
 * (`- [ ] пункт`, `* [x] пункт`, `1. [ ] пункт`). Чистый модуль: разбор и правка текста тела
 * с сохранением остального текста, переводов строк (`\n`/`\r\n`) и отступов.
 * Пункты внутри блоков кода (``` и ~~~) не считаются.
 */

/** Пункт чек-листа. `line` — номер строки тела (с нуля). */
export interface ChecklistItem {
  text: string;
  checked: boolean;
  line: number;
}

/** Прогресс чек-листа: выполнено `done` из `total`. */
export interface ChecklistProgress {
  done: number;
  total: number;
}

/** Отступ, маркер списка, пробел, `[`, флажок, `]`, остаток строки. */
const ITEM_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)\[([^\]])\](?:([ \t]+)(.*))?$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

interface ParsedLine {
  indent: string;
  marker: string;
  gap: string;
  mark: string;
  text: string;
}

function matchLine(line: string): ParsedLine | null {
  const m = ITEM_RE.exec(line);
  if (!m) return null;
  return { indent: m[1] ?? '', marker: m[2] ?? '-', gap: m[3] ?? ' ', mark: m[4] ?? ' ', text: (m[6] ?? '').trimEnd() };
}

/** Строки и разделители: чётные индексы — строки, нечётные — `\r\n`/`\n`. */
function splitParts(body: string): string[] {
  return body.split(/(\r\n|\n)/);
}

function lineCount(parts: readonly string[]): number {
  return Math.ceil(parts.length / 2);
}

function eolOf(body: string): string {
  return /\r\n/.test(body) ? '\r\n' : '\n';
}

/** Номера строк вне блоков кода. */
function codeLines(parts: readonly string[]): Set<number> {
  const inside = new Set<number>();
  let fence: { char: string; length: number } | null = null;
  for (let i = 0; i < lineCount(parts); i++) {
    const line = parts[i * 2] ?? '';
    const m = FENCE_RE.exec(line);
    if (fence) {
      inside.add(i);
      if (m && m[1] && m[1][0] === fence.char && m[1].length >= fence.length && line.trim() === m[1]) fence = null;
    } else if (m && m[1]) {
      inside.add(i);
      fence = { char: m[1][0] ?? '`', length: m[1].length };
    }
  }
  return inside;
}

/** Пункты чек-листа в теле заметки. */
export function parseChecklist(body: string): ChecklistItem[] {
  const parts = splitParts(body);
  const code = codeLines(parts);
  const items: ChecklistItem[] = [];
  for (let i = 0; i < lineCount(parts); i++) {
    if (code.has(i)) continue;
    const parsed = matchLine(parts[i * 2] ?? '');
    if (parsed) items.push({ text: parsed.text, checked: parsed.mark !== ' ', line: i });
  }
  return items;
}

/** Прогресс по пунктам; `null`, если пунктов нет. */
export function checklistProgress(items: readonly { checked: boolean }[]): ChecklistProgress | null {
  if (items.length === 0) return null;
  return { done: items.filter((item) => item.checked).length, total: items.length };
}

/**
 * Прогресс из `CachedMetadata.listItems` Obsidian: у пунктов задач есть `task`
 * (`' '` — не выполнен, иной знак — выполнен). Код-блоки Obsidian не индексирует.
 */
export function checklistFromListItems(listItems: readonly { task?: string | undefined }[] | null | undefined): ChecklistProgress | null {
  if (!listItems) return null;
  return checklistProgress(listItems.filter((item) => typeof item.task === 'string').map((item) => ({ checked: item.task !== ' ' })));
}

/** «2/5». */
export function formatChecklistProgress(progress: ChecklistProgress): string {
  return `${progress.done}/${progress.total}`;
}

/** Все пункты выполнены. */
export function isChecklistComplete(progress: ChecklistProgress): boolean {
  return progress.total > 0 && progress.done >= progress.total;
}

/** Строка пункта вне кода или `null`. */
function itemAt(parts: readonly string[], line: number): ParsedLine | null {
  if (!Number.isInteger(line) || line < 0 || line >= lineCount(parts)) return null;
  if (codeLines(parts).has(line)) return null;
  return matchLine(parts[line * 2] ?? '');
}

function cleanText(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}

/** Отмечает пункт строки `line` выполненным или нет. Не пункт — тело без изменений. */
export function setChecklistItemChecked(body: string, line: number, checked: boolean): string {
  const parts = splitParts(body);
  const item = itemAt(parts, line);
  if (!item || (item.mark !== ' ') === checked) return body;
  const source = parts[line * 2] ?? '';
  // Меняется только знак между скобками.
  const at = item.indent.length + item.marker.length + item.gap.length + 1;
  parts[line * 2] = source.slice(0, at) + (checked ? 'x' : ' ') + source.slice(at + 1);
  return parts.join('');
}

/** Переключает пункт строки `line`. */
export function toggleChecklistItem(body: string, line: number): string {
  const item = itemAt(splitParts(body), line);
  if (!item) return body;
  return setChecklistItemChecked(body, line, item.mark === ' ');
}

/** Меняет текст пункта; пустой текст — без изменений (для удаления — `removeChecklistItem`). */
export function renameChecklistItem(body: string, line: number, text: string): string {
  const value = cleanText(text);
  const parts = splitParts(body);
  const item = itemAt(parts, line);
  if (!item || value === '') return body;
  parts[line * 2] = `${item.indent}${item.marker}${item.gap}[${item.mark}] ${value}`;
  return parts.join('');
}

/** Удаляет строку пункта вместе с её переводом строки. */
export function removeChecklistItem(body: string, line: number): string {
  const parts = splitParts(body);
  if (!itemAt(parts, line)) return body;
  const index = line * 2;
  if (index + 1 < parts.length) parts.splice(index, 2);
  else if (index > 0) parts.splice(index - 1, 2);
  else parts.splice(index, 1);
  return parts.join('');
}

/**
 * Добавляет невыполненный пункт: после последнего пункта чек-листа (и его вложенных строк)
 * с тем же отступом и маркером, иначе — в конец тела через пустую строку.
 */
export function addChecklistItem(body: string, text: string): string {
  const value = cleanText(text);
  if (value === '') return body;
  const eol = eolOf(body);
  const parts = splitParts(body);
  const items = parseChecklist(body);
  const last = items[items.length - 1];
  if (last) {
    const item = matchLine(parts[last.line * 2] ?? '');
    if (item) {
      const numbered = /^(\d+)([.)])$/.exec(item.marker);
      const marker = numbered ? `${Number(numbered[1]) + 1}${numbered[2] ?? '.'}` : item.marker;
      // Вложенные строки последнего пункта (отступ больше) остаются над новым пунктом.
      let after = last.line;
      for (let i = last.line + 1; i < lineCount(parts); i++) {
        const line = parts[i * 2] ?? '';
        if (line.trim() === '') break;
        const indent = /^[ \t]*/.exec(line)?.[0] ?? '';
        if (indent.length <= item.indent.length) break;
        after = i;
      }
      parts.splice(after * 2 + 1, 0, eol, `${item.indent}${marker} [ ] ${value}`);
      return parts.join('');
    }
  }
  const newLine = `- [ ] ${value}`;
  if (body.trim() === '') return newLine;
  const trailing = /(\r\n|\n)$/.test(body);
  const trimmed = body.replace(/(?:[ \t]*(?:\r\n|\n))+$/, '').replace(/[ \t]+$/, '');
  return `${trimmed}${eol}${eol}${newLine}${trailing ? eol : ''}`;
}

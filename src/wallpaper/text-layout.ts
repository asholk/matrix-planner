/**
 * Перенос и обрезка текста для обоев через внедрённый `TextMeasurer`. Чистый модуль.
 * Строки режутся по кодовым точкам (без разрыва суррогатных пар).
 */

import type { TextMeasurer } from '../app/contracts';
import type { FontSpec } from '../model/types';

export const ELLIPSIS = '…';

function width(measurer: TextMeasurer, text: string, font: FontSpec): number {
  return text === '' ? 0 : measurer.measure(text, font).width;
}

/** Схлопывает пробельные символы (переносы строк в названии не нужны на обоях). */
export function normalizeSpaces(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Обрезает строку до `maxWidth` с многоточием. Если не помещается даже многоточие — пустая строка.
 */
export function truncateText(text: string, maxWidth: number, font: FontSpec, measurer: TextMeasurer): string {
  const clean = normalizeSpaces(text);
  if (width(measurer, clean, font) <= maxWidth) return clean;
  if (width(measurer, ELLIPSIS, font) > maxWidth) return '';
  const chars = Array.from(clean);
  // Двоичный поиск наибольшего префикса, который помещается вместе с многоточием.
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = chars.slice(0, mid).join('').trimEnd() + ELLIPSIS;
    if (width(measurer, candidate, font) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join('').trimEnd() + ELLIPSIS;
}

/** Делит слово, не помещающееся в строку, на части по ширине. */
function breakWord(word: string, maxWidth: number, font: FontSpec, measurer: TextMeasurer): string[] {
  const parts: string[] = [];
  let current = '';
  for (const ch of Array.from(word)) {
    const next = current + ch;
    if (current !== '' && width(measurer, next, font) > maxWidth) {
      parts.push(current);
      current = ch;
    } else {
      current = next;
    }
  }
  if (current !== '') parts.push(current);
  return parts;
}

/**
 * Переносит текст по словам в не более чем `maxLines` строк; последняя строка
 * при переполнении обрезается с многоточием.
 */
export function wrapText(
  text: string,
  maxWidth: number,
  font: FontSpec,
  measurer: TextMeasurer,
  maxLines: number,
): string[] {
  const clean = normalizeSpaces(text);
  if (clean === '' || maxLines <= 0) return [];
  const words = clean.split(' ');
  const lines: string[] = [];
  let current = '';
  let index = 0;

  for (; index < words.length; index++) {
    const word = words[index];
    const candidate = current === '' ? word : `${current} ${word}`;
    if (width(measurer, candidate, font) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current !== '') {
      lines.push(current);
      current = '';
      if (lines.length === maxLines) break;
    }
    if (width(measurer, word, font) <= maxWidth) {
      current = word;
      continue;
    }
    // Длинное слово: режем на куски, последний кусок продолжает строку.
    const pieces = breakWord(word, maxWidth, font, measurer);
    while (pieces.length > 1 && lines.length < maxLines) lines.push(pieces.shift() as string);
    current = pieces.join('');
    if (lines.length === maxLines) {
      index++;
      break;
    }
  }

  if (lines.length < maxLines) {
    if (current !== '') lines.push(current);
    return lines;
  }
  // Не поместилось: дописываем остаток к последней строке и обрезаем с многоточием.
  const rest = [current, ...words.slice(index)].filter((w) => w !== '').join(' ');
  if (rest !== '') {
    const last = lines.length - 1;
    lines[last] = truncateText(`${lines[last]} ${rest}`, maxWidth, font, measurer);
  }
  return lines;
}

/** Ширина текста (0 для пустой строки). */
export function textWidth(text: string, font: FontSpec, measurer: TextMeasurer): number {
  return width(measurer, text, font);
}

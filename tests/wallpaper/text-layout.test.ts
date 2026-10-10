import { describe, it, expect } from 'vitest';
import type { TextMeasurer } from '../../src/app/contracts';
import type { FontSpec } from '../../src/model/types';
import { ELLIPSIS, normalizeSpaces, textWidth, truncateText, wrapText } from '../../src/wallpaper/text-layout';

/** Моноширинное измерение: ширина кодовой точки = 0,5 × размер шрифта. */
const measurer: TextMeasurer = {
  measure: (text, font) => ({ width: Array.from(text).length * font.size * 0.5, ascent: font.size * 0.8, descent: font.size * 0.2 }),
};
const font: FontSpec = { size: 10, weight: 400, family: null };
const charW = 5;

describe('truncateText', () => {
  it('keeps text that fits', () => {
    expect(truncateText('Танцы', 100, font, measurer)).toBe('Танцы');
  });

  it('cuts long Russian titles with an ellipsis within the width', () => {
    const title = 'Оформить документы для получения налогового вычета';
    const result = truncateText(title, 20 * charW, font, measurer);
    expect(result.endsWith(ELLIPSIS)).toBe(true);
    expect(textWidth(result, font, measurer)).toBeLessThanOrEqual(20 * charW);
    expect(Array.from(result).length).toBeLessThanOrEqual(20);
    expect(title.startsWith(result.slice(0, -1).trimEnd())).toBe(true);
  });

  it('does not leave a trailing space before the ellipsis', () => {
    expect(truncateText('Забрать Авито на почте', 9 * charW, font, measurer)).toBe('Забрать…');
  });

  it('returns empty string when even the ellipsis does not fit', () => {
    expect(truncateText('Текст', charW - 1, font, measurer)).toBe('');
  });

  it('does not split surrogate pairs', () => {
    const result = truncateText('😀😀😀😀😀😀', 3 * charW, font, measurer);
    expect(result).toBe('😀😀…');
  });

  it('normalizes whitespace and line breaks', () => {
    expect(normalizeSpaces('  Хрум \n чудо-юдо ')).toBe('Хрум чудо-юдо');
  });
});

describe('wrapText', () => {
  it('wraps by words', () => {
    const lines = wrapText('Оплатить налоги до конца года', 16 * charW, font, measurer, 3);
    expect(lines).toEqual(['Оплатить налоги', 'до конца года']);
  });

  it('limits lines and ends the last with an ellipsis', () => {
    const lines = wrapText('Оформить документы для получения налогового вычета', 16 * charW, font, measurer, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith(ELLIPSIS)).toBe(true);
    for (const line of lines) expect(textWidth(line, font, measurer)).toBeLessThanOrEqual(16 * charW);
  });

  it('breaks a word longer than the line', () => {
    const lines = wrapText('Достопримечательности', 8 * charW, font, measurer, 5);
    expect(lines.join('')).toBe('Достопримечательности');
    for (const line of lines) expect(textWidth(line, font, measurer)).toBeLessThanOrEqual(8 * charW);
  });

  it('truncates a broken long word on the last line', () => {
    const lines = wrapText('Достопримечательности', 8 * charW, font, measurer, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith(ELLIPSIS)).toBe(true);
  });

  it('exact fit has no ellipsis; empty input gives no lines', () => {
    expect(wrapText('Танцы Кино', 5 * charW, font, measurer, 2)).toEqual(['Танцы', 'Кино']);
    expect(wrapText('   ', 100, font, measurer, 2)).toEqual([]);
    expect(wrapText('Танцы', 100, font, measurer, 0)).toEqual([]);
  });
});

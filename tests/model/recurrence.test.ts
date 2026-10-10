import { describe, expect, it } from 'vitest';
import fixtures from '../../fixtures/recurrence.json';
import {
  firstOccurrences,
  isOccurrence,
  nextPendingOccurrence,
  occurrenceAfter,
  occurrencesInRange,
} from '../../src/model/recurrence';
import type { RepeatRule } from '../../src/model/types';

interface SeriesCase { name: string; rule: string; anchor: string; count: number; expected: string[] }
interface NextCase { name: string; rule: string; anchor: string; after: string; skip: string[]; expected: string | null }

describe('recurrence fixtures', () => {
  for (const c of fixtures.series as SeriesCase[]) {
    it(`series: ${c.name}`, () => {
      expect(firstOccurrences(c.rule as RepeatRule, c.anchor, c.count)).toEqual(c.expected);
    });
  }

  for (const c of fixtures.nextAfter as NextCase[]) {
    it(`next: ${c.name}`, () => {
      expect(nextPendingOccurrence(c.rule as RepeatRule, c.anchor, c.after, c.skip)).toBe(c.expected);
    });
  }
});

describe('recurrence rules', () => {
  it('monthly from January 31: Feb 28 2026, then Mar 31 (acceptance 8)', () => {
    expect(occurrenceAfter('monthly', '2026-01-31', '2026-01-31')).toBe('2026-02-28');
    expect(occurrenceAfter('monthly', '2026-01-31', '2026-02-28')).toBe('2026-03-31');
  });

  it('yearly from Feb 29 2028: Feb 28 2029, then Feb 29 2032 (acceptance 8)', () => {
    expect(occurrenceAfter('yearly', '2028-02-29', '2028-02-29')).toBe('2029-02-28');
    expect(occurrenceAfter('yearly', '2028-02-29', '2031-02-28')).toBe('2032-02-29');
  });

  it('recognizes occurrences by anchor', () => {
    expect(isOccurrence('monthly', '2026-01-31', '2026-04-30')).toBe(true);
    expect(isOccurrence('monthly', '2026-01-31', '2026-04-29')).toBe(false);
    expect(isOccurrence('weekly', '2026-10-03', '2026-10-17')).toBe(true);
    expect(isOccurrence('weekly', '2026-10-03', '2026-10-16')).toBe(false);
    expect(isOccurrence('daily', '2026-10-03', '2026-10-02')).toBe(false);
  });

  it('lists occurrences in a range not before due', () => {
    expect(
      occurrencesInRange('weekly', '2026-10-03', { from: '2026-10-01', to: '2026-10-31' }, { notBefore: '2026-10-10' }),
    ).toEqual(['2026-10-10', '2026-10-17', '2026-10-24', '2026-10-31']);
    expect(occurrencesInRange('none', '2026-10-10', { from: '2026-10-01', to: '2026-10-31' })).toEqual(['2026-10-10']);
    expect(occurrencesInRange('daily', '2026-10-10', { from: '2026-10-01', to: '2026-10-31' }, { limit: 2 })).toEqual([
      '2026-10-10',
      '2026-10-11',
    ]);
  });

  it('returns null for non-recurring next occurrence', () => {
    expect(nextPendingOccurrence('none', '2026-10-10', '2026-10-01')).toBeNull();
  });
});

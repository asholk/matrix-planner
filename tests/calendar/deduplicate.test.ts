import { describe, it, expect } from 'vitest';
import { isCacheFreshFor, partitionCacheEvents, shouldUseCacheOccurrences, uniqueByKey } from '../../src/calendar/deduplicate';
import type { CachedCalendarEvent } from '../../src/model/types';

function cached(occurrenceKey: string, linkedItemId: string | null = null): CachedCalendarEvent {
  return {
    eventId: occurrenceKey.split('|')[0],
    occurrenceKey,
    calendarId: 'c',
    title: occurrenceKey,
    allDay: false,
    start: { date: '2026-10-10', time: '10:00' },
    end: { date: '2026-10-10', time: '11:00' },
    startMs: null,
    endMs: null,
    recurrenceText: null,
    linkedItemId,
    location: null,
    url: null,
    notes: null,
  };
}

describe('partitionCacheEvents', () => {
  it('связанные с известными заметками скрыты, повторы событий-заметок сгруппированы', () => {
    const result = partitionCacheEvents(
      [cached('a|1', 'E1'), cached('a|2', 'E1'), cached('t|1', 'T1'), cached('x|1'), cached('y|1', 'UNKNOWN')],
      new Set(['E1', 'T1']),
      new Set(['E1']),
    );
    expect(result.external.map((e) => e.occurrenceKey)).toEqual(['x|1', 'y|1']);
    expect(result.linkedToEvents.get('E1')?.map((e) => e.occurrenceKey)).toEqual(['a|1', 'a|2']);
    expect(result.linkedToEvents.has('T1')).toBe(false);
    expect(result.hiddenLinked).toBe(3);
  });

  it('одинаковый occurrenceKey схлопывается', () => {
    const result = partitionCacheEvents([cached('x|1'), cached('x|1')], new Set(), new Set());
    expect(result.external).toHaveLength(1);
  });
});

describe('свежесть кэша', () => {
  const cache = { generatedAt: '2026-10-10T10:00:00Z' };

  it('кэш после изменения заметки — свежий', () => {
    expect(isCacheFreshFor({ mtime: Date.parse('2026-10-10T09:00:00Z') }, cache)).toBe(true);
    expect(isCacheFreshFor({ mtime: Date.parse('2026-10-10T11:00:00Z') }, cache)).toBe(false);
    expect(isCacheFreshFor({ mtime: 0 }, { generatedAt: 'not a date' })).toBe(false);
  });

  it('повторения из кэша — только для повторяющихся событий со связанными записями', () => {
    const linked = [cached('a|1', 'E1')];
    expect(shouldUseCacheOccurrences({ repeat: 'daily', mtime: 0 }, linked, cache)).toBe(true);
    expect(shouldUseCacheOccurrences({ repeat: 'none', mtime: 0 }, linked, cache)).toBe(false);
    expect(shouldUseCacheOccurrences({ repeat: 'daily', mtime: 0 }, [], cache)).toBe(false);
    expect(shouldUseCacheOccurrences({ repeat: 'daily', mtime: 0 }, undefined, cache)).toBe(false);
  });
});

describe('uniqueByKey', () => {
  it('сохраняет первый элемент с ключом', () => {
    expect(uniqueByKey([{ key: 'a', n: 1 }, { key: 'b', n: 2 }, { key: 'a', n: 3 }])).toEqual([{ key: 'a', n: 1 }, { key: 'b', n: 2 }]);
  });
});

import { describe, it, expect } from 'vitest';
import {
  convertZonedTime,
  expandEventOccurrences,
  splitSpanByDays,
  zonedDateTimeToInstant,
} from '../../src/calendar/event-occurrences';
import type { PlannerEvent } from '../../src/model/types';

type Shape = Pick<PlannerEvent, 'start' | 'end' | 'allDay' | 'tz' | 'repeat'>;

function timed(start: string, end: string, over: Partial<Shape> = {}): Shape {
  const [sd, st] = start.split('T');
  const [ed, et] = end.split('T');
  return { start: { date: sd, time: st }, end: { date: ed, time: et }, allDay: false, tz: null, repeat: 'none', ...over };
}

function allDay(start: string, end: string, over: Partial<Shape> = {}): Shape {
  return { start: { date: start, time: null }, end: { date: end, time: null }, allDay: true, tz: null, repeat: 'none', ...over };
}

describe('expandEventOccurrences', () => {
  it('all-day: end не включается', () => {
    const occ = expandEventOccurrences(allDay('2026-10-21', '2026-10-22'), { from: '2026-10-20', to: '2026-10-25' }, 'UTC');
    expect(occ).toHaveLength(1);
    expect(splitSpanByDays(occ[0].span).map((p) => p.date)).toEqual(['2026-10-21']);
  });

  it('многодневное all-day, начатое до диапазона, попадает в диапазон', () => {
    const occ = expandEventOccurrences(allDay('2026-10-18', '2026-10-22'), { from: '2026-10-20', to: '2026-10-25' }, 'UTC');
    expect(occ).toHaveLength(1);
    expect(splitSpanByDays(occ[0].span).map((p) => p.date)).toEqual(['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21']);
  });

  it('ежемесячное событие 31-го: последний день месяца', () => {
    const occ = expandEventOccurrences(timed('2026-01-31T10:00', '2026-01-31T11:00', { repeat: 'monthly' }), { from: '2026-02-01', to: '2026-04-30' }, 'UTC');
    expect(occ.map((o) => o.span.start.date)).toEqual(['2026-02-28', '2026-03-31', '2026-04-30']);
  });

  it('повторение, начавшееся вечером накануне, продолжается в первый день диапазона', () => {
    const occ = expandEventOccurrences(timed('2026-10-01T23:00', '2026-10-02T01:00', { repeat: 'daily' }), { from: '2026-10-10', to: '2026-10-10' }, 'UTC');
    expect(occ.map((o) => o.occurrenceStart.date)).toEqual(['2026-10-09', '2026-10-10']);
  });

  it('событие, заканчивающееся ровно в 00:00 накануне, не попадает в диапазон', () => {
    const occ = expandEventOccurrences(timed('2026-10-09T22:00', '2026-10-10T00:00'), { from: '2026-10-10', to: '2026-10-10' }, 'UTC');
    expect(occ).toEqual([]);
  });

  it('IANA: время события в зоне tz переводится в зону устройства', () => {
    const occ = expandEventOccurrences(
      timed('2026-10-12T09:00', '2026-10-12T10:00', { tz: 'Europe/Moscow' }),
      { from: '2026-10-12', to: '2026-10-12' },
      'Europe/Berlin',
    );
    // Москва UTC+3, Берлин летом UTC+2.
    expect(occ[0].span.start).toEqual({ date: '2026-10-12', time: '08:00' });
    expect(occ[0].span.end).toEqual({ date: '2026-10-12', time: '09:00' });
    expect(occ[0].occurrenceStart).toEqual({ date: '2026-10-12', time: '09:00' });
  });

  it('DST: еженедельное событие в Нью-Йорке остаётся на 09:00 по местному, в Москве сдвигается', () => {
    const occ = expandEventOccurrences(
      timed('2026-10-26T09:00', '2026-10-26T10:00', { tz: 'America/New_York', repeat: 'weekly' }),
      { from: '2026-10-26', to: '2026-11-02' },
      'Europe/Moscow',
    );
    // До 1 нояб. EDT (UTC−4) → 16:00 MSK; после — EST (UTC−5) → 17:00 MSK.
    expect(occ.map((o) => `${o.span.start.date} ${o.span.start.time}`)).toEqual(['2026-10-26 16:00', '2026-11-02 17:00']);
  });
});

describe('zonedDateTimeToInstant', () => {
  it('обычное время', () => {
    expect(zonedDateTimeToInstant('2026-10-12', '09:00', 'Europe/Moscow')).toBe(Date.parse('2026-10-12T06:00:00Z'));
  });

  it('несуществующее время (переход на летнее) сдвигается вперёд', () => {
    // 29 марта 2026, Берлин: 02:00 → 03:00. 02:30 не существует → 03:30 CEST = 01:30Z.
    expect(zonedDateTimeToInstant('2026-03-29', '02:30', 'Europe/Berlin')).toBe(Date.parse('2026-03-29T01:30:00Z'));
  });

  it('неоднозначное время (переход на зимнее) — раннее мгновение', () => {
    // 25 окт. 2026, Берлин: 03:00 → 02:00. 02:30 встречается дважды, раннее — CEST = 00:30Z.
    expect(zonedDateTimeToInstant('2026-10-25', '02:30', 'Europe/Berlin')).toBe(Date.parse('2026-10-25T00:30:00Z'));
  });

  it('convertZonedTime без tz или с той же зоной не меняет время', () => {
    expect(convertZonedTime({ date: '2026-10-12', time: '09:00' }, null, 'Europe/Moscow')).toEqual({ date: '2026-10-12', time: '09:00' });
    expect(convertZonedTime({ date: '2026-10-12', time: '09:00' }, 'Europe/Moscow', 'Europe/Moscow')).toEqual({ date: '2026-10-12', time: '09:00' });
    expect(convertZonedTime({ date: '2026-10-12', time: '09:00' }, 'Bad/Zone', 'Europe/Moscow')).toEqual({ date: '2026-10-12', time: '09:00' });
  });

  it('перевод через полночь меняет дату', () => {
    expect(convertZonedTime({ date: '2026-10-12', time: '23:00' }, 'Europe/London', 'Asia/Tokyo')).toEqual({ date: '2026-10-13', time: '07:00' });
  });
});

describe('splitSpanByDays', () => {
  it('однодневный интервал', () => {
    expect(splitSpanByDays({ start: { date: '2026-10-10', time: '09:00' }, end: { date: '2026-10-10', time: '10:30' }, allDay: false })).toEqual([
      { date: '2026-10-10', allDay: false, startMinute: 540, endMinute: 630, continuesFromPrevious: false, continuesToNext: false },
    ]);
  });

  it('конец в 00:00 следующего дня — одна часть до 1440', () => {
    const pieces = splitSpanByDays({ start: { date: '2026-10-10', time: '22:00' }, end: { date: '2026-10-11', time: '00:00' }, allDay: false });
    expect(pieces).toEqual([{ date: '2026-10-10', allDay: false, startMinute: 1320, endMinute: 1440, continuesFromPrevious: false, continuesToNext: false }]);
  });

  it('конец раньше начала сводится к нулевой длительности', () => {
    const pieces = splitSpanByDays({ start: { date: '2026-10-10', time: '10:00' }, end: { date: '2026-10-10', time: '09:00' }, allDay: false });
    expect(pieces).toEqual([{ date: '2026-10-10', allDay: false, startMinute: 600, endMinute: 600, continuesFromPrevious: false, continuesToNext: false }]);
  });

  it('all-day без длительности считается однодневным', () => {
    const pieces = splitSpanByDays({ start: { date: '2026-10-10', time: null }, end: { date: '2026-10-10', time: null }, allDay: true });
    expect(pieces.map((p) => p.date)).toEqual(['2026-10-10']);
  });
});

describe('финальные исправления', () => {
  it('зона события совпадает с зоной устройства: несуществующее 02:30 при переходе на летнее время сдвигается', () => {
    const ev = timed('2026-03-29T02:30', '2026-03-29T03:30', { tz: 'Europe/Berlin' });
    const occ = expandEventOccurrences(ev, { from: '2026-03-29', to: '2026-03-29' }, 'Europe/Berlin');
    expect(occ).toHaveLength(1);
    expect(occ[0].span.start).toEqual({ date: '2026-03-29', time: '03:30' });
    expect(convertZonedTime({ date: '2026-03-29', time: '02:30' }, 'Europe/Berlin', 'Europe/Berlin')).toEqual({ date: '2026-03-29', time: '03:30' });
  });

  it('очень длинный интервал ограничивается диапазоном до разбиения, признаки продолжения сохраняются', () => {
    const span = { start: { date: '2026-01-01', time: '10:00' }, end: { date: '9999-12-31', time: '10:00' }, allDay: false };
    const pieces = splitSpanByDays(span, { from: '2026-10-10', to: '2026-10-11' });
    expect(pieces.map((p) => p.date)).toEqual(['2026-10-10', '2026-10-11']);
    expect(pieces[0]).toMatchObject({ allDay: true, continuesFromPrevious: true, continuesToNext: true });
    const allDaySpan = { start: { date: '2026-10-11', time: null }, end: { date: '9999-12-31', time: null }, allDay: true };
    const allDayPieces = splitSpanByDays(allDaySpan, { from: '2026-10-10', to: '2026-10-12' });
    expect(allDayPieces.map((p) => [p.date, p.continuesFromPrevious, p.continuesToNext])).toEqual([
      ['2026-10-11', false, true],
      ['2026-10-12', true, true],
    ]);
    const occ = expandEventOccurrences(allDay('2026-01-01', '9999-12-31'), { from: '2026-10-10', to: '2026-10-16' }, 'UTC');
    expect(occ).toHaveLength(1);
  });
});

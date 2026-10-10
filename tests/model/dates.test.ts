import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMinutes,
  addMonthsClamped,
  compareFloating,
  createDateLabelStrings,
  daysInMonth,
  diffDays,
  floatingFromDate,
  formatDueLabel,
  formatFloating,
  isPastDue,
  isValidTimeZone,
  parseFloating,
  startOfWeek,
  weekday,
  type DateLabelStrings,
} from '../../src/model/dates';
import { ruModel } from '../../src/i18n/ru/model';
import { enModel } from '../../src/i18n/en/model';

/** Плоский перевод из словаря модуля `model` без регистрации в i18n. */
function translator(dict: Record<string, unknown>): (key: string) => string {
  return (key) => {
    let node: unknown = dict;
    for (const part of key.replace(/^model\./, '').split('.')) node = (node as Record<string, unknown>)[part];
    if (typeof node !== 'string') throw new Error(`missing key ${key}`);
    return node;
  };
}

const RU: DateLabelStrings = createDateLabelStrings(translator(ruModel));
const EN: DateLabelStrings = createDateLabelStrings(translator(enModel));
const TODAY = '2026-10-10';

describe('parse and format', () => {
  it('parses date and floating date-time', () => {
    expect(parseFloating('2026-10-11')).toEqual({ date: '2026-10-11', time: null });
    expect(parseFloating('2026-10-11T09:00')).toEqual({ date: '2026-10-11', time: '09:00' });
    expect(parseFloating('2026-10-11 9:05')).toEqual({ date: '2026-10-11', time: '09:05' });
    expect(parseFloating('2026-10-11T09:00:30.000')).toEqual({ date: '2026-10-11', time: '09:00' });
  });

  it('keeps floating wall-clock time and ignores offsets', () => {
    expect(parseFloating('2026-10-11T09:00+03:00')).toEqual({ date: '2026-10-11', time: '09:00' });
    expect(parseFloating('2026-10-11T09:00Z')).toEqual({ date: '2026-10-11', time: '09:00' });
  });

  it('rejects invalid values', () => {
    expect(parseFloating('2026-02-29')).toBeNull();
    expect(parseFloating('2026-04-31')).toBeNull();
    expect(parseFloating('2026-10-11T24:00')).toBeNull();
    expect(parseFloating('tomorrow')).toBeNull();
    expect(parseFloating(42)).toBeNull();
    expect(parseFloating(null)).toBeNull();
  });

  it('formats for YAML', () => {
    expect(formatFloating({ date: '2026-10-11', time: null })).toBe('2026-10-11');
    expect(formatFloating({ date: '2026-10-11', time: '09:00' })).toBe('2026-10-11T09:00');
  });
});

describe('calendar arithmetic', () => {
  it('handles leap years and month ends', () => {
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2100, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(diffDays('2026-01-31', '2026-03-01')).toBe(29);
  });

  it('clamps months to the last day (Jan 31, Feb 29)', () => {
    expect(addMonthsClamped('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsClamped('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonthsClamped('2026-02-28', 1, 31)).toBe('2026-03-31');
    expect(addMonthsClamped('2026-11-30', 3)).toBe('2027-02-28');
    expect(addMonthsClamped('2026-01-15', -2)).toBe('2025-11-15');
  });

  it('computes weekdays and week start', () => {
    expect(weekday('2026-10-10')).toBe(6); // суббота
    expect(weekday('1970-01-01')).toBe(4);
    expect(startOfWeek('2026-10-10', 1)).toBe('2026-10-05');
    expect(startOfWeek('2026-10-10', 0)).toBe('2026-10-04');
    expect(startOfWeek('2026-10-11', 0)).toBe('2026-10-11');
  });

  it('adds minutes across midnight', () => {
    expect(addMinutes({ date: '2026-12-31', time: '23:30' }, 60)).toEqual({ date: '2027-01-01', time: '00:30' });
    expect(addMinutes({ date: '2026-10-10', time: null }, -1)).toEqual({ date: '2026-10-09', time: '23:59' });
  });

  it('orders date-only before date-time of the same day', () => {
    expect(compareFloating({ date: TODAY, time: null }, { date: TODAY, time: '00:00' })).toBe(-1);
    expect(compareFloating({ date: TODAY, time: '10:00' }, { date: TODAY, time: '09:00' })).toBe(1);
  });
});

describe('floating time', () => {
  it('converts an instant to wall-clock time of a time zone', () => {
    const instant = new Date(Date.UTC(2026, 9, 10, 6, 0)); // 06:00Z
    expect(floatingFromDate(instant, 'Europe/Moscow')).toEqual({ date: '2026-10-10', time: '09:00' });
    expect(floatingFromDate(instant, 'America/New_York')).toEqual({ date: '2026-10-10', time: '02:00' });
    expect(floatingFromDate(instant, 'Asia/Tokyo')).toEqual({ date: '2026-10-10', time: '15:00' });
  });

  it('a 09:00 task stays at 09:00 local time after a flight', () => {
    const due = { date: '2026-10-11', time: '09:00' };
    // Одно и то же мгновение: в Москве уже 09:30, в Нью-Йорке ещё 02:30.
    const instant = new Date(Date.UTC(2026, 9, 11, 6, 30));
    expect(isPastDue(due, floatingFromDate(instant, 'Europe/Moscow'))).toBe(true);
    expect(isPastDue(due, floatingFromDate(instant, 'America/New_York'))).toBe(false);
  });

  it('date-only due is past only after the day ends', () => {
    expect(isPastDue({ date: TODAY, time: null }, { date: TODAY, time: '23:59' })).toBe(false);
    expect(isPastDue({ date: '2026-10-09', time: null }, { date: TODAY, time: '00:00' })).toBe(true);
  });

  it('validates IANA zones', () => {
    expect(isValidTimeZone('Europe/Moscow')).toBe(true);
    expect(isValidTimeZone('Mars/Base')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('relative labels', () => {
  it('formats Russian labels from the specification', () => {
    expect(formatDueLabel({ date: TODAY, time: '17:00' }, TODAY, RU)).toBe('Сегодня 17:00');
    expect(formatDueLabel({ date: '2026-10-11', time: '12:30' }, TODAY, RU)).toBe('Завтра 12:30');
    expect(formatDueLabel({ date: '2026-10-16', time: '15:00' }, TODAY, RU)).toBe('16 окт. 15:00');
    expect(formatDueLabel({ date: '2026-10-09', time: null }, TODAY, RU)).toBe('Вчера');
    expect(formatDueLabel({ date: TODAY, time: null }, TODAY, RU)).toBe('Сегодня');
    expect(formatDueLabel({ date: '2027-02-01', time: null }, TODAY, RU)).toBe('1 февр. 2027');
  });

  it('formats English labels with 12-hour time', () => {
    expect(formatDueLabel({ date: TODAY, time: '17:00' }, TODAY, EN, { hour12: true })).toBe('Today 5:00 PM');
    expect(formatDueLabel({ date: '2026-10-11', time: '00:30' }, TODAY, EN, { hour12: true })).toBe('Tomorrow 12:30 AM');
    expect(formatDueLabel({ date: '2026-10-16', time: '15:00' }, TODAY, EN)).toBe('Oct 16 15:00');
    expect(formatDueLabel({ date: '2025-12-31', time: null }, TODAY, EN)).toBe('Dec 31, 2025');
  });
});

import { describe, it, expect } from 'vitest';
import {
  expandOccurrences,
  parseRrule,
  presetToRrule,
  rruleToPreset,
  serializeRrule,
  seriesDates,
  zonedToEpoch,
} from '../../src/caldav/rrule';
import type { IcsDateTime, IcsEvent, Rrule } from '../../src/caldav/ics-types';
import { occurrenceAt } from '../../src/model/recurrence';
import { REPEAT_RULES } from '../../src/model/types';

function rule(text: string): Rrule {
  const r = parseRrule(text);
  if (!r) throw new Error(`bad rule ${text}`);
  return r;
}

function dt(date: string, time: string | null, tzid: string | null = null, utc = false): IcsDateTime {
  return { date, time, tzid, utc };
}

function event(start: IcsDateTime, end: IcsDateTime, rrule?: string, extra: Partial<IcsEvent> = {}): IcsEvent {
  return {
    uid: 'u',
    summary: 's',
    start,
    end,
    allDay: start.time === null,
    exdates: [],
    alarms: [],
    extra: [],
    ...(rrule ? { rrule: rule(rrule), rruleText: rrule } : {}),
    ...extra,
  };
}

const starts = (e: IcsEvent, from: string, to: string, tz: string) =>
  expandOccurrences(e, { from, to }, tz).occurrences.map((o) => (o.start.time ? `${o.start.date} ${o.start.time}` : o.start.date));

describe('parseRrule / serializeRrule', () => {
  it('разбирает и записывает все поддерживаемые части', () => {
    const text = 'FREQ=MONTHLY;INTERVAL=2;COUNT=10;BYMONTH=1,7;BYMONTHDAY=-1;BYDAY=2MO,-1FR;BYSETPOS=1;WKST=SU';
    const r = rule(`RRULE:${text}`);
    expect(r).toEqual({
      freq: 'MONTHLY',
      interval: 2,
      count: 10,
      byMonth: [1, 7],
      byMonthDay: [-1],
      byDay: [
        { day: 'MO', n: 2 },
        { day: 'FR', n: -1 },
      ],
      bySetPos: [1],
      wkst: 'SU',
    });
    expect(serializeRrule(r)).toBe(text);
  });

  it('UNTIL — дата или UTC; TZID переводится в UTC', () => {
    expect(rule('FREQ=DAILY;UNTIL=20261231').until).toEqual(dt('2026-12-31', null));
    expect(rule('FREQ=DAILY;UNTIL=20261231T205959Z').until).toEqual(dt('2026-12-31', '20:59', null, true));
    const r: Rrule = { freq: 'DAILY', interval: 1, until: dt('2026-12-31', '23:59', 'Europe/Moscow') };
    expect(serializeRrule(r)).toBe('FREQ=DAILY;UNTIL=20261231T205900Z');
  });

  it('отклоняет неподдерживаемую частоту и ошибки, помечает неподдерживаемые части', () => {
    expect(parseRrule('FREQ=HOURLY')).toBeNull();
    expect(parseRrule('FREQ=DAILY;INTERVAL=0')).toBeNull();
    expect(parseRrule('FREQ=WEEKLY;BYDAY=XX')).toBeNull();
    expect(parseRrule('INTERVAL=2')).toBeNull();
    expect(rule('FREQ=DAILY;BYHOUR=9,18').unsupported).toEqual({ BYHOUR: '9,18' });
  });
});

describe('seriesDates', () => {
  it('WEEKLY с BYDAY и COUNT', () => {
    expect(seriesDates(rule('FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=5'), '2026-10-12', '2030-01-01')).toEqual([
      '2026-10-12',
      '2026-10-14',
      '2026-10-16',
      '2026-10-19',
      '2026-10-21',
    ]);
  });

  it('WEEKLY с INTERVAL=2 и WKST=SU', () => {
    // Начало во вторник; неделя с воскресенья: вт и сб той же недели, затем через одну.
    expect(seriesDates(rule('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SA;WKST=SU;COUNT=4'), '2026-10-13', '2030-01-01')).toEqual([
      '2026-10-13',
      '2026-10-17',
      '2026-10-27',
      '2026-10-31',
    ]);
  });

  it('MONTHLY с номером дня недели: 2MO и -1FR', () => {
    expect(seriesDates(rule('FREQ=MONTHLY;BYDAY=2MO;COUNT=3'), '2026-10-12', '2030-01-01')).toEqual([
      '2026-10-12',
      '2026-11-09',
      '2026-12-14',
    ]);
    expect(seriesDates(rule('FREQ=MONTHLY;BYDAY=-1FR;COUNT=3'), '2026-10-30', '2030-01-01')).toEqual([
      '2026-10-30',
      '2026-11-27',
      '2026-12-25',
    ]);
  });

  it('31-е число: по RFC пропускает короткие месяцы, BYMONTHDAY=-1 — последний день', () => {
    expect(seriesDates(rule('FREQ=MONTHLY;COUNT=4'), '2026-01-31', '2030-01-01')).toEqual([
      '2026-01-31',
      '2026-03-31',
      '2026-05-31',
      '2026-07-31',
    ]);
    expect(seriesDates(rule('FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=4'), '2026-01-31', '2030-01-01')).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ]);
  });

  it('BYSETPOS: последний рабочий день месяца', () => {
    expect(seriesDates(rule('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3'), '2026-10-30', '2030-01-01')).toEqual([
      '2026-10-30',
      '2026-11-30',
      '2026-12-31',
    ]);
  });

  it('YEARLY: BYMONTH + BYDAY и 29 февраля', () => {
    expect(seriesDates(rule('FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU;COUNT=3'), '2026-03-29', '2040-01-01')).toEqual([
      '2026-03-29',
      '2027-03-28',
      '2028-03-26',
    ]);
    expect(seriesDates(rule('FREQ=YEARLY;COUNT=3'), '2024-02-29', '2040-01-01')).toEqual([
      '2024-02-29',
      '2028-02-29',
      '2032-02-29',
    ]);
  });

  it('DAILY с BYMONTH (фильтр) и UNTIL-датой', () => {
    expect(seriesDates(rule('FREQ=DAILY;BYMONTH=1'), '2026-12-30', '2027-01-03')).toEqual([
      '2026-12-30',
      '2027-01-01',
      '2027-01-02',
      '2027-01-03',
    ]);
  });
});

describe('expandOccurrences', () => {
  it('DST: серия 09:00 Europe/Berlin в зоне Москвы меняет час после перехода', () => {
    const e = event(dt('2026-03-27', '09:00', 'Europe/Berlin'), dt('2026-03-27', '10:00', 'Europe/Berlin'), 'FREQ=DAILY');
    expect(starts(e, '2026-03-27', '2026-03-30', 'Europe/Moscow')).toEqual([
      '2026-03-27 11:00',
      '2026-03-28 11:00',
      '2026-03-29 10:00',
      '2026-03-30 10:00',
    ]);
    // В своей зоне время стены не меняется.
    expect(starts(e, '2026-03-27', '2026-03-30', 'Europe/Berlin')).toEqual([
      '2026-03-27 09:00',
      '2026-03-28 09:00',
      '2026-03-29 09:00',
      '2026-03-30 09:00',
    ]);
  });

  it('DST: длительность часа сохраняется через переход', () => {
    const e = event(dt('2026-10-24', '02:30', 'Europe/Berlin'), dt('2026-10-24', '03:30', 'Europe/Berlin'), 'FREQ=DAILY;COUNT=2');
    const occ = expandOccurrences(e, { from: '2026-10-24', to: '2026-10-25' }, 'UTC').occurrences;
    expect(occ.map((o) => [o.start.time, o.end.time])).toEqual([
      ['00:30', '01:30'],
      ['01:30', '02:30'],
    ]);
  });

  it('несуществующее время при весеннем переводе сдвигается вперёд', () => {
    const epoch = zonedToEpoch('2026-03-29', '02:30', 'Europe/Berlin');
    expect(new Date(epoch).toISOString()).toBe('2026-03-29T01:30:00.000Z');
  });

  it('UTC-серия и плавающая серия', () => {
    const utc = event(dt('2026-10-24', '07:00', null, true), dt('2026-10-24', '08:00', null, true), 'FREQ=DAILY');
    expect(starts(utc, '2026-10-24', '2026-10-25', 'Europe/Berlin')).toEqual(['2026-10-24 09:00', '2026-10-25 08:00']);
    const floating = event(dt('2026-10-24', '07:00'), dt('2026-10-24', '08:00'), 'FREQ=DAILY');
    expect(starts(floating, '2026-10-24', '2026-10-25', 'Asia/Tokyo')).toEqual(['2026-10-24 07:00', '2026-10-25 07:00']);
  });

  it('UNTIL в UTC включительно и COUNT', () => {
    const until = event(
      dt('2026-10-12', '10:00', 'Europe/Moscow'),
      dt('2026-10-12', '11:00', 'Europe/Moscow'),
      'FREQ=DAILY;UNTIL=20261014T070000Z',
    );
    expect(starts(until, '2026-10-01', '2026-10-31', 'Europe/Moscow')).toEqual([
      '2026-10-12 10:00',
      '2026-10-13 10:00',
      '2026-10-14 10:00',
    ]);
    const count = event(dt('2026-10-12', null), dt('2026-10-13', null), 'FREQ=WEEKLY;COUNT=3');
    expect(starts(count, '2026-01-01', '2027-12-31', 'Europe/Moscow')).toEqual(['2026-10-12', '2026-10-19', '2026-10-26']);
    // COUNT считается от начала серии, даже если диапазон позже.
    expect(starts(count, '2026-10-20', '2027-12-31', 'Europe/Moscow')).toEqual(['2026-10-26']);
  });

  it('EXDATE датой для повторов на весь день', () => {
    const e = event(dt('2026-10-12', null), dt('2026-10-13', null), 'FREQ=DAILY;COUNT=4', {
      exdates: [dt('2026-10-13', null)],
    });
    expect(starts(e, '2026-10-01', '2026-10-31', 'UTC')).toEqual(['2026-10-12', '2026-10-14', '2026-10-15']);
  });

  it('переопределение переносит экземпляр в диапазон и из него', () => {
    const master = event(dt('2026-10-12', '10:00', 'Europe/Moscow'), dt('2026-10-12', '11:00', 'Europe/Moscow'), 'FREQ=WEEKLY');
    const movedOut = event(dt('2026-11-30', '10:00', 'Europe/Moscow'), dt('2026-11-30', '11:00', 'Europe/Moscow'), undefined, {
      recurrenceId: dt('2026-10-19', '10:00', 'Europe/Moscow'),
    });
    const movedIn = event(dt('2026-10-20', '15:00', 'Europe/Moscow'), dt('2026-10-20', '16:00', 'Europe/Moscow'), undefined, {
      recurrenceId: dt('2026-11-02', '07:00', null, true),
    });
    const res = expandOccurrences(master, { from: '2026-10-12', to: '2026-10-25' }, 'Europe/Moscow', {
      overrides: [movedOut, movedIn],
    });
    expect(res.occurrences.map((o) => `${o.start.date} ${o.start.time}`)).toEqual(['2026-10-12 10:00', '2026-10-20 15:00']);
  });

  it('лимит 1000 повторений на диапазон', () => {
    const e = event(dt('2020-01-01', '09:00', 'Europe/Moscow'), dt('2020-01-01', '10:00', 'Europe/Moscow'), 'FREQ=DAILY');
    const res = expandOccurrences(e, { from: '2020-01-01', to: '2029-12-31' }, 'Europe/Moscow');
    expect(res.occurrences).toHaveLength(1000);
    expect(res.truncated).toBe(true);
    const small = expandOccurrences(e, { from: '2026-10-01', to: '2026-10-31' }, 'Europe/Moscow');
    expect(small.occurrences).toHaveLength(31);
    expect(small.truncated).toBe(false);
  });

  it('неподдерживаемые части — только начало серии', () => {
    const e = event(dt('2026-10-12', '09:00'), dt('2026-10-12', '10:00'), 'FREQ=DAILY;BYHOUR=9,18');
    const res = expandOccurrences(e, { from: '2026-10-01', to: '2026-10-31' }, 'UTC');
    expect(res.unsupported).toBe(true);
    expect(res.occurrences).toHaveLength(1);
  });

  it('событие без повтора попадает в диапазон по пересечению', () => {
    const e = event(dt('2026-10-12', '23:00', 'Europe/Moscow'), dt('2026-10-13', '01:00', 'Europe/Moscow'));
    expect(starts(e, '2026-10-13', '2026-10-13', 'Europe/Moscow')).toEqual(['2026-10-12 23:00']);
    expect(starts(e, '2026-10-14', '2026-10-20', 'Europe/Moscow')).toEqual([]);
  });
});

describe('пресеты плагина ↔ RRULE', () => {
  const anchors = ['2026-01-15', '2026-01-29', '2026-01-30', '2026-01-31', '2024-02-29', '2026-10-12'];

  it('RRULE пресета даёт те же даты, что model/recurrence', () => {
    for (const repeat of REPEAT_RULES) {
      if (repeat === 'none') continue;
      for (const anchor of anchors) {
        const r = presetToRrule(repeat, anchor)!;
        const n = repeat === 'yearly' ? 9 : 26;
        const expected = Array.from({ length: n }, (_, i) => occurrenceAt(repeat, anchor, i));
        const actual = seriesDates({ ...r, count: n }, anchor, '2100-01-01');
        expect(actual, `${repeat} ${anchor}`).toEqual(expected);
      }
    }
  });

  it('пресет → RRULE → пресет', () => {
    for (const repeat of REPEAT_RULES) {
      for (const anchor of anchors) {
        const r = presetToRrule(repeat, anchor);
        const back = rruleToPreset(r, anchor);
        expect(back.repeat, `${repeat} ${anchor}`).toBe(repeat);
        expect(back.extra).toBeNull();
      }
    }
  });

  it('конкретные формы RRULE', () => {
    expect(serializeRrule(presetToRrule('monthly', '2026-01-31')!)).toBe('FREQ=MONTHLY;BYMONTHDAY=-1');
    expect(serializeRrule(presetToRrule('monthly', '2026-01-30')!)).toBe('FREQ=MONTHLY;BYMONTHDAY=28,29,30;BYSETPOS=-1');
    expect(serializeRrule(presetToRrule('yearly', '2024-02-29')!)).toBe('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1');
    expect(presetToRrule('none', '2026-01-01')).toBeNull();
  });

  it('эквивалентные формы iOS сводятся к пресету', () => {
    expect(rruleToPreset('FREQ=WEEKLY;BYDAY=MO', '2026-10-12')).toEqual({ repeat: 'weekly', anchor: '2026-10-12', extra: null });
    expect(rruleToPreset('RRULE:FREQ=MONTHLY;BYMONTHDAY=15', '2026-10-15').repeat).toBe('monthly');
    expect(rruleToPreset('FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=12', '2026-10-12').repeat).toBe('yearly');
    expect(rruleToPreset('FREQ=DAILY;INTERVAL=1;WKST=MO', '2026-10-12').repeat).toBe('daily');
  });

  it('неэквивалентные правила → none с исходным RRULE', () => {
    for (const text of [
      'FREQ=WEEKLY;INTERVAL=2',
      'FREQ=DAILY;COUNT=5',
      'FREQ=WEEKLY;BYDAY=MO,WE',
      'FREQ=WEEKLY;BYDAY=TU',
      'FREQ=MONTHLY;BYDAY=2MO',
      'FREQ=MONTHLY',
      'FREQ=DAILY;BYHOUR=9',
      'FREQ=HOURLY',
    ]) {
      // 2026-10-31: «FREQ=MONTHLY» пропускает короткие месяцы — не равен пресету.
      expect(rruleToPreset(text, '2026-10-31'), text).toEqual({ repeat: 'none', anchor: null, extra: { rrule: text } });
    }
    expect(rruleToPreset(undefined, '2026-10-12')).toEqual({ repeat: 'none', anchor: null, extra: null });
  });
});

import { describe, it, expect } from 'vitest';
import {
  ICS_PRODID,
  buildVtimezone,
  escapeText,
  foldLine,
  parseIcs,
  resolveTimeZoneId,
  serializeEvent,
  toTimeZone,
  unescapeText,
} from '../../src/caldav/ics';
import { expandOccurrences, groupSeries } from '../../src/caldav/rrule';
import type { IcsEvent } from '../../src/caldav/ics-types';

const ics = (lines: string[]) => lines.join('\r\n') + '\r\n';
const utf8 = (s: string) => new TextEncoder().encode(s).length;

/** Образец экспорта iCloud: событие с TZID=Europe/Moscow и двумя напоминаниями. */
const ICLOUD_TIMED = ics([
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Apple Inc.//iOS 18.0//EN',
  'CALSCALE:GREGORIAN',
  'X-WR-CALNAME:Работа',
  'X-APPLE-CALENDAR-COLOR:#FF2968FF',
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Moscow',
  'BEGIN:STANDARD',
  'DTSTART:20110327T020000',
  'TZOFFSETFROM:+0300',
  'TZOFFSETTO:+0300',
  'TZNAME:MSK',
  'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'CREATED:20261001T090000Z',
  'DTEND;TZID=Europe/Moscow:20261012T110000',
  'DTSTAMP:20261001T090000Z',
  'DTSTART;TZID=Europe/Moscow:20261012T100000',
  'LAST-MODIFIED:20261001T090500Z',
  'SEQUENCE:2',
  'SUMMARY:Планёрка',
  'UID:5A1B2C3D-0000-4F1A-9C77-1E2F3A4B5C6D',
  'URL;VALUE=URI:matrixplanner://item/01JABCDEF0123456789ABCDEFG',
  'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'DESCRIPTION:Reminder',
  'TRIGGER:-PT15M',
  'UID:A1',
  'X-WR-ALARMUID:A1',
  'END:VALARM',
  'BEGIN:VALARM',
  'ACTION:NONE',
  'TRIGGER;VALUE=DATE-TIME:19760401T005545Z',
  'X-APPLE-DEFAULT-ALARM:TRUE',
  'END:VALARM',
  'END:VEVENT',
  'END:VCALENDAR',
]);

describe('parseIcs', () => {
  it('читает событие iCloud с TZID=Europe/Moscow', () => {
    const cal = parseIcs(ICLOUD_TIMED);
    expect(cal.name).toBe('Работа');
    expect(cal.color).toBe('#ff2968');
    expect(cal.timezones['Europe/Moscow']?.iana).toBe('Europe/Moscow');
    expect(cal.events).toHaveLength(1);
    const e = cal.events[0]!;
    expect(e.uid).toBe('5A1B2C3D-0000-4F1A-9C77-1E2F3A4B5C6D');
    expect(e.summary).toBe('Планёрка');
    expect(e.allDay).toBe(false);
    expect(e.start).toEqual({ date: '2026-10-12', time: '10:00', tzid: 'Europe/Moscow', utc: false });
    expect(e.end.time).toBe('11:00');
    expect(e.url).toBe('matrixplanner://item/01JABCDEF0123456789ABCDEFG');
    expect(e.sequence).toBe(2);
    expect(e.lastModified).toEqual({ date: '2026-10-01', time: '09:05', tzid: null, utc: true });
    // ACTION:NONE (пустое напоминание iOS) пропускается.
    expect(e.alarms).toEqual([{ triggerMinutesBefore: 15, action: 'DISPLAY', description: 'Reminder' }]);
    expect(e.extra.map((p) => p.name)).toEqual(['X-APPLE-TRAVEL-ADVISORY-BEHAVIOR']);
  });

  it('переводит время в зону устройства через Intl', () => {
    const e = parseIcs(ICLOUD_TIMED).events[0]!;
    expect(toTimeZone(e.start, 'Europe/Berlin')).toEqual({ date: '2026-10-12', time: '09:00' });
    expect(toTimeZone(e.start, 'Asia/Vladivostok')).toEqual({ date: '2026-10-12', time: '17:00' });
    expect(toTimeZone(e.start, 'America/New_York')).toEqual({ date: '2026-10-12', time: '03:00' });
  });

  it('читает событие на весь день и напоминания -P1D / -PT15H', () => {
    const cal = parseIcs(
      ics([
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'UID:allday-1',
        'DTSTART;VALUE=DATE:20261015',
        'DTEND;VALUE=DATE:20261017',
        'SUMMARY:Отпуск',
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        'TRIGGER:-P1D',
        'END:VALARM',
        'BEGIN:VALARM',
        'ACTION:AUDIO',
        'TRIGGER:-PT15H',
        'END:VALARM',
        'END:VEVENT',
        'END:VCALENDAR',
      ]),
    );
    const e = cal.events[0]!;
    expect(e.allDay).toBe(true);
    expect(e.start).toEqual({ date: '2026-10-15', time: null, tzid: null, utc: false });
    expect(e.end.date).toBe('2026-10-17');
    expect(e.alarms.map((a) => a.triggerMinutesBefore)).toEqual([1440, 900]);
    const occ = expandOccurrences(e, { from: '2026-10-16', to: '2026-10-16' }, 'Europe/Moscow').occurrences;
    expect(occ).toHaveLength(1);
    expect(occ[0]!.end).toEqual({ date: '2026-10-17', time: null });
  });

  it('TRIGGER относительно конца и после начала', () => {
    const e = parseIcs(
      ics([
        'BEGIN:VEVENT',
        'UID:x',
        'DTSTART:20261012T070000Z',
        'DTEND:20261012T080000Z',
        'BEGIN:VALARM',
        'TRIGGER;RELATED=END:-PT10M',
        'ACTION:DISPLAY',
        'END:VALARM',
        'BEGIN:VALARM',
        'TRIGGER:PT5M',
        'ACTION:DISPLAY',
        'END:VALARM',
        'END:VEVENT',
      ]),
    ).events[0]!;
    expect(e.alarms.map((a) => a.triggerMinutesBefore)).toEqual([-50, -5]);
  });

  it('разворачивает folding (CRLF, LF, табуляция) с кириллицей, разрезанной по байтам', () => {
    const summary = 'Встреча с командой по планированию квартала и обсуждению задач';
    const folded = foldLine(`SUMMARY:${summary}`);
    expect(folded).toContain('\r\n ');
    const textLf = ['BEGIN:VEVENT', 'UID:f', 'DTSTART:20261012T100000', folded.replace(/\r\n/g, '\n'), 'DESCRIPTION:раз', '\tдва', 'END:VEVENT'].join('\n');
    const e = parseIcs(textLf).events[0]!;
    expect(e.summary).toBe(summary);
    expect(e.description).toBe('раздва');
  });

  it('снимает экранирование TEXT', () => {
    const e = parseIcs(
      ics([
        'BEGIN:VEVENT',
        'UID:esc',
        'DTSTART:20261012T100000',
        'SUMMARY:Купить: хлеб\\, молоко\\; сыр',
        'DESCRIPTION:Строка 1\\nСтрока 2\\NСтрока 3 \\\\ слеш',
        'LOCATION:Москва\\, ул. Тверская',
        'CATEGORIES:Работа,Дом\\,сад',
        'END:VEVENT',
      ]),
    ).events[0]!;
    expect(e.summary).toBe('Купить: хлеб, молоко; сыр');
    expect(e.description).toBe('Строка 1\nСтрока 2\nСтрока 3 \\ слеш');
    expect(e.location).toBe('Москва, ул. Тверская');
    expect(e.categories).toEqual(['Работа', 'Дом,сад']);
    expect(e.start.tzid).toBeNull();
    expect(e.start.utc).toBe(false);
  });

  it('читает STATUS:CANCELLED, отменённое событие не разворачивается', () => {
    const e = parseIcs(
      ics(['BEGIN:VEVENT', 'UID:c', 'DTSTART:20261012T100000', 'DTEND:20261012T110000', 'STATUS:CANCELLED', 'END:VEVENT']),
    ).events[0]!;
    expect(e.status).toBe('CANCELLED');
    expect(expandOccurrences(e, { from: '2026-10-01', to: '2026-10-31' }, 'Europe/Moscow').occurrences).toEqual([]);
  });

  it('повтор с EXDATE и переопределением RECURRENCE-ID', () => {
    const cal = parseIcs(
      ics([
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'UID:series-1',
        'DTSTART;TZID=Europe/Moscow:20261012T100000',
        'DTEND;TZID=Europe/Moscow:20261012T103000',
        'RRULE:FREQ=WEEKLY;BYDAY=MO',
        'EXDATE;TZID=Europe/Moscow:20261019T100000',
        'SUMMARY:Еженедельная',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:series-1',
        'RECURRENCE-ID;TZID=Europe/Moscow:20261026T100000',
        'DTSTART;TZID=Europe/Moscow:20261026T120000',
        'DTEND;TZID=Europe/Moscow:20261026T130000',
        'SUMMARY:Еженедельная (перенесена)',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:series-1',
        'RECURRENCE-ID:20261102T070000Z',
        'DTSTART;TZID=Europe/Moscow:20261102T100000',
        'DTEND;TZID=Europe/Moscow:20261102T103000',
        'STATUS:CANCELLED',
        'SUMMARY:Отменена',
        'END:VEVENT',
        'END:VCALENDAR',
      ]),
    );
    expect(cal.events).toHaveLength(3);
    const groups = groupSeries(cal.events);
    expect(groups).toHaveLength(1);
    const { master, overrides } = groups[0]!;
    expect(master.rrule).toEqual({ freq: 'WEEKLY', interval: 1, byDay: [{ day: 'MO', n: null }] });
    expect(master.exdates).toHaveLength(1);
    const res = expandOccurrences(master, { from: '2026-10-01', to: '2026-11-10' }, 'Europe/Moscow', { overrides });
    expect(res.occurrences.map((o) => `${o.start.date} ${o.start.time}${o.isOverride ? ' *' : ''}`)).toEqual([
      '2026-10-12 10:00',
      '2026-10-26 12:00 *',
      '2026-11-09 10:00',
    ]);
    expect(res.occurrences[1]!.event.summary).toBe('Еженедельная (перенесена)');
    expect(res.occurrences[1]!.recurrenceKey).toBe('2026-10-26T10:00');
  });

  it('DURATION вместо DTEND', () => {
    const e = parseIcs(
      ics(['BEGIN:VEVENT', 'UID:d', 'DTSTART;TZID=Europe/Berlin:20261024T233000', 'DURATION:PT1H30M', 'END:VEVENT']),
    ).events[0]!;
    expect(e.end).toEqual({ date: '2026-10-25', time: '01:00', tzid: 'Europe/Berlin', utc: false });
    expect(e.duration).toBe('PT1H30M');
  });

  it('сопоставляет нестандартные TZID с IANA', () => {
    expect(resolveTimeZoneId('Europe/Moscow')).toBe('Europe/Moscow');
    expect(resolveTimeZoneId('Russian Standard Time')).toBe('Europe/Moscow');
    expect(resolveTimeZoneId('/mozilla.org/20050126_1/Europe/Berlin')).toBe('Europe/Berlin');
    expect(resolveTimeZoneId('My Zone', 'Asia/Yekaterinburg')).toBe('Asia/Yekaterinburg');
    expect(resolveTimeZoneId('(UTC+03:00) Moscow, St. Petersburg')).toBe('Etc/GMT-3');
    expect(resolveTimeZoneId('Custom Zone')).toBeNull();

    const cal = parseIcs(
      ics([
        'BEGIN:VCALENDAR',
        'BEGIN:VTIMEZONE',
        'TZID:Moscow Time',
        'X-LIC-LOCATION:Europe/Moscow',
        'END:VTIMEZONE',
        'BEGIN:VEVENT',
        'UID:a',
        'DTSTART;TZID="Moscow Time":20261012T100000',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:b',
        'DTSTART;TZID=Custom Zone:20261012T100000',
        'END:VEVENT',
        'END:VCALENDAR',
      ]),
    );
    expect(cal.events[0]!.start.tzid).toBe('Europe/Moscow');
    // Неизвестная зона — плавающее время.
    expect(cal.events[1]!.start.tzid).toBeNull();
    expect(cal.events[1]!.start.utc).toBe(false);
  });
});

function sampleEvent(overrides: Partial<IcsEvent> = {}): IcsEvent {
  return {
    uid: '01JABCDEF0123456789ABCDEFG',
    summary: 'Планёрка',
    start: { date: '2026-10-12', time: '10:00', tzid: 'Europe/Moscow', utc: false },
    end: { date: '2026-10-12', time: '11:00', tzid: 'Europe/Moscow', utc: false },
    allDay: false,
    exdates: [],
    alarms: [{ triggerMinutesBefore: 15 }],
    extra: [],
    ...overrides,
  };
}

const NOW = new Date(Date.UTC(2026, 9, 11, 8, 30, 5));

describe('serializeEvent', () => {
  it('пишет VCALENDAR с PRODID, CRLF, DTSTAMP, TZID, VTIMEZONE и VALARM', () => {
    const text = serializeEvent(sampleEvent({ url: 'matrixplanner://item/01JABCDEF0123456789ABCDEFG' }), { now: NOW });
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    const lines = text.split('\r\n');
    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(lines).toContain(`PRODID:${ICS_PRODID}`);
    expect(lines).toContain('VERSION:2.0');
    expect(lines).toContain('UID:01JABCDEF0123456789ABCDEFG');
    expect(lines).toContain('DTSTAMP:20261011T083005Z');
    expect(lines).toContain('DTSTART;TZID=Europe/Moscow:20261012T100000');
    expect(lines).toContain('DTEND;TZID=Europe/Moscow:20261012T110000');
    expect(lines).toContain('URL;VALUE=URI:matrixplanner://item/01JABCDEF0123456789ABCDEFG');
    expect(lines).toContain('BEGIN:VTIMEZONE');
    expect(lines).toContain('TZID:Europe/Moscow');
    expect(lines).toContain('TRIGGER:-PT15M');
    expect(lines).toContain('ACTION:DISPLAY');
    expect(lines.indexOf('BEGIN:VTIMEZONE')).toBeLessThan(lines.indexOf('BEGIN:VEVENT'));
  });

  it('весь день — VALUE=DATE с исключительным DTEND, плавающее время — без TZID', () => {
    const allDay = serializeEvent(
      sampleEvent({
        allDay: true,
        start: { date: '2026-10-15', time: null, tzid: null, utc: false },
        end: { date: '2026-10-16', time: null, tzid: null, utc: false },
        alarms: [{ triggerMinutesBefore: 1440 }],
      }),
      { now: NOW },
    );
    expect(allDay).toContain('DTSTART;VALUE=DATE:20261015\r\n');
    expect(allDay).toContain('DTEND;VALUE=DATE:20261016\r\n');
    expect(allDay).toContain('TRIGGER:-P1D\r\n');
    expect(allDay).not.toContain('VTIMEZONE');

    const floating = serializeEvent(
      sampleEvent({
        start: { date: '2026-10-12', time: '10:00', tzid: null, utc: false },
        end: { date: '2026-10-12', time: '10:45', tzid: null, utc: false },
        alarms: [],
      }),
      { now: NOW },
    );
    expect(floating).toContain('DTSTART:20261012T100000\r\n');
    expect(floating).toContain('DTEND:20261012T104500\r\n');
    expect(floating).not.toContain('TZID');
    expect(floating).not.toContain('VALARM');
  });

  it('сворачивает по 75 октетам UTF-8, не разрывая символы, и читается обратно', () => {
    const summary = 'Подготовить квартальный отчёт 📊 для руководства и согласовать бюджет на следующий год';
    const description = 'Первая строка\nВторая строка; с точкой с запятой, запятой и \\ слешем';
    const text = serializeEvent(sampleEvent({ summary, description }), { now: NOW });
    for (const line of text.split('\r\n')) {
      expect(utf8(line)).toBeLessThanOrEqual(75);
      expect(line).not.toMatch(/�/);
    }
    // Строка SUMMARY действительно свёрнута.
    expect(text).toMatch(/\r\n [^\r]/);
    expect(text.replace(/\r\n /g, '')).toContain('Первая строка\\nВторая строка\\; с точкой с запятой\\, запятой и \\\\ слешем');
    const back = parseIcs(text).events[0]!;
    expect(back.summary).toBe(summary);
    expect(back.description).toBe(description);
    expect(back.start).toEqual(sampleEvent().start);
    expect(back.alarms[0]!.triggerMinutesBefore).toBe(15);
  });

  it('повтор: RRULE, EXDATE и переопределение в одном ресурсе', () => {
    const master = sampleEvent({
      rrule: { freq: 'WEEKLY', interval: 1, byDay: [{ day: 'MO', n: null }] },
      exdates: [{ date: '2026-10-19', time: '10:00', tzid: 'Europe/Moscow', utc: false }],
    });
    const text = serializeEvent(master, { now: NOW });
    expect(text).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO\r\n');
    expect(text).toContain('EXDATE;TZID=Europe/Moscow:20261019T100000\r\n');
    const round = parseIcs(text).events[0]!;
    expect(round.rrule).toEqual(master.rrule);
    expect(round.exdates).toEqual(master.exdates);
  });

  it('переносит неизвестные свойства и статус', () => {
    const text = serializeEvent(
      sampleEvent({
        status: 'CANCELLED',
        categories: ['Работа', 'A,B'],
        extra: [{ name: 'X-APPLE-STRUCTURED-LOCATION', params: { VALUE: 'URI', 'X-TITLE': 'Офис: 5 этаж' }, value: 'geo:55.75,37.61' }],
      }),
      { now: NOW },
    );
    const back = parseIcs(text).events[0]!;
    expect(back.status).toBe('CANCELLED');
    expect(back.categories).toEqual(['Работа', 'A,B']);
    expect(back.extra).toEqual([
      { name: 'X-APPLE-STRUCTURED-LOCATION', params: { VALUE: 'URI', 'X-TITLE': 'Офис: 5 этаж' }, value: 'geo:55.75,37.61' },
    ]);
  });
});

describe('экранирование и VTIMEZONE', () => {
  it('escapeText / unescapeText взаимно обратны', () => {
    const s = 'a\\b;c,d\ne';
    expect(escapeText(s)).toBe('a\\\\b\\;c\\,d\\ne');
    expect(unescapeText(escapeText(s))).toBe(s);
  });

  it('VTIMEZONE для Europe/Berlin с правилами перехода', () => {
    const lines = buildVtimezone('Europe/Berlin', 2026);
    expect(lines).toContain('TZID:Europe/Berlin');
    expect(lines).toContain('DTSTART:19700329T020000');
    expect(lines).toContain('RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU');
    expect(lines).toContain('DTSTART:19701025T030000');
    expect(lines).toContain('RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU');
    expect(lines.indexOf('BEGIN:DAYLIGHT')).toBeGreaterThan(0);
    expect(lines).toContain('TZOFFSETTO:+0200');
  });

  it('VTIMEZONE для зоны без перехода (Europe/Moscow)', () => {
    expect(buildVtimezone('Europe/Moscow', 2026)).toEqual([
      'BEGIN:VTIMEZONE',
      'TZID:Europe/Moscow',
      'X-LIC-LOCATION:Europe/Moscow',
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      'TZOFFSETFROM:+0300',
      'TZOFFSETTO:+0300',
      'END:STANDARD',
      'END:VTIMEZONE',
    ]);
  });

  it('VTIMEZONE для America/New_York (2-е воскресенье марта, 1-е ноября)', () => {
    const lines = buildVtimezone('America/New_York', 2026);
    expect(lines).toContain('RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU');
    expect(lines).toContain('RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU');
    expect(lines).toContain('TZOFFSETFROM:-0500');
  });
});

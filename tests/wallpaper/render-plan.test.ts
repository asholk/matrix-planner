import { describe, it, expect } from 'vitest';
import { ruModel } from '../../src/i18n/ru/model';
import { createDateLabelStrings, parseFloating } from '../../src/model/dates';
import { defaultMatrixConfig } from '../../src/model/defaults';
import type { QuadrantKey, Task, WallpaperProfile } from '../../src/model/types';
import { createDefaultWallpaperSettings } from '../../src/settings/defaults';
import {
  EXPIRED_FILE_NAME,
  LOCK_FILE_NAME,
  WALLPAPER_DAYS,
  WALLPAPER_TEMPLATE_VERSION,
  createLayoutInput,
  expiredDate,
  hashString,
  packFingerprint,
  sameBytes,
  stableStringify,
  datedFileName,
  formatWallpaperDue,
  nowForDate,
  parseDatedFileName,
  planRenderDates,
  renderDataRange,
  resolveWallpaperWeekStart,
} from '../../src/wallpaper/render-plan';
import type { WallpaperLayoutStrings } from '../../src/wallpaper/types';

type Dict = { [key: string]: string | Dict };

function lookup(dict: Dict, path: string[]): string | undefined {
  let node: string | Dict | undefined = dict;
  for (const part of path) {
    if (typeof node !== 'object') return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

const labels = createDateLabelStrings((key) => {
  const [module, ...path] = key.split('.');
  return (module === 'model' ? lookup(ruModel, path) : undefined) ?? key;
});

function makeTask(id: string, quadrant: QuadrantKey, dueRaw: string | null, done = false): Task {
  const due = dueRaw === null ? null : parseFloating(dueRaw);
  return {
    kind: 'task',
    id,
    path: `Планировщик/Задачи/${id}.md`,
    title: id,
    mtime: 0,
    props: {
      type: 'task',
      id,
      quadrant,
      due: dueRaw,
      repeat: 'none',
      repeat_anchor: null,
      remind: 'none',
      priority: 'normal',
      duration: null,
      done,
      completed: null,
      completions: [],
      created: null,
    },
    extra: {},
    issues: [],
    quadrant,
    due,
    repeat: 'none',
    repeatAnchor: due ? due.date : null,
    remind: 'none',
    priority: 'normal',
    duration: null,
    done,
    completed: null,
    completions: [],
    created: null,
    archived: false,
  };
}

describe('planRenderDates', () => {
  it('returns today and six following days', () => {
    expect(planRenderDates('2026-10-10')).toEqual([
      '2026-10-10',
      '2026-10-11',
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
      '2026-10-16',
    ]);
    expect(WALLPAPER_DAYS).toBe(7);
  });

  it('crosses month and year boundaries', () => {
    expect(planRenderDates('2026-12-29')).toEqual([
      '2026-12-29',
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
      '2027-01-03',
      '2027-01-04',
    ]);
  });

  it('handles leap February', () => {
    expect(planRenderDates('2028-02-26')).toEqual([
      '2028-02-26',
      '2028-02-27',
      '2028-02-28',
      '2028-02-29',
      '2028-03-01',
      '2028-03-02',
      '2028-03-03',
    ]);
    expect(planRenderDates('2027-02-27').slice(0, 3)).toEqual(['2027-02-27', '2027-02-28', '2027-03-01']);
  });
});

describe('file names', () => {
  it('builds and parses dated names', () => {
    expect(datedFileName('2026-10-10')).toBe('lock-2026-10-10.png');
    expect(parseDatedFileName('lock-2026-10-10.png')).toBe('2026-10-10');
    expect(LOCK_FILE_NAME).toBe('lock.png');
  });

  it('ignores foreign and invalid names', () => {
    expect(parseDatedFileName('lock.png')).toBeNull();
    expect(parseDatedFileName('shortcut-last-run.txt')).toBeNull();
    expect(parseDatedFileName('lock-2026-02-30.png')).toBeNull();
    expect(parseDatedFileName('lock-2026-10-10.png.bak')).toBeNull();
    expect(parseDatedFileName('my-lock-2026-10-10.png')).toBeNull();
    expect(parseDatedFileName('lock-2026-10-10.jpg')).toBeNull();
  });
});

describe('renderDataRange', () => {
  it('covers month grids and weeks of all dates', () => {
    const range = renderDataRange(planRenderDates('2026-12-29'));
    // Сетка декабря может начинаться с 25 ноября, неделя 4 января — кончаться 10 января.
    expect(range.from <= '2026-11-25').toBe(true);
    expect(range.to >= '2027-01-10').toBe(true);
    // А сетка января — кончаться в начале февраля.
    expect(range.to >= '2027-02-06').toBe(true);
  });
});

describe('formatWallpaperDue', () => {
  it('shows only time for a task on the wallpaper date', () => {
    expect(formatWallpaperDue({ date: '2026-10-10', time: '17:00' }, '2026-10-10', labels, false)).toBe('17:00');
    expect(formatWallpaperDue({ date: '2026-10-10', time: '17:00' }, '2026-10-10', labels, true)).toBe('5:00 PM');
  });

  it('с длительностью — диапазон времени (008)', () => {
    expect(formatWallpaperDue({ date: '2026-10-10', time: '18:00' }, '2026-10-10', labels, false, 90)).toBe('18:00–19:30');
    expect(formatWallpaperDue({ date: '2026-10-11', time: '18:00' }, '2026-10-10', labels, false, 30)).toBe('Завтра 18:00–18:30');
  });

  it('labels relative to each wallpaper date', () => {
    const due = { date: '2026-10-11', time: '12:30' };
    expect(formatWallpaperDue(due, '2026-10-10', labels, false)).toBe('Завтра 12:30');
    expect(formatWallpaperDue(due, '2026-10-11', labels, false)).toBe('12:30');
    expect(formatWallpaperDue(due, '2026-10-12', labels, false)).toBe('Вчера 12:30');
    expect(formatWallpaperDue({ date: '2026-10-10', time: null }, '2026-10-10', labels, false)).toBe('Сегодня');
    expect(formatWallpaperDue({ date: '2027-01-02', time: null }, '2026-12-31', labels, false)).toBe('2 янв. 2027');
  });
});

describe('createLayoutInput', () => {
  const profile: WallpaperProfile = {
    id: 'iphone-1179x2556',
    label: 'iPhone',
    width: 1179,
    height: 2556,
    safeTop: 0.38,
    safeBottom: 0.88,
  };
  const strings = {} as WallpaperLayoutStrings;

  it('uses wallpaper settings and resolves week start', () => {
    const settings = { ...createDefaultWallpaperSettings(), template: 'calendar' as const, weekStart: 'sunday' as const, tasksPerQuadrant: 2 as const };
    const input = createLayoutInput({
      date: '2026-10-12',
      today: '2026-10-10',
      now: { date: '2026-10-10', time: '09:00' },
      settings,
      profile,
      weekStart: 1,
      hour12: false,
      matrix: defaultMatrixConfig('ru'),
      tasks: [],
      days: new Map(),
      strings,
    });
    expect(input.template).toBe('calendar');
    expect(input.date).toBe('2026-10-12');
    expect(input.weekStart).toBe(0);
    expect(input.tasksPerQuadrant).toBe(2);
    expect(input.expired).toBeUndefined();
    expect(input.layoutPreset).toBe(settings.layoutPreset);
    expect(resolveWallpaperWeekStart('auto', 1)).toBe(1);
    expect(resolveWallpaperWeekStart('monday', 0)).toBe(1);
  });

  it('sorts tasks as of each wallpaper date and drops completed ones', () => {
    const tasks = [
      makeTask('later', 'do', '2026-10-13'),
      makeTask('soon', 'do', '2026-10-11 10:00'),
      makeTask('done', 'do', '2026-10-10', true),
      makeTask('none', 'plan', null),
    ];
    const base = {
      today: '2026-10-10',
      now: { date: '2026-10-10', time: '09:00' },
      settings: createDefaultWallpaperSettings(),
      profile,
      weekStart: 1 as const,
      hour12: false,
      matrix: defaultMatrixConfig('ru'),
      tasks,
      days: new Map(),
      strings,
    };
    const today = createLayoutInput({ ...base, date: '2026-10-10' });
    expect(today.tasksByQuadrant.do.map((t) => t.id)).toEqual(['soon', 'later']);
    expect(today.tasksByQuadrant.plan.map((t) => t.id)).toEqual(['none']);
    // На 12-е задача «soon» уже просрочена — остаётся первой.
    const later = createLayoutInput({ ...base, date: '2026-10-12' });
    expect(later.tasksByQuadrant.do.map((t) => t.id)).toEqual(['soon', 'later']);
    expect(nowForDate('2026-10-12', '2026-10-10', base.now)).toEqual({ date: '2026-10-12', time: '00:00' });
    expect(nowForDate('2026-10-10', '2026-10-10', base.now)).toBe(base.now);
  });
});

describe('lock-expired.png and pack fingerprint (007)', () => {
  it('expired file is the day after the last pack date', () => {
    expect(EXPIRED_FILE_NAME).toBe('lock-expired.png');
    expect(expiredDate(planRenderDates('2026-12-29'))).toBe('2027-01-05');
  });

  it('marks the expired layout input', () => {
    const input = createLayoutInput({
      date: '2026-10-17',
      today: '2026-10-10',
      now: { date: '2026-10-10', time: '09:00' },
      settings: createDefaultWallpaperSettings(),
      profile: { id: 'p', label: 'p', width: 10, height: 20, safeTop: 0.38, safeBottom: 0.88 },
      weekStart: 1,
      hour12: false,
      matrix: defaultMatrixConfig('ru'),
      tasks: [],
      days: new Map(),
      strings: {} as WallpaperLayoutStrings,
      expired: true,
    });
    expect(input.expired).toBe(true);
  });

  it('stableStringify ignores key order and functions, handles Map and Set', () => {
    expect(stableStringify({ b: 1, a: [1, { d: 2, c: () => 1 }] })).toBe(stableStringify({ a: [1, { c: () => 2, d: 2 }], b: 1 }));
    expect(stableStringify(new Map([['x', new Set([1, 2])]]))).toBe('[["x",[1,2]]]');
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    expect(stableStringify(cyclic)).toBe('{"a":1,"self":"[cycle]"}');
  });

  it('hashString is stable and sensitive', () => {
    expect(hashString('abc')).toMatch(/^[0-9a-f]{16}$/);
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
    expect(hashString('')).not.toBe(hashString(' '));
  });

  it('packFingerprint carries the template version and date', () => {
    const fp = packFingerprint('2026-10-10', { a: 1 });
    expect(fp.startsWith(`v${WALLPAPER_TEMPLATE_VERSION}-2026-10-10-`)).toBe(true);
    expect(packFingerprint('2026-10-11', { a: 1 })).not.toBe(fp);
    expect(packFingerprint('2026-10-10', { a: 2 })).not.toBe(fp);
  });

  it('sameBytes compares PNG bytes', () => {
    const a = new Uint8Array([1, 2, 3]).buffer;
    expect(sameBytes(a, new Uint8Array([1, 2, 3]).buffer)).toBe(true);
    expect(sameBytes(a, new Uint8Array([1, 2, 4]).buffer)).toBe(false);
    expect(sameBytes(a, new Uint8Array([1, 2]).buffer)).toBe(false);
  });
});

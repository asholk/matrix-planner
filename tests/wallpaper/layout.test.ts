import { describe, it, expect } from 'vitest';
import fixtures from '../../fixtures/wallpaper.json';
import type { TextMeasurer } from '../../src/app/contracts';
import type {
  DayAgenda,
  DayItem,
  DrawCommand,
  LocalDateString,
  QuadrantKey,
  Task,
  WallpaperLayout,
  WallpaperLayoutInput,
  WallpaperPalette,
  WallpaperProfile,
  WallpaperTemplate,
} from '../../src/model/types';
import { QUADRANT_KEYS } from '../../src/model/types';
import { addDays, createDateLabelStrings, datesInRange, formatDueLabel, parseFloating } from '../../src/model/dates';
import { defaultMatrixConfig } from '../../src/model/defaults';
import { ruCommon } from '../../src/i18n/ru/common';
import { ruModel } from '../../src/i18n/ru/model';
import { ruWallpaperLayout } from '../../src/i18n/ru/wallpaper-layout';
import { enWallpaperLayout } from '../../src/i18n/en/wallpaper-layout';
import {
  MIN_TEXT_CONTRAST,
  contrastRatio,
  createLayoutContext,
  createWallpaperStrings,
  ensureContrast,
  layoutWallpaper,
  parseColor,
  resolvePalette,
} from '../../src/wallpaper/layout';
import { monthGrid, yearProgress } from '../../src/wallpaper/calendar-layout';
import { KNOWN_PROFILES, contentBand, findProfileBySize } from '../../src/wallpaper/profiles';
import type { WallpaperLayoutStrings } from '../../src/wallpaper/types';

// ---------------------------------------------------------------------------
// Тестовые данные
// ---------------------------------------------------------------------------

/** Моноширинное измерение: ширина кодовой точки = 0,55 × размер шрифта. */
const measurer: TextMeasurer = {
  measure: (text, font) => ({ width: Array.from(text).length * font.size * 0.55, ascent: font.size * 0.8, descent: font.size * 0.2 }),
};

type Dict = { [key: string]: string | Dict };

function lookup(dict: Dict, path: string[]): string | undefined {
  let node: string | Dict | undefined = dict;
  for (const part of path) {
    if (typeof node !== 'object') return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

const RU: Record<string, Dict> = { common: ruCommon, model: ruModel, wallpaperLayout: ruWallpaperLayout };

function translate(key: string, params?: Record<string, string | number>): string {
  const [module, ...path] = key.split('.');
  const template = RU[module] ? lookup(RU[module], path) : undefined;
  if (template === undefined) return key;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (params?.[name] === undefined ? m : String(params[name])));
}

const dateLabels = createDateLabelStrings((key) => translate(key));

const strings: WallpaperLayoutStrings = createWallpaperStrings({
  translate,
  translatePlural: (key, count) => translate(`${key}.${new Intl.PluralRules('ru').select(count)}`, { count }),
  formatDue: (due, relativeTo) => formatDueLabel(due, relativeTo, dateLabels),
});

function makeTask(quadrant: QuadrantKey, index: number, title: string, dueRaw: string | null): Task {
  const due = dueRaw === null ? null : parseFloating(dueRaw);
  const id = `01TASK${quadrant}${index}`;
  return {
    kind: 'task',
    id,
    path: `Планировщик/Задачи/${title}.md`,
    title,
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
      done: false,
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
    done: false,
    completed: null,
    completions: [],
    created: null,
    archived: false,
  };
}

interface FixtureItem {
  source: string;
  title: string;
  allDay: boolean;
  color: string;
}

function makeItem(date: LocalDateString, raw: FixtureItem, index: number): DayItem {
  const base = {
    key: `${date}-${index}`,
    date,
    title: raw.title,
    allDay: raw.allDay,
    startMinute: raw.allDay ? null : 600 + index * 30,
    endMinute: raw.allDay ? null : 630 + index * 30,
    continuesFromPrevious: false,
    continuesToNext: false,
    color: raw.color,
    icon: null,
  };
  switch (raw.source) {
    case 'task':
      return {
        ...base,
        source: 'task',
        taskId: `t${index}`,
        quadrant: 'do',
        priority: 'normal',
        duration: null,
        instanceDate: date,
        projected: false,
        recurring: false,
        completed: false,
        overdue: false,
      };
    case 'external':
      return { ...base, source: 'external', calendarId: 'cal', occurrenceKey: `o${index}`, eventId: `e${index}`, readOnly: true };
    case 'note':
      return { ...base, source: 'note', noteId: `n${index}`, startMinute: null, endMinute: null };
    default:
      return { ...base, source: 'event', eventId: `ev${index}`, calendarId: null, recurring: false, occurrenceStart: { date, time: null } };
  }
}

function buildDays(): Map<LocalDateString, DayAgenda> {
  const days = new Map<LocalDateString, DayAgenda>();
  for (const date of datesInRange('2026-07-20', '2026-11-15')) {
    days.set(date, { date, allDay: [], timed: [], notes: [], coverage: 'covered' });
  }
  const raw = fixtures.days as Record<string, FixtureItem[]>;
  for (const [date, list] of Object.entries(raw)) {
    const agenda = days.get(date) as DayAgenda;
    list.forEach((entry, i) => {
      const item = makeItem(date, entry, i);
      if (item.source === 'note') {
        agenda.notes.push(item);
        // Защита: даже если заметка попала в общий блок, на обои она не выводится.
        agenda.timed.push(item);
      } else if (item.allDay) agenda.allDay.push(item);
      else agenda.timed.push(item);
    });
  }
  return days;
}

function buildTasks(): Record<QuadrantKey, Task[]> {
  const result = {} as Record<QuadrantKey, Task[]>;
  const raw = fixtures.tasks as Record<QuadrantKey, { title: string; due: string | null }[]>;
  for (const key of QUADRANT_KEYS) result[key] = (raw[key] ?? []).map((t, i) => makeTask(key, i, t.title, t.due));
  return result;
}

const DAYS = buildDays();
const TASKS = buildTasks();

function profileOf(id: string): WallpaperProfile {
  const ref = fixtures.profiles.find((p) => p.id === id);
  const profile = ref ? findProfileBySize(ref.width, ref.height) : null;
  if (!profile) throw new Error(`no profile ${id}`);
  return profile;
}

const PALETTES: WallpaperPalette[] = ['dark', 'light', 'translucent'];
const TEMPLATES: WallpaperTemplate[] = ['matrix', 'calendar'];

function makeInput(overrides: Partial<WallpaperLayoutInput> = {}): WallpaperLayoutInput {
  return {
    template: 'matrix',
    palette: 'dark',
    profile: profileOf('iphone-1179x2556'),
    date: fixtures.date,
    weekStart: 1,
    hour12: false,
    tasksPerQuadrant: 3,
    matrix: defaultMatrixConfig('ru'),
    tasksByQuadrant: TASKS,
    days: DAYS,
    strings,
    ...overrides,
  };
}

type TextCommand = Extract<DrawCommand, { op: 'text' }>;

function texts(layout: WallpaperLayout): TextCommand[] {
  return layout.commands.filter((c): c is TextCommand => c.op === 'text');
}

function textValues(layout: WallpaperLayout): string[] {
  return texts(layout).map((c) => c.text);
}

/** Вертикальные границы команды (с учётом высоты шрифта для текста). */
function verticalExtent(c: DrawCommand): [number, number] {
  switch (c.op) {
    case 'rect':
      return [c.y, c.y + c.h];
    case 'circle':
      return [c.cy - c.r, c.cy + c.r];
    case 'line':
      return [Math.min(c.y1, c.y2), Math.max(c.y1, c.y2)];
    case 'text':
      return [c.y - c.font.size / 2, c.y + c.font.size / 2];
    case 'icon':
      return [c.y, c.y + c.size];
  }
}

function horizontalExtent(c: DrawCommand, layout: WallpaperLayout): [number, number] {
  switch (c.op) {
    case 'rect':
      return [c.x, c.x + c.w];
    case 'circle':
      return [c.cx - c.r, c.cx + c.r];
    case 'line':
      return [Math.min(c.x1, c.x2), Math.max(c.x1, c.x2)];
    case 'icon':
      return [c.x, c.x + c.size];
    case 'text': {
      const w = measurer.measure(c.text, c.font).width;
      if (c.align === 'left') return [c.x, c.x + w];
      if (c.align === 'right') return [c.x - w, c.x];
      return [c.x - w / 2, c.x + w / 2];
    }
  }
  return [0, layout.width];
}

// ---------------------------------------------------------------------------
// Безопасные зоны и размеры
// ---------------------------------------------------------------------------

describe('wallpaper layout: safe zones and sizes (composition as in LockDay)', () => {
  // 2026-08 и 2026-03 — сетка месяца на 6 недель (неделя с понедельника), 2026-10 — на 5.
  const DATES = [fixtures.date, '2026-08-15', '2026-03-31'];
  const PRESETS = ['widgets', 'no-widgets'] as const;
  for (const template of TEMPLATES) {
    for (const profile of KNOWN_PROFILES) {
      for (const layoutPreset of PRESETS) {
        for (const date of DATES) {
          it(`${template} / ${profile.id} / ${layoutPreset} / ${date}: content between the clock and 84%`, () => {
            const layout = layoutWallpaper(makeInput({ template, profile, date, layoutPreset }), measurer);
            expect(layout.width).toBe(profile.width);
            expect(layout.height).toBe(profile.height);
            expect(layout.commands.length).toBeGreaterThan(20);
            const band = contentBand(profile, layoutPreset);
            const top = layoutPreset === 'widgets' ? 0.31 : 0.27;
            expect(band.top).toBeGreaterThanOrEqual(profile.height * top - 1);
            expect(band.top).toBeLessThanOrEqual(profile.height * top + 1);
            expect(band.bottom).toBeLessThanOrEqual(profile.height * 0.84);
            for (const c of layout.commands) {
              const [cTop, cBottom] = verticalExtent(c);
              expect(cTop).toBeGreaterThanOrEqual(band.top - 0.5);
              expect(cBottom).toBeLessThanOrEqual(profile.height * 0.84 + 0.5);
              const [left, right] = horizontalExtent(c, layout);
              expect(left).toBeGreaterThanOrEqual(-0.5);
              expect(right).toBeLessThanOrEqual(profile.width + 0.5);
            }
            // Первая карточка (лента недели / прогресс года) начинается сразу под часами (виджетами).
            const first = layout.commands.find((c) => c.op === 'rect');
            expect(first && first.op === 'rect' ? first.y / profile.height : 0).toBeLessThan(top + 0.01);
          });
        }
      }
    }
  }

  it('matrix keeps the iOS notification area free on modern iPhones (bottom ≤ 70%)', () => {
    for (const profile of KNOWN_PROFILES.filter((p) => p.height / p.width > 2)) {
      for (const layoutPreset of PRESETS) {
        const layout = layoutWallpaper(makeInput({ profile, layoutPreset }), measurer);
        const bottom = Math.max(...layout.commands.map((c) => verticalExtent(c)[1]));
        expect(bottom / profile.height).toBeLessThanOrEqual(0.7 + 1e-3);
      }
    }
  });

  it('calendar with a 6-week month fits by shrinking, not by cutting', () => {
    for (const profile of KNOWN_PROFILES) {
      const layout = layoutWallpaper(makeInput({ template: 'calendar', profile, date: '2026-08-15' }), measurer);
      // Все 42 дня сетки нарисованы.
      const numbers = textValues(layout).filter((t) => /^\d+$/.test(t));
      expect(numbers.length).toBeGreaterThanOrEqual(42);
      const bottom = Math.max(...layout.commands.map((c) => verticalExtent(c)[1]));
      expect(bottom).toBeLessThanOrEqual(profile.height * 0.84 + 0.5);
    }
  });

  it('without widgets the content starts ~4% higher', () => {
    const profile = profileOf('iphone-1179x2556');
    const firstY = (preset: 'widgets' | 'no-widgets') => {
      const rect = layoutWallpaper(makeInput({ profile, layoutPreset: preset }), measurer).commands.find((c) => c.op === 'rect');
      return rect && rect.op === 'rect' ? rect.y / profile.height : 0;
    };
    expect(firstY('widgets') - firstY('no-widgets')).toBeCloseTo(0.04, 2);
    // Как на снимке LockDay: лента недели с ~31 %.
    expect(firstY('widgets')).toBeGreaterThan(0.305);
    expect(firstY('widgets')).toBeLessThan(0.32);
  });

  it('scales with the device: larger screen gives larger fonts', () => {
    const small = layoutWallpaper(makeInput({ profile: profileOf('iphone-1080x2340') }), measurer);
    const large = layoutWallpaper(makeInput({ profile: profileOf('iphone-1320x2868') }), measurer);
    const titleSize = (l: WallpaperLayout) => texts(l).find((c) => c.text === 'Важно и срочно')?.font.size ?? 0;
    expect(titleSize(small)).toBeGreaterThan(0);
    expect(titleSize(large)).toBeGreaterThan(titleSize(small));
  });

  it('shrinks the content when the safe band is too small', () => {
    const tiny: WallpaperProfile = { ...profileOf('iphone-1179x2556'), id: 'test-small', safeTop: 0.6, safeBottom: 0.8 };
    const layout = layoutWallpaper(makeInput({ profile: tiny, template: 'calendar', date: '2026-08-15' }), measurer);
    const band = contentBand(tiny);
    for (const c of layout.commands) {
      const [top, bottom] = verticalExtent(c);
      expect(top).toBeGreaterThanOrEqual(band.top - 0.5);
      expect(bottom).toBeLessThanOrEqual(band.bottom + 0.5);
    }
  });

  it('marks cards for the frosted glass backdrop', () => {
    const layout = layoutWallpaper(makeInput(), measurer);
    const cards = layout.commands.filter((c) => c.op === 'rect' && c.backdrop === 'blur');
    // Лента недели и четыре квадранта.
    expect(cards).toHaveLength(5);
  });
});

describe('expired wallpaper (fallback file after 7 days)', () => {
  const palette = resolvePalette('dark');
  const selectedCircles = (layout: WallpaperLayout) => layout.commands.filter((c) => c.op === 'circle' && c.fill === palette.text);

  it('matrix: notice on top, no selected day, no relative due labels', () => {
    const normal = layoutWallpaper(makeInput(), measurer);
    expect(selectedCircles(normal)).toHaveLength(1);
    const layout = layoutWallpaper(makeInput({ expired: true }), measurer);
    const values = textValues(layout);
    expect(values).toContain('Обои устарели — откройте Obsidian');
    expect(selectedCircles(layout)).toHaveLength(0);
    expect(values.some((v) => /Сегодня|Завтра|Вчера/.test(v))).toBe(false);
    expect(values).toContain('11 окт.');
    expect(values).toContain('16 окт.');
    // Плашка — над лентой недели.
    const notice = texts(layout).find((c) => c.text.startsWith('Обои устарели'));
    const firstNumber = texts(layout).find((c) => c.text === '5');
    expect(notice && firstNumber ? notice.y < firstNumber.y : false).toBe(true);
    expect(layout.commands.some((c) => c.op === 'icon' && c.name === 'alert-triangle')).toBe(true);
  });

  it('calendar: notice and no selected day; still within the safe band', () => {
    const profile = profileOf('iphone-1179x2556');
    const layout = layoutWallpaper(makeInput({ template: 'calendar', expired: true, date: '2026-08-15', profile }), measurer);
    expect(textValues(layout)).toContain('Обои устарели — откройте Obsidian');
    expect(selectedCircles(layout)).toHaveLength(0);
    for (const c of layout.commands) expect(verticalExtent(c)[1]).toBeLessThanOrEqual(profile.height * 0.84 + 0.5);
  });

  it('English strings', () => {
    const en = createWallpaperStrings({
      translate: (key, params) => {
        const [module, ...path] = key.split('.');
        const dict: Record<string, Dict> = { wallpaperLayout: enWallpaperLayout };
        const template = dict[module] ? lookup(dict[module], path) : undefined;
        if (template === undefined) return key;
        return template.replace(/\{(\w+)\}/g, (m, name: string) => (params?.[name] === undefined ? m : String(params[name])));
      },
      translatePlural: (key) => key,
      formatDue: () => '',
    });
    expect(en.expiredNotice).toBe('Wallpaper is out of date — open Obsidian');
    expect(en.formatDueDate?.({ date: '2026-10-16', time: '17:00' })).toBe('Oct 16');
  });
});

// ---------------------------------------------------------------------------
// Шаблон «Матрица»
// ---------------------------------------------------------------------------

describe('matrix template', () => {
  it('draws the week Mon–Sun with the selected day in a circle', () => {
    const input = makeInput();
    const layout = layoutWallpaper(input, measurer);
    const labels = texts(layout)
      .filter((c) => c.font.size === texts(layout).find((t) => t.text === 'П')?.font.size && /^[ПВСЧ]$/.test(c.text))
      .slice(0, 7)
      .map((c) => c.text);
    expect(labels).toEqual(['П', 'В', 'С', 'Ч', 'П', 'С', 'В']);
    const numbers = textValues(layout).filter((t) => /^\d+$/.test(t));
    for (const n of ['5', '6', '7', '8', '9', '10', '11']) expect(numbers).toContain(n);
    const ten = texts(layout).find((c) => c.text === '10');
    const palette = resolvePalette('dark');
    const circle = layout.commands.find(
      (c) => c.op === 'circle' && c.fill === palette.text && ten !== undefined && Math.abs(c.cx - ten.x) < 1 && Math.abs(c.cy - ten.y) < 1,
    );
    expect(circle).toBeDefined();
    expect(ten?.color).toBe(palette.cardEffective);
  });

  it('week starting on Sunday', () => {
    const layout = layoutWallpaper(makeInput({ weekStart: 0 }), measurer);
    const numbers = textValues(layout).filter((t) => /^\d+$/.test(t));
    expect(numbers.slice(0, 7)).toEqual(['4', '5', '6', '7', '8', '9', '10']);
  });

  it('shows at most two pills per day and «+N» for the rest; notes are excluded', () => {
    const layout = layoutWallpaper(makeInput(), measurer);
    const values = textValues(layout);
    expect(values.filter((t) => t === '+3')).toHaveLength(2);
    expect(layout.overflow.week).toBe(6);
    expect(values.some((t) => t.includes('Секретная'))).toBe(false);
    expect(values.some((t) => t.startsWith('Встреча'))).toBe(false);
  });

  it('pill colors follow the calendar/quadrant color', () => {
    const layout = layoutWallpaper(makeInput(), measurer);
    const rectUnder = (text: string) => {
      const t = texts(layout).find((c) => c.text.startsWith(text));
      if (!t) throw new Error(text);
      return layout.commands.find(
        (c) => c.op === 'rect' && c.x <= t.x && t.x <= c.x + c.w && c.y <= t.y && t.y <= c.y + c.h && c.h < 60,
      );
    };
    // Событие на весь день — плашка залита цветом календаря.
    const solid = rectUnder('Бабушк');
    expect(solid?.op === 'rect' && solid.fill).toBe('#3E8BF0');
    // Обычное событие — тонированная плашка.
    const tinted = rectUnder('Годовщ');
    expect(tinted?.op === 'rect' && tinted.fill).not.toBe('#3E8BF0');
  });

  it('shows 3 tasks per quadrant, counter and overflow', () => {
    const layout = layoutWallpaper(makeInput({ tasksPerQuadrant: 3 }), measurer);
    const values = textValues(layout);
    expect(values).toContain('Разобрать антресоль');
    expect(values).not.toContain('Выучить португальский');
    expect(values).toContain('4');
    expect(layout.overflow.someday).toBe(1);
    expect(layout.overflow.do).toBeUndefined();
  });

  it('shows 2 tasks per quadrant when configured', () => {
    const layout = layoutWallpaper(makeInput({ tasksPerQuadrant: 2 }), measurer);
    const values = textValues(layout);
    expect(values).not.toContain('Разобрать антресоль');
    expect(layout.overflow.someday).toBe(2);
    const circles = layout.commands.filter((c) => c.op === 'circle' && c.fill === null && c.r > 12);
    // 2 + 1 + 2 + 2 кружков задач.
    expect(circles).toHaveLength(7);
  });

  it('quadrant headers: Lucide icon, title, due labels on the right', () => {
    const layout = layoutWallpaper(makeInput(), measurer);
    const icons = layout.commands.filter((c) => c.op === 'icon').map((c) => (c.op === 'icon' ? c.name : ''));
    expect(icons).toEqual(['flame', 'calendar-days', 'zap', 'menu']);
    const values = textValues(layout);
    for (const title of ['Важно и срочно', 'Важно', 'Срочно', 'Когда-нибудь']) expect(values).toContain(title);
    expect(values.filter((t) => t === 'Завтра')).toHaveLength(2);
    expect(values).toContain('16 окт.');
    expect(values).toContain('Завтра 17:00');
    const due = texts(layout).find((c) => c.text === '16 окт.');
    expect(due?.align).toBe('right');
  });

  it('long Russian titles are cut with an ellipsis inside the card', () => {
    const layout = layoutWallpaper(makeInput(), measurer);
    const long = texts(layout).find((c) => c.text.startsWith('Стоматолог'));
    expect(long?.text.endsWith('…')).toBe(true);
    const due = texts(layout).find((c) => c.text === '16 окт.');
    if (!long || !due) throw new Error('missing');
    const longRight = long.x + measurer.measure(long.text, long.font).width;
    const dueLeft = due.x - measurer.measure(due.text, due.font).width;
    expect(longRight).toBeLessThan(dueLeft);
    const noDue = texts(layout).find((c) => c.text.startsWith('Забрать Авито'));
    expect(noDue?.text.endsWith('…')).toBe(true);
  });

  it('empty quadrant shows a placeholder and zero counter', () => {
    const layout = layoutWallpaper(makeInput({ tasksByQuadrant: { ...TASKS, plan: [] } }), measurer);
    const values = textValues(layout);
    expect(values).toContain('Нет задач');
    expect(values).toContain('0');
  });

  it('custom quadrant title from Матрица.md is used', () => {
    const matrix = defaultMatrixConfig('ru');
    const custom = { ...matrix, byKey: { ...matrix.byKey, do: { ...matrix.byKey.do, title: 'Горит' } } };
    const layout = layoutWallpaper(makeInput({ matrix: custom }), measurer);
    expect(textValues(layout)).toContain('Горит');
  });
});

// ---------------------------------------------------------------------------
// Шаблон «Календарь»
// ---------------------------------------------------------------------------

describe('calendar template', () => {
  it('year progress for 10.10.2026: 77 %, 83 days left', () => {
    expect(yearProgress('2026-10-10')).toMatchObject({ year: 2026, percent: 77, daysLeft: 83 });
    expect(yearProgress('2026-01-01')).toMatchObject({ percent: 0, daysLeft: 365 });
    expect(yearProgress('2026-12-31')).toMatchObject({ percent: 99, daysLeft: 1 });
    expect(yearProgress('2028-12-31')).toMatchObject({ percent: 99, daysLeft: 1 });
    expect(yearProgress('2028-07-01').fraction).toBeCloseTo(182 / 366);
  });

  it('month grid has 4–6 weeks', () => {
    expect(monthGrid('2026-10-10', 1)).toEqual({ year: 2026, month: 10, start: '2026-09-28', weeks: 5 });
    expect(monthGrid('2026-10-10', 0)).toMatchObject({ start: '2026-09-27', weeks: 5 });
    expect(monthGrid('2027-02-10', 1).weeks).toBe(4);
    expect(monthGrid('2026-08-15', 1).weeks).toBe(6);
  });

  it('draws year header, progress bar and captions', () => {
    const layout = layoutWallpaper(makeInput({ template: 'calendar' }), measurer);
    const values = textValues(layout);
    expect(values).toContain('2026');
    expect(values).toContain('77%');
    expect(values).toContain('77% года позади');
    expect(values).toContain('Осталось 83 дня');
    expect(values).toContain('Октябрь 2026');
    const palette = resolvePalette('dark');
    const bars = layout.commands.filter((c) => c.op === 'rect' && (c.fill === palette.track || c.fill === palette.text));
    expect(bars).toHaveLength(2);
    const [track, fill] = bars;
    if (track.op !== 'rect' || fill.op !== 'rect') throw new Error('rect');
    expect(fill.w / track.w).toBeCloseTo(282 / 365, 3);
  });

  it('month cells: events as pills, «+N», notes excluded, selected day', () => {
    const layout = layoutWallpaper(makeInput({ template: 'calendar' }), measurer);
    const values = textValues(layout);
    expect(values.filter((t) => t === '+4')).toHaveLength(2);
    expect(layout.overflow.month).toBe(8);
    expect(values.some((t) => t.includes('Секретная'))).toBe(false);
    // 31 день октября + дни соседних месяцев в 5 неделях.
    expect(values.filter((t) => /^\d{1,2}$/.test(t))).toHaveLength(35);
    const palette = resolvePalette('dark');
    const ten = texts(layout).find((c) => c.text === '10' && c.color === palette.cardEffective);
    expect(ten).toBeDefined();
  });

  it('without the extra daysLeft string still renders the progress caption', () => {
    const { daysLeft: _unused, ...base } = strings;
    void _unused;
    const layout = layoutWallpaper(makeInput({ template: 'calendar', strings: base }), measurer);
    expect(textValues(layout)).toContain('77% года позади');
  });
});

// ---------------------------------------------------------------------------
// Палитры и контраст
// ---------------------------------------------------------------------------

describe('palettes and contrast', () => {
  it('contrast ratio follows WCAG', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#000000', '#000000')).toBeCloseTo(1, 5);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
    expect(contrastRatio('#FFFFFF', '#777777')).toBeCloseTo(contrastRatio('#777777', '#FFFFFF'), 10);
  });

  it('parses hex and rgb() colors', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('#E5484D80')?.a).toBeCloseTo(128 / 255);
    expect(parseColor('rgba(0, 0, 0, 0.56)')).toEqual({ r: 0, g: 0, b: 0, a: 0.56 });
    expect(parseColor('var(--color-red)')).toBeNull();
  });

  it('ensureContrast keeps good colors and fixes poor ones', () => {
    expect(ensureContrast('#FFFFFF', '#000000')).toBe('#FFFFFF');
    const fixed = ensureContrast('#F2B33D', '#FFFFFF');
    expect(contrastRatio(fixed, '#FFFFFF')).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    expect(fixed).not.toBe('#000000');
  });

  for (const id of PALETTES) {
    it(`${id}: text colors reach 4.5:1 over the worst backdrop`, () => {
      const palette = resolvePalette(id);
      expect(contrastRatio(palette.text, palette.cardEffective)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      expect(contrastRatio(palette.secondary, palette.cardEffective)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      // Выделенный день: номер цвета карточки на круге цвета текста.
      expect(contrastRatio(palette.cardEffective, palette.text)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    });

    it(`${id}: reference accent and pill colors reach 4.5:1`, () => {
      const ctx = createLayoutContext(makeInput({ palette: id }), measurer, 3, resolvePalette(id));
      for (const color of fixtures.referenceColors) {
        expect(contrastRatio(ctx.accent(color), ctx.palette.cardEffective)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
        const tinted = ctx.pill(color, false);
        expect(contrastRatio(tinted.text, tinted.fill)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
        const solid = ctx.pill(color, true);
        expect(contrastRatio(solid.text, solid.fill)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
        expect(contrastRatio(ctx.onFill(color), solid.fill)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      }
    });
  }

  it('light and dark palettes differ', () => {
    const dark = resolvePalette('dark');
    const light = resolvePalette('light');
    expect(dark.card).not.toBe(light.card);
    expect(contrastRatio(dark.text, '#000000')).toBeGreaterThan(contrastRatio(light.text, '#000000'));
    const layoutLight = layoutWallpaper(makeInput({ palette: 'light' }), measurer);
    expect(layoutLight.commands.some((c) => c.op === 'rect' && c.fill === light.card)).toBe(true);
    const title = texts(layoutLight).find((c) => c.text === 'Танцы');
    expect(title?.color).toBe(light.text);
  });

  it('quadrant titles in the layout are readable on the card', () => {
    for (const id of PALETTES) {
      const layout = layoutWallpaper(makeInput({ palette: id }), measurer);
      const palette = resolvePalette(id);
      for (const title of ['Важно и срочно', 'Важно', 'Срочно', 'Когда-нибудь']) {
        const cmd = texts(layout).find((c) => c.text === title);
        expect(cmd).toBeDefined();
        expect(contrastRatio(cmd?.color ?? '', palette.cardEffective)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Строки
// ---------------------------------------------------------------------------

describe('wallpaper strings', () => {
  it('builds Russian strings from dictionaries', () => {
    expect(strings.weekdayShort).toEqual(['В', 'П', 'В', 'С', 'Ч', 'П', 'С']);
    expect(strings.monthNames[9]).toBe('Октябрь');
    expect(strings.quadrantTitles.do).toBe('Важно и срочно');
    expect(strings.moreItems(3)).toBe('+3');
    expect(strings.daysLeft?.(1)).toBe('Остался 1 день');
    expect(strings.daysLeft?.(83)).toBe('Осталось 83 дня');
    expect(strings.daysLeft?.(85)).toBe('Осталось 85 дней');
    expect(strings.formatDue({ date: addDays(fixtures.date, 1), time: '17:00' }, fixtures.date)).toBe('Завтра 17:00');
  });

  it('English dictionary has the same keys', () => {
    const keys = (d: Dict, prefix = ''): string[] =>
      Object.entries(d).flatMap(([k, v]) => (typeof v === 'string' ? [`${prefix}${k}`] : keys(v, `${prefix}${k}.`)));
    const ru = keys(ruWallpaperLayout).filter((k) => !k.startsWith('daysLeft.'));
    const en = keys(enWallpaperLayout).filter((k) => !k.startsWith('daysLeft.'));
    expect(en.sort()).toEqual(ru.sort());
    expect(enWallpaperLayout.daysLeft.other).toContain('{count}');
  });
});

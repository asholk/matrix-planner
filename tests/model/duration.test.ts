import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TASK_DURATION,
  DURATION_PRESETS,
  effectiveDuration,
  formatDuration,
  isValidDuration,
  parseDurationValue,
} from '../../src/model/duration';
import { createDateLabelStrings, formatDueLabel, formatDueTimeLabel, type DateLabelStrings } from '../../src/model/dates';
import { applyFrontmatterPatch, parsePlannerNote, taskToFrontmatter } from '../../src/model/properties';
import { newTaskProperties, planDraftUpdate } from '../../src/model/task-rules';
import type { FrontmatterRecord, Task, TaskProperties } from '../../src/model/types';
import { ruModel } from '../../src/i18n/ru/model';
import { activeCard } from '../../src/tasks/tasks-presenter';

const ID = '01J00000000000000000000001';

function translator(dict: Record<string, unknown>): (key: string) => string {
  return (key) => {
    let node: unknown = dict;
    for (const part of key.replace(/^model\./, '').split('.')) node = (node as Record<string, unknown>)[part];
    if (typeof node !== 'string') throw new Error(`missing key ${key}`);
    return node;
  };
}

const RU: DateLabelStrings = createDateLabelStrings(translator(ruModel));

function parse(frontmatter: FrontmatterRecord): Task {
  const parsed = parsePlannerNote({ path: 'Задачи/Танцы.md', title: 'Танцы', mtime: 1, frontmatter, archived: false, deletedInCalendar: false });
  if (!parsed || parsed.kind !== 'task') throw new Error('ожидалась задача');
  return parsed;
}

const BASE: FrontmatterRecord = { type: 'task', id: ID, quadrant: 'do', due: '2026-10-12T18:00' };

describe('длительность: проверка и подписи', () => {
  it('допустимы целые 5…1440', () => {
    expect([5, 30, 1440].every(isValidDuration)).toBe(true);
    expect([4, 1441, 30.5, '30', null, Number.NaN].some(isValidDuration)).toBe(false);
    expect(DURATION_PRESETS).toEqual([15, 30, 45, 60, 90, 120]);
  });

  it('значение YAML: число или строка из цифр; пусто — undefined; невалидно — null', () => {
    expect(parseDurationValue(90)).toBe(90);
    expect(parseDurationValue(' 45 ')).toBe(45);
    expect(parseDurationValue(undefined)).toBeUndefined();
    expect(parseDurationValue('')).toBeUndefined();
    expect(parseDurationValue('1h')).toBeNull();
    expect(parseDurationValue(0)).toBeNull();
    expect(parseDurationValue(2000)).toBeNull();
    expect(parseDurationValue(true)).toBeNull();
  });

  it('эффективная длительность — по умолчанию 30 мин', () => {
    expect(DEFAULT_TASK_DURATION).toBe(30);
    expect(effectiveDuration(null)).toBe(30);
    expect(effectiveDuration(90)).toBe(90);
  });

  it('подпись: минуты, часы с половиной, часы и минуты', () => {
    const ru = { minutes: '{n} мин', hours: '{n} ч', decimal: ',' };
    const en = { minutes: '{n} min', hours: '{n} h', decimal: '.' };
    expect(DURATION_PRESETS.map((m) => formatDuration(m, ru))).toEqual(['15 мин', '30 мин', '45 мин', '1 ч', '1,5 ч', '2 ч']);
    expect(formatDuration(90, en)).toBe('1.5 h');
    expect(formatDuration(75, ru)).toBe('1 ч 15 мин');
  });

  it('диапазон времени: «18:00–19:30», 12 ч, переход через полночь; без длительности — начало', () => {
    expect(formatDueTimeLabel('18:00', 90, false, RU)).toBe('18:00–19:30');
    expect(formatDueTimeLabel('18:00', null, false, RU)).toBe('18:00');
    expect(formatDueTimeLabel('23:30', 60, false, RU)).toBe('23:30–00:30');
    expect(formatDueTimeLabel('18:00', 90, true, { am: 'AM', pm: 'PM' })).toBe('6:00 PM–7:30 PM');
    expect(formatDueLabel({ date: '2026-10-10', time: '18:00' }, '2026-10-10', RU, { duration: 90 })).toBe('Сегодня 18:00–19:30');
    expect(formatDueLabel({ date: '2026-10-10', time: null }, '2026-10-10', RU, { duration: 90 })).toBe('Сегодня');
  });

  it('карточка задачи получает длительность для подписи срока', () => {
    const task = parse({ ...BASE, duration: 90 });
    const card = activeCard(task, { date: '2026-10-12', time: '10:00' }, {
      due: (due, today, duration) => formatDueLabel(due, today, RU, { duration }),
      completed: () => '',
    });
    expect(card.dueLabel).toBe('Сегодня 18:00–19:30');
  });
});

describe('длительность: свойство заметки', () => {
  it('разбор: число, строка; без свойства — null без проблем', () => {
    expect(parse({ ...BASE, duration: 90 })).toMatchObject({ duration: 90, props: { duration: 90 }, issues: [] });
    expect(parse({ ...BASE, duration: '45' }).duration).toBe(45);
    const old = parse(BASE);
    expect(old.duration).toBeNull();
    expect(old.issues).toEqual([]);
    expect(old.extra).toEqual({});
  });

  it('невалидное значение — проблема и null', () => {
    const bad = parse({ ...BASE, duration: 3 });
    expect(bad.duration).toBeNull();
    expect(bad.issues).toEqual([{ property: 'duration', code: 'invalid-value', value: 3 }]);
    expect(parse({ ...BASE, duration: [1] }).issues).toEqual([{ property: 'duration', code: 'invalid-type', value: [1] }]);
    expect(parse({ ...BASE, duration: '1,5 ч' }).duration).toBeNull();
  });

  it('запись: null не пишется, значение — после priority', () => {
    const props = parse(BASE).props;
    expect('duration' in taskToFrontmatter(props)).toBe(false);
    const keys = Object.keys(taskToFrontmatter({ ...props, duration: 60 }));
    expect(keys.indexOf('duration')).toBe(keys.indexOf('priority') + 1);
  });

  it('изменение: null удаляет свойство, число — записывает', () => {
    const fm: FrontmatterRecord = { ...BASE, duration: 30, custom: 'x' };
    applyFrontmatterPatch<TaskProperties>(fm, { duration: null });
    expect(fm).toEqual({ ...BASE, custom: 'x' });
    applyFrontmatterPatch<TaskProperties>(fm, { duration: 120 });
    expect(fm.duration).toBe(120);
  });

  it('правила: новая задача и правка из формы', () => {
    const now = { date: '2026-10-10', time: '13:20' };
    const draft = { quadrant: 'do' as const, due: { date: '2026-10-12', time: '18:00' }, repeat: 'weekly' as const, remind: 'none' as const, priority: 'normal' as const };
    expect(newTaskProperties({ ...draft, duration: 90 }, { id: 'ID', now }).duration).toBe(90);
    expect(newTaskProperties({ ...draft, duration: null }, { id: 'ID', now }).duration).toBeNull();
    const props = newTaskProperties({ ...draft, duration: 90 }, { id: 'ID', now });
    expect(planDraftUpdate(props, { duration: 90 })).toEqual({ kind: 'skip' });
    expect(planDraftUpdate(props, { duration: 45 })).toEqual({ kind: 'change', patch: { duration: 45 } });
    expect(planDraftUpdate(props, { duration: null })).toEqual({ kind: 'change', patch: { duration: null } });
    // Смена времени не трогает длительность серии.
    expect(planDraftUpdate(props, { due: { date: '2026-10-12', time: '19:00' } })).toEqual({ kind: 'change', patch: { due: '2026-10-12T19:00' } });
  });
});

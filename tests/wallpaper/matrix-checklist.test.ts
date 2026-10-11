import { describe, expect, it } from 'vitest';
import type { TextMeasurer } from '../../src/app/contracts';
import type { DrawCommand, QuadrantKey, Task, WallpaperLayoutInput } from '../../src/model/types';
import { defaultMatrixConfig } from '../../src/model/defaults';
import { createWallpaperStrings, layoutWallpaper } from '../../src/wallpaper/layout';
import { KNOWN_PROFILES } from '../../src/wallpaper/profiles';
import { createLayoutInput, packFingerprint } from '../../src/wallpaper/render-plan';

const measurer: TextMeasurer = {
  measure: (text, font) => ({ width: Array.from(text).length * font.size * 0.55, ascent: font.size * 0.8, descent: font.size * 0.2 }),
};

const strings = createWallpaperStrings({
  translate: (key) => key,
  translatePlural: (key, count) => `${key}:${count}`,
  formatDue: (due) => due.date,
});

function task(id: string, title: string, checklist: Task['checklist']): Task {
  return { kind: 'task', id, title, quadrant: 'do', due: null, done: false, repeat: 'none', priority: 'normal', archived: false, checklist } as unknown as Task;
}

function input(tasks: Task[]): WallpaperLayoutInput {
  const profile = KNOWN_PROFILES[0];
  if (!profile) throw new Error('нет профилей');
  const tasksByQuadrant: Record<QuadrantKey, Task[]> = { do: tasks, plan: [], urgent: [], someday: [] };
  return {
    template: 'matrix',
    palette: 'dark',
    profile,
    date: '2026-10-11',
    weekStart: 1,
    hour12: false,
    tasksPerQuadrant: 3,
    matrix: defaultMatrixConfig('ru'),
    tasksByQuadrant,
    days: new Map(),
    strings,
  };
}

type TextCommand = Extract<DrawCommand, { op: 'text' }>;

function texts(tasks: Task[]): TextCommand[] {
  return layoutWallpaper(input(tasks), measurer).commands.filter((c): c is TextCommand => c.op === 'text');
}

describe('обои «Матрица»: прогресс чек-листа (доработка 008)', () => {
  it('«2/5» мелким шрифтом сразу после названия', () => {
    const all = texts([task('A', 'Чемодан', { done: 2, total: 5 })]);
    const title = all.find((c) => c.text === 'Чемодан');
    const progress = all.find((c) => c.text === '2/5');
    expect(title).toBeDefined();
    expect(progress).toBeDefined();
    if (!title || !progress) return;
    expect(progress.font.size).toBeLessThan(title.font.size);
    expect(progress.y).toBe(title.y);
    expect(progress.x).toBeGreaterThan(title.x + measurer.measure(title.text, title.font).width);
  });

  it('без чек-листа подписи нет', () => {
    const all = texts([task('A', 'Чемодан', null)]);
    expect(all.some((c) => /^\d+\/\d+$/.test(c.text))).toBe(false);
  });

  it('прогресс входит в отпечаток пакета (обои перерисовываются)', () => {
    const source = (checklist: Task['checklist']) =>
      createLayoutInput({
        date: '2026-10-11',
        today: '2026-10-11',
        now: { date: '2026-10-11', time: '09:00' },
        settings: { template: 'matrix', palette: 'dark', weekStart: 'auto', tasksPerQuadrant: 3, layoutPreset: 'widgets' } as never,
        profile: KNOWN_PROFILES[0],
        weekStart: 1,
        hour12: false,
        matrix: defaultMatrixConfig('ru'),
        tasks: [task('A', 'Чемодан', checklist)],
        days: new Map(),
        strings,
      });
    expect(packFingerprint('2026-10-11', source({ done: 1, total: 3 }))).not.toBe(packFingerprint('2026-10-11', source({ done: 2, total: 3 })));
  });
});

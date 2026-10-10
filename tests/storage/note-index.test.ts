import { afterEach, describe, expect, it } from 'vitest';
import type { App } from 'obsidian';
import { createMockApp, type App as MockApp } from '../__mocks__/obsidian';
import type { IndexChange, PlannerNoteParser } from '../../src/app/contracts';
import type { InvalidPlannerNote, ItemKind, MatrixConfig, ParsedNote, PlannerItem } from '../../src/model/types';
import { MetadataNoteIndex, type IndexTimers } from '../../src/storage/note-index';
import { createPlannerPaths } from '../../src/storage/paths';

/** Простой фейковый парсер (настоящий — model/properties, S1.T2). */
const fakeParser: PlannerNoteParser = {
  parse(input) {
    const fm = input.frontmatter;
    if (!fm) return null;
    const type = fm['type'];
    if (type !== 'task' && type !== 'event' && type !== 'note') return null;
    if (typeof fm['id'] !== 'string') {
      const invalid: InvalidPlannerNote = {
        kind: 'invalid',
        path: input.path,
        title: input.title,
        mtime: input.mtime,
        declaredType: type as ItemKind,
        frontmatter: fm,
        issues: [{ property: 'id', code: 'missing' }],
      };
      return invalid;
    }
    return {
      kind: type,
      id: fm['id'],
      path: input.path,
      title: input.title,
      mtime: input.mtime,
      props: fm,
      extra: {},
      issues: [],
      quadrant: fm['quadrant'],
      archived: input.archived,
      deletedInCalendar: input.deletedInCalendar,
    } as unknown as PlannerItem;
  },
  parseMatrix(path, frontmatter) {
    return { path, quadrants: [], byKey: {}, issues: [], raw: frontmatter } as unknown as MatrixConfig;
  },
};

/** Ручные таймеры: срабатывают только по `fireAll()`. */
function manualTimers() {
  const pending = new Map<number, () => void>();
  let seq = 0;
  const timers: IndexTimers = {
    set: (callback) => {
      seq += 1;
      pending.set(seq, callback);
      return seq;
    },
    clear: (handle) => {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    count: () => pending.size,
    fireAll: () => {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const cb of callbacks) cb();
    },
  };
}

const ROOT = 'Планировщик';
const TASKS = `${ROOT}/Задачи`;

function task(id: string, quadrant = 'do', extra = ''): string {
  return `---\ntype: task\nid: ${id}\nquadrant: ${quadrant}\n${extra}---\nтело\n`;
}

/** Даёт микрозадачам мока (`changed`) выполниться. */
async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

let active: MetadataNoteIndex | null = null;

function setup(app: MockApp = createMockApp()) {
  const timers = manualTimers();
  const paths = createPlannerPaths(ROOT);
  const index = new MetadataNoteIndex(app as unknown as App, {
    parser: fakeParser,
    getPaths: () => paths,
    timers: timers.timers,
  });
  const changes: IndexChange[] = [];
  index.onChange((change) => changes.push(change));
  active = index;
  return { app, index, timers, changes };
}

function quadrantOf(note: ParsedNote | null | undefined): unknown {
  return note && note.kind === 'task' ? (note as unknown as { quadrant: unknown }).quadrant : undefined;
}

describe('storage/note-index', () => {
  afterEach(() => {
    active?.stop();
    active = null;
  });

  describe('первичная индексация', () => {
    it('индексирует заметки Планировщика внутри корня', async () => {
      const app = createMockApp({ resolved: false });
      await app.vault.create(`${TASKS}/A.md`, task('A'));
      await app.vault.create(`${TASKS}/Без id.md`, '---\ntype: task\n---\n');
      await app.vault.create(`${ROOT}/Заметки/Обычная.md`, '---\ntags: [x]\n---\n');
      await app.vault.create(`${ROOT}/Заметки/N.md`, '---\ntype: note\nid: N\n---\n');
      await app.vault.create('Другое/Чужая.md', task('X'));
      await app.vault.create('matrix-planner.md', '---\nschema: 1\n---\n');
      app.metadataCache.resolve();

      const { index } = setup(app);
      index.start();
      expect(index.isReady()).toBe(true);
      await index.whenReady();
      expect(index.getTasks().map((t) => t.id)).toEqual(['A']);
      expect(index.getNotes().map((n) => n.id)).toEqual(['N']);
      expect(index.getInvalid().map((n) => n.path)).toEqual([`${TASKS}/Без id.md`]);
      expect(index.getById('X')).toBeUndefined();
      expect(index.getByPath(`${TASKS}/A.md`)?.title).toBe('A');
    });

    it('холодный старт: готов только после resolved', async () => {
      const app = createMockApp({ resolved: false });
      const { index } = setup(app);
      app.metadataCache.resolved = false;
      index.start();
      expect(index.isReady()).toBe(false);
      await app.vault.create(`${TASKS}/A.md`, task('A'));
      app.metadataCache.resolve();
      await index.whenReady();
      expect(index.isReady()).toBe(true);
      expect(index.getTasks()).toHaveLength(1);
    });

    it('без события resolved готов по таймауту', () => {
      const app = createMockApp({ resolved: false });
      const { index, timers } = setup(app);
      index.start();
      expect(index.isReady()).toBe(false);
      timers.fireAll();
      expect(index.isReady()).toBe(true);
    });

    it('передаёт парсеру признак архива', async () => {
      const { app, index } = setup();
      await app.vault.create(`${TASKS}/Архив/2026-10/Старая.md`, task('OLD'));
      await tick();
      index.start();
      expect((index.getById('OLD') as unknown as { archived: boolean }).archived).toBe(true);
    });
  });

  describe('инкрементальные изменения', () => {
    it('создание и изменение по событию changed', async () => {
      const { app, index, changes } = setup();
      index.start();
      changes.length = 0;
      await app.vault.create(`${TASKS}/A.md`, task('A'));
      await tick();
      expect(index.getById('A')?.path).toBe(`${TASKS}/A.md`);
      expect(changes.at(-1)).toEqual({ kind: 'upsert', paths: [`${TASKS}/A.md`], ids: ['A'] });
    });

    it('задержка changed: индекс не обновлён до события, waitFor дожидается его', async () => {
      const { app, index } = setup();
      const file = await app.vault.create(`${TASKS}/A.md`, task('A'));
      await tick();
      index.start();

      app.metadataCache.autoFlush = false;
      await app.fileManager.processFrontMatter(file, (fm) => {
        fm['quadrant'] = 'plan';
      });
      // Запись прошла, но кэш ещё старый.
      expect(quadrantOf(index.getByPath(`${TASKS}/A.md`))).toBe('do');

      let resolved: ParsedNote | null | undefined;
      const waiting = index.waitFor(`${TASKS}/A.md`, (note) => quadrantOf(note) === 'plan').then((note) => {
        resolved = note;
      });
      await tick();
      expect(resolved).toBeUndefined();

      app.metadataCache.flush();
      await waiting;
      expect(quadrantOf(resolved)).toBe('plan');
    });

    it('waitFor по таймауту возвращает последнее известное состояние или null', async () => {
      const { app, index, timers } = setup();
      await app.vault.create(`${TASKS}/A.md`, task('A'));
      await tick();
      index.start();

      const known = index.waitFor(`${TASKS}/A.md`, (note) => quadrantOf(note) === 'plan', 50);
      const unknown = index.waitFor(`${TASKS}/Нет.md`, undefined, 50);
      timers.fireAll();
      expect(quadrantOf(await known)).toBe('do');
      expect(await unknown).toBeNull();
    });

    it('waitFor сразу возвращает уже подходящее состояние', async () => {
      const { app, index } = setup();
      await app.vault.create(`${TASKS}/A.md`, task('A'));
      await tick();
      index.start();
      const note = await index.waitFor(`${TASKS}/A.md`, (n) => quadrantOf(n) === 'do');
      expect(note?.path).toBe(`${TASKS}/A.md`);
    });

    it('снятие type удаляет заметку из индекса', async () => {
      const { app, index } = setup();
      const file = await app.vault.create(`${TASKS}/A.md`, task('A'));
      await tick();
      index.start();
      await app.fileManager.processFrontMatter(file, (fm) => {
        delete fm['type'];
      });
      await tick();
      expect(index.getById('A')).toBeUndefined();
      expect(index.getTasks()).toHaveLength(0);
    });
  });

  describe('переименование и удаление', () => {
    it('переименование сохраняет id и обновляет путь (без события changed)', async () => {
      const { app, index, changes } = setup();
      const file = await app.vault.create(`${TASKS}/A.md`, task('A'));
      await tick();
      index.start();
      changes.length = 0;

      await app.vault.rename(file, `${TASKS}/Новое имя.md`);
      expect(index.getByPath(`${TASKS}/A.md`)).toBeUndefined();
      expect(index.getById('A')?.path).toBe(`${TASKS}/Новое имя.md`);
      expect(index.getById('A')?.title).toBe('Новое имя');
      expect(changes.map((c) => c.kind)).toEqual(['remove', 'upsert']);
      await tick();
      expect(index.getAllById('A')).toHaveLength(1);
    });

    it('перенос за пределы корня удаляет из индекса', async () => {
      const { app, index } = setup();
      const file = await app.vault.create(`${TASKS}/A.md`, task('A'));
      await tick();
      index.start();
      await app.vault.rename(file, 'Другое/A.md');
      expect(index.getById('A')).toBeUndefined();
    });

    it('перенос в корень добавляет в индекс', async () => {
      const { app, index } = setup();
      const file = await app.vault.create('Входящие/A.md', task('A'));
      await tick();
      index.start();
      await app.vault.rename(file, `${TASKS}/A.md`);
      await tick();
      expect(index.getById('A')?.path).toBe(`${TASKS}/A.md`);
    });

    it('удаление в корзину', async () => {
      const { app, index, changes } = setup();
      const file = await app.vault.create(`${TASKS}/A.md`, task('A'));
      await tick();
      index.start();
      changes.length = 0;
      await app.fileManager.trashFile(file);
      expect(index.getById('A')).toBeUndefined();
      expect(changes).toEqual([{ kind: 'remove', paths: [`${TASKS}/A.md`], ids: ['A'] }]);
    });
  });

  describe('дубликаты id', () => {
    it('getAllById возвращает все копии, getById — первую по пути', async () => {
      const { app, index } = setup();
      await app.vault.create(`${TASKS}/B копия.md`, task('DUP'));
      await app.vault.create(`${TASKS}/A.md`, task('DUP'));
      await tick();
      index.start();
      expect(index.getAllById('DUP').map((n) => n.path)).toEqual([`${TASKS}/A.md`, `${TASKS}/B копия.md`]);
      expect(index.getById('DUP')?.path).toBe(`${TASKS}/A.md`);
      expect(index.getTasks()).toHaveLength(2);
    });

    it('смена id у копии убирает её из старой группы', async () => {
      const { app, index } = setup();
      await app.vault.create(`${TASKS}/A.md`, task('DUP'));
      const copy = await app.vault.create(`${TASKS}/A 2.md`, task('DUP'));
      await tick();
      index.start();
      await app.fileManager.processFrontMatter(copy, (fm) => {
        fm['id'] = 'NEW';
      });
      await tick();
      expect(index.getAllById('DUP')).toHaveLength(1);
      expect(index.getById('NEW')?.path).toBe(`${TASKS}/A 2.md`);
    });
  });

  describe('матрица', () => {
    it('по умолчанию без файла; появление и удаление файла', async () => {
      const { app, index, changes } = setup();
      index.start();
      expect(index.getMatrix().path).toBeNull();
      const file = await app.vault.create(`${ROOT}/Матрица.md`, '---\nquadrants: []\n---\n');
      await tick();
      expect(index.getMatrix().path).toBe(`${ROOT}/Матрица.md`);
      expect(changes.some((c) => c.kind === 'matrix')).toBe(true);
      expect(index.getTasks()).toHaveLength(0);
      await app.fileManager.trashFile(file);
      expect(index.getMatrix().path).toBeNull();
    });
  });

  describe('остановка и перестройка', () => {
    it('после stop изменения не применяются', async () => {
      const { app, index } = setup();
      index.start();
      index.stop();
      await app.vault.create(`${TASKS}/A.md`, task('A'));
      await tick();
      expect(index.getById('A')).toBeUndefined();
    });

    it('rebuild сообщает reset', async () => {
      const { app, index, changes } = setup();
      await app.vault.create(`${TASKS}/A.md`, task('A'));
      await tick();
      index.start();
      changes.length = 0;
      await index.rebuild();
      expect(changes).toEqual([{ kind: 'reset', paths: [`${TASKS}/A.md`], ids: ['A'] }]);
    });
  });
});

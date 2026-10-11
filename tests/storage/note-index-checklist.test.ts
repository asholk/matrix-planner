import { afterEach, describe, expect, it } from 'vitest';
import type { App } from 'obsidian';
import { createMockApp } from '../__mocks__/obsidian';
import type { PlannerNoteParser } from '../../src/app/contracts';
import type { MatrixConfig, PlannerItem } from '../../src/model/types';
import { MetadataNoteIndex, type IndexTimers } from '../../src/storage/note-index';
import { createPlannerPaths } from '../../src/storage/paths';

/** Минимальный парсер: задача с `type` и `id`. */
const parser: PlannerNoteParser = {
  parse(input) {
    const fm = input.frontmatter;
    if (!fm || typeof fm['id'] !== 'string') return null;
    const kind = fm['type'];
    if (kind !== 'task' && kind !== 'note') return null;
    return { kind, id: fm['id'], path: input.path, title: input.title, mtime: input.mtime, props: fm, extra: {}, issues: [] } as unknown as PlannerItem;
  },
  parseMatrix(path) {
    return { path, quadrants: [], byKey: {}, issues: [] } as unknown as MatrixConfig;
  },
};

const timers: IndexTimers = { set: () => 0, clear: () => undefined };
const ROOT = 'Планировщик';
const TASKS = `${ROOT}/Задачи`;

let active: MetadataNoteIndex | null = null;

function setup() {
  const app = createMockApp({ resolved: false });
  const index = new MetadataNoteIndex(app as unknown as App, { parser, getPaths: () => createPlannerPaths(ROOT), timers });
  active = index;
  return { app, index };
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function taskNote(id: string, body: string, type = 'task'): string {
  return `---\ntype: ${type}\nid: ${id}\nquadrant: do\n---\n${body}`;
}

describe('storage/note-index: чек-лист из listItems (доработка 008)', () => {
  afterEach(() => {
    active?.stop();
    active = null;
  });

  it('прогресс задачи берётся из кэша метаданных без чтения файла', async () => {
    const { app, index } = setup();
    await app.vault.create(`${TASKS}/A.md`, taskNote('A', 'Описание\n- [ ] один\n- [x] два\n- [X] три\n- просто пункт\n'));
    await app.vault.create(`${TASKS}/B.md`, taskNote('B', 'Без пунктов\n- просто пункт\n'));
    await app.vault.create(`${ROOT}/Заметки/N.md`, taskNote('N', '- [ ] пункт заметки\n', 'note'));
    app.metadataCache.resolve();
    index.start();
    await index.whenReady();

    expect(index.getTasks().find((t) => t.id === 'A')?.checklist).toEqual({ done: 2, total: 3 });
    expect(index.getTasks().find((t) => t.id === 'B')?.checklist).toBeNull();
    // Только задачи получают прогресс.
    expect((index.getById('N') as { checklist?: unknown } | undefined)?.checklist).toBeUndefined();
  });

  it('изменение тела обновляет прогресс', async () => {
    const { app, index } = setup();
    const file = await app.vault.create(`${TASKS}/A.md`, taskNote('A', '- [ ] один\n- [ ] два\n'));
    app.metadataCache.resolve();
    index.start();
    await index.whenReady();
    expect(index.getTasks()[0]?.checklist).toEqual({ done: 0, total: 2 });

    await app.vault.modify(file, taskNote('A', '- [x] один\n- [x] два\n'));
    await tick();
    expect(index.getTasks()[0]?.checklist).toEqual({ done: 2, total: 2 });
  });
});

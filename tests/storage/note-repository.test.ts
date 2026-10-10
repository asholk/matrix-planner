import { beforeEach, describe, expect, it } from 'vitest';
import type { App } from 'obsidian';
import { createMockApp, MarkdownView, splitFrontmatter, type App as MockApp } from '../__mocks__/obsidian';
import type { WriteGuard } from '../../src/app/contracts';
import { bodyOf, buildNoteText, ObsidianNoteRepository, offsetToPosition, splitFrontmatterText } from '../../src/storage/note-repository';
import { createPlannerPaths } from '../../src/storage/paths';
import { KeyedWriteQueue } from '../../src/storage/write-queue';

const TASKS = 'Планировщик/Задачи';

function setup() {
  const app: MockApp = createMockApp();
  let writable = true;
  const guard: WriteGuard = {
    canWrite: () => writable,
    check: () => (writable ? null : { code: 'read-only', messageKey: 'storage.readOnly.newer' }),
  };
  const paths = createPlannerPaths('Планировщик');
  const repo = new ObsidianNoteRepository(app as unknown as App, {
    getPaths: () => paths,
    guard,
    queue: new KeyedWriteQueue(),
    untitled: () => 'Без названия',
  });
  return {
    app,
    repo,
    setWritable: (value: boolean) => {
      writable = value;
    },
  };
}

function text(app: MockApp, path: string): string {
  const value = app.vault.contents.get(path);
  if (typeof value !== 'string') throw new Error(`no file ${path}`);
  return value;
}

const NOTE = [
  '---',
  'type: task',
  'id: 01J0000000000000000000000A',
  'quadrant: do',
  'custom_field: оставить',
  'tags:',
  '  - работа',
  '---',
  '# Заголовок',
  '',
  'Текст с [[ссылкой]] и пробелами   ',
  '',
].join('\n');

describe('storage/note-repository', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  describe('вспомогательные функции', () => {
    it('разделяет свойства и тело', () => {
      const split = splitFrontmatterText(NOTE);
      expect(NOTE.slice(split.end)).toBe('# Заголовок\n\nТекст с [[ссылкой]] и пробелами   \n');
      expect(bodyOf('без свойств')).toBe('без свойств');
      expect(bodyOf('---\n---\nтело')).toBe('тело');
      expect(splitFrontmatterText('---\r\na: 1\r\n---\r\nтело').end).toBe(16);
    });

    it('строит текст заметки', () => {
      expect(buildNoteText({}, 'тело')).toBe('тело');
      const built = buildNoteText({ type: 'note', id: 'X' }, 'тело\n');
      expect(splitFrontmatter(built)).toMatchObject({ frontmatter: { type: 'note', id: 'X' }, body: 'тело\n' });
    });

    it('смещение → позиция', () => {
      expect(offsetToPosition('ab\ncd\ne', 4)).toEqual({ line: 1, ch: 1 });
      expect(offsetToPosition('ab', 0)).toEqual({ line: 0, ch: 0 });
    });
  });

  describe('создание', () => {
    it('создаёт заметку со свойствами и телом, создаёт папку', async () => {
      const result = await ctx.repo.create({ folder: TASKS, title: 'Позвонить', frontmatter: { type: 'task', id: 'A' }, body: 'Тело\n' });
      expect(result).toEqual({ ok: true, value: `${TASKS}/Позвонить.md`, changed: true });
      const split = splitFrontmatter(text(ctx.app, `${TASKS}/Позвонить.md`));
      expect(split.frontmatter).toEqual({ type: 'task', id: 'A' });
      expect(split.body).toBe('Тело\n');
    });

    it('санитизирует имя и добавляет суффикс при коллизии', async () => {
      const a = await ctx.repo.create({ folder: TASKS, title: 'Купить: молоко/хлеб?', frontmatter: {}, body: '' });
      const b = await ctx.repo.create({ folder: TASKS, title: 'Купить молоко хлеб', frontmatter: {}, body: '' });
      const c = await ctx.repo.create({ folder: TASKS, title: 'купить молоко хлеб', frontmatter: {}, body: '' });
      expect(a.ok && a.value).toBe(`${TASKS}/Купить молоко хлеб.md`);
      expect(b.ok && b.value).toBe(`${TASKS}/Купить молоко хлеб (2).md`);
      // Совпадение без учёта регистра — тоже коллизия (iCloud/Windows).
      expect(c.ok && c.value).toBe(`${TASKS}/купить молоко хлеб (3).md`);
    });

    it('пустое название → «Без названия»', async () => {
      const result = await ctx.repo.create({ folder: TASKS, title: '  ', frontmatter: {}, body: '' });
      expect(result.ok && result.value).toBe(`${TASKS}/Без названия.md`);
    });

    it('папка вне корня — ошибка', async () => {
      for (const folder of ['Другое', 'Планировщик/../Другое', '../Планировщик']) {
        const result = await ctx.repo.create({ folder, title: 'X', frontmatter: {}, body: '' });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe('outside-root');
      }
      expect(ctx.app.vault.getFileByPath('Другое/X.md')).toBeNull();
    });

    it('сбой записи → write-failed', async () => {
      ctx.app.vault.failNextWrite(`${TASKS}/A.md`);
      await ctx.repo.ensureFolder(TASKS);
      const result = await ctx.repo.create({ folder: TASKS, title: 'A', frontmatter: {}, body: '' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('write-failed');
    });
  });

  describe('свойства', () => {
    it('сохраняет тело и чужие свойства', async () => {
      await ctx.app.vault.create(`${TASKS}/A.md`, NOTE);
      const result = await ctx.repo.updateFrontmatter(`${TASKS}/A.md`, (fm) => {
        fm['quadrant'] = 'plan';
      });
      expect(result).toEqual({ ok: true, value: undefined, changed: true });
      const after = text(ctx.app, `${TASKS}/A.md`);
      const split = splitFrontmatter(after);
      expect(split.frontmatter).toEqual({
        type: 'task',
        id: '01J0000000000000000000000A',
        quadrant: 'plan',
        custom_field: 'оставить',
        tags: ['работа'],
      });
      expect(split.body).toBe(bodyOf(NOTE));
    });

    it('без изменений → changed: false', async () => {
      await ctx.app.vault.create(`${TASKS}/A.md`, NOTE);
      const result = await ctx.repo.updateFrontmatter(`${TASKS}/A.md`, (fm) => {
        fm['quadrant'] = 'do';
      });
      expect(result.ok && result.changed).toBe(false);
    });

    it('нет файла → not-found', async () => {
      const result = await ctx.repo.updateFrontmatter(`${TASKS}/Нет.md`, () => undefined);
      expect(!result.ok && result.error.code).toBe('not-found');
    });
  });

  describe('тело', () => {
    it('меняет только тело, блок свойств остаётся байт в байт', async () => {
      await ctx.app.vault.create(`${TASKS}/A.md`, NOTE);
      const fmBlock = NOTE.slice(0, splitFrontmatterText(NOTE).end);
      const result = await ctx.repo.updateBody(`${TASKS}/A.md`, (body) => `${body}Новая строка\n`);
      expect(result.ok && result.changed).toBe(true);
      const after = text(ctx.app, `${TASKS}/A.md`);
      expect(after.startsWith(fmBlock)).toBe(true);
      expect(after.slice(fmBlock.length)).toBe(`${bodyOf(NOTE)}Новая строка\n`);
      const read = await ctx.repo.readBody(`${TASKS}/A.md`);
      expect(read.ok && read.value).toBe(`${bodyOf(NOTE)}Новая строка\n`);
    });

    it('активная заметка меняется через редактор, несохранённый ввод не теряется', async () => {
      const file = await ctx.app.vault.create(`${TASKS}/A.md`, NOTE);
      const leaf = ctx.app.workspace.getLeaf();
      await leaf.openFile(file);
      const view = leaf.view as MarkdownView;
      view.editor.setValue(`${NOTE}несохранённый ввод\n`);

      const result = await ctx.repo.updateBody(`${TASKS}/A.md`, (body) => `${body}из формы\n`);
      expect(result.ok && result.changed).toBe(true);
      expect(view.editor.getValue()).toBe(`${NOTE}несохранённый ввод\nиз формы\n`);
      // Файл на диске не перезаписан в обход редактора.
      expect(text(ctx.app, `${TASKS}/A.md`)).toBe(NOTE);

      const read = await ctx.repo.readBody(`${TASKS}/A.md`);
      expect(read.ok && read.value).toBe(`${bodyOf(NOTE)}несохранённый ввод\nиз формы\n`);
    });
  });

  describe('переименование и перенос', () => {
    it('переименовывает с суффиксом при коллизии', async () => {
      await ctx.app.vault.create(`${TASKS}/A.md`, NOTE);
      await ctx.app.vault.create(`${TASKS}/B.md`, '');
      const result = await ctx.repo.rename(`${TASKS}/A.md`, 'B');
      expect(result.ok && result.value).toBe(`${TASKS}/B (2).md`);
      expect(text(ctx.app, `${TASKS}/B (2).md`)).toBe(NOTE);
    });

    it('то же название → changed: false', async () => {
      await ctx.app.vault.create(`${TASKS}/A.md`, NOTE);
      const result = await ctx.repo.rename(`${TASKS}/A.md`, 'A');
      expect(result).toEqual({ ok: true, value: `${TASKS}/A.md`, changed: false });
    });

    it('переносит в архив, создавая папку', async () => {
      await ctx.app.vault.create(`${TASKS}/A.md`, NOTE);
      const result = await ctx.repo.move(`${TASKS}/A.md`, `${TASKS}/Архив/2026-10`);
      expect(result.ok && result.value).toBe(`${TASKS}/Архив/2026-10/A.md`);
      expect(ctx.app.vault.getFileByPath(`${TASKS}/A.md`)).toBeNull();
    });

    it('перенос за корень запрещён', async () => {
      await ctx.app.vault.create(`${TASKS}/A.md`, NOTE);
      const result = await ctx.repo.move(`${TASKS}/A.md`, 'Другое');
      expect(!result.ok && result.error.code).toBe('outside-root');
    });
  });

  describe('удаление', () => {
    it('через корзину', async () => {
      await ctx.app.vault.create(`${TASKS}/A.md`, NOTE);
      const result = await ctx.repo.trash(`${TASKS}/A.md`);
      expect(result.ok).toBe(true);
      expect(ctx.app.vault.trashed.get(`${TASKS}/A.md`)).toBe(NOTE);
      expect(ctx.repo.exists(`${TASKS}/A.md`)).toBe(false);
    });

    it('нет файла → not-found', async () => {
      const result = await ctx.repo.trash(`${TASKS}/A.md`);
      expect(!result.ok && result.error.code).toBe('not-found');
    });
  });

  describe('только чтение', () => {
    it('пишущие операции возвращают read-only и ничего не меняют', async () => {
      await ctx.app.vault.create(`${TASKS}/A.md`, NOTE);
      ctx.setWritable(false);
      const results = [
        await ctx.repo.create({ folder: TASKS, title: 'B', frontmatter: {}, body: '' }),
        await ctx.repo.updateFrontmatter(`${TASKS}/A.md`, (fm) => {
          fm['quadrant'] = 'plan';
        }),
        await ctx.repo.updateBody(`${TASKS}/A.md`, () => 'x'),
        await ctx.repo.rename(`${TASKS}/A.md`, 'C'),
        await ctx.repo.move(`${TASKS}/A.md`, `${TASKS}/Архив`),
        await ctx.repo.trash(`${TASKS}/A.md`),
        await ctx.repo.ensureFolder(`${TASKS}/Новая`),
        await ctx.repo.writeBinary('Планировщик/Обои/p/lock.png', new ArrayBuffer(4)),
      ];
      for (const result of results) {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('read-only');
          expect(result.error.messageKey).toBe('storage.readOnly.newer');
        }
      }
      expect(text(ctx.app, `${TASKS}/A.md`)).toBe(NOTE);
      expect(ctx.app.vault.getFileByPath(`${TASKS}/B.md`)).toBeNull();
      // Чтение разрешено.
      const read = await ctx.repo.readBody(`${TASKS}/A.md`);
      expect(read.ok).toBe(true);
    });
  });

  describe('папки и бинарные файлы', () => {
    it('ensureFolder идемпотентен', async () => {
      const first = await ctx.repo.ensureFolder(`${TASKS}/Архив/2026-10`);
      const second = await ctx.repo.ensureFolder(`${TASKS}/Архив/2026-10`);
      expect(first.ok && first.changed).toBe(true);
      expect(second.ok && second.changed).toBe(false);
    });

    it('listFolder возвращает прямых потомков', async () => {
      await ctx.app.vault.create(`${TASKS}/B.md`, '');
      await ctx.app.vault.create(`${TASKS}/A.md`, '');
      await ctx.app.vault.create(`${TASKS}/Архив/2026-10/C.md`, '');
      const result = await ctx.repo.listFolder(TASKS);
      expect(result.ok && result.value).toEqual({ files: [`${TASKS}/A.md`, `${TASKS}/B.md`], folders: [`${TASKS}/Архив`] });
    });

    it('writeBinary создаёт, затем изменяет файл', async () => {
      const path = 'Планировщик/Обои/iphone/lock.png';
      expect((await ctx.repo.writeBinary(path, new Uint8Array([1, 2]).buffer)).ok).toBe(true);
      expect((await ctx.repo.writeBinary(path, new Uint8Array([3, 4, 5]).buffer)).ok).toBe(true);
      const read = await ctx.repo.readBinary(path);
      expect(read.ok && new Uint8Array(read.value)).toEqual(new Uint8Array([3, 4, 5]));
    });
  });
});

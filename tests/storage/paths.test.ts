import { describe, expect, it } from 'vitest';
import {
  createPlannerPaths,
  isInsideRoot,
  MAX_FILE_TITLE_LENGTH,
  resolveInsideRoot,
  resolveRootFolder,
  sanitizeFileName,
  titleFromPath,
  uniqueFilePath,
  validateRootFolder,
} from '../../src/storage/paths';

describe('storage/paths', () => {
  describe('корневая папка', () => {
    it('нормализует путь', () => {
      expect(validateRootFolder('Планировщик/')).toEqual({ ok: true, root: 'Планировщик' });
      expect(validateRootFolder('/Работа//Планировщик/')).toEqual({ ok: true, root: 'Работа/Планировщик' });
      expect(validateRootFolder('Работа\\Планы')).toEqual({ ok: true, root: 'Работа/Планы' });
    });

    it('отклоняет корень хранилища, выход наверх и скрытые папки', () => {
      expect(validateRootFolder('')).toEqual({ ok: false, reason: 'empty' });
      expect(validateRootFolder('/')).toEqual({ ok: false, reason: 'empty' });
      expect(validateRootFolder('../Чужое')).toEqual({ ok: false, reason: 'parent' });
      expect(validateRootFolder('A/../B')).toEqual({ ok: false, reason: 'parent' });
      expect(validateRootFolder('.hidden')).toEqual({ ok: false, reason: 'hidden' });
      expect(validateRootFolder('A/B:C')).toEqual({ ok: false, reason: 'invalid-chars' });
    });

    it('некорректная настройка → папка по умолчанию', () => {
      expect(resolveRootFolder('../x')).toBe('Планировщик');
      expect(resolveRootFolder(undefined)).toBe('Планировщик');
      expect(resolveRootFolder('Мои планы')).toBe('Мои планы');
    });
  });

  describe('ограничение корнем', () => {
    const root = 'Планировщик';

    it('пути внутри корня', () => {
      expect(isInsideRoot('Планировщик', root)).toBe(true);
      expect(isInsideRoot('Планировщик/Задачи/A.md', root)).toBe(true);
      expect(isInsideRoot('/Планировщик//Задачи/A.md', root)).toBe(true);
      expect(isInsideRoot('Планировщик\\Задачи\\A.md', root)).toBe(true);
    });

    it('выход за корень', () => {
      expect(isInsideRoot('Другое/A.md', root)).toBe(false);
      expect(isInsideRoot('Планировщик2/A.md', root)).toBe(false);
      expect(isInsideRoot('Планировщик/../Другое/A.md', root)).toBe(false);
      expect(isInsideRoot('Планировщик/./A.md', root)).toBe(false);
      expect(isInsideRoot('matrix-planner.md', root)).toBe(false);
      expect(isInsideRoot('', root)).toBe(false);
    });

    it('resolveInsideRoot возвращает нормализованный путь или null', () => {
      expect(resolveInsideRoot('/Планировщик/Задачи/', root)).toBe('Планировщик/Задачи');
      expect(resolveInsideRoot('Планировщик/../x', root)).toBeNull();
    });
  });

  describe('имя файла', () => {
    it('заменяет недопустимые символы', () => {
      expect(sanitizeFileName('Купить: молоко/хлеб?', 'Без названия')).toBe('Купить молоко хлеб');
      expect(sanitizeFileName('a\\b*c"d<e>f|g#h^i[j]k', 'x')).toBe('a b c d e f g h i j k');
      expect(sanitizeFileName('  много   пробелов  ', 'x')).toBe('много пробелов');
    });

    it('убирает ведущие точки и замыкающие точки/пробелы', () => {
      expect(sanitizeFileName('..скрытый', 'x')).toBe('скрытый');
      expect(sanitizeFileName('Конец. . ', 'x')).toBe('Конец');
    });

    it('пустое название → значение по умолчанию', () => {
      expect(sanitizeFileName('', 'Без названия')).toBe('Без названия');
      expect(sanitizeFileName('###', 'Без названия')).toBe('Без названия');
      expect(sanitizeFileName('...', '')).toBe('Untitled');
    });

    it('ограничивает длину и обходит зарезервированные имена', () => {
      const long = 'я'.repeat(500);
      expect(sanitizeFileName(long, 'x')).toHaveLength(MAX_FILE_TITLE_LENGTH);
      expect(sanitizeFileName('CON', 'x')).toBe('CON_');
    });

    it('название из пути', () => {
      expect(titleFromPath('Планировщик/Задачи/Позвонить.md')).toBe('Позвонить');
      expect(titleFromPath('A.png')).toBe('A.png');
    });
  });

  describe('коллизии имён', () => {
    it('добавляет суффикс (2), (3)', () => {
      const taken = new Set(['F/A.md', 'F/A (2).md']);
      expect(uniqueFilePath('F', 'A', '.md', (p) => taken.has(p))).toBe('F/A (3).md');
      expect(uniqueFilePath('F', 'B', '.md', (p) => taken.has(p))).toBe('F/B.md');
    });
  });

  describe('пути Планировщика', () => {
    it('строит пути от корня', () => {
      const paths = createPlannerPaths('Планировщик');
      expect(paths.root).toBe('Планировщик');
      expect(paths.marker).toBe('matrix-planner.md');
      expect(paths.tasks).toBe('Планировщик/Задачи');
      expect(paths.archiveRoot).toBe('Планировщик/Задачи/Архив');
      expect(paths.archiveFor('2026-10')).toBe('Планировщик/Задачи/Архив/2026-10');
      expect(paths.events).toBe('Планировщик/События');
      expect(paths.deletedEvents).toBe('Планировщик/События/Удалённые');
      expect(paths.notes).toBe('Планировщик/Заметки');
      expect(paths.matrix).toBe('Планировщик/Матрица.md');
      expect(paths.system).toBe('Планировщик/_system');
      expect(paths.systemFile('tombstones.json')).toBe('Планировщик/_system/tombstones.json');
      expect(paths.wallpaperProfile('iphone-1179x2556')).toBe('Планировщик/Обои/iphone-1179x2556');
    });

    it('вложенный корень', () => {
      expect(createPlannerPaths('Работа/План/').tasks).toBe('Работа/План/Задачи');
    });
  });
});

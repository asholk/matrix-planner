/**
 * Эталонное хранилище для приёмочных тестов (ТЗ §10).
 *
 * Дата — 10.10.2026, 13:40 по Москве (Europe/Moscow, UTC+3 без перехода на летнее время).
 * Задачи и событие — как на кадрах видео (разбор ТЗ); повторяющиеся задачи — для критерия 8
 * (31 января и 29 февраля); генератор — набор на 1 000 задач для замера.
 *
 * Свойства пишутся в форме YAML из docs/contracts.md. Значения сериализуются через
 * `JSON.stringify` — это корректный поток YAML, а даты в кавычках не превращаются в timestamp.
 */

import { createMockApp, type App as MockApp } from '../__mocks__/obsidian';
import type { Clock } from '../../src/app/contracts';
import type { EventProperties, LocalDateString, NoteProperties, TaskProperties } from '../../src/model/types';

export const REFERENCE_ROOT = 'Планировщик';
export const REFERENCE_TIME_ZONE = 'Europe/Moscow';
export const REFERENCE_TODAY: LocalDateString = '2026-10-10';
export const REFERENCE_TOMORROW: LocalDateString = '2026-10-11';
/** Локальное время «сейчас» в эталоне. */
export const REFERENCE_NOW_LOCAL = '2026-10-10T13:40';
export const REFERENCE_VAULT_NAME = 'Эталон';

const TASKS_DIR = `${REFERENCE_ROOT}/Задачи`;
const EVENTS_DIR = `${REFERENCE_ROOT}/События`;
const NOTES_DIR = `${REFERENCE_ROOT}/Заметки`;

/** Смещение Москвы от UTC, часы. */
const MOSCOW_OFFSET_HOURS = 3;

/** Момент по локальному московскому времени `YYYY-MM-DDTHH:mm`. */
export function moscowInstant(local: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match) throw new Error(`Неверное локальное время: ${local}`);
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  return new Date(Date.UTC(y, mo - 1, d, h - MOSCOW_OFFSET_HOURS, mi));
}

/** Часы эталона; время можно переставить (сценарии повторов в другие даты). */
export class ReferenceClock implements Clock {
  private current: Date = moscowInstant(REFERENCE_NOW_LOCAL);

  now(): Date {
    return new Date(this.current.getTime());
  }

  timeZone(): string {
    return REFERENCE_TIME_ZONE;
  }

  /** Переставить «сейчас» на локальное московское время. */
  setLocal(local: string): void {
    this.current = moscowInstant(local);
  }

  reset(): void {
    this.current = moscowInstant(REFERENCE_NOW_LOCAL);
  }
}

// ---------------------------------------------------------------------------
// Идентификаторы
// ---------------------------------------------------------------------------

/** Детерминированный ULID: префикс из 4 символов + номер в 22 цифры (цифры входят в алфавит Crockford). */
function fixtureId(prefix: string, n: number): string {
  return `${prefix}${String(n).padStart(22, '0')}`;
}

export const REFERENCE_IDS = {
  dentist: fixtureId('01JR', 1),
  cooking: fixtureId('01JR', 2),
  dancing: fixtureId('01JR', 3),
  dentistLukerya: fixtureId('01JR', 4),
  khrum: fixtureId('01JR', 5),
  avito: fixtureId('01JR', 6),
  document: fixtureId('01JR', 7),
  taxes: fixtureId('01JR', 8),
  concert: fixtureId('01JR', 20),
  concertNote: fixtureId('01JR', 30),
  monthly: fixtureId('01JR', 40),
  yearly: fixtureId('01JR', 41),
} as const;

// ---------------------------------------------------------------------------
// Сериализация
// ---------------------------------------------------------------------------

export interface FixtureFile {
  path: string;
  content: string;
}

function noteText(props: object, body = ''): string {
  const lines = Object.entries(props).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

type TaskInput = Partial<Omit<TaskProperties, 'type' | 'id'>> & Pick<TaskProperties, 'id' | 'quadrant'>;

function taskProps(input: TaskInput): TaskProperties {
  return {
    type: 'task',
    id: input.id,
    quadrant: input.quadrant,
    due: input.due ?? null,
    repeat: input.repeat ?? 'none',
    repeat_anchor: input.repeat_anchor ?? null,
    remind: input.remind ?? 'none',
    priority: input.priority ?? 'normal',
    duration: null,
    done: input.done ?? false,
    completed: input.completed ?? null,
    completions: input.completions ?? [],
    created: input.created ?? '2026-10-01T10:00',
  };
}

function taskFile(title: string, input: TaskInput, body = ''): FixtureFile {
  return { path: `${TASKS_DIR}/${title}.md`, content: noteText(taskProps(input), body) };
}

// ---------------------------------------------------------------------------
// Эталонные элементы
// ---------------------------------------------------------------------------

export interface ReferenceTaskSpec {
  id: string;
  title: string;
  quadrant: TaskProperties['quadrant'];
}

/** Задачи с кадров видео. Название «Оформить документ о ст…» на кадре обрезано — дописано условно. */
export const REFERENCE_TASKS: readonly FixtureFile[] = [
  taskFile('Стоматолог', {
    id: REFERENCE_IDS.dentist,
    quadrant: 'do',
    due: `${REFERENCE_TOMORROW}T09:00`,
    repeat_anchor: REFERENCE_TOMORROW,
    remind: '15m',
    created: '2026-10-08T09:00',
  }),
  taskFile('Кулинария', {
    id: REFERENCE_IDS.cooking,
    quadrant: 'do',
    due: `${REFERENCE_TOMORROW}T12:30`,
    created: '2026-10-08T09:05',
  }),
  taskFile('Танцы', {
    id: REFERENCE_IDS.dancing,
    quadrant: 'do',
    due: `${REFERENCE_TODAY}T13:00`,
    done: true,
    completed: `${REFERENCE_TODAY}T13:31`,
    created: '2026-10-08T09:10',
  }),
  taskFile('Стоматолог Лукерья', {
    id: REFERENCE_IDS.dentistLukerya,
    quadrant: 'plan',
    due: '2026-10-16T15:00',
    priority: 'high',
    created: '2026-10-08T09:15',
  }),
  taskFile('Хрум чудо-юдо', {
    id: REFERENCE_IDS.khrum,
    quadrant: 'urgent',
    due: `${REFERENCE_TODAY}T17:00`,
    priority: 'high',
    created: '2026-10-08T09:20',
  }),
  taskFile('Забрать Авито на почте', {
    id: REFERENCE_IDS.avito,
    quadrant: 'urgent',
    created: '2026-10-08T09:25',
  }),
  taskFile('Оформить документ о стаже', {
    id: REFERENCE_IDS.document,
    quadrant: 'someday',
    priority: 'high',
    created: '2026-10-08T09:30',
  }),
  taskFile('Оплатить налоги', {
    id: REFERENCE_IDS.taxes,
    quadrant: 'someday',
    created: '2026-10-08T09:35',
  }),
];

/** Ожидаемый порядок активных задач по квадрантам (ТЗ §4.2; «Танцы» выполнена). */
export const REFERENCE_QUADRANT_TITLES = {
  do: ['Стоматолог', 'Кулинария'],
  plan: ['Стоматолог Лукерья'],
  urgent: ['Хрум чудо-юдо', 'Забрать Авито на почте'],
  someday: ['Оформить документ о стаже', 'Оплатить налоги'],
} as const;

const concertProps: EventProperties = {
  type: 'event',
  id: REFERENCE_IDS.concert,
  start: '2026-10-21T09:00',
  end: '2026-10-21T10:00',
  all_day: false,
  tz: null,
  repeat: 'none',
  color: 'purple',
  icon: 'music',
  calendar_id: null,
  url: null,
};

export const REFERENCE_EVENTS: readonly FixtureFile[] = [{ path: `${EVENTS_DIR}/Концерт.md`, content: noteText(concertProps) }];

const concertNoteProps: NoteProperties = { type: 'note', id: REFERENCE_IDS.concertNote, date: '2026-10-21' };

export const REFERENCE_NOTES: readonly FixtureFile[] = [
  { path: `${NOTES_DIR}/Взять билеты.md`, content: noteText(concertNoteProps, 'Билеты в почте.\n') },
];

/**
 * Повторяющиеся задачи для критерия 8: ежемесячная от 31 января 2026 и ежегодная от 29 февраля 2028.
 * Подключаются отдельно: просроченная ежемесячная изменила бы порядок квадрантов эталона.
 */
export const RECURRING_TASKS: readonly FixtureFile[] = [
  taskFile('Ежемесячный отчёт', {
    id: REFERENCE_IDS.monthly,
    quadrant: 'plan',
    due: '2026-01-31T09:00',
    repeat: 'monthly',
    repeat_anchor: '2026-01-31',
    created: '2026-01-01T10:00',
  }),
  taskFile('День високосного года', {
    id: REFERENCE_IDS.yearly,
    quadrant: 'someday',
    due: '2028-02-29',
    repeat: 'yearly',
    repeat_anchor: '2028-02-29',
    created: '2026-01-01T10:00',
  }),
];

/** Маркер хранилища со схемой (по умолчанию текущей — 1). */
export function markerFile(schema = 1): FixtureFile {
  return { path: 'matrix-planner.md', content: `---\nroot: ${REFERENCE_ROOT}\nschema: ${schema}\nvault_id: REFERENCE-VAULT\nmigrating: false\n---\n` };
}

// ---------------------------------------------------------------------------
// Набор на 1 000 задач
// ---------------------------------------------------------------------------

const LOAD_QUADRANTS: readonly TaskProperties['quadrant'][] = ['do', 'plan', 'urgent', 'someday'];
const LOAD_REPEATS: readonly TaskProperties['repeat'][] = ['none', 'none', 'none', 'daily', 'weekly', 'monthly'];

function shiftDate(date: LocalDateString, days: number): LocalDateString {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return shifted.toISOString().slice(0, 10);
}

/**
 * Детерминированный набор задач: квадранты по кругу, сроки от −10 до +29 дней от эталонной даты,
 * у части — время, повтор, высокий приоритет; каждая седьмая без срока, каждая девятая выполнена.
 */
export function generateLoadTasks(count = 1000): FixtureFile[] {
  const files: FixtureFile[] = [];
  for (let i = 0; i < count; i++) {
    const noDue = i % 7 === 0;
    const date = shiftDate(REFERENCE_TODAY, (i % 40) - 10);
    const time = i % 3 === 0 ? null : `${String(8 + (i % 12)).padStart(2, '0')}:${i % 2 === 0 ? '00' : '30'}`;
    const repeat = noDue ? 'none' : LOAD_REPEATS[i % LOAD_REPEATS.length];
    const done = repeat === 'none' && i % 9 === 0;
    files.push(
      taskFile(`Нагрузка ${String(i + 1).padStart(4, '0')}`, {
        id: fixtureId('01JS', i + 1),
        quadrant: LOAD_QUADRANTS[i % LOAD_QUADRANTS.length],
        due: noDue ? null : time ? `${date}T${time}` : date,
        repeat,
        repeat_anchor: repeat === 'none' || noDue ? null : date,
        priority: i % 5 === 0 ? 'high' : 'normal',
        done,
        completed: done ? `${REFERENCE_TODAY}T09:00` : null,
        created: `2026-09-${String(1 + (i % 28)).padStart(2, '0')}T10:00`,
      }),
    );
  }
  return files;
}

// ---------------------------------------------------------------------------
// Сборка мок-хранилища
// ---------------------------------------------------------------------------

export interface ReferenceVaultOptions {
  /** Добавить повторяющиеся задачи критерия 8. */
  recurring?: boolean;
  /** Добавить N сгенерированных задач. */
  loadTasks?: number;
  /** Схема маркера (`2` — новее поддерживаемой, режим только чтения). */
  schema?: number;
  /** Без эталонных задач, события и заметки (только маркер и дополнительные наборы). */
  empty?: boolean;
}

export function referenceFiles(options: ReferenceVaultOptions = {}): FixtureFile[] {
  const files: FixtureFile[] = [markerFile(options.schema ?? 1)];
  if (!options.empty) files.push(...REFERENCE_TASKS, ...REFERENCE_EVENTS, ...REFERENCE_NOTES);
  if (options.recurring) files.push(...RECURRING_TASKS);
  if (options.loadTasks) files.push(...generateLoadTasks(options.loadTasks));
  return files;
}

/**
 * Мок-приложение с эталонным хранилищем: файлы записываются до индексации,
 * затем `metadataCache.resolve()` моделирует холодный старт Obsidian.
 */
export function createReferenceApp(options: ReferenceVaultOptions = {}): MockApp {
  const app = createMockApp({ vaultName: REFERENCE_VAULT_NAME, resolved: false });
  for (const file of referenceFiles(options)) app.vault.writeRaw(file.path, file.content, true);
  app.metadataCache.resolve();
  return app;
}

/**
 * Модель вкладки «Задачи» (ТЗ §4.2). Чистый модуль: без `obsidian` и DOM.
 * Время, подписи дат и цвета матрицы передаются параметрами.
 */

import {
  QUADRANT_KEYS,
  type CompletionEntry,
  type FloatingDateTime,
  type IconName,
  type ItemId,
  type LocalDateString,
  type LocalTimeString,
  type MatrixConfig,
  type PlannerErrorCode,
  type QuadrantKey,
  type Task,
  type TasksLayout,
  type TasksListGrouping,
  type VaultPath,
} from '../model/types';
import { DEFAULT_QUADRANT_STYLE } from '../model/defaults';
import { parseFloating } from '../model/dates';
import { completionEntries, groupTasksByDate, groupTasksByQuadrant, isTaskOverdue } from '../model/task-selectors';

// ---------------------------------------------------------------------------
// Приветствие
// ---------------------------------------------------------------------------

export type GreetingKind = 'morning' | 'afternoon' | 'evening';

/** 05:00–11:59 — утро, 12:00–17:59 — день, иначе вечер (ночью тоже «Добрый вечер»). */
export function greetingFor(hour: number): GreetingKind {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  return 'evening';
}

// ---------------------------------------------------------------------------
// Модель
// ---------------------------------------------------------------------------

export type TasksMode = 'active' | 'done';

/** Форматирование подписей (тексты — у вызывающего). */
export interface TaskLabelFormat {
  /** Относительный срок: «Сегодня 17:00», «16 окт. 15:00» (`formatDueLabel`). */
  due(due: FloatingDateTime, today: LocalDateString): string;
  /** Дата выполнения: «10 окт. 2026 г., 13:31»; `time === null` — только дата. */
  completed(date: LocalDateString, time: LocalTimeString | null): string;
}

export interface TaskCardModel {
  /** Уникальный ключ карточки (у повторений в «Выполнено» — с датой). */
  key: string;
  taskId: ItemId;
  path: VaultPath;
  title: string;
  quadrant: QuadrantKey;
  highPriority: boolean;
  recurring: boolean;
  /** Подпись срока (активный режим); `null` — без срока. */
  dueLabel: string | null;
  overdue: boolean;
  done: boolean;
  /** Подпись даты выполнения (режим «Выполнено»). */
  completedLabel: string | null;
  /**
   * Дата повторения: у выполненной карточки — для `uncomplete`, у активной повторяющейся —
   * показанное повторение (срок) для `complete`; `null` — неповторяющаяся.
   */
  instanceDate: LocalDateString | null;
}

export interface QuadrantSection {
  key: QuadrantKey;
  title: string;
  icon: IconName;
  color: string;
  count: number;
  cards: TaskCardModel[];
}

export type DateSectionKind = 'overdue' | 'date' | 'no-date';

export interface DateSection {
  key: string;
  kind: DateSectionKind;
  date: LocalDateString | null;
  cards: TaskCardModel[];
}

export interface TasksViewInput {
  tasks: readonly Task[];
  matrix: MatrixConfig;
  now: FloatingDateTime;
  mode: TasksMode;
  layout: TasksLayout;
  grouping: TasksListGrouping;
  format: TaskLabelFormat;
}

export interface TasksViewModel {
  today: LocalDateString;
  mode: TasksMode;
  layout: TasksLayout;
  grouping: TasksListGrouping;
  /** Счётчик «Выполнено N»: каждое повторение отдельно. */
  doneCount: number;
  /** Сетка и список по квадрантам: всегда 4 квадранта, пустые тоже. */
  quadrants: QuadrantSection[];
  /** Список по датам. */
  dates: DateSection[];
  /** Нет ни одной карточки в текущем режиме. */
  empty: boolean;
}

/** Задачи для «Выполнено»: архив не показывается и не считается. */
function visibleForDone(tasks: readonly Task[]): Task[] {
  return tasks.filter((task) => !task.archived);
}

/** Счётчик «Выполнено N» (повторения считаются отдельно). */
export function countDone(tasks: readonly Task[]): number {
  return completionEntries(visibleForDone(tasks)).length;
}

export function activeCard(task: Task, now: FloatingDateTime, format: TaskLabelFormat): TaskCardModel {
  return {
    key: task.id,
    taskId: task.id,
    path: task.path,
    title: task.title,
    quadrant: task.quadrant,
    highPriority: task.priority === 'high',
    recurring: task.repeat !== 'none',
    dueLabel: task.due ? format.due(task.due, now.date) : null,
    overdue: isTaskOverdue(task, now),
    done: false,
    completedLabel: null,
    // Выполняем именно показанное повторение, даже если срок успеет сдвинуться.
    instanceDate: task.repeat !== 'none' ? (task.due?.date ?? null) : null,
  };
}

export function doneCard(task: Task, entry: CompletionEntry, format: TaskLabelFormat): TaskCardModel {
  const completedAt = parseFloating(entry.completedAt);
  return {
    key: `${task.id}@${entry.instanceDate ?? 'single'}`,
    taskId: task.id,
    path: task.path,
    title: task.title,
    quadrant: task.quadrant,
    highPriority: task.priority === 'high',
    recurring: task.repeat !== 'none',
    dueLabel: null,
    overdue: false,
    done: true,
    completedLabel: format.completed(entry.date, completedAt?.time ?? null),
    instanceDate: entry.instanceDate,
  };
}

function emptyQuadrantMap<T>(): Record<QuadrantKey, T[]> {
  const map = {} as Record<QuadrantKey, T[]>;
  for (const key of QUADRANT_KEYS) map[key] = [];
  return map;
}

/** Карточки «Выполнено»: сначала новые. */
export function buildDoneCards(tasks: readonly Task[], format: TaskLabelFormat): Array<{ card: TaskCardModel; date: LocalDateString }> {
  const visible = visibleForDone(tasks);
  const byId = new Map<ItemId, Task>();
  for (const task of visible) if (!byId.has(task.id)) byId.set(task.id, task);
  const result: Array<{ card: TaskCardModel; date: LocalDateString }> = [];
  for (const entry of completionEntries(visible)) {
    const task = byId.get(entry.taskId);
    if (task) result.push({ card: doneCard(task, entry, format), date: entry.date });
  }
  return result;
}

export function buildTasksView(input: TasksViewInput): TasksViewModel {
  const { tasks, matrix, now, mode, format } = input;
  const byQuadrant = emptyQuadrantMap<TaskCardModel>();
  let dates: DateSection[] = [];

  if (mode === 'active') {
    const groups = groupTasksByQuadrant(tasks, now);
    for (const key of QUADRANT_KEYS) byQuadrant[key] = groups[key].map((task) => activeCard(task, now, format));
    if (input.layout === 'list' && input.grouping === 'date') {
      dates = groupTasksByDate(tasks, now).map((group) => ({
        key: group.kind === 'date' ? group.date : group.kind,
        kind: group.kind,
        date: group.kind === 'date' ? group.date : null,
        cards: group.tasks.map((task) => activeCard(task, now, format)),
      }));
    }
  } else {
    const done = buildDoneCards(tasks, format);
    for (const { card } of done) byQuadrant[card.quadrant].push(card);
    if (input.layout === 'list' && input.grouping === 'date') {
      // Группы по дате выполнения, сначала новые (порядок уже задан `completionEntries`).
      const map = new Map<LocalDateString, TaskCardModel[]>();
      for (const { card, date } of done) {
        const list = map.get(date);
        if (list) list.push(card);
        else map.set(date, [card]);
      }
      dates = [...map.entries()].map(([date, cards]) => ({ key: date, kind: 'date' as const, date, cards }));
    }
  }

  const quadrants: QuadrantSection[] = QUADRANT_KEYS.map((key) => {
    const config = matrix.byKey[key];
    return {
      key,
      title: config?.title ?? key,
      icon: config?.icon ?? DEFAULT_QUADRANT_STYLE[key].icon,
      color: config?.color ?? DEFAULT_QUADRANT_STYLE[key].color,
      count: byQuadrant[key].length,
      cards: byQuadrant[key],
    };
  });

  return {
    today: now.date,
    mode,
    layout: input.layout,
    grouping: input.grouping,
    doneCount: countDone(tasks),
    quadrants,
    dates,
    empty: quadrants.every((section) => section.count === 0),
  };
}

// ---------------------------------------------------------------------------
// Цвета квадрантов из «Матрица.md»
// ---------------------------------------------------------------------------

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * Переопределения CSS-переменных `--mp-q-<key>` и `--mp-q-<key>-bg` для цветов,
 * отличных от значений по умолчанию. Фон — смесь цвета с фоном темы (работает в светлой и тёмной).
 */
export function quadrantColorOverrides(matrix: MatrixConfig): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const key of QUADRANT_KEYS) {
    const color = matrix.byKey[key]?.color;
    if (!color || !HEX_COLOR.test(color)) continue;
    if (color.toLowerCase() === DEFAULT_QUADRANT_STYLE[key].color.toLowerCase()) continue;
    vars[`--mp-q-${key}`] = color;
    vars[`--mp-q-${key}-bg`] = `color-mix(in srgb, ${color} 14%, var(--background-primary))`;
  }
  return vars;
}

/** Все имена переменных квадрантов (для сброса прежних переопределений). */
export const QUADRANT_CSS_VARS: readonly string[] = QUADRANT_KEYS.flatMap((key) => [`--mp-q-${key}`, `--mp-q-${key}-bg`]);

// ---------------------------------------------------------------------------
// Меню карточки
// ---------------------------------------------------------------------------

export type TaskMenuAction =
  | { kind: 'open-note' }
  | { kind: 'move'; quadrant: QuadrantKey }
  | { kind: 'postpone' }
  | { kind: 'uncomplete' }
  | { kind: 'delete' };

export interface TaskMenuItem {
  action: TaskMenuAction;
  /** Ключ i18n подписи. */
  labelKey: string;
  /** Параметры подписи (название квадранта). */
  labelParams?: Record<string, string>;
  icon: IconName;
  section: 'open' | 'move' | 'schedule' | 'danger';
  warning: boolean;
}

/**
 * Пункты меню (долгое нажатие / ПКМ / кнопка действий): «Открыть заметку»,
 * «Перенести в квадрант» (кроме текущего), «Перенести на завтра», «Удалить».
 * В «Выполнено» — «Открыть заметку», «Вернуть в работу», «Удалить».
 */
export function buildTaskMenu(card: Pick<TaskCardModel, 'quadrant' | 'done'>, matrix: MatrixConfig): TaskMenuItem[] {
  const items: TaskMenuItem[] = [
    { action: { kind: 'open-note' }, labelKey: 'tasks.menu.openNote', icon: 'file-text', section: 'open', warning: false },
  ];
  if (card.done) {
    items.push({ action: { kind: 'uncomplete' }, labelKey: 'tasks.menu.uncomplete', icon: 'rotate-ccw', section: 'schedule', warning: false });
  } else {
    for (const key of QUADRANT_KEYS) {
      if (key === card.quadrant) continue;
      const config = matrix.byKey[key];
      items.push({
        action: { kind: 'move', quadrant: key },
        labelKey: 'tasks.menu.moveTo',
        labelParams: { quadrant: config?.title ?? key },
        icon: config?.icon ?? DEFAULT_QUADRANT_STYLE[key].icon,
        section: 'move',
        warning: false,
      });
    }
    items.push({ action: { kind: 'postpone' }, labelKey: 'tasks.menu.postpone', icon: 'calendar-clock', section: 'schedule', warning: false });
  }
  items.push({ action: { kind: 'delete' }, labelKey: 'tasks.menu.delete', icon: 'trash-2', section: 'danger', warning: true });
  return items;
}

// ---------------------------------------------------------------------------
// Ошибки операций
// ---------------------------------------------------------------------------

const ERROR_KEYS: Record<PlannerErrorCode, string> = {
  'not-found': 'common.errors.notFound',
  'read-only': 'common.errors.readOnly',
  stale: 'common.errors.stale',
  invalid: 'common.errors.invalid',
  'outside-root': 'common.errors.outsideRoot',
  'write-failed': 'common.errors.writeFailed',
  'trash-failed': 'common.errors.trashFailed',
  'tombstone-failed': 'common.errors.tombstoneFailed',
  'not-ready': 'common.errors.notReady',
  unsupported: 'common.errors.unsupported',
  unknown: 'common.errors.unknown',
};

/** Ключ сообщения об ошибке: собственный `messageKey` или общий по коду. */
export function errorMessageKey(error: { code: PlannerErrorCode; messageKey?: string }): string {
  return error.messageKey ?? ERROR_KEYS[error.code] ?? ERROR_KEYS.unknown;
}

// ---------------------------------------------------------------------------
// Подпись для экранного диктора
// ---------------------------------------------------------------------------

export interface CardLabelStrings {
  label(title: string): string;
  quadrant(title: string): string;
  highPriority: string;
  repeat: string;
  overdue: string;
  noDue: string;
  notDone: string;
  done: string;
}

/** «Задача „Стоматолог“, Завтра 9:00, квадрант „Важно и срочно“, не выполнена». */
export function cardAriaLabel(card: TaskCardModel, quadrantTitle: string, strings: CardLabelStrings): string {
  const parts = [strings.label(card.title)];
  if (card.done) {
    if (card.completedLabel) parts.push(card.completedLabel);
  } else {
    parts.push(card.dueLabel ?? strings.noDue);
    if (card.overdue) parts.push(strings.overdue);
  }
  parts.push(strings.quadrant(quadrantTitle));
  if (card.highPriority) parts.push(strings.highPriority);
  if (card.recurring) parts.push(strings.repeat);
  parts.push(card.done ? strings.done : strings.notDone);
  return parts.join(', ');
}


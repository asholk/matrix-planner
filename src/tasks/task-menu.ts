/**
 * Меню действий задачи (ТЗ §4.2): «Открыть заметку», «Перенести в квадрант «…»» ×3,
 * «Перенести на завтра», «Удалить» (выполненная — «Вернуть в работу»). Общее для карточек
 * вкладки «Задачи» и задач на вкладке «Календарь»; пункты строит `buildTaskMenu`.
 */

import { Menu } from 'obsidian';
import type { TaskService } from '../app/contracts';
import type { ItemId, LocalDateString, MatrixConfig, OpResult, QuadrantKey, VaultPath } from '../model/types';
import { interpolate, registerDictionary, t } from '../i18n';
import { ruTasks } from '../i18n/ru/tasks';
import { enTasks } from '../i18n/en/tasks';
import type { HapticKind } from '../ui/haptics';
import { buildTaskMenu, type TaskMenuAction } from './tasks-presenter';

registerDictionary('ru', 'tasks', ruTasks);
registerDictionary('en', 'tasks', enTasks);

export interface TaskMenuTarget {
  taskId: ItemId;
  path: VaultPath;
  quadrant: QuadrantKey;
  done: boolean;
  /** Дата выполненного повторения (для «Вернуть в работу»). */
  instanceDate: LocalDateString | null;
}

export interface TaskMenuDeps {
  tasks: Pick<TaskService, 'moveToQuadrant' | 'postponeToTomorrow' | 'uncomplete' | 'delete'>;
  matrix(): MatrixConfig;
  openNote(path: VaultPath): void;
  /** Выполнить операцию: ошибка — уведомление, успех с изменением — `successMessage`. */
  run(op: () => Promise<OpResult<unknown>>, successMessage?: string): void;
  /**
   * Перенос в квадрант и на завтра с «Вернуть» в уведомлении (вкладка «Задачи», доработка 006).
   * Без него — `run` с обычным уведомлением.
   */
  runUndoable?(action: UndoableMenuAction): void;
  /** Тактильный отклик на выбор пункта. */
  haptic?(kind: HapticKind): void;
}

/** Пункты меню, которые можно отменить «Вернуть». */
export type UndoableMenuAction = { kind: 'move'; quadrant: QuadrantKey; message: string } | { kind: 'postpone' };

/** Отклик на пункт меню. */
const MENU_HAPTICS: Record<TaskMenuAction['kind'], HapticKind> = {
  'open-note': 'tap',
  move: 'drop',
  postpone: 'drop',
  uncomplete: 'undo',
  delete: 'delete',
};

/** Добавляет пункты задачи в меню. */
export function addTaskMenuItems(menu: Menu, target: TaskMenuTarget, deps: TaskMenuDeps): void {
  for (const item of buildTaskMenu(target, deps.matrix())) {
    const title = item.labelParams ? interpolate(t(item.labelKey), item.labelParams) : t(item.labelKey);
    menu.addItem((menuItem) => {
      menuItem
        .setTitle(title)
        .setIcon(item.icon)
        .setSection(item.section)
        .setWarning(item.warning)
        .onClick(() => runTaskMenuAction(target, item.action, deps));
    });
  }
}

export function runTaskMenuAction(target: TaskMenuTarget, action: TaskMenuAction, deps: TaskMenuDeps): void {
  const { tasks } = deps;
  deps.haptic?.(MENU_HAPTICS[action.kind]);
  switch (action.kind) {
    case 'open-note':
      deps.openNote(target.path);
      return;
    case 'move': {
      const title = deps.matrix().byKey[action.quadrant]?.title ?? action.quadrant;
      const message = t('tasks.notices.moved', { quadrant: title });
      if (deps.runUndoable) deps.runUndoable({ kind: 'move', quadrant: action.quadrant, message });
      else deps.run(() => tasks.moveToQuadrant(target.taskId, action.quadrant), message);
      return;
    }
    case 'postpone':
      if (deps.runUndoable) deps.runUndoable({ kind: 'postpone' });
      else deps.run(() => tasks.postponeToTomorrow(target.taskId));
      return;
    case 'uncomplete':
      deps.run(() => tasks.uncomplete(target.taskId, target.instanceDate ?? undefined));
      return;
    case 'delete':
      deps.run(() => tasks.delete(target.taskId), t('tasks.notices.deleted'));
      return;
  }
}

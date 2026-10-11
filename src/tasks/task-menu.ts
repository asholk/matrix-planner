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
}

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
  switch (action.kind) {
    case 'open-note':
      deps.openNote(target.path);
      return;
    case 'move': {
      const title = deps.matrix().byKey[action.quadrant]?.title ?? action.quadrant;
      deps.run(() => tasks.moveToQuadrant(target.taskId, action.quadrant), t('tasks.notices.moved', { quadrant: title }));
      return;
    }
    case 'postpone':
      deps.run(() => tasks.postponeToTomorrow(target.taskId));
      return;
    case 'uncomplete':
      deps.run(() => tasks.uncomplete(target.taskId, target.instanceDate ?? undefined));
      return;
    case 'delete':
      deps.run(() => tasks.delete(target.taskId), t('tasks.notices.deleted'));
      return;
  }
}

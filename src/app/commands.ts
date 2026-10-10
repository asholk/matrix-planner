/**
 * Команды (ТЗ §4.7): без названия плагина и без сочетаний клавиш.
 * Команды ядра — `registerCoreCommands`; этапа 2 («Открыть календарь», «Создать событие» и др.) —
 * `registerPlannerCommands` из compose-planner.
 */

import type { App, Command } from 'obsidian';
import type { IntegrityService, NoteIndex, Notifier, PlannerActions, WallpaperStatusTracker } from './contracts';
import type { Task } from '../model/types';
import { QUADRANT_KEYS } from '../model/types';
import { t, tPlural } from '../i18n';
import type { TaskActions } from '../tasks/task-actions';

/** Минимум от `Plugin`, нужный для регистрации команд. */
export interface CommandHost {
  addCommand(command: Command): Command;
}

export interface CoreCommandDeps {
  app: App;
  actions: PlannerActions;
  taskActions: Pick<TaskActions, 'complete' | 'postponeToTomorrow'>;
  index: Pick<NoteIndex, 'getByPath'>;
  integrity: Pick<IntegrityService, 'check'>;
  notifier: Notifier;
}

/** Задача Планировщика в активной заметке (архивные не считаются). */
export function activePlannerTask(app: App, index: Pick<NoteIndex, 'getByPath'>): Task | null {
  const file = app.workspace.getActiveFile();
  if (!file) return null;
  const item = index.getByPath(file.path);
  if (!item || item.kind !== 'task' || item.archived) return null;
  return item;
}

/** Можно ли выполнить: одиночная — ещё не выполнена; повторяющаяся — есть срок текущего повторения. */
export function canCompleteTask(task: Task): boolean {
  return task.repeat === 'none' ? !task.done : task.due !== null;
}

/** Можно ли перенести на завтра: задача в работе. */
export function canPostponeTask(task: Task): boolean {
  return !task.done;
}

export function registerCoreCommands(host: CommandHost, deps: CoreCommandDeps): void {
  const { actions } = deps;

  host.addCommand({
    id: 'open-tasks',
    name: t('app.commands.openTasks'),
    icon: 'layout-grid',
    callback: () => void actions.showTab('tasks'),
  });

  host.addCommand({
    id: 'create-task',
    name: t('app.commands.createTask'),
    icon: 'circle-check',
    callback: () => actions.openTaskForm({ mode: 'create' }),
  });

  for (const quadrant of QUADRANT_KEYS) {
    host.addCommand({
      id: `create-task-${quadrant}`,
      name: t('app.commands.createTaskInQuadrant', { quadrant: t(`common.quadrants.${quadrant}`) }),
      icon: 'circle-check',
      callback: () => actions.openTaskForm({ mode: 'create', quadrant }),
    });
  }

  host.addCommand({
    id: 'complete-active-task',
    name: t('app.commands.completeActiveTask'),
    icon: 'check',
    checkCallback: (checking) => {
      const task = activePlannerTask(deps.app, deps.index);
      if (!task || !canCompleteTask(task)) return false;
      if (!checking) {
        void deps.taskActions.complete(task.id).then((result) => {
          if (result.ok && result.changed) deps.notifier.show(t('app.notices.taskCompleted'));
        });
      }
      return true;
    },
  });

  host.addCommand({
    id: 'postpone-active-task',
    name: t('app.commands.postponeActiveTask'),
    icon: 'calendar-clock',
    checkCallback: (checking) => {
      const task = activePlannerTask(deps.app, deps.index);
      if (!task || !canPostponeTask(task)) return false;
      if (!checking) void deps.taskActions.postponeToTomorrow(task.id);
      return true;
    },
  });

  host.addCommand({
    id: 'check-integrity',
    name: t('app.commands.checkIntegrity'),
    icon: 'shield-check',
    callback: async () => {
      const result = await deps.integrity.check();
      if (!result.ok) {
        deps.notifier.show(t('app.notices.integrityFailed'));
        return;
      }
      const count = result.value.items.length;
      deps.notifier.show(count === 0 ? t('app.notices.integrityClean') : tPlural('app.notices.integrityFound', count));
    },
  });
}

export interface PlannerCommandDeps {
  actions: PlannerActions;
  wallpaperStatus: Pick<WallpaperStatusTracker, 'getState' | 'run'>;
}

/** Команды этапа 2: календарь, экран блокировки, событие, заметка, обновление обоев. */
export function registerPlannerCommands(host: CommandHost, deps: PlannerCommandDeps): void {
  const { actions } = deps;

  host.addCommand({
    id: 'open-calendar',
    name: t('app.commands.openCalendar'),
    icon: 'calendar',
    callback: () => void actions.showTab('calendar'),
  });

  host.addCommand({
    id: 'open-lockscreen',
    name: t('app.commands.openLockscreen'),
    icon: 'smartphone',
    callback: () => void actions.showTab('lockscreen'),
  });

  host.addCommand({
    id: 'create-event',
    name: t('app.commands.createEvent'),
    icon: 'calendar-plus',
    callback: () => actions.openEventForm({ mode: 'create' }),
  });

  host.addCommand({
    id: 'create-note',
    name: t('app.commands.createNote'),
    icon: 'sticky-note',
    callback: () => actions.openNoteForm({ mode: 'create' }),
  });

  host.addCommand({
    id: 'update-lockscreen',
    name: t('app.commands.updateLockscreen'),
    icon: 'refresh-cw',
    // Синхронно: на iOS быстрая команда открывается в пределах жеста пользователя.
    callback: () => {
      if (deps.wallpaperStatus.getState().kind === 'rendering') return;
      void deps.wallpaperStatus.run();
    },
  });
}

export interface CalendarSyncCommandDeps {
  /** Ручная синхронизация с уведомлением о результате. */
  syncNow(): void;
}

/** «Синхронизировать календарь» (CalDAV, src/caldav). */
export function registerCalendarSyncCommand(host: CommandHost, deps: CalendarSyncCommandDeps): void {
  host.addCommand({
    id: 'sync-calendar',
    name: t('caldav.commands.sync'),
    icon: 'refresh-ccw',
    callback: () => deps.syncNow(),
  });
}

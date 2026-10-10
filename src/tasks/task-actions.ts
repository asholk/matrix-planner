/**
 * Действия с задачами для интерфейса (карточки, меню, форма, команды).
 *
 * Обёртка над `TaskService`/`ArchiveService`: показывает `Notice` (через `Notifier`)
 * с локализованным сообщением об ошибке или результате и возвращает исходный `OpResult`,
 * чтобы вызывающий мог, например, оставить форму открытой. Идемпотентный пропуск
 * (`changed: false`) сообщений не показывает.
 */

import type { ArchiveService, Notifier, TaskService } from '../app/contracts';
import type {
  ItemId,
  LocalDateString,
  OpResult,
  PlannerError,
  PlannerErrorCode,
  QuadrantKey,
  Task,
  TaskDraft,
  TaskPatch,
} from '../model/types';
import { hasTranslation, t, tPlural } from '../i18n';
import { registerTaskDictionaries } from './task-service';

registerTaskDictionaries();

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

/** Текст ошибки для пользователя: `messageKey`, иначе общий текст по коду. */
export function errorMessage(error: PlannerError): string {
  const key = error.messageKey && hasTranslation(error.messageKey) ? error.messageKey : ERROR_KEYS[error.code] ?? ERROR_KEYS.unknown;
  return t(key);
}

export interface TaskActionsDeps {
  tasks: TaskService;
  archive: ArchiveService;
  notifier: Notifier;
  /** Технические подробности ошибок (по умолчанию `console.error`). */
  log?(message: string, error: PlannerError): void;
}

export class TaskActions {
  constructor(private readonly deps: TaskActionsDeps) {}

  create(draft: TaskDraft): Promise<OpResult<Task | null>> {
    return this.report('create', this.deps.tasks.create(draft));
  }

  update(id: ItemId, patch: TaskPatch): Promise<OpResult> {
    return this.report('update', this.deps.tasks.update(id, patch));
  }

  /** Без сообщения при успехе: отклик даёт анимация карточки. */
  complete(id: ItemId, instanceDate?: LocalDateString): Promise<OpResult> {
    return this.report('complete', this.deps.tasks.complete(id, instanceDate));
  }

  uncomplete(id: ItemId, instanceDate?: LocalDateString): Promise<OpResult> {
    return this.report('uncomplete', this.deps.tasks.uncomplete(id, instanceDate), 'taskActions.done.uncompleted');
  }

  moveToQuadrant(id: ItemId, quadrant: QuadrantKey): Promise<OpResult> {
    return this.report('moveToQuadrant', this.deps.tasks.moveToQuadrant(id, quadrant));
  }

  reschedule(id: ItemId, date: LocalDateString): Promise<OpResult> {
    return this.report('reschedule', this.deps.tasks.reschedule(id, date));
  }

  postponeToTomorrow(id: ItemId): Promise<OpResult> {
    return this.report('postponeToTomorrow', this.deps.tasks.postponeToTomorrow(id), 'taskActions.done.postponed');
  }

  delete(id: ItemId): Promise<OpResult> {
    return this.report('delete', this.deps.tasks.delete(id), 'taskActions.done.deleted');
  }

  archive(id: ItemId): Promise<OpResult> {
    return this.report('archive', this.deps.archive.archive(id), 'taskActions.done.archived');
  }

  restore(id: ItemId): Promise<OpResult> {
    return this.report('restore', this.deps.archive.restore(id), 'taskActions.done.restored');
  }

  /**
   * Автоперенос в архив (запуск плагина, смена настройки). При успехе сообщает число
   * перенесённых задач; «данные ещё загружаются» не показывает — вызов повторят позже.
   */
  async runAutoArchive(options: { silent?: boolean } = {}): Promise<OpResult<number>> {
    const result = await this.deps.archive.runAuto();
    if (!result.ok) {
      this.logError('runAutoArchive', result.error);
      if (result.error.code !== 'not-ready') {
        this.deps.notifier.show(t('taskActions.errors.autoArchive', { reason: errorMessage(result.error) }));
      }
      return result;
    }
    if (!options.silent && result.value > 0) {
      this.deps.notifier.show(tPlural('taskActions.done.autoArchived', result.value));
    }
    return result;
  }

  // -------------------------------------------------------------------------

  private async report<T>(action: string, pending: Promise<OpResult<T>>, successKey?: string): Promise<OpResult<T>> {
    let result: OpResult<T>;
    try {
      result = await pending;
    } catch (cause) {
      // Сервисы не бросают исключений для ожидаемых сбоев; это страховка.
      result = { ok: false, error: { code: 'unknown', detail: String(cause), cause } };
    }
    if (!result.ok) {
      this.logError(action, result.error);
      this.deps.notifier.show(errorMessage(result.error));
    } else if (result.changed && successKey) {
      this.deps.notifier.show(t(successKey));
    }
    return result;
  }

  private logError(action: string, error: PlannerError): void {
    // Ожидаемые отказы (нет прав на запись, устаревшее действие) не засоряют консоль.
    if (error.code === 'read-only' || error.code === 'stale' || error.code === 'not-ready' || error.code === 'invalid') return;
    const message = `Matrix planner: task action "${action}" failed (${error.code})${error.detail ? `: ${error.detail}` : ''}`;
    if (this.deps.log) this.deps.log(message, error);
    else console.error(message, error.cause ?? '');
  }
}

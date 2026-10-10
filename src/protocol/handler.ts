/**
 * Обработчик `obsidian://planner` (ТЗ §4.8). Подключается сборкой:
 *   this.registerObsidianProtocolHandler(PROTOCOL_ACTION, (params) => handler.handle(params));
 *
 * При холодном запуске ссылка приходит раньше, чем `metadataCache` выдаст `resolved`,
 * поэтому любая обработка ждёт `index.whenReady()`. Ссылки обрабатываются строго по очереди.
 */

import type { NoteIndex, Notifier, PlannerActions, ProtocolHandler, WallpaperStatusTracker } from '../app/contracts';
import { registerDictionary, t } from '../i18n';
import { enProtocol } from '../i18n/en/protocol';
import { ruProtocol } from '../i18n/ru/protocol';
import type { PlannerLink } from '../model/types';
import { parseLinkParams } from './parameters';

registerDictionary('ru', 'protocol', ruProtocol);
registerDictionary('en', 'protocol', enProtocol);

export const ITEM_NOT_FOUND_KEY = 'common.errors.notFound';
export const LINK_FAILED_KEY = 'protocol.errors.failed';

export interface ProtocolHandlerDeps {
  index: Pick<NoteIndex, 'whenReady' | 'getById'>;
  actions: Pick<PlannerActions, 'showTab' | 'openTaskForm' | 'openItem'>;
  notifier: Notifier;
  /** На этапе 1 статуса обоев нет: `wallpaper-*` тогда игнорируются. */
  wallpaperStatus?: Pick<WallpaperStatusTracker, 'onWallpaperCallback'> | null;
  /** Перевод (подменяется в тестах). */
  translate?: (key: string) => string;
}

export class PlannerProtocolHandler implements ProtocolHandler {
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly deps: ProtocolHandlerDeps) {}

  handle(params: Record<string, string>): Promise<void> {
    // Копия: Obsidian может переиспользовать объект параметров.
    const snapshot = { ...params };
    const run = this.queue.then(() => this.process(snapshot));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** После выгрузки плагина отложенные ссылки не выполняются. */
  dispose(): void {
    this.disposed = true;
  }

  private translate(key: string): string {
    return (this.deps.translate ?? t)(key);
  }

  private async process(params: Record<string, string>): Promise<void> {
    const parsed = parseLinkParams(params);
    // Проверку параметров сообщаем сразу, не дожидаясь индекса.
    if (!parsed.ok) {
      this.deps.notifier.show(this.translate(parsed.messageKey));
      return;
    }
    try {
      await this.deps.index.whenReady();
      if (this.disposed) return;
      await this.dispatch(parsed.link);
    } catch {
      if (!this.disposed) this.deps.notifier.show(this.translate(LINK_FAILED_KEY));
    }
  }

  private async dispatch(link: PlannerLink): Promise<void> {
    const { actions, index, wallpaperStatus } = this.deps;
    switch (link.action) {
      case 'view':
        await actions.showTab(link.view);
        return;
      case 'new-task':
        actions.openTaskForm({ mode: 'create', quadrant: link.quadrant, date: link.date });
        return;
      case 'open':
        if (!index.getById(link.id)) {
          this.deps.notifier.show(this.translate(ITEM_NOT_FOUND_KEY));
          return;
        }
        await actions.openItem(link.id);
        return;
      case 'wallpaper-done':
        await wallpaperStatus?.onWallpaperCallback('done');
        return;
      case 'wallpaper-failed':
        await wallpaperStatus?.onWallpaperCallback('failed');
        return;
    }
  }
}

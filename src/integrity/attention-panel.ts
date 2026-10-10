/**
 * Панель «Требуют внимания» для раздела «Данные» вкладки настроек (ТЗ §3.8, §4.6).
 * Действия: «Открыть», «Оставить эту версию», «Объединить вручную» (открыть все версии рядом).
 * Удаления среди действий нет.
 */

import { setIcon, type App } from 'obsidian';
import type { IntegrityService, Notifier } from '../app/contracts';
import type { AttentionItem, AttentionKind, IntegrityReport, VaultPath } from '../model/types';
import type { AttentionPanelHandle } from '../settings/types';
import { t } from '../i18n';
import { itemActions, pathActions } from './checks';
// Регистрирует словари модуля.
import './integrity-service';

export interface AttentionPanelDeps {
  integrity: Pick<IntegrityService, 'getLastReport' | 'keepVersion' | 'onChange'>;
  openNote(path: VaultPath): void;
  /** «Объединить вручную»: открыть все версии (на компьютере — рядом). */
  openSideBySide(paths: readonly VaultPath[]): void;
  notifier?: Notifier;
}

const KIND_ICONS: Record<AttentionKind, string> = {
  'duplicate-id': 'copy',
  'conflict-copy': 'git-compare',
  'invalid-properties': 'file-warning',
  'deleted-in-calendar': 'calendar-x',
  'pending-deletion': 'trash-2',
  schema: 'database',
};

/** Подпись версии: для дубликата первая — исходная, для конфликтной копии первая — копия. */
function versionLabel(item: AttentionItem, index: number): string | null {
  if (item.paths.length < 2) return null;
  if (item.kind === 'duplicate-id') return index === 0 ? t('integrity.panel.original') : t('integrity.panel.copy');
  if (item.kind === 'conflict-copy') return index === 0 ? t('integrity.panel.copy') : t('integrity.panel.original');
  return null;
}

/** Фабрика панели для `SettingsTabDeps.attentionPanel`. */
export function createAttentionPanel(deps: AttentionPanelDeps): (containerEl: HTMLElement) => AttentionPanelHandle {
  return (containerEl: HTMLElement): AttentionPanelHandle => {
    const rootEl = containerEl.createDiv({ cls: 'mp-attention' });
    let disposed = false;
    let busy = false;

    const render = (report: IntegrityReport | null): void => {
      if (disposed) return;
      rootEl.empty();
      if (!report) return;
      if (report.items.length === 0) {
        rootEl.createDiv({ cls: 'mp-attention-empty', text: t('integrity.panel.empty') });
        return;
      }
      const list = rootEl.createEl('ul', { cls: 'mp-attention-list' });
      for (const item of report.items) renderItem(list, item);
    };

    const renderItem = (list: HTMLElement, item: AttentionItem): void => {
      const row = list.createEl('li', { cls: ['mp-attention-item', `mp-attention-${item.kind}`] });
      row.dataset['key'] = item.key;
      const header = row.createDiv({ cls: 'mp-attention-header' });
      setIcon(header.createSpan({ cls: 'mp-attention-icon' }), KIND_ICONS[item.kind]);
      header.createSpan({ cls: 'mp-attention-message', text: t(item.messageKey, item.messageParams) });

      item.paths.forEach((path, index) => {
        const pathRow = row.createDiv({ cls: 'mp-attention-path' });
        const label = versionLabel(item, index);
        if (label) pathRow.createSpan({ cls: 'mp-attention-label', text: label });
        pathRow.createSpan({ cls: 'mp-attention-file', text: path });
        const buttons = pathRow.createDiv({ cls: 'mp-attention-actions' });
        for (const action of pathActions(item)) {
          if (action === 'open') {
            button(buttons, t('integrity.panel.open'), 'mp-attention-open', () => deps.openNote(path));
          } else if (action === 'keep') {
            button(buttons, t('integrity.panel.keep'), 'mp-attention-keep', () => void keep(item, path));
          }
        }
      });

      const actions = itemActions(item);
      if (actions.includes('merge')) {
        const footer = row.createDiv({ cls: 'mp-attention-actions mp-attention-footer' });
        button(footer, t('integrity.panel.merge'), 'mp-attention-merge', () => deps.openSideBySide(item.paths));
      }
    };

    const button = (parent: HTMLElement, text: string, cls: string, onClick: () => void): HTMLElement => {
      const el = parent.createEl('button', { cls: ['mp-attention-button', cls], text });
      el.addEventListener('click', onClick);
      return el;
    };

    const keep = async (item: AttentionItem, path: VaultPath): Promise<void> => {
      if (busy) return;
      busy = true;
      try {
        const result = await deps.integrity.keepVersion(item, path);
        deps.notifier?.show(result.ok ? t('integrity.panel.keepDone') : t('integrity.panel.keepFailed'));
      } catch (error) {
        console.error('[matrix-planner] keepVersion failed', error);
        deps.notifier?.show(t('integrity.panel.keepFailed'));
      } finally {
        busy = false;
      }
    };

    const unsubscribe = deps.integrity.onChange(render);
    render(deps.integrity.getLastReport());

    return {
      dispose(): void {
        if (disposed) return;
        disposed = true;
        unsubscribe();
        rootEl.remove();
      },
    };
  };
}

/** Открытие заметок через рабочую область Obsidian (для сборки ядра). */
export function createWorkspaceOpeners(app: App): Pick<AttentionPanelDeps, 'openNote' | 'openSideBySide'> {
  const open = (path: VaultPath, mode: false | 'tab' | 'split'): void => {
    const file = app.vault.getFileByPath(path);
    if (!file) return;
    void app.workspace.getLeaf(mode).openFile(file);
  };
  return {
    openNote: (path) => open(path, false),
    openSideBySide: (paths) => {
      // Первая версия — в новой вкладке, остальные — рядом (на телефоне split открывается вкладкой).
      paths.forEach((path, index) => open(path, index === 0 ? 'tab' : 'split'));
    },
  };
}

/**
 * Строка статуса синхронизации под шапкой вкладки «Календарь» (доработка 006, §7). Показывается,
 * только когда есть что сказать: «Отправка…», «Не отправлено: нет связи · Повторить»,
 * «Ошибка входа в iCloud · Настройки»; после успешной адресной отправки — на 3 с
 * «Отправлено в «Календарь» iOS». Источник — статус движка синхронизации (`onStatusChange`).
 */

import { setIcon } from 'obsidian';
import { registerDictionary, t } from '../i18n';
import { ruCaldav } from '../i18n/ru/caldav';
import { enCaldav } from '../i18n/en/caldav';
import type { HapticKind } from '../ui/haptics';

registerDictionary('ru', 'caldav', ruCaldav);
registerDictionary('en', 'caldav', enCaldav);

/** Сколько показывается «Отправлено…», мс. */
export const SENT_FLASH_MS = 3000;

/** Часть статуса движка (`CalendarSyncStatus`), нужная строке. */
export interface SyncLineStatus {
  running: boolean;
  pushing?: boolean;
  error: { kind: string } | null;
  lastPushAt: string | null;
}

export type SyncLineKind = 'sending' | 'offline' | 'auth' | 'sent';

export interface SyncLineInput {
  /** Синхронизация включена в настройках. */
  enabled: boolean;
  status: SyncLineStatus;
  /** Идёт повтор после «Повторить». */
  retrying: boolean;
  /** Показать «Отправлено…» (3 с после успешной отправки). */
  sentFlash: boolean;
}

/** Что показать; `null` — строки нет. */
export function syncLineKind(input: SyncLineInput): SyncLineKind | null {
  if (!input.enabled) return null;
  const { status } = input;
  if (status.pushing || (input.retrying && status.running)) return 'sending';
  if (status.error?.kind === 'auth') return 'auth';
  if (status.error?.kind === 'network') return 'offline';
  if (input.sentFlash) return 'sent';
  return null;
}

export interface SyncLineView {
  text: string;
  icon: string;
  /** Кнопка справа: «Повторить» / «Настройки». */
  action: 'retry' | 'settings' | null;
  tone: 'neutral' | 'error' | 'success';
}

export function syncLineView(kind: SyncLineKind, provider: string): SyncLineView {
  const icloud = provider === 'icloud';
  switch (kind) {
    case 'sending':
      return { text: t('caldav.statusLine.sending'), icon: 'refresh-cw', action: null, tone: 'neutral' };
    case 'offline':
      return { text: t('caldav.statusLine.offline'), icon: 'wifi-off', action: 'retry', tone: 'error' };
    case 'auth':
      return { text: t(icloud ? 'caldav.statusLine.auth' : 'caldav.statusLine.authCaldav'), icon: 'key-round', action: 'settings', tone: 'error' };
    case 'sent':
      return { text: t(icloud ? 'caldav.statusLine.sent' : 'caldav.statusLine.sentCaldav'), icon: 'check', action: null, tone: 'success' };
  }
}

/** Источник статуса (движок синхронизации и настройки). */
export interface SyncStatusSource {
  getStatus(): SyncLineStatus;
  onStatusChange(listener: (status: SyncLineStatus) => void): () => void;
  isEnabled(): boolean;
  provider(): string;
  /** «Повторить»: полный проход синхронизации; `true` — успешно. */
  retry(): Promise<boolean>;
}

export interface SyncStatusLineDeps {
  source: SyncStatusSource;
  /** «Настройки» — вкладка «Настройки» вида. */
  openSettings(): void;
  haptic?(kind: HapticKind): void;
  /** Таймеры (в тестах — поддельные). */
  setTimeout?(callback: () => void, ms: number): number;
  clearTimeout?(id: number): void;
}

/** Строка статуса: монтируется под шапкой вкладки, сама подписывается на движок. */
export class SyncStatusLine {
  private el: HTMLElement | null = null;
  private unsubscribe: (() => void) | null = null;
  private lastPushAt: string | null = null;
  private sentTimer: number | null = null;
  private sentFlash = false;
  private retrying = false;

  constructor(private readonly deps: SyncStatusLineDeps) {}

  mount(el: HTMLElement): void {
    this.unmount();
    this.el = el;
    el.addClass('mp-cal-sync');
    el.setAttr('role', 'status');
    el.setAttr('aria-live', 'polite');
    this.lastPushAt = this.deps.source.getStatus().lastPushAt;
    this.unsubscribe = this.deps.source.onStatusChange((status) => this.onStatus(status));
    this.render();
  }

  unmount(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clearSent();
    this.el = null;
  }

  /** Текущий вид (для тестов). */
  kind(): SyncLineKind | null {
    return syncLineKind({ enabled: this.deps.source.isEnabled(), status: this.deps.source.getStatus(), retrying: this.retrying, sentFlash: this.sentFlash });
  }

  /** Настройки изменились (включение синхронизации) — перерисовать. */
  refresh(): void {
    this.render();
  }

  private onStatus(status: SyncLineStatus): void {
    if (status.lastPushAt !== null && status.lastPushAt !== this.lastPushAt) {
      this.lastPushAt = status.lastPushAt;
      this.flashSent();
    }
    this.render();
  }

  private flashSent(): void {
    this.clearSent();
    this.sentFlash = true;
    const done = (): void => {
      this.sentTimer = null;
      this.sentFlash = false;
      this.render();
    };
    this.sentTimer = this.deps.setTimeout ? this.deps.setTimeout(done, SENT_FLASH_MS) : window.setTimeout(done, SENT_FLASH_MS);
  }

  private clearSent(): void {
    if (this.sentTimer !== null) {
      if (this.deps.clearTimeout) this.deps.clearTimeout(this.sentTimer);
      else window.clearTimeout(this.sentTimer);
      this.sentTimer = null;
    }
    this.sentFlash = false;
  }

  private retry(): void {
    if (this.retrying) return;
    this.deps.haptic?.('tap');
    this.retrying = true;
    this.render();
    void this.deps.source
      .retry()
      .catch(() => false)
      .then((ok) => {
        this.retrying = false;
        if (ok) this.flashSent();
        else this.deps.haptic?.('error');
        this.render();
      });
  }

  private render(): void {
    const el = this.el;
    if (!el) return;
    const kind = this.kind();
    el.empty();
    el.hidden = kind === null;
    if (kind === null) {
      delete el.dataset.kind;
      return;
    }
    el.dataset.kind = kind;
    const view = syncLineView(kind, this.deps.source.provider());
    el.dataset.tone = view.tone;
    setIcon(el.createSpan({ cls: 'mp-cal-sync-icon', attr: { 'aria-hidden': 'true' } }), view.icon);
    el.createSpan({ cls: 'mp-cal-sync-text', text: view.text });
    if (view.action) {
      const label = t(view.action === 'retry' ? 'caldav.statusLine.retry' : 'caldav.statusLine.settings');
      const button = el.createEl('button', { cls: 'mp-cal-sync-action', text: label, attr: { type: 'button' } });
      button.addEventListener('click', () => {
        if (view.action === 'retry') this.retry();
        else {
          this.deps.haptic?.('tap');
          this.deps.openSettings();
        }
      });
    }
  }
}

/**
 * Макет экрана блокировки iOS поверх предпросмотра обоев (доработка 007, п.10):
 * дата «Сб 10 окт.», часы, ряд виджетов под часами, кнопки фонарика и камеры,
 * штрихованная зона уведомлений. Только интерфейс — на PNG не рисуется.
 * Положения — доли высоты экрана, сверенные с реальным снимком LockDay.
 */

import { setIcon } from 'obsidian';
import { t } from '../i18n';
import { floatingFromDate } from '../model/dates';

export interface IosOverlayOptions {
  date: string;
  time: string;
  /** Ряд виджетов под часами (композиция `widgets`). */
  widgets: boolean;
  /** Зоны iOS: виджеты, кнопки, зона уведомлений. Без них — только дата и часы. */
  zones: boolean;
}

/**
 * Дата как на экране блокировки iOS: «Сб 10 окт.» / «Sat Oct 10» —
 * короткий день недели с заглавной буквы, без запятых.
 */
export function iosDateText(now: Date, timeZone: string, language: string): string {
  try {
    const format = new Intl.DateTimeFormat(language, { weekday: 'short', day: 'numeric', month: 'short', timeZone });
    const parts = format.formatToParts(now).filter((part) => part.type !== 'literal');
    const text = parts.map((part) => part.value.replace(/[,،]/g, '').trim()).filter((value) => value !== '').join(' ');
    return text.charAt(0).toLocaleUpperCase(language) + text.slice(1);
  } catch {
    return now.toDateString();
  }
}

/** Часы экрана блокировки: «13:32», в 12-часовом формате — «1:32» без AM/PM. */
export function iosTimeText(now: Date, timeZone: string, hour12: boolean): string {
  const time = floatingFromDate(now, timeZone).time;
  const [hh, mm] = time.split(':').map(Number);
  const hours = hour12 ? (hh % 12 === 0 ? 12 : hh % 12) : hh;
  return `${hour12 ? hours : String(hours).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** Слой макета iOS в рамке телефона; повторный вызов заменяет прежний слой. */
export function renderIosOverlay(frameEl: HTMLElement, options: IosOverlayOptions): HTMLElement {
  frameEl.querySelector(':scope > .mp-ios')?.remove();
  const root = frameEl.createDiv({ cls: 'mp-ios', attr: { 'aria-hidden': 'true' } });
  root.toggleClass('is-zones-off', !options.zones);
  root.createDiv({ cls: 'mp-ios-date', text: options.date });
  root.createDiv({ cls: 'mp-ios-time', text: options.time });
  if (options.widgets) {
    const row = root.createDiv({ cls: 'mp-ios-widgets mp-ios-zone-item' });
    row.createDiv({ cls: 'mp-ios-widget is-wide' });
    row.createDiv({ cls: 'mp-ios-widget is-round' });
    row.createDiv({ cls: 'mp-ios-widget is-round' });
  }
  const notifications = root.createDiv({ cls: 'mp-ios-notifications mp-ios-zone-item' });
  notifications.createSpan({ cls: 'mp-ios-notifications-label', text: t('lockscreen.editor.zones.notifications') });
  for (const [cls, icon] of [
    ['is-left', 'flashlight'],
    ['is-right', 'camera'],
  ] as const) {
    const button = root.createDiv({ cls: `mp-ios-button mp-ios-zone-item ${cls}` });
    setIcon(button, icon);
  }
  return root;
}

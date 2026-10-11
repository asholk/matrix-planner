/**
 * Меню действий элемента — общие жесты для карточек задач и строк календаря (ТЗ §4.2, §4.4):
 * долгое нажатие на сенсоре (автомат `CardGesture`, 500 мс; сдвиг пальца — прокрутка, жест
 * отменяется), правая кнопка мыши, Shift+F10 и клавиша ContextMenu. После меню долгого
 * нажатия ближайший `click` подавляется (`consumeClick`).
 */

import type { Menu } from 'obsidian';
import { CardGesture, DEFAULT_GESTURE_OPTIONS, type GestureEffect, type GestureOptions, type PointerKind } from '../../tasks/task-drag';

/** Повторное открытие меню в этот промежуток игнорируется (долгое нажатие + `contextmenu` на Android). */
export const MENU_DEBOUNCE_MS = 700;

export function toPointerKind(type: string): PointerKind {
  return type === 'touch' || type === 'pen' ? type : 'mouse';
}

function isMouseEvent(value: unknown): value is MouseEvent {
  return typeof MouseEvent !== 'undefined' && value instanceof MouseEvent;
}

/** Shift+F10 или клавиша ContextMenu. */
export function isMenuKey(evt: Pick<KeyboardEvent, 'key' | 'shiftKey'>): boolean {
  return evt.key === 'ContextMenu' || (evt.key === 'F10' && evt.shiftKey);
}

/** Показ меню у мыши (ПКМ) или под элементом (долгое нажатие, клавиатура). */
export function showMenuAt(menu: Menu, anchor: MouseEvent | HTMLElement): void {
  if (isMouseEvent(anchor) && (anchor.clientX !== 0 || anchor.clientY !== 0)) {
    menu.showAtMouseEvent(anchor);
    return;
  }
  const target = isMouseEvent(anchor) ? (anchor.currentTarget as HTMLElement | null) : anchor;
  if (target && typeof target.getBoundingClientRect === 'function') {
    const rect = target.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom }, target.doc);
    return;
  }
  menu.showAtPosition({ x: 0, y: 0 });
}

export interface ContextMenuBinding {
  /** `true` один раз после меню долгого нажатия: этот `click` не открывает элемент. */
  consumeClick(): boolean;
  /** Снять обработчики и таймер. */
  dispose(): void;
}

export interface ContextMenuOptions {
  /** Элемент, на котором ловится клавиатура (по умолчанию — сам элемент). */
  keyTarget?: HTMLElement;
  /** Нажатие на эти элементы (кнопки со своим действием) жест не начинает. */
  controlSelector?: string;
  /** Короткая вибрация при долгом нажатии (Android). */
  vibrate?: boolean;
  gesture?: GestureOptions;
  /** Время для защиты от двойного открытия (тесты). */
  now?: () => number;
}

/**
 * Подключает меню к элементу: долгое нажатие (сенсор, перо), ПКМ и клавиатура.
 * Мышь меню по долгому нажатию не открывает — для неё ПКМ.
 */
export function attachContextMenu(
  el: HTMLElement,
  open: (anchor: MouseEvent | HTMLElement) => void,
  options: ContextMenuOptions = {},
): ContextMenuBinding {
  const gesture = new CardGesture(options.gesture ?? DEFAULT_GESTURE_OPTIONS);
  const now = options.now ?? (() => Date.now());
  let lastMenuAt = -Infinity;
  let timer: number | null = null;
  let cleanup: (() => void) | null = null;

  const show = (anchor: MouseEvent | HTMLElement): void => {
    const at = now();
    if (at - lastMenuAt < MENU_DEBOUNCE_MS) return;
    lastMenuAt = at;
    open(anchor);
  };
  const clearTimer = (): void => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };
  const finish = (): void => {
    clearTimer();
    cleanup?.();
    cleanup = null;
  };
  const apply = (effect: GestureEffect): void => {
    switch (effect.type) {
      case 'schedule-long-press':
        clearTimer();
        timer = window.setTimeout(() => {
          timer = null;
          apply(gesture.timeout());
        }, effect.delayMs);
        return;
      case 'long-press':
        finish();
        if (options.vibrate) {
          try {
            navigator.vibrate?.(10);
          } catch {
            // Вибрация необязательна.
          }
        }
        show(el);
        return;
      case 'cancel':
        finish();
        return;
      default:
        return;
    }
  };

  const onPointerDown = (evt: PointerEvent): void => {
    const pointerType = toPointerKind(evt.pointerType);
    if (pointerType === 'mouse') {
      // Нажатие мышью после меню долгого нажатия (без click) — прежний флаг подавления не нужен.
      gesture.consumesClick();
      return;
    }
    const target = evt.target as HTMLElement | null;
    const onControl = Boolean(options.controlSelector && target?.closest?.(options.controlSelector));
    finish();
    const effect = gesture.down({ x: evt.clientX, y: evt.clientY, time: evt.timeStamp, pointerType, button: evt.button, onHandle: false, onControl });
    if (gesture.getPhase() === 'idle') return;
    const doc = el.doc;
    const onMove = (e: PointerEvent): void => {
      if (e.pointerId === evt.pointerId) apply(gesture.move({ x: e.clientX, y: e.clientY, time: e.timeStamp }));
    };
    const onUp = (e: PointerEvent): void => {
      if (e.pointerId !== evt.pointerId) return;
      gesture.up({ x: e.clientX, y: e.clientY, time: e.timeStamp });
      finish();
    };
    const onCancel = (e: PointerEvent): void => {
      if (e.pointerId === evt.pointerId) apply(gesture.cancel());
    };
    // Прокрутка панели (на iOS — без `pointercancel`) отменяет долгое нажатие.
    const onScroll = (): void => apply(gesture.cancel());
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') apply(gesture.cancel());
    };
    doc.addEventListener('pointermove', onMove);
    doc.addEventListener('pointerup', onUp);
    doc.addEventListener('pointercancel', onCancel);
    doc.addEventListener('scroll', onScroll, true);
    doc.addEventListener('keydown', onKey);
    cleanup = () => {
      doc.removeEventListener('pointermove', onMove);
      doc.removeEventListener('pointerup', onUp);
      doc.removeEventListener('pointercancel', onCancel);
      doc.removeEventListener('scroll', onScroll, true);
      doc.removeEventListener('keydown', onKey);
    };
    apply(effect);
  };
  const onContextMenu = (evt: MouseEvent): void => {
    evt.preventDefault();
    evt.stopPropagation();
    show(evt);
  };
  const keyTarget = options.keyTarget ?? el;
  const onKeyDown = (evt: KeyboardEvent): void => {
    if (!isMenuKey(evt)) return;
    evt.preventDefault();
    evt.stopPropagation();
    show(keyTarget);
  };

  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('contextmenu', onContextMenu);
  keyTarget.addEventListener('keydown', onKeyDown);
  return {
    consumeClick: () => gesture.consumesClick(),
    dispose: () => {
      apply(gesture.cancel());
      finish();
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('contextmenu', onContextMenu);
      keyTarget.removeEventListener('keydown', onKeyDown);
    },
  };
}

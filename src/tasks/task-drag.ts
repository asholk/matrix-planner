/**
 * Жесты карточки (ТЗ §4.2, доработка 005). Чистый модуль: без DOM и `obsidian`.
 *
 * - Мышь: перетаскивание за любую часть карточки после сдвига на `dragThreshold`.
 * - Касание/перо: долгое нажатие (`longPressMs`) на карточку. Режим `longPress`:
 *   `'drag'` — карточка «поднимается» и перетаскивается (вкладка «Задачи»),
 *   `'menu'` — меню действий (строки «Календаря», запрос 004).
 *   Сдвиг пальца больше `moveTolerance` до срабатывания — прокрутка, жест отменяется.
 * Нажатие (tap) обрабатывается обычным `click`; после перетаскивания или меню
 * вызывающий подавляет следующий `click` (`consumesClick`).
 */

import type { ItemId, QuadrantKey } from '../model/types';

export type PointerKind = 'mouse' | 'touch' | 'pen';

export interface GestureOptions {
  /** Задержка долгого нажатия, мс. */
  longPressMs: number;
  /** Допуск дрожания пальца для долгого нажатия, px. */
  moveTolerance: number;
  /** Сдвиг мыши, после которого начинается перетаскивание, px. */
  dragThreshold: number;
  /** Что делает долгое нажатие касанием: меню (по умолчанию) или перетаскивание. */
  longPress?: 'menu' | 'drag';
}

export const DEFAULT_GESTURE_OPTIONS: GestureOptions = {
  longPressMs: 500,
  moveTolerance: 10,
  dragThreshold: 6,
  longPress: 'menu',
};

/** Карточки вкладки «Задачи»: долгое нажатие — перетаскивание, сдвиг > 8 px до него — прокрутка. */
export const TASK_DRAG_GESTURE_OPTIONS: GestureOptions = {
  longPressMs: 500,
  moveTolerance: 8,
  dragThreshold: 6,
  longPress: 'drag',
};

export interface PointerDown {
  x: number;
  y: number;
  time: number;
  pointerType: PointerKind;
  /** 0 — основная кнопка. */
  button: number;
  /** Нажатие пришлось на элемент со своим действием (кружок, кнопка) — жест не начинается. */
  onControl: boolean;
}

export interface PointerPoint {
  x: number;
  y: number;
  time: number;
}

export type GesturePhase = 'idle' | 'pressed' | 'dragging' | 'menu' | 'cancelled';

export type GestureEffect =
  | { type: 'none' }
  /** Запустить таймер долгого нажатия на `delayMs`, по нему вызвать `timeout()`. */
  | { type: 'schedule-long-press'; delayMs: number }
  /** Начало перетаскивания; `byLongPress` — карточку «подняли» долгим нажатием. */
  | { type: 'drag-start'; x: number; y: number; byLongPress: boolean }
  | { type: 'drag-move'; x: number; y: number }
  | { type: 'drop'; x: number; y: number }
  | { type: 'long-press' }
  /** Жест прерван (прокрутка, отмена указателя); если шло перетаскивание — вернуть карточку. */
  | { type: 'cancel'; wasDragging: boolean };

const NONE: GestureEffect = { type: 'none' };

/** Автомат жеста одной карточки. */
export class CardGesture {
  private phase: GesturePhase = 'idle';
  private start: PointerDown | null = null;
  /** Последняя точка указателя до начала перетаскивания. */
  private last: PointerPoint | null = null;
  /** Подавить ближайший `click` (после перетаскивания или меню). */
  private suppressClick = false;

  constructor(private readonly options: GestureOptions = DEFAULT_GESTURE_OPTIONS) {}

  getPhase(): GesturePhase {
    return this.phase;
  }

  isDragging(): boolean {
    return this.phase === 'dragging';
  }

  /** Активный жест касанием или пером (нажат палец). */
  isTouchActive(): boolean {
    return this.phase !== 'idle' && this.start !== null && this.start.pointerType !== 'mouse';
  }

  down(event: PointerDown): GestureEffect {
    this.reset();
    if (event.button !== 0 || event.onControl) return NONE;
    this.start = event;
    this.last = { x: event.x, y: event.y, time: event.time };
    this.phase = 'pressed';
    if (event.pointerType !== 'mouse') return { type: 'schedule-long-press', delayMs: this.options.longPressMs };
    return NONE;
  }

  move(point: PointerPoint): GestureEffect {
    const start = this.start;
    if (!start) return NONE;
    if (this.phase === 'dragging') return { type: 'drag-move', x: point.x, y: point.y };
    if (this.phase !== 'pressed') return NONE;
    this.last = point;
    const distance = Math.hypot(point.x - start.x, point.y - start.y);
    if (start.pointerType === 'mouse') {
      if (distance < this.options.dragThreshold) return NONE;
      this.phase = 'dragging';
      this.suppressClick = true;
      return { type: 'drag-start', x: point.x, y: point.y, byLongPress: false };
    }
    if (distance > this.options.moveTolerance) {
      // Палец сдвинулся до долгого нажатия: это прокрутка.
      this.phase = 'cancelled';
      return { type: 'cancel', wasDragging: false };
    }
    return NONE;
  }

  /** Срабатывание таймера долгого нажатия. */
  timeout(time?: number): GestureEffect {
    const start = this.start;
    if (!start || this.phase !== 'pressed') return NONE;
    if (start.pointerType === 'mouse') return NONE;
    if (time !== undefined && time - start.time < this.options.longPressMs) return NONE;
    this.suppressClick = true;
    if (this.options.longPress === 'drag') {
      this.phase = 'dragging';
      const at = this.last ?? start;
      return { type: 'drag-start', x: at.x, y: at.y, byLongPress: true };
    }
    this.phase = 'menu';
    return { type: 'long-press' };
  }

  up(point: PointerPoint): GestureEffect {
    const phase = this.phase;
    this.phase = 'idle';
    this.start = null;
    this.last = null;
    if (phase === 'dragging') return { type: 'drop', x: point.x, y: point.y };
    return NONE;
  }

  /** `pointercancel`, потеря захвата, Escape, прокрутка панели. */
  cancel(): GestureEffect {
    const wasDragging = this.phase === 'dragging';
    const active = this.phase !== 'idle';
    this.phase = 'idle';
    this.start = null;
    this.last = null;
    return active ? { type: 'cancel', wasDragging } : NONE;
  }

  /** Возвращает true один раз после перетаскивания или долгого нажатия. */
  consumesClick(): boolean {
    const result = this.suppressClick;
    this.suppressClick = false;
    return result;
  }

  private reset(): void {
    this.phase = 'idle';
    this.start = null;
    this.last = null;
    this.suppressClick = false;
  }
}

// ---------------------------------------------------------------------------
// Цели переноса
// ---------------------------------------------------------------------------

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface DropZone {
  quadrant: QuadrantKey;
  rect: Rect;
}

function contains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/** Квадрант под точкой; `null` — вне зон. При вложенных зонах побеждает последняя. */
export function dropZoneAt(zones: readonly DropZone[], x: number, y: number): QuadrantKey | null {
  let found: QuadrantKey | null = null;
  for (const zone of zones) if (contains(zone.rect, x, y)) found = zone.quadrant;
  return found;
}

export interface DragSession {
  taskId: ItemId;
  from: QuadrantKey;
  /** Квадрант под указателем. */
  over: QuadrantKey | null;
  /** Указатель над зоной «Перетащите сюда, чтобы удалить». */
  overDelete: boolean;
}

export function startDrag(taskId: ItemId, from: QuadrantKey): DragSession {
  return { taskId, from, over: null, overDelete: false };
}

/**
 * Обновить цель под указателем. Зона удаления (`deleteRect`) важнее квадрантов: она лежит
 * поверх матрицы. Возвращает тот же объект, если ничего не изменилось.
 */
export function updateDrag(session: DragSession, zones: readonly DropZone[], x: number, y: number, deleteRect: Rect | null = null): DragSession {
  const overDelete = deleteRect !== null && contains(deleteRect, x, y);
  const over = overDelete ? null : dropZoneAt(zones, x, y);
  return over === session.over && overDelete === session.overDelete ? session : { ...session, over, overDelete };
}

export type DropResult = { kind: 'move'; taskId: ItemId; quadrant: QuadrantKey } | { kind: 'delete'; taskId: ItemId };

/** Итог переноса: удаление, квадрант назначения или `null` (тот же квадрант / вне зон). */
export function resolveDrop(session: DragSession): DropResult | null {
  if (session.overDelete) return { kind: 'delete', taskId: session.taskId };
  if (!session.over || session.over === session.from) return null;
  return { kind: 'move', taskId: session.taskId, quadrant: session.over };
}

/** Подсвечивать ли зону: только чужой квадрант под указателем. */
export function isHighlightedZone(session: DragSession, quadrant: QuadrantKey): boolean {
  return session.over === quadrant && quadrant !== session.from;
}

// ---------------------------------------------------------------------------
// Зона удаления
// ---------------------------------------------------------------------------

export interface DeleteZoneLayout {
  /** Желаемая ширина зоны, px. */
  width: number;
  height: number;
  /** Отступ от «+» и от края вида, px. */
  gap: number;
}

/**
 * Положение зоны «Перетащите сюда, чтобы удалить» (кадр 06): на одной высоте с «+», по центру
 * вида, но не заходя на «+». Без «+» — у нижнего края вида по центру.
 */
export function deleteZoneRect(view: Rect, fab: Rect | null, layout: DeleteZoneLayout): Rect {
  const { gap, height } = layout;
  const centerX = (view.left + view.right) / 2;
  if (!fab) {
    const width = Math.max(0, Math.min(layout.width, view.right - view.left - gap * 2));
    const bottom = view.bottom - gap;
    return { left: centerX - width / 2, right: centerX + width / 2, top: bottom - height, bottom };
  }
  const minLeft = view.left + gap;
  const maxRight = Math.max(minLeft, fab.left - gap);
  const width = Math.max(0, Math.min(layout.width, maxRight - minLeft));
  let left = centerX - width / 2;
  if (left + width > maxRight) left = maxRight - width;
  if (left < minLeft) left = minLeft;
  const centerY = (fab.top + fab.bottom) / 2;
  return { left, right: left + width, top: centerY - height / 2, bottom: centerY + height / 2 };
}

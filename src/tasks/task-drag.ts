/**
 * Жесты карточки задачи (ТЗ §4.2). Чистый модуль: без DOM и `obsidian`.
 *
 * - Мышь: перетаскивание за любую часть карточки после сдвига на `dragThreshold`.
 * - Касание/перо: перетаскивание только за маркер справа; долгое нажатие на карточку — меню.
 *   Сдвиг пальца до срабатывания долгого нажатия — прокрутка, жест отменяется.
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
  /** Сдвиг, после которого начинается перетаскивание, px. */
  dragThreshold: number;
}

export const DEFAULT_GESTURE_OPTIONS: GestureOptions = {
  longPressMs: 500,
  moveTolerance: 10,
  dragThreshold: 6,
};

export interface PointerDown {
  x: number;
  y: number;
  time: number;
  pointerType: PointerKind;
  /** 0 — основная кнопка. */
  button: number;
  /** Нажатие пришлось на маркер перетаскивания. */
  onHandle: boolean;
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
  | { type: 'drag-start'; x: number; y: number }
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
  /** Подавить ближайший `click` (после перетаскивания или меню). */
  private suppressClick = false;

  constructor(private readonly options: GestureOptions = DEFAULT_GESTURE_OPTIONS) {}

  getPhase(): GesturePhase {
    return this.phase;
  }

  isDragging(): boolean {
    return this.phase === 'dragging';
  }

  down(event: PointerDown): GestureEffect {
    this.reset();
    if (event.button !== 0 || event.onControl) return NONE;
    const touchLike = event.pointerType !== 'mouse';
    this.start = event;
    this.phase = 'pressed';
    // На касании маркер — только для перетаскивания, без меню.
    if (touchLike && !event.onHandle) return { type: 'schedule-long-press', delayMs: this.options.longPressMs };
    return NONE;
  }

  move(point: PointerPoint): GestureEffect {
    const start = this.start;
    if (!start) return NONE;
    if (this.phase === 'dragging') return { type: 'drag-move', x: point.x, y: point.y };
    if (this.phase !== 'pressed') return NONE;
    const distance = Math.hypot(point.x - start.x, point.y - start.y);
    const canDrag = start.pointerType === 'mouse' || start.onHandle;
    if (canDrag) {
      if (distance < this.options.dragThreshold) return NONE;
      this.phase = 'dragging';
      this.suppressClick = true;
      return { type: 'drag-start', x: point.x, y: point.y };
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
    if (start.pointerType === 'mouse' || start.onHandle) return NONE;
    if (time !== undefined && time - start.time < this.options.longPressMs) return NONE;
    this.phase = 'menu';
    this.suppressClick = true;
    return { type: 'long-press' };
  }

  up(point: PointerPoint): GestureEffect {
    const phase = this.phase;
    this.phase = 'idle';
    this.start = null;
    if (phase === 'dragging') return { type: 'drop', x: point.x, y: point.y };
    return NONE;
  }

  /** `pointercancel`, потеря захвата, Escape. */
  cancel(): GestureEffect {
    const wasDragging = this.phase === 'dragging';
    const active = this.phase !== 'idle';
    this.phase = 'idle';
    this.start = null;
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
}

export function startDrag(taskId: ItemId, from: QuadrantKey): DragSession {
  return { taskId, from, over: null };
}

/** Обновить квадрант под указателем. Возвращает тот же объект, если ничего не изменилось. */
export function updateDrag(session: DragSession, zones: readonly DropZone[], x: number, y: number): DragSession {
  const over = dropZoneAt(zones, x, y);
  return over === session.over ? session : { ...session, over };
}

/** Итог переноса: квадрант назначения или `null` (тот же квадрант / вне зон). */
export function resolveDrop(session: DragSession): { taskId: ItemId; quadrant: QuadrantKey } | null {
  if (!session.over || session.over === session.from) return null;
  return { taskId: session.taskId, quadrant: session.over };
}

/** Подсвечивать ли зону: только чужой квадрант под указателем. */
export function isHighlightedZone(session: DragSession, quadrant: QuadrantKey): boolean {
  return session.over === quadrant && quadrant !== session.from;
}

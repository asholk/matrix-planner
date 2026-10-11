/**
 * Свайпы по карточке в режиме «Список» (доработка 006, §2). Чистый модуль: без DOM и `obsidian`.
 *
 * - Вправо — «Выполнить» (зелёный фон с галочкой).
 * - Влево — «Перенести на завтра» (оранжевый, `calendar-clock`); длинный свайп влево — «Удалить» (красный, `trash-2`).
 * - Действие выбирается, когда сдвиг больше `threshold` ширины карточки (35–40 %), удаление — больше `deleteThreshold`.
 *   Пересечение порога — отклик `threshold` (эффект `move` с `crossed: true`).
 * - Жест «захватывается» горизонтальным сдвигом больше `lockDistance` до долгого нажатия; вертикальный сдвиг —
 *   прокрутка, свайп отменяется.
 */

export type SwipeAction = 'complete' | 'postpone' | 'delete';

export interface SwipeOptions {
  /** Сдвиг, после которого понятно направление жеста, px. */
  lockDistance: number;
  /** Во сколько раз горизонтальный сдвиг должен превышать вертикальный, чтобы стать свайпом. */
  axisRatio: number;
  /** Порог действия, доля ширины карточки. */
  threshold: number;
  /** Порог удаления (длинный свайп влево), доля ширины карточки. */
  deleteThreshold: number;
}

export const DEFAULT_SWIPE_OPTIONS: SwipeOptions = {
  lockDistance: 10,
  axisRatio: 1.2,
  threshold: 0.38,
  deleteThreshold: 0.7,
};

export interface SwipeStart {
  x: number;
  y: number;
  /** Ширина карточки, px. */
  width: number;
  /** Разрешённые направления: вправо — выполнить, влево — на завтра / удалить. */
  right: boolean;
  left: boolean;
}

export type SwipePhase = 'idle' | 'pending' | 'swiping' | 'cancelled';

export type SwipeEffect =
  | { type: 'none' }
  /** Жест стал свайпом: отменить долгое нажатие, не прокручивать. */
  | { type: 'start' }
  /** Сдвиг карточки и действие под порогом; `crossed` — действие сменилось (отклик). */
  | { type: 'move'; offset: number; action: SwipeAction | null; crossed: boolean }
  | { type: 'commit'; action: SwipeAction; offset: number }
  /** Свайп не состоялся: вернуть карточку на место (`wasSwiping`) или ничего не делать. */
  | { type: 'cancel'; wasSwiping: boolean };

const NONE: SwipeEffect = { type: 'none' };

/** Действие для сдвига `offset` карточки шириной `width`. */
export function swipeActionFor(offset: number, width: number, options: SwipeOptions = DEFAULT_SWIPE_OPTIONS): SwipeAction | null {
  if (width <= 0) return null;
  const ratio = Math.abs(offset) / width;
  if (offset > 0) return ratio >= options.threshold ? 'complete' : null;
  if (offset < 0) {
    if (ratio >= options.deleteThreshold) return 'delete';
    return ratio >= options.threshold ? 'postpone' : null;
  }
  return null;
}

export class SwipeGesture {
  private phase: SwipePhase = 'idle';
  private start: SwipeStart | null = null;
  private offset = 0;
  private action: SwipeAction | null = null;

  constructor(private readonly options: SwipeOptions = DEFAULT_SWIPE_OPTIONS) {}

  getPhase(): SwipePhase {
    return this.phase;
  }

  isSwiping(): boolean {
    return this.phase === 'swiping';
  }

  down(start: SwipeStart): void {
    this.start = start.right || start.left ? start : null;
    this.phase = this.start ? 'pending' : 'idle';
    this.offset = 0;
    this.action = null;
  }

  move(x: number, y: number): SwipeEffect {
    const start = this.start;
    if (!start) return NONE;
    const dx = x - start.x;
    const dy = y - start.y;
    if (this.phase === 'pending') {
      const ax = Math.abs(dx);
      const ay = Math.abs(dy);
      if (ay > this.options.lockDistance && ay >= ax) {
        // Вертикально — прокрутка списка.
        this.phase = 'cancelled';
        return { type: 'cancel', wasSwiping: false };
      }
      if (ax <= this.options.lockDistance || ax < ay * this.options.axisRatio) return NONE;
      if ((dx > 0 && !start.right) || (dx < 0 && !start.left)) {
        this.phase = 'cancelled';
        return { type: 'cancel', wasSwiping: false };
      }
      this.phase = 'swiping';
      return { type: 'start' };
    }
    if (this.phase !== 'swiping') return NONE;
    let offset = dx;
    // Запрещённое направление: карточка не уезжает дальше нуля.
    if ((offset > 0 && !start.right) || (offset < 0 && !start.left)) offset = 0;
    offset = Math.max(-start.width, Math.min(start.width, offset));
    const action = swipeActionFor(offset, start.width, this.options);
    const crossed = action !== this.action;
    this.offset = offset;
    this.action = action;
    return { type: 'move', offset, action, crossed };
  }

  up(): SwipeEffect {
    const phase = this.phase;
    const action = this.action;
    const offset = this.offset;
    this.reset();
    if (phase !== 'swiping') return NONE;
    if (action) return { type: 'commit', action, offset };
    return { type: 'cancel', wasSwiping: true };
  }

  /** `pointercancel` (началась прокрутка), Escape, перерисовка. */
  cancel(): SwipeEffect {
    const wasSwiping = this.phase === 'swiping';
    const active = this.phase === 'pending' || wasSwiping;
    this.reset();
    return active ? { type: 'cancel', wasSwiping } : NONE;
  }

  private reset(): void {
    this.phase = 'idle';
    this.start = null;
    this.offset = 0;
    this.action = null;
  }
}

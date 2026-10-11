/**
 * Листание дней свайпом в режимах «Список» и «Временная шкала» (доработка 007). Чистый модуль:
 * без DOM и `obsidian`.
 *
 * - Влево — следующий день, вправо — предыдущий; содержимое дня едет за пальцем.
 * - Направление распознаётся по первым `lockDistance` px: вертикальный сдвиг — прокрутка, жест отменяется.
 * - Переход — за порогом `threshold` ширины области или быстрым «фликом» (`flickVelocity`, px/мс);
 *   иначе содержимое пружинит назад. Пересечение порога — эффект `move` с `crossed: true` (отклик).
 * - Если палец не сдвинулся до долгого нажатия (`longPressMs`), жест отменяется: это меню элемента
 *   или создание события на шкале.
 * - Горизонтальное колесо (тачпад) — `DayWheel`, клавиатура — `dayKeyStep`.
 */

/** Смена дня: `1` — следующий, `-1` — предыдущий. */
export type DayStep = -1 | 1;

export interface DaySwipeOptions {
  /** Сдвиг, после которого понятно направление жеста, px. */
  lockDistance: number;
  /** Во сколько раз горизонтальный сдвиг должен превышать вертикальный, чтобы стать свайпом. */
  axisRatio: number;
  /** Порог перехода, доля ширины области. */
  threshold: number;
  /** Скорость «флика», px/мс. */
  flickVelocity: number;
  /** Минимальный сдвиг для «флика», px. */
  flickMinDistance: number;
  /** Окно усреднения скорости, мс. */
  velocityWindowMs: number;
  /** Неподвижное удержание дольше этого — долгое нажатие, а не свайп, мс. */
  longPressMs: number;
}

export const DEFAULT_DAY_SWIPE_OPTIONS: DaySwipeOptions = {
  lockDistance: 10,
  axisRatio: 1.2,
  threshold: 0.25,
  flickVelocity: 0.5,
  flickMinDistance: 30,
  velocityWindowMs: 100,
  longPressMs: 450,
};

export interface DaySwipeStart {
  x: number;
  y: number;
  /** Время события, мс. */
  time: number;
  /** Ширина области дня, px. */
  width: number;
}

export type DaySwipePhase = 'idle' | 'pending' | 'swiping' | 'cancelled';

export type DaySwipeEffect =
  | { type: 'none' }
  /** Жест стал свайпом: отменить долгое нажатие, не прокручивать. */
  | { type: 'start' }
  /** Сдвиг содержимого; `armed` — отпускание сменит день, `crossed` — `armed` только что изменился. */
  | { type: 'move'; offset: number; armed: boolean; crossed: boolean }
  /** Сменить день на `step`; `offset` — текущий сдвиг. */
  | { type: 'commit'; step: DayStep; offset: number }
  /** Свайп не состоялся: вернуть содержимое на место (`wasSwiping`) или ничего не делать. */
  | { type: 'cancel'; wasSwiping: boolean };

const NONE: DaySwipeEffect = { type: 'none' };

/** Сдвиг пальца → шаг дня: влево (отрицательный) — следующий. */
export function stepForOffset(offset: number): DayStep {
  return offset < 0 ? 1 : -1;
}

/** Отпускание при сдвиге `offset` и скорости `velocity` (px/мс) меняет день. */
export function shouldCommit(offset: number, velocity: number, width: number, options: DaySwipeOptions = DEFAULT_DAY_SWIPE_OPTIONS): boolean {
  if (width <= 0 || offset === 0) return false;
  if (Math.abs(offset) >= width * options.threshold) return true;
  // «Флик»: быстро и в ту же сторону, что и сдвиг.
  return Math.abs(offset) >= options.flickMinDistance && Math.abs(velocity) >= options.flickVelocity && Math.sign(velocity) === Math.sign(offset);
}

interface Sample {
  x: number;
  time: number;
}

export class DaySwipeGesture {
  private phase: DaySwipePhase = 'idle';
  private start: DaySwipeStart | null = null;
  private offset = 0;
  private armed = false;
  private samples: Sample[] = [];

  constructor(private readonly options: DaySwipeOptions = DEFAULT_DAY_SWIPE_OPTIONS) {}

  getPhase(): DaySwipePhase {
    return this.phase;
  }

  isSwiping(): boolean {
    return this.phase === 'swiping';
  }

  down(start: DaySwipeStart): void {
    this.reset();
    if (start.width <= 0) return;
    this.start = start;
    this.phase = 'pending';
    this.samples = [{ x: start.x, time: start.time }];
  }

  move(x: number, y: number, time: number): DaySwipeEffect {
    const start = this.start;
    if (!start) return NONE;
    const dx = x - start.x;
    const dy = y - start.y;
    if (this.phase === 'pending') {
      const ax = Math.abs(dx);
      const ay = Math.abs(dy);
      if (ax <= this.options.lockDistance && ay <= this.options.lockDistance) {
        // Палец стоит дольше долгого нажатия — это меню или новое событие, не свайп.
        if (time - start.time >= this.options.longPressMs) return this.abort();
        return NONE;
      }
      if (time - start.time >= this.options.longPressMs) return this.abort();
      // Вертикально (или наискось) — прокрутка списка или шкалы.
      if (ax < ay * this.options.axisRatio) return this.abort();
      this.phase = 'swiping';
      this.push(x, time);
      return { type: 'start' };
    }
    if (this.phase !== 'swiping') return NONE;
    this.push(x, time);
    const offset = Math.max(-start.width, Math.min(start.width, dx));
    const armed = Math.abs(offset) >= start.width * this.options.threshold;
    const crossed = armed !== this.armed;
    this.offset = offset;
    this.armed = armed;
    return { type: 'move', offset, armed, crossed };
  }

  /** Отпускание пальца в момент `time`. */
  up(time: number): DaySwipeEffect {
    const phase = this.phase;
    const start = this.start;
    const offset = this.offset;
    const velocity = this.velocity(time);
    this.reset();
    if (phase !== 'swiping' || !start) return NONE;
    if (shouldCommit(offset, velocity, start.width, this.options)) return { type: 'commit', step: stepForOffset(offset), offset };
    return { type: 'cancel', wasSwiping: true };
  }

  /** `pointercancel` (началась прокрутка), Escape, перерисовка. */
  cancel(): DaySwipeEffect {
    const wasSwiping = this.phase === 'swiping';
    const active = this.phase === 'pending' || wasSwiping;
    this.reset();
    return active ? { type: 'cancel', wasSwiping } : NONE;
  }

  /** Скорость по последним точкам окна `velocityWindowMs`, px/мс. */
  private velocity(now: number): number {
    const recent = this.samples.filter((sample) => now - sample.time <= this.options.velocityWindowMs);
    const first = recent[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || !last) return 0;
    const span = Math.max(last.time, now) - first.time;
    if (span <= 0) return 0;
    return (last.x - first.x) / span;
  }

  private push(x: number, time: number): void {
    this.samples.push({ x, time });
    // Хранить достаточно для окна скорости.
    const cutoff = time - this.options.velocityWindowMs * 2;
    while (this.samples.length > 2 && (this.samples[0]?.time ?? time) < cutoff) this.samples.shift();
  }

  private abort(): DaySwipeEffect {
    this.reset();
    this.phase = 'cancelled';
    return { type: 'cancel', wasSwiping: false };
  }

  private reset(): void {
    this.phase = 'idle';
    this.start = null;
    this.offset = 0;
    this.armed = false;
    this.samples = [];
  }
}

// ---------------------------------------------------------------------------
// Горизонтальное колесо (тачпад) и клавиатура
// ---------------------------------------------------------------------------

export interface DayWheelOptions {
  /** Накопленный горизонтальный сдвиг для смены дня, px. */
  threshold: number;
  /** Пауза между событиями, после которой начинается новый жест, мс. */
  idleMs: number;
}

export const DEFAULT_DAY_WHEEL_OPTIONS: DayWheelOptions = { threshold: 60, idleMs: 220 };

/**
 * Один жест тачпада (включая инерцию) — не больше одного дня: после смены дня события того же
 * жеста игнорируются, пока не будет паузы `idleMs`.
 */
export class DayWheel {
  private sum = 0;
  private lastTime = -Infinity;
  private locked = false;

  constructor(private readonly options: DayWheelOptions = DEFAULT_DAY_WHEEL_OPTIONS) {}

  /** Горизонтальное ли событие (его нужно перехватить, а не отдавать прокрутке). */
  static isHorizontal(deltaX: number, deltaY: number): boolean {
    return Math.abs(deltaX) > Math.abs(deltaY);
  }

  /** Событие колеса в момент `time`; возвращает шаг дня или `0`. */
  push(deltaX: number, time: number): DayStep | 0 {
    if (time - this.lastTime > this.options.idleMs) {
      this.sum = 0;
      this.locked = false;
    }
    this.lastTime = time;
    if (this.locked) return 0;
    this.sum += deltaX;
    if (Math.abs(this.sum) < this.options.threshold) return 0;
    const step: DayStep = this.sum > 0 ? 1 : -1;
    this.sum = 0;
    this.locked = true;
    return step;
  }
}

/** Стрелки ←/→ без модификаторов: предыдущий и следующий день. */
export function dayKeyStep(evt: { key: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }): DayStep | 0 {
  if (evt.altKey || evt.ctrlKey || evt.metaKey || evt.shiftKey) return 0;
  if (evt.key === 'ArrowLeft') return -1;
  if (evt.key === 'ArrowRight') return 1;
  return 0;
}

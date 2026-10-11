/**
 * Кадрировщик фона обоев (доработка 007, п.14 и мини-редактор композиции):
 * полноэкранный лист — фото на весь экран телефона (пропорции профиля), поверх —
 * полупрозрачные карточки обоев и макет часов iOS.
 *
 * Жесты: один палец — сдвиг (фото точно под пальцем), два пальца — масштаб 1–4×
 * от точки между пальцами, колесо мыши и Ctrl+колесо — масштаб от курсора,
 * двойное касание — вписать заново. Математика — `crop-math.ts`.
 */

import type { SheetHandle, SheetPresenter } from '../app/contracts';
import { t } from '../i18n';
import type { VaultPath, WallpaperCrop, WallpaperProfile } from '../model/types';
import type { HapticKind } from '../ui/haptics';
import { findBackgroundError, type ImageLease } from './background';
import type { CardBox } from './composition';
import {
  DEFAULT_CROP,
  clampCrop,
  cropSourceRect,
  distance,
  fitView,
  midpoint,
  panCropBy,
  pinchCrop,
  sameCrop,
  wheelZoomFactor,
  zoomCropAt,
  type CropChange,
  type Point,
  type Size,
} from './crop-math';
import { renderIosOverlay } from './ios-overlay';

/** Наибольшая сторона холста кадрировщика, px (память iOS). */
const MAX_CANVAS_SIDE = 2400;
/** Двойное касание: интервал и допуск, мс / CSS px. */
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_SLOP = 30;
const TAP_SLOP = 8;

export interface CropEditorDeps {
  sheets: SheetPresenter;
  /** Картинка фона; ошибка — `WallpaperBackgroundError`. */
  acquireImage(path: VaultPath): Promise<ImageLease>;
  haptic?(kind: HapticKind): void;
}

export interface CropEditorOptions {
  path: VaultPath;
  crop: WallpaperCrop;
  profile: WallpaperProfile;
  /** Карточки обоев (пиксели профиля) и их заливка. */
  cards: readonly CardBox[];
  cardFill: string;
  clock: { date: string; time: string };
  widgets: boolean;
  /** Подпись причины, если картинка не открылась. */
  describeError(error: unknown): string;
  onDone(crop: WallpaperCrop): void;
  /** Лист закрыт (после «Готово» или отмены). */
  onClose?(): void;
}

export function openCropEditor(deps: CropEditorDeps, options: CropEditorOptions): SheetHandle {
  const editor = new CropEditor(deps, options);
  const handle = deps.sheets.open({
    title: t('lockscreen.crop.title'),
    submitLabel: t('lockscreen.crop.done'),
    fullScreenOnPhone: true,
    cls: 'mp-crop-sheet',
    render: (contentEl, sheet) => editor.render(contentEl, sheet),
    onSubmit: () => editor.submit(),
    onClose: () => {
      editor.dispose();
      options.onClose?.();
    },
    isDirty: () => editor.isDirty(),
    haptic: (kind) => deps.haptic?.(kind),
  });
  return handle;
}

interface Gesture {
  crop: WallpaperCrop;
  /** Указатели на начало жеста (CSS px вида). */
  points: Map<number, Point>;
  /** Масштаб уже упирался в предел (отклик один раз за жест). */
  limited: boolean;
}

class CropEditor {
  private crop: WallpaperCrop;
  private initial: WallpaperCrop;
  private image: ImageLease | null = null;
  private view: Size = { width: 0, height: 0 };
  private frameEl: HTMLElement | null = null;
  private stageEl: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private zoomEl: HTMLElement | null = null;
  private messageEl: HTMLElement | null = null;
  private sheet: SheetHandle | null = null;
  private readonly pointers = new Map<number, Point>();
  private gesture: Gesture | null = null;
  private tapStart: { point: Point; time: number; moved: boolean } | null = null;
  private lastTap: { point: Point; time: number } | null = null;
  private frame: number | null = null;
  private disposed = false;
  private readonly cleanups: (() => void)[] = [];

  constructor(
    private readonly deps: CropEditorDeps,
    private readonly options: CropEditorOptions,
  ) {
    this.crop = { ...options.crop };
    this.initial = { ...options.crop };
  }

  // --- Лист ---

  render(contentEl: HTMLElement, sheet: SheetHandle): void {
    this.sheet = sheet;
    const root = contentEl.createDiv({ cls: 'mp-crop' });
    const stage = root.createDiv({ cls: 'mp-crop-stage' });
    this.stageEl = stage;
    const frame = stage.createDiv({ cls: 'mp-crop-frame', attr: { role: 'img', 'aria-label': t('lockscreen.crop.label'), tabindex: '0' } });
    frame.setCssProps({ '--mp-ls-aspect': `${this.options.profile.width} / ${this.options.profile.height}` });
    this.frameEl = frame;
    this.canvas = frame.createEl('canvas', { cls: 'mp-crop-canvas' });
    renderIosOverlay(frame, { ...this.options.clock, widgets: this.options.widgets, zones: true });
    this.messageEl = frame.createDiv({ cls: 'mp-crop-message', text: t('lockscreen.crop.loading') });

    const footer = root.createDiv({ cls: 'mp-crop-footer' });
    const info = footer.createDiv({ cls: 'mp-crop-info' });
    info.createDiv({ cls: 'mp-crop-hint', text: t('lockscreen.crop.hint') });
    this.zoomEl = info.createDiv({ cls: 'mp-crop-zoom', attr: { 'aria-live': 'polite' } });
    const actions = footer.createDiv({ cls: 'mp-crop-actions' });
    const reset = actions.createEl('button', { cls: 'mp-ls-button', text: t('lockscreen.crop.reset'), attr: { type: 'button' } });
    reset.addEventListener('click', () => this.reset());
    const done = actions.createEl('button', { cls: 'mp-ls-button mod-primary', text: t('lockscreen.crop.done'), attr: { type: 'button' } });
    done.addEventListener('click', () => sheet.submit?.());

    this.attachGestures(frame);
    this.observeSize(stage);
    this.updateZoomLabel();
    void this.load();
  }

  isDirty(): boolean {
    return !sameCrop(this.crop, this.initial);
  }

  submit(): boolean {
    this.options.onDone(roundCrop(this.crop));
    this.deps.haptic?.('success');
    return true;
  }

  dispose(): void {
    this.disposed = true;
    if (this.frame !== null) window.cancelAnimationFrame(this.frame);
    this.frame = null;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.image?.release();
    this.image = null;
    if (this.canvas) {
      // iOS держит память холста, пока у него есть размер.
      this.canvas.width = 0;
      this.canvas.height = 0;
    }
    this.canvas = null;
  }

  // --- Картинка ---

  private async load(): Promise<void> {
    try {
      const lease = await this.deps.acquireImage(this.options.path);
      if (this.disposed) {
        lease.release();
        return;
      }
      this.image = lease;
      // Сохранённый кадр мог выходить за края — точка отсчёта «без изменений» тоже в пределах.
      this.crop = clampCrop(this.imageSize(), this.options.profile, this.crop);
      this.initial = clampCrop(this.imageSize(), this.options.profile, this.initial);
      this.messageEl?.remove();
      this.messageEl = null;
      this.updateZoomLabel();
      this.requestDraw();
    } catch (error) {
      if (this.disposed) return;
      console.error('[matrix-planner] crop image failed', error);
      this.deps.haptic?.('error');
      this.messageEl?.setText(this.options.describeError(findBackgroundError(error) ?? error));
      this.messageEl?.addClass('is-error');
      this.sheet?.setSubmitEnabled(false);
    }
  }

  private imageSize(): Size {
    const image = this.image?.image;
    return image ? { width: image.width, height: image.height } : { width: 0, height: 0 };
  }

  // --- Размер и рисование ---

  private observeSize(stage: HTMLElement): void {
    const update = (): void => this.layout();
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(update);
      observer.observe(stage);
      this.cleanups.push(() => observer.disconnect());
    }
    window.requestAnimationFrame(update);
  }

  private layout(): void {
    const stage = this.stageEl;
    const frame = this.frameEl;
    const canvas = this.canvas;
    if (!stage || !frame || !canvas || this.disposed) return;
    const box = { width: stage.clientWidth, height: stage.clientHeight };
    const view = fitView(this.options.profile, box);
    if (view.width <= 0 || view.height <= 0) return;
    this.view = view;
    frame.setCssStyles({ width: `${view.width}px`, height: `${view.height}px` });
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const k = Math.min(dpr, MAX_CANVAS_SIDE / Math.max(view.width, view.height));
    const width = Math.max(1, Math.round(view.width * k));
    const height = Math.max(1, Math.round(view.height * k));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    this.requestDraw();
  }

  private requestDraw(): void {
    if (this.frame !== null || this.disposed) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = null;
      this.draw();
    });
  }

  private draw(): void {
    const canvas = this.canvas;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const { width, height } = canvas;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#1C1C1E';
    ctx.fillRect(0, 0, width, height);
    const image = this.image?.image;
    if (image) {
      const r = cropSourceRect(this.imageSize(), this.options.profile, this.crop);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(image.source, r.sx, r.sy, r.sw, r.sh, 0, 0, width, height);
    }
    // Карточки обоев — полупрозрачно, чтобы видеть, что под ними.
    const k = width / this.options.profile.width;
    ctx.save();
    for (const card of this.options.cards) {
      roundRect(ctx, card.x * k, card.y * k, card.w * k, card.h * k, card.radius * k);
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = this.options.cardFill;
      ctx.fill();
      ctx.globalAlpha = 0.7;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.lineWidth = Math.max(1, k * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  private updateZoomLabel(): void {
    this.zoomEl?.setText(t('lockscreen.crop.zoom', { percent: Math.round(this.crop.scale * 100) }));
  }

  private apply(change: CropChange, gesture: Gesture | null): void {
    if (change.scaleLimited && gesture && !gesture.limited) {
      gesture.limited = true;
      this.deps.haptic?.('threshold');
    } else if (!change.scaleLimited && gesture) {
      gesture.limited = false;
    }
    this.crop = change.crop;
    this.updateZoomLabel();
    this.requestDraw();
  }

  private reset(): void {
    this.lastResetAt = Date.now();
    this.crop = clampCrop(this.imageSize(), this.options.profile, { ...DEFAULT_CROP });
    this.gesture = this.pointers.size > 0 ? this.startGesture() : null;
    this.deps.haptic?.('select');
    this.updateZoomLabel();
    this.requestDraw();
  }

  // --- Жесты ---

  private localPoint(evt: { clientX: number; clientY: number }): Point {
    const rect = this.frameEl?.getBoundingClientRect();
    return rect ? { x: evt.clientX - rect.left, y: evt.clientY - rect.top } : { x: 0, y: 0 };
  }

  private startGesture(): Gesture {
    return { crop: { ...this.crop }, points: new Map(this.pointers), limited: false };
  }

  private attachGestures(frame: HTMLElement): void {
    const down = (evt: PointerEvent): void => {
      if (!this.image) return;
      evt.preventDefault();
      frame.setPointerCapture?.(evt.pointerId);
      const point = this.localPoint(evt);
      this.pointers.set(evt.pointerId, point);
      // Новый палец — новая точка отсчёта жеста.
      this.gesture = this.startGesture();
      this.tapStart = this.pointers.size === 1 ? { point, time: evt.timeStamp, moved: false } : null;
    };
    const move = (evt: PointerEvent): void => {
      if (!this.pointers.has(evt.pointerId) || !this.gesture) return;
      evt.preventDefault();
      const point = this.localPoint(evt);
      this.pointers.set(evt.pointerId, point);
      const gesture = this.gesture;
      const image = this.imageSize();
      const frameSize = this.options.profile;
      if (this.tapStart && distance(this.tapStart.point, point) > TAP_SLOP) this.tapStart.moved = true;
      const ids = [...this.pointers.keys()];
      if (ids.length >= 2) {
        const [a, b] = ids;
        const startA = gesture.points.get(a);
        const startB = gesture.points.get(b);
        const nowA = this.pointers.get(a);
        const nowB = this.pointers.get(b);
        if (!startA || !startB || !nowA || !nowB) return;
        this.apply(
          pinchCrop(image, frameSize, gesture.crop, this.view, { center: midpoint(startA, startB), distance: distance(startA, startB) }, { center: midpoint(nowA, nowB), distance: distance(nowA, nowB) }),
          gesture,
        );
        return;
      }
      const start = gesture.points.get(evt.pointerId);
      if (!start) return;
      this.apply(panCropBy(image, frameSize, gesture.crop, this.view, { x: point.x - start.x, y: point.y - start.y }), gesture);
    };
    const up = (evt: PointerEvent): void => {
      if (!this.pointers.has(evt.pointerId)) return;
      this.pointers.delete(evt.pointerId);
      const tap = this.tapStart;
      this.tapStart = null;
      // Оставшиеся пальцы продолжают жест от текущего кадра.
      this.gesture = this.pointers.size > 0 ? this.startGesture() : null;
      if (evt.type !== 'pointerup' || !tap || tap.moved || this.pointers.size > 0) return;
      const point = this.localPoint(evt);
      const last = this.lastTap;
      if (last && evt.timeStamp - last.time <= DOUBLE_TAP_MS && distance(last.point, point) <= DOUBLE_TAP_SLOP) {
        this.lastTap = null;
        this.reset();
        return;
      }
      this.lastTap = { point, time: evt.timeStamp };
    };
    const wheel = (evt: WheelEvent): void => {
      if (!this.image) return;
      evt.preventDefault();
      const gesture: Gesture = this.wheelGesture ?? { crop: this.crop, points: new Map(), limited: false };
      this.wheelGesture = gesture;
      if (this.wheelTimer !== null) window.clearTimeout(this.wheelTimer);
      this.wheelTimer = window.setTimeout(() => {
        this.wheelGesture = null;
        this.wheelTimer = null;
      }, 250);
      const factor = wheelZoomFactor(evt.deltaY, evt.ctrlKey, evt.deltaMode);
      this.apply(zoomCropAt(this.imageSize(), this.options.profile, this.crop, this.view, factor, this.localPoint(evt)), gesture);
    };
    const dblclick = (evt: MouseEvent): void => {
      // Двойной щелчок мышью; касания обрабатываются в `up`.
      evt.preventDefault();
      // После двойного касания браузер может прислать и `dblclick` — второй сброс не нужен.
      if (this.image && Date.now() - this.lastResetAt > 500) this.reset();
    };
    const key = (evt: KeyboardEvent): void => {
      if (!this.image) return;
      const step = 12;
      const moves: Record<string, Point> = { ArrowLeft: { x: step, y: 0 }, ArrowRight: { x: -step, y: 0 }, ArrowUp: { x: 0, y: step }, ArrowDown: { x: 0, y: -step } };
      const center = { x: this.view.width / 2, y: this.view.height / 2 };
      if (moves[evt.key]) {
        this.apply(panCropBy(this.imageSize(), this.options.profile, this.crop, this.view, moves[evt.key]), null);
      } else if (evt.key === '+' || evt.key === '=') {
        this.apply(zoomCropAt(this.imageSize(), this.options.profile, this.crop, this.view, 1.1, center), null);
      } else if (evt.key === '-') {
        this.apply(zoomCropAt(this.imageSize(), this.options.profile, this.crop, this.view, 1 / 1.1, center), null);
      } else {
        return;
      }
      evt.preventDefault();
    };
    frame.addEventListener('pointerdown', down);
    frame.addEventListener('pointermove', move);
    frame.addEventListener('pointerup', up);
    frame.addEventListener('pointercancel', up);
    frame.addEventListener('wheel', wheel, { passive: false });
    frame.addEventListener('dblclick', dblclick);
    frame.addEventListener('keydown', key);
    this.cleanups.push(() => {
      frame.removeEventListener('pointerdown', down);
      frame.removeEventListener('pointermove', move);
      frame.removeEventListener('pointerup', up);
      frame.removeEventListener('pointercancel', up);
      frame.removeEventListener('wheel', wheel);
      frame.removeEventListener('dblclick', dblclick);
      frame.removeEventListener('keydown', key);
      if (this.wheelTimer !== null) window.clearTimeout(this.wheelTimer);
    });
  }

  private lastResetAt = 0;
  private wheelGesture: Gesture | null = null;
  private wheelTimer: number | null = null;
}

/** Кадр для черновика: доли с точностью 1e-4. */
function roundCrop(crop: WallpaperCrop): WallpaperCrop {
  const r = (value: number): number => Math.round(value * 10000) / 10000;
  return { centerX: r(crop.centerX), centerY: r(crop.centerY), scale: r(crop.scale) };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: number): void {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

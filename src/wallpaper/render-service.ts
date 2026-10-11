/**
 * Сервис обоев (ТЗ §4.5): пакет PNG на семь дат + `lock.png`, предпросмотр, очистка.
 *
 * Порядок записи защищает прежние файлы: сначала датированные `lock-ГГГГ-ММ-ДД.png`,
 * затем запасной `lock-expired.png` (день после пакета, шаблон «Обои устарели»),
 * `lock.png` — последним и только при удачном рендере на сегодня. Данные читаются
 * один раз в начале; в результате — ревизия данных на этот момент, поэтому правки,
 * сделанные во время рендера, не считаются перенесёнными на экран блокировки.
 *
 * Отпечаток пакета — хеш входа раскладки на все даты (задачи, события, настройки,
 * профиль, дата, зона, версия шаблона). Совпал с сохранённым и файлы на месте — пакет
 * не перерисовывается; одинаковые PNG не переписываются (`writeIfChanged`).
 * Недоступный фон (`WallpaperBackgroundError`) останавливает пакет до записи: прежние PNG остаются.
 */

import { Platform } from 'obsidian';
import type {
  Clock,
  DayItemsProvider,
  FormatPreferencesProvider,
  NoteIndex,
  SettingsStore,
  WallpaperLayoutFn,
  WallpaperRenderer,
  WallpaperRenderFailure,
  WallpaperRenderOptions,
  WallpaperRenderResult,
  WallpaperService,
} from '../app/contracts';
import { registerDictionary, t, tPlural } from '../i18n';
import { enWallpaperLayout } from '../i18n/en/wallpaper-layout';
import { enWallpaperRender } from '../i18n/en/wallpaper-render';
import { ruWallpaperLayout } from '../i18n/ru/wallpaper-layout';
import { ruWallpaperRender } from '../i18n/ru/wallpaper-render';
import { createDateLabelStrings, floatingFromDate, isValidTimeZone } from '../model/dates';
import type { LocalDateString, OpResult, PlannerError, VaultPath, WallpaperLayoutInput, WallpaperProfile, WallpaperSettings } from '../model/types';
import { WALLPAPER_LAYOUT_MODULE, createWallpaperStrings, layoutWallpaper } from './layout';
import type { WallpaperOutputRepository } from './output-repository';
import { resolveProfile as resolveProfileSetting, type ScreenInfo } from './profiles';
import { createLayoutInput, expiredDate, formatWallpaperDue, packFingerprint, planRenderDates, renderDataRange } from './render-plan';
import type { WallpaperLayoutStrings } from './types';

registerDictionary('ru', WALLPAPER_LAYOUT_MODULE, ruWallpaperLayout);
registerDictionary('en', WALLPAPER_LAYOUT_MODULE, enWallpaperLayout);
registerDictionary('ru', 'wallpaperRender', ruWallpaperRender);
registerDictionary('en', 'wallpaperRender', enWallpaperRender);

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Renderer с необязательным освобождением кэшей после пакета (теперь часть контракта). */
export type BatchWallpaperRenderer = WallpaperRenderer;

export interface WallpaperRenderServiceDeps {
  settings: Pick<SettingsStore, 'get'>;
  index: Pick<NoteIndex, 'getTasks' | 'getMatrix'>;
  dayItems: Pick<DayItemsProvider, 'getDays' | 'prepare'>;
  output: WallpaperOutputRepository;
  renderer: BatchWallpaperRenderer;
  clock: Clock;
  format: FormatPreferencesProvider;
  /** Ревизия данных (`WallpaperStatusTracker.getDataRevision`). */
  getDataRevision(): number;
  /** Размер экрана для автопрофиля; по умолчанию `screen × devicePixelRatio`. */
  getScreen?(): ScreenInfo | null;
  /** Телефон или планшет; на компьютере автопрофиль — iPhone по умолчанию. По умолчанию `Platform.isMobile`. */
  isMobile?(): boolean;
  /**
   * Отметка файла фона (время изменения и размер) для отпечатка: замена картинки
   * под тем же путём должна перерисовать пакет. `null` — файла нет.
   */
  backgroundStamp?(path: VaultPath): string | null;
  /** Подмена раскладки (тесты). */
  layout?: WallpaperLayoutFn;
  /** Подмена строк раскладки (тесты); по умолчанию — из словарей через `t`. */
  strings?(hour12: boolean): WallpaperLayoutStrings;
  translate?: Translate;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Коды недоступного фона (`WallpaperBackgroundError` из `background.ts`). */
export const BACKGROUND_ERROR_CODES = ['missing', 'read', 'decode'] as const;
export type BackgroundErrorCode = (typeof BACKGROUND_ERROR_CODES)[number];

/** Код ошибки фона или `null`, если это другая ошибка рендера. */
export function backgroundErrorCode(error: unknown): BackgroundErrorCode | null {
  if (!(error instanceof Error)) return null;
  const code = (error as { code?: unknown }).code;
  const isBackground = error.name === 'WallpaperBackgroundError' || error.constructor.name === 'WallpaperBackgroundError';
  if (!isBackground || typeof code !== 'string') return null;
  return (BACKGROUND_ERROR_CODES as readonly string[]).includes(code) ? (code as BackgroundErrorCode) : null;
}

/** Ключ i18n причины для недоступного фона (словарь `protocol`). */
export function backgroundErrorKey(code: BackgroundErrorCode): string {
  return `protocol.wallpaper.background.${code}`;
}

function defaultScreen(): ScreenInfo | null {
  if (typeof window === 'undefined') return null;
  const g = window as { screen?: { width: number; height: number }; devicePixelRatio?: number };
  if (!g.screen) return null;
  return { width: g.screen.width, height: g.screen.height, devicePixelRatio: g.devicePixelRatio ?? 1 };
}

export class PlannerWallpaperService implements WallpaperService {
  private inFlight: Promise<OpResult<WallpaperRenderResult>> | null = null;

  constructor(private readonly deps: WallpaperRenderServiceDeps) {}

  resolveProfile(settings?: WallpaperSettings): WallpaperProfile {
    const wallpaper = settings ?? this.deps.settings.get().wallpaper;
    const mobile = this.deps.isMobile ? this.deps.isMobile() : Platform.isMobile;
    return resolveProfileSetting(wallpaper.profile, (this.deps.getScreen ?? defaultScreen)(), { mobile });
  }

  /** Повторный вызов во время рендера получает тот же результат (без параллельных записей). */
  renderAll(options: WallpaperRenderOptions = {}): Promise<OpResult<WallpaperRenderResult>> {
    if (!this.inFlight) {
      this.inFlight = this.runBatch(options).finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  /** Отпечаток пакета на текущие данные без рендера (сверка свежести после перезапуска). */
  async computeFingerprint(): Promise<{ profileId: string; fingerprint: string }> {
    const settings = this.deps.settings.get().wallpaper;
    const profile = this.resolveProfile(settings);
    const dates = planRenderDates(this.today());
    await this.deps.dayItems.prepare?.();
    const snapshot = this.snapshot(dates);
    return { profileId: profile.id, fingerprint: this.fingerprint(dates, settings, profile, snapshot) };
  }

  async renderPreview(canvas: HTMLCanvasElement, draft: WallpaperSettings, date: LocalDateString): Promise<void> {
    const profile = this.resolveProfile(draft);
    await this.deps.dayItems.prepare?.();
    // Календари черновика, а не сохранённых настроек.
    const snapshot = this.snapshot([date], draft.calendarIds);
    const layout = this.layoutFor(date, draft, profile, snapshot);
    await this.deps.renderer.renderTo(canvas, { layout, background: draft.background });
  }

  getCurrentImagePath(): VaultPath | null {
    const path = this.deps.output.lockPath(this.resolveProfile().id);
    return this.deps.output.exists(path) ? path : null;
  }

  // -------------------------------------------------------------------------

  private async runBatch(options: WallpaperRenderOptions): Promise<OpResult<WallpaperRenderResult>> {
    // Ревизия — до чтения данных: всё, что изменится позже, останется «есть изменения».
    const dataRevision = this.deps.getDataRevision();
    const settings = this.deps.settings.get().wallpaper;
    const profile = this.resolveProfile(settings);
    const today = this.today();
    const dates = planRenderDates(today);
    const result: WallpaperRenderResult = { profile, written: [], failed: [], lockUpdated: false, dataRevision };
    let lastError: PlannerError | null = null;
    let todayPng: ArrayBuffer | null = null;
    let anyChanged = false;

    let snapshot: RenderSnapshot;
    try {
      await this.deps.dayItems.prepare?.();
      snapshot = this.snapshot(dates);
      result.fingerprint = this.fingerprint(dates, settings, profile, snapshot);
    } catch (error) {
      return { ok: false, error: { code: 'unknown', messageKey: 'wallpaperRender.errors.nothingSaved', detail: describeError(error), cause: error } };
    }

    // Те же данные, что в сохранённом пакете, и файлы на месте — ничего не рисуем.
    const known = options.knownFingerprint ?? null;
    if (known !== null && known === result.fingerprint && this.packComplete(profile.id, dates)) {
      const written = dates.map((date) => this.deps.output.datedPath(profile.id, date));
      return { ok: true, value: { ...result, written, lockUpdated: true, unchanged: true }, changed: false };
    }

    try {
      // Последовательно: в памяти одновременно один холст.
      for (const date of dates) {
        let png: ArrayBuffer;
        try {
          const layout = this.layoutFor(date, settings, profile, snapshot);
          png = await this.deps.renderer.render({ layout, background: settings.background });
        } catch (error) {
          const background = backgroundErrorCode(error);
          // Фон недоступен — так же на все даты: прежние PNG не трогаем.
          if (background !== null) return this.backgroundFailure(background, error);
          result.failed.push(this.failure(date, this.translate('wallpaperRender.errors.render', { date }), error));
          lastError = { code: 'unknown', messageKey: 'wallpaperRender.errors.render', detail: describeError(error) };
          continue;
        }
        const written = await this.deps.output.writeDated(profile.id, date, png);
        if (written.ok) {
          result.written.push(this.deps.output.datedPath(profile.id, date));
          anyChanged ||= written.changed;
        } else {
          result.failed.push({ date, detail: written.error.detail ?? written.error.code });
          lastError = written.error;
          // Иначе быстрая команда взяла бы прежний файл на сегодня вместо нового `lock.png`.
          if (date === today) await this.deps.output.removeDated(profile.id, date).catch(() => undefined);
        }
        if (date === today) todayPng = png;
      }

      // Запасной файл после пакета; сбой не влияет на результат (без файла пакет не считается полным).
      if (result.written.length > 0) anyChanged = (await this.writeExpired(dates, settings, profile, snapshot)) || anyChanged;

      // lock.png — последним: при сбое рендера на сегодня прежний файл не трогается.
      if (todayPng) {
        const lock = await this.deps.output.writeLock(profile.id, todayPng);
        if (lock.ok) {
          result.lockUpdated = true;
          anyChanged ||= lock.changed;
        } else {
          lastError = lock.error;
        }
      }
      todayPng = null;

      // Сбой очистки не влияет на результат: старые файлы удалятся в следующий раз.
      await this.deps.output.cleanup(profile.id, today).catch(() => undefined);
    } finally {
      this.deps.renderer.releaseResources?.();
    }

    if (result.written.length === 0 && !result.lockUpdated) {
      const error = lastError ?? { code: 'unknown' as const };
      return {
        ok: false,
        error: { ...error, messageKey: error.messageKey ?? 'wallpaperRender.errors.nothingSaved' },
      };
    }
    return { ok: true, value: result, changed: anyChanged };
  }

  /** `lock-expired.png`: `true` — файл изменён. */
  private async writeExpired(dates: readonly LocalDateString[], settings: WallpaperSettings, profile: WallpaperProfile, snapshot: RenderSnapshot): Promise<boolean> {
    try {
      const layout = this.layoutFor(expiredDate(dates), settings, profile, snapshot, true);
      const png = await this.deps.renderer.render({ layout, background: settings.background });
      const written = await this.deps.output.writeExpired(profile.id, png);
      return written.ok && written.changed;
    } catch {
      return false;
    }
  }

  private backgroundFailure(code: BackgroundErrorCode, error: unknown): OpResult<WallpaperRenderResult> {
    return {
      ok: false,
      error: { code: code === 'missing' ? 'not-found' : 'unknown', messageKey: backgroundErrorKey(code), detail: describeError(error), cause: error },
    };
  }

  /** Все файлы пакета на месте (датированные, `lock.png`, `lock-expired.png`). */
  private packComplete(profileId: string, dates: readonly LocalDateString[]): boolean {
    const { output } = this.deps;
    return (
      dates.every((date) => output.exists(output.datedPath(profileId, date))) &&
      output.exists(output.lockPath(profileId)) &&
      output.exists(output.expiredPath(profileId))
    );
  }

  /** Хеш входа раскладки на все даты пакета и запасной файл. */
  private fingerprint(dates: readonly LocalDateString[], settings: WallpaperSettings, profile: WallpaperProfile, snapshot: RenderSnapshot): string {
    const inputs = [
      ...dates.map((date) => this.inputFor(date, settings, profile, snapshot)),
      this.inputFor(expiredDate(dates), settings, profile, snapshot, true),
    ];
    const background = settings.background;
    return packFingerprint(snapshot.today, {
      zone: this.deps.clock.timeZone(),
      language: this.deps.format.get().language,
      background,
      backgroundStamp: background.kind === 'image' ? (this.deps.backgroundStamp?.(background.path) ?? null) : null,
      inputs,
    });
  }

  private failure(date: LocalDateString, message: string, error: unknown): WallpaperRenderFailure {
    return { date, detail: `${message}: ${describeError(error)}` };
  }

  private today(): LocalDateString {
    return this.now().date;
  }

  private now(): ReturnType<typeof floatingFromDate> {
    const zone = this.deps.clock.timeZone();
    return floatingFromDate(this.deps.clock.now(), isValidTimeZone(zone) ? zone : undefined);
  }

  /** Снимок данных на все даты сразу — пакет рисуется по одному состоянию. */
  private snapshot(dates: readonly LocalDateString[], calendarIds?: readonly string[] | null): RenderSnapshot {
    const now = this.now();
    const format = this.deps.format.get();
    return {
      today: now.date,
      now,
      weekStart: format.weekStart,
      hour12: format.hour12,
      tasks: this.deps.index.getTasks(),
      matrix: this.deps.index.getMatrix(),
      days: this.deps.dayItems.getDays(renderDataRange(dates), calendarIds === undefined ? { forWallpaper: true } : { forWallpaper: true, calendarIds }),
      strings: this.createStrings(format.hour12),
    };
  }

  private inputFor(date: LocalDateString, settings: WallpaperSettings, profile: WallpaperProfile, snapshot: RenderSnapshot, expired = false): WallpaperLayoutInput {
    return createLayoutInput({ ...snapshot, date, settings, profile, expired });
  }

  private layoutFor(date: LocalDateString, settings: WallpaperSettings, profile: WallpaperProfile, snapshot: RenderSnapshot, expired = false) {
    return (this.deps.layout ?? layoutWallpaper)(this.inputFor(date, settings, profile, snapshot, expired), this.deps.renderer.measurer);
  }

  private createStrings(hour12: boolean): WallpaperLayoutStrings {
    if (this.deps.strings) return this.deps.strings(hour12);
    const labels = createDateLabelStrings((key) => t(key));
    return createWallpaperStrings({
      translate: t,
      translatePlural: (key, count) => tPlural(key, count),
      formatDue: (due, relativeTo) => formatWallpaperDue(due, relativeTo, labels, hour12),
    });
  }

  private readonly translate: Translate = (key, params) => (this.deps.translate ?? t)(key, params);
}

interface RenderSnapshot {
  today: LocalDateString;
  now: ReturnType<typeof floatingFromDate>;
  weekStart: 0 | 1;
  hour12: boolean;
  tasks: ReturnType<NoteIndex['getTasks']>;
  matrix: ReturnType<NoteIndex['getMatrix']>;
  days: ReturnType<DayItemsProvider['getDays']>;
  strings: WallpaperLayoutStrings;
}

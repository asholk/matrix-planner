/**
 * Сервис обоев (ТЗ §4.5): пакет PNG на семь дат + `lock.png`, предпросмотр, очистка.
 *
 * Порядок записи защищает прежние файлы: сначала датированные `lock-ГГГГ-ММ-ДД.png`,
 * `lock.png` — последним и только при удачном рендере на сегодня. Данные читаются
 * один раз в начале; в результате — ревизия данных на этот момент, поэтому правки,
 * сделанные во время рендера, не считаются перенесёнными на экран блокировки.
 */

import type {
  Clock,
  DayItemsProvider,
  FormatPreferencesProvider,
  NoteIndex,
  SettingsStore,
  WallpaperLayoutFn,
  WallpaperRenderer,
  WallpaperRenderFailure,
  WallpaperRenderResult,
  WallpaperService,
} from '../app/contracts';
import { registerDictionary, t, tPlural } from '../i18n';
import { enWallpaperLayout } from '../i18n/en/wallpaper-layout';
import { enWallpaperRender } from '../i18n/en/wallpaper-render';
import { ruWallpaperLayout } from '../i18n/ru/wallpaper-layout';
import { ruWallpaperRender } from '../i18n/ru/wallpaper-render';
import { createDateLabelStrings, floatingFromDate, isValidTimeZone } from '../model/dates';
import type { LocalDateString, OpResult, PlannerError, VaultPath, WallpaperProfile, WallpaperSettings } from '../model/types';
import { WALLPAPER_LAYOUT_MODULE, createWallpaperStrings, layoutWallpaper } from './layout';
import type { WallpaperOutputRepository } from './output-repository';
import { resolveProfile as resolveProfileSetting, type ScreenInfo } from './profiles';
import { createLayoutInput, formatWallpaperDue, planRenderDates, renderDataRange } from './render-plan';
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
  dayItems: Pick<DayItemsProvider, 'getDays'>;
  output: WallpaperOutputRepository;
  renderer: BatchWallpaperRenderer;
  clock: Clock;
  format: FormatPreferencesProvider;
  /** Ревизия данных (`WallpaperStatusTracker.getDataRevision`). */
  getDataRevision(): number;
  /** Размер экрана для автопрофиля; по умолчанию `screen × devicePixelRatio`. */
  getScreen?(): ScreenInfo | null;
  /** Подмена раскладки (тесты). */
  layout?: WallpaperLayoutFn;
  /** Подмена строк раскладки (тесты); по умолчанию — из словарей через `t`. */
  strings?(hour12: boolean): WallpaperLayoutStrings;
  translate?: Translate;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultScreen(): ScreenInfo | null {
  const g = globalThis as { screen?: { width: number; height: number }; devicePixelRatio?: number };
  if (!g.screen) return null;
  return { width: g.screen.width, height: g.screen.height, devicePixelRatio: g.devicePixelRatio ?? 1 };
}

export class PlannerWallpaperService implements WallpaperService {
  private inFlight: Promise<OpResult<WallpaperRenderResult>> | null = null;

  constructor(private readonly deps: WallpaperRenderServiceDeps) {}

  resolveProfile(settings?: WallpaperSettings): WallpaperProfile {
    const wallpaper = settings ?? this.deps.settings.get().wallpaper;
    return resolveProfileSetting(wallpaper.profile, (this.deps.getScreen ?? defaultScreen)());
  }

  /** Повторный вызов во время рендера получает тот же результат (без параллельных записей). */
  renderAll(): Promise<OpResult<WallpaperRenderResult>> {
    if (!this.inFlight) {
      this.inFlight = this.runBatch().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  async renderPreview(canvas: HTMLCanvasElement, draft: WallpaperSettings, date: LocalDateString): Promise<void> {
    const profile = this.resolveProfile(draft);
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

  private async runBatch(): Promise<OpResult<WallpaperRenderResult>> {
    // Ревизия — до чтения данных: всё, что изменится позже, останется «есть изменения».
    const dataRevision = this.deps.getDataRevision();
    const settings = this.deps.settings.get().wallpaper;
    const profile = this.resolveProfile(settings);
    const today = this.today();
    const dates = planRenderDates(today);
    const result: WallpaperRenderResult = { profile, written: [], failed: [], lockUpdated: false, dataRevision };
    let lastError: PlannerError | null = null;
    let todayPng: ArrayBuffer | null = null;

    try {
      let snapshot: RenderSnapshot;
      try {
        snapshot = this.snapshot(dates);
      } catch (error) {
        return { ok: false, error: { code: 'unknown', messageKey: 'wallpaperRender.errors.nothingSaved', detail: describeError(error), cause: error } };
      }
      // Последовательно: в памяти одновременно один холст.
      for (const date of dates) {
        let png: ArrayBuffer;
        try {
          const layout = this.layoutFor(date, settings, profile, snapshot);
          png = await this.deps.renderer.render({ layout, background: settings.background });
        } catch (error) {
          result.failed.push(this.failure(date, this.translate('wallpaperRender.errors.render', { date }), error));
          lastError = { code: 'unknown', messageKey: 'wallpaperRender.errors.render', detail: describeError(error) };
          continue;
        }
        const written = await this.deps.output.writeDated(profile.id, date, png);
        if (written.ok) {
          result.written.push(this.deps.output.datedPath(profile.id, date));
        } else {
          result.failed.push({ date, detail: written.error.detail ?? written.error.code });
          lastError = written.error;
        }
        if (date === today) todayPng = png;
      }

      // lock.png — последним: при сбое рендера на сегодня прежний файл не трогается.
      if (todayPng) {
        const lock = await this.deps.output.writeLock(profile.id, todayPng);
        if (lock.ok) result.lockUpdated = true;
        else lastError = lock.error;
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
    return { ok: true, value: result, changed: true };
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

  private layoutFor(date: LocalDateString, settings: WallpaperSettings, profile: WallpaperProfile, snapshot: RenderSnapshot) {
    const input = createLayoutInput({ ...snapshot, date, settings, profile });
    return (this.deps.layout ?? layoutWallpaper)(input, this.deps.renderer.measurer);
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

/**
 * Статус обоев и баннер «Обновить экран блокировки» (ТЗ §4.5, §5.5; доработка 007).
 *
 * Разные события не смешиваются: «данные изменены» (ревизия), «PNG сохранены»,
 * «PNG готовы к установке», «команда запущена», «подтверждено» (`x-success`),
 * «отменено» (`x-cancel`), «ошибка» (`x-error` с `errorMessage` или сбой).
 * Время событий, запуск и отпечаток пакета хранятся в `companion.json` через `CompanionStore`.
 *
 * Фоновая подготовка: через ~4 с после последнего изменения (пока Obsidian на переднем
 * плане) и сразу при уходе в фон пакет рисуется без запуска команды. Повторный рендер
 * с тем же отпечатком данных пропускается сервисом.
 *
 * Жест пользователя: если PNG уже соответствуют данным, быстрая команда запускается
 * синхронно, до первого `await`. Иначе — пакет дорисовывается, и баннер предлагает
 * «Обои готовы · Установить»: второе нажатие открывает команду синхронно.
 */

import type {
  BannerDescription,
  Clock,
  CompanionStore,
  FormatPreferencesProvider,
  Notifier,
  PlatformInfo,
  WallpaperBannerState,
  WallpaperRenderResult,
  WallpaperService,
  WallpaperStatusTracker,
} from '../app/contracts';
import { registerDictionary, t } from '../i18n';
import { enProtocol } from '../i18n/en/protocol';
import { ruProtocol } from '../i18n/ru/protocol';
import { floatingFromDate, formatTimeLabel, isValidTimeZone, parseDateParts } from '../model/dates';
import { parseProfileId } from '../wallpaper/profiles';
import { datedFileName } from '../wallpaper/render-plan';
import type { WallpaperCallbackContext, WallpaperCallbackResult } from './handler';
import type { ProfileShortcutLauncher } from './shortcut-launcher';
import type { CompanionState, LocalDateString, Unsubscribe, WallpaperStatusRecord } from '../model/types';

registerDictionary('ru', 'protocol', ruProtocol);
registerDictionary('en', 'protocol', enProtocol);

export type WallpaperActionKind = 'update' | 'save';
type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Пауза фоновой подготовки после последнего изменения. */
export const PREPARE_DELAY_MS = 4_000;

// ===========================================================================
// Чистые функции: тексты баннера и статуса
// ===========================================================================

export type { BannerDescription };

export function describeBanner(state: WallpaperBannerState, actionKind: WallpaperActionKind, translate: Translate = t): BannerDescription {
  const actionLabel = translate(actionKind === 'update' ? 'protocol.wallpaper.actionUpdate' : 'protocol.wallpaper.actionSave');
  const base = { actionLabel, helpLabel: null, attention: false };
  const dirtyText = translate(actionKind === 'update' ? 'protocol.wallpaper.dirtyUpdate' : 'protocol.wallpaper.dirtySave');
  switch (state.kind) {
    case 'idle':
      return { ...base, text: actionLabel };
    case 'dirty':
      return { ...base, attention: true, text: dirtyText };
    case 'cancelled':
      // Отмена — не ошибка: изменения просто не перенесены.
      return { ...base, attention: true, text: dirtyText };
    case 'rendering':
      return { ...base, text: translate('protocol.wallpaper.rendering') };
    case 'saved':
      return { ...base, text: translate('protocol.wallpaper.saved') };
    case 'ready':
      if (actionKind === 'save') return { ...base, text: translate('protocol.wallpaper.saved') };
      return { ...base, actionLabel: translate('protocol.wallpaper.readyAction'), text: translate('protocol.wallpaper.readyHint') };
    case 'launched':
      return { ...base, text: translate('protocol.wallpaper.launched') };
    case 'confirmed':
      return { ...base, text: translate('protocol.wallpaper.confirmed') };
    case 'failed': {
      const reason = state.message ?? null;
      if (state.reason === 'render') {
        const text = reason ? translate('protocol.wallpaper.failedRenderReason', { reason }) : translate('protocol.wallpaper.failedRender');
        return { ...base, attention: true, text };
      }
      let text: string;
      if (state.reason === 'shortcut') text = translate('protocol.wallpaper.failedShortcut');
      else text = reason ? translate('protocol.wallpaper.failedInstallReason', { reason }) : translate('protocol.wallpaper.failedCallback');
      return { ...base, attention: true, text, helpLabel: translate('protocol.wallpaper.howToSetUp') };
    }
  }
}

export interface StatusFormatOptions {
  now: Date;
  /** IANA-зона; `undefined` — локальная зона устройства. */
  timeZone?: string;
  hour12: boolean;
  actionKind: WallpaperActionKind;
  translate?: Translate;
}

/** «10 окт.» / «Oct 10» без зависимости от ICU. */
export function formatShortDate(date: LocalDateString, translate: Translate = t): string {
  const parts = parseDateParts(date);
  if (!parts) return date;
  const month = translate(`protocol.wallpaper.months.m${parts.month}`);
  return translate('protocol.wallpaper.dayMonth', { day: parts.day, month });
}

function parseInstant(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Строка статуса карточки «Текущий».
 * iPhone/iPad: подтверждение сегодня — «Обои обновлены 10 окт. в 13:32»,
 * раньше — «Нет подтверждённого обновления с 9 окт.» (без утверждения, что автоматизация сломана).
 * Компьютер/Android: только время сохранения PNG.
 */
export function formatWallpaperStatus(record: WallpaperStatusRecord | null, options: StatusFormatOptions): string {
  const translate = options.translate ?? t;
  const today = floatingFromDate(options.now, options.timeZone).date;
  const stamp = (moment: Date): { date: string; time: string; day: LocalDateString } => {
    const local = floatingFromDate(moment, options.timeZone);
    return {
      day: local.date,
      date: formatShortDate(local.date, translate),
      time: formatTimeLabel(local.time, options.hour12, { am: 'AM', pm: 'PM' }),
    };
  };

  if (options.actionKind === 'save') {
    const saved = parseInstant(record?.savedAt);
    if (!saved) return translate('protocol.wallpaper.status.neverSaved');
    const s = stamp(saved);
    return translate('protocol.wallpaper.status.saved', { date: s.date, time: s.time });
  }

  const confirmed = parseInstant(record?.confirmedAt);
  if (!confirmed) return translate('protocol.wallpaper.status.neverConfirmed');
  const c = stamp(confirmed);
  if (c.day === today) return translate('protocol.wallpaper.status.confirmed', { date: c.date, time: c.time });
  return translate('protocol.wallpaper.status.notConfirmedSince', { date: c.date });
}

export function wallpaperRecordOf(state: CompanionState, profileId: string): WallpaperStatusRecord | null {
  return state.status === 'ok' ? state.wallpapers[profileId] ?? null : null;
}

/** Идентификатор запуска быстрой команды: время + случайный хвост (base36). */
export function createRunId(nowMs: number, random: () => number = Math.random): string {
  const tail = Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0');
  return `${nowMs.toString(36)}-${tail}`;
}

// ===========================================================================
// Трекер
// ===========================================================================

export interface PrepareTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** Таймеры окна; без `window` (тесты в Node) фоновая подготовка по таймеру не планируется. */
const defaultTimers: PrepareTimers = {
  set: (callback, ms) => (typeof window === 'undefined' ? null : window.setTimeout(callback, ms)),
  clear: (handle) => {
    if (typeof window !== 'undefined' && typeof handle === 'number') window.clearTimeout(handle);
  },
};

function defaultForeground(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

export interface WallpaperStatusDeps {
  wallpaper: Pick<WallpaperService, 'renderAll' | 'resolveProfile'>;
  companion: Pick<CompanionStore, 'getState' | 'updateWallpaperStatus'>;
  /** Запуск с профилем и `runId`: ссылки возврата несут `profile=` и `run=`. */
  launcher: ProfileShortcutLauncher;
  platform: Pick<PlatformInfo, 'isIos'>;
  clock: Clock;
  notifier: Notifier;
  /** Название быстрой команды из настроек (`wallpaper.shortcutName`). */
  getShortcutName(): string;
  format?: FormatPreferencesProvider;
  /** Имя устройства для `companion.json` (необязательно). */
  getDeviceName?(): string | null;
  translate?: Translate;
  /** Obsidian на переднем плане (фоновая подготовка по таймеру — только тогда). */
  isForeground?(): boolean;
  /** Таймеры фоновой подготовки (тесты). */
  timers?: PrepareTimers;
  /** Пауза фоновой подготовки, мс. */
  prepareDelayMs?: number;
  /** Журнал (игнорируемые подтверждения, тихие ошибки фоновой подготовки). */
  log?(message: string, detail?: unknown): void;
  /** Генератор `runId` (тесты). */
  createRunId?(): string;
}

/** Итог рендера пакета для вызывающего (баннер выставляет он). */
type PackOutcome =
  | { ok: true; profileId: string; savedAt: string; failedDates: LocalDateString[]; todayFailed: boolean }
  | { ok: false; message: string | null };

interface SavedPack {
  revision: number;
  day: LocalDateString;
  zone: string;
  profileId: string;
  fingerprint: string | null;
}

export class PlannerWallpaperStatusTracker implements WallpaperStatusTracker {
  private state: WallpaperBannerState = { kind: 'idle' };
  private revision = 0;
  /**
   * Полный пакет PNG: ревизия данных, день, зона, профиль и отпечаток рендера.
   * `null` — не сохранялся в этом сеансе или сохранён не полностью.
   */
  private saved: SavedPack | null = null;
  /** Пользовательское действие (`run`) выполняется. */
  private running = false;
  /** Идущий рендер пакета (общий для фоновой подготовки и нажатия). */
  private packInFlight: Promise<PackOutcome> | null = null;
  private prepareTimer: unknown = null;
  private disposed = false;
  /** Ожидаемое подтверждение: запуск, профиль и отпечаток запущенного пакета. */
  private pending: { runId: string; profileId: string; fingerprint: string | null } | null = null;
  /** Уже обработанные запуски (повторные ссылки возврата игнорируются). */
  private readonly resolvedRuns = new Set<string>();
  /** Отпечаток пакета, установка которого подтверждена. */
  private confirmedFingerprint: string | null = null;
  /** День и зона последней проверки — смена суток оповещает подписчиков. */
  private dayKey: string;
  /** Последняя тихая ошибка фоновой подготовки. */
  private lastPrepareError: string | null = null;
  private readonly listeners = new Set<(state: WallpaperBannerState) => void>();

  constructor(private readonly deps: WallpaperStatusDeps) {
    this.dayKey = this.currentDayKey();
  }

  getState(): WallpaperBannerState {
    return this.state;
  }

  getActionKind(): WallpaperActionKind {
    return this.deps.platform.isIos ? 'update' : 'save';
  }

  getDataRevision(): number {
    return this.revision;
  }

  /** Тихая ошибка последней фоновой подготовки (`null` — не было). */
  getLastPrepareError(): string | null {
    return this.lastPrepareError;
  }

  /** PNG соответствуют текущим данным, сегодняшней дате, часовому поясу и профилю. */
  isFresh(): boolean {
    const saved = this.saved;
    if (saved === null || saved.revision !== this.revision) return false;
    const now = this.currentDay();
    return saved.day === now.day && saved.zone === now.zone && saved.profileId === this.profileId();
  }

  markDataChanged(): void {
    this.revision += 1;
    // Во время рендера состояние выставит его владелец по сравнению ревизий.
    if (this.state.kind !== 'rendering') this.setState({ kind: 'dirty' });
    this.schedulePrepare();
  }

  describe(): BannerDescription {
    return describeBanner(this.state, this.getActionKind(), this.translate);
  }

  /** Строка статуса карточки «Текущий» по данным `companion.json`. */
  getStatusText(): string {
    return formatWallpaperStatus(wallpaperRecordOf(this.deps.companion.getState(), this.profileId()), {
      now: this.deps.clock.now(),
      timeZone: this.deps.clock.timeZone(),
      hour12: this.deps.format?.get().hour12 ?? false,
      actionKind: this.getActionKind(),
      translate: this.translate,
    });
  }

  // -------------------------------------------------------------------------
  // Свежесть, смена суток, фоновая подготовка
  // -------------------------------------------------------------------------

  /**
   * Пересчёт после смены суток/зоны, возврата в приложение или запуска: смена дня
   * оповещает подписчиков (миниатюры вкладки), устаревший пакет — «Есть изменения»
   * и фоновая подготовка (на переднем плане).
   */
  refresh(): void {
    if (this.disposed) return;
    const key = this.currentDayKey();
    const dayChanged = key !== this.dayKey;
    this.dayKey = key;
    if (!this.isFresh()) {
      const kind = this.state.kind;
      // Пакет не на сегодня — «обновлено»/«готово» больше не верно. После запуска (`idle`)
      // состояние выставит фоновая подготовка: тот же отпечаток — без ложного «Есть изменения».
      if (kind === 'confirmed' || kind === 'saved' || kind === 'ready' || kind === 'launched' || kind === 'cancelled') {
        this.setState({ kind: 'dirty' });
      } else if (dayChanged) {
        this.emit();
      }
      if (this.isForeground()) this.schedulePrepare(0);
      return;
    }
    if (dayChanged) this.emit();
  }

  /** Obsidian уходит в фон (`visibilitychange → hidden`, `pagehide`): подготовить пакет сразу. */
  onHidden(): void {
    if (this.disposed || this.isFresh()) return;
    void this.prepareNow();
  }

  /** Фоновая подготовка через паузу после последнего изменения (только на переднем плане). */
  schedulePrepare(delayMs = this.deps.prepareDelayMs ?? PREPARE_DELAY_MS): void {
    if (this.disposed) return;
    this.clearPrepareTimer();
    if (!this.isForeground()) return;
    const timers = this.deps.timers ?? defaultTimers;
    this.prepareTimer = timers.set(() => {
      this.prepareTimer = null;
      void this.prepareNow();
    }, delayMs);
  }

  /** Рендер пакета без запуска команды; ошибки — тихо (журнал и `getLastPrepareError`). */
  async prepareNow(): Promise<void> {
    this.clearPrepareTimer();
    if (this.disposed || this.running) return;
    if (this.isFresh()) return;
    const outcome = await this.renderPack();
    if (this.disposed || this.running) return;
    if (!outcome.ok) {
      this.lastPrepareError = outcome.message ?? this.translate('protocol.wallpaper.failedRender');
      this.deps.log?.('Wallpaper background preparation failed', outcome.message);
      return;
    }
    this.lastPrepareError = null;
    if (outcome.failedDates.length > 0) {
      this.deps.log?.('Wallpaper background preparation is incomplete', outcome.failedDates);
      return;
    }
    if (this.state.kind === 'rendering' || !this.isFresh()) return;
    this.setState(this.restingState(outcome.savedAt));
  }

  dispose(): void {
    this.disposed = true;
    this.clearPrepareTimer();
  }

  // -------------------------------------------------------------------------
  // Нажатие
  // -------------------------------------------------------------------------

  async run(): Promise<void> {
    if (this.running) return;
    const kind = this.getActionKind();
    // Файлы актуальны — запуск без await, пока жест пользователя действителен.
    if (kind === 'update' && this.isFresh()) {
      await this.launchShortcut(this.saved?.profileId ?? this.profileId());
      return;
    }

    this.running = true;
    this.clearPrepareTimer();
    try {
      this.setState({ kind: 'rendering' });
      let outcome = await this.renderPack();
      // Присоединились к фоновой подготовке, начатой до последней правки, — дорисовать.
      if (outcome.ok && outcome.failedDates.length === 0 && !this.isFresh()) outcome = await this.renderPack();
      if (!outcome.ok) {
        this.setState({ kind: 'failed', reason: 'render', message: outcome.message });
        this.deps.notifier.show(
          outcome.message ? this.translate('protocol.wallpaper.failedRenderReason', { reason: outcome.message }) : this.translate('protocol.wallpaper.failedRender'),
        );
        return;
      }

      if (outcome.failedDates.length > 0) {
        this.deps.notifier.show(
          this.translate('wallpaperRender.errors.render', { date: outcome.failedDates.map((d) => formatShortDate(d, this.translate)).join(', ') }),
        );
        // Файл на сегодня не записан, а для «Сохранить обои» пакет неполон — команду не предлагаем.
        if (kind === 'save' || outcome.todayFailed) {
          this.setState({ kind: 'failed', reason: 'render' });
          return;
        }
        // Неполный пакет (будущая дата) — сегодняшний файл готов, установка возможна.
        this.setState({ kind: 'ready', at: outcome.savedAt });
        return;
      }

      if (!this.isFresh()) {
        this.setState({ kind: 'dirty' });
        return;
      }
      if (kind === 'save') {
        this.setState({ kind: 'saved', at: outcome.savedAt });
        this.deps.notifier.show(this.translate('protocol.wallpaper.saved'));
        return;
      }
      // Жест пользователя истёк за время рендера: команда — по второму нажатию.
      this.setState({ kind: 'ready', at: outcome.savedAt });
    } finally {
      this.running = false;
    }
  }

  // -------------------------------------------------------------------------
  // Возврат из быстрой команды
  // -------------------------------------------------------------------------

  /**
   * Возврат из быстрой команды. Статус пишется в профиль из ссылки возврата
   * (профиль запуска; при холодном запуске — единственный источник), иначе — в текущий.
   * Подтверждение с `runId` принимается только для ожидающего запуска.
   */
  async onWallpaperCallback(result: WallpaperCallbackResult, context?: WallpaperCallbackContext): Promise<void> {
    const fromLink = context?.profileId ?? null;
    const profileId = fromLink !== null && parseProfileId(fromLink) !== null ? fromLink : this.profileId();
    const runId = context?.runId ?? null;
    if (runId !== null && !this.acceptsRun(runId, profileId)) {
      this.deps.log?.(`Ignored wallpaper callback "${result}" for run ${runId}`, { expected: this.pending?.runId ?? null, profileId });
      return;
    }
    if (runId !== null) this.resolvedRuns.add(runId);
    const launchedFingerprint = this.pending?.fingerprint ?? null;
    this.pending = null;
    const at = this.nowIso();

    if (result === 'done') {
      this.confirmedFingerprint = launchedFingerprint ?? this.saved?.fingerprint ?? null;
      // Данные могли измениться, пока работала команда: тогда снова «есть изменения».
      this.setState(this.saved !== null && !this.isFresh() ? { kind: 'dirty' } : { kind: 'confirmed', at });
      this.deps.notifier.show(this.translate('protocol.wallpaper.confirmed'));
      await this.persist(profileId, { confirmedAt: at, errorMessage: null, runId: null });
      return;
    }
    if (result === 'cancelled') {
      this.setState({ kind: 'cancelled', at });
      this.deps.notifier.show(this.translate('protocol.wallpaper.cancelled'));
      await this.persist(profileId, { cancelledAt: at, runId: null });
      return;
    }
    const message = context?.errorMessage ?? null;
    this.setState({ kind: 'failed', reason: 'callback-error', message });
    this.deps.notifier.show(
      message ? this.translate('protocol.wallpaper.failedInstallReason', { reason: message }) : this.translate('protocol.wallpaper.failedCallback'),
    );
    await this.persist(profileId, { failedAt: at, errorMessage: message, runId: null });
  }

  onChange(listener: (state: WallpaperBannerState) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // -------------------------------------------------------------------------

  private readonly translate: Translate = (key, params) => (this.deps.translate ?? t)(key, params);

  private profileId(): string {
    return this.deps.wallpaper.resolveProfile().id;
  }

  private isForeground(): boolean {
    return (this.deps.isForeground ?? defaultForeground)();
  }

  private clearPrepareTimer(): void {
    if (this.prepareTimer === null) return;
    (this.deps.timers ?? defaultTimers).clear(this.prepareTimer);
    this.prepareTimer = null;
  }

  /** Ожидается ли подтверждение этого запуска (в памяти или в `companion.json` после перезапуска). */
  private acceptsRun(runId: string, profileId: string): boolean {
    if (this.resolvedRuns.has(runId)) return false;
    if (this.pending !== null) return this.pending.runId === runId;
    const stored = wallpaperRecordOf(this.deps.companion.getState(), profileId)?.runId ?? null;
    return stored === runId;
  }

  /** Состояние после готового пакета: установлен этот же пакет — «обновлено», иначе «готово». */
  private restingState(savedAt: string): WallpaperBannerState {
    if (this.getActionKind() === 'save') return { kind: 'saved', at: savedAt };
    const fingerprint = this.saved?.fingerprint ?? null;
    if (fingerprint !== null && fingerprint === this.confirmedFingerprint) return { kind: 'confirmed', at: savedAt };
    return { kind: 'ready', at: savedAt };
  }

  /** Один рендер пакета за раз: фоновая подготовка и нажатие ждут общий результат. */
  private renderPack(): Promise<PackOutcome> {
    if (!this.packInFlight) {
      this.packInFlight = this.doRenderPack().finally(() => {
        this.packInFlight = null;
      });
    }
    return this.packInFlight;
  }

  private async doRenderPack(): Promise<PackOutcome> {
    const revisionAtStart = this.revision;
    const dayAtStart = this.currentDay();
    const profileAtStart = this.profileId();
    const record = wallpaperRecordOf(this.deps.companion.getState(), profileAtStart);
    let rendered: Awaited<ReturnType<WallpaperService['renderAll']>>;
    try {
      rendered = await this.deps.wallpaper.renderAll({ knownFingerprint: record?.fingerprint ?? null });
    } catch (error) {
      rendered = { ok: false, error: { code: 'unknown', detail: error instanceof Error ? error.message : String(error) } };
    }
    if (!rendered.ok) {
      const key = rendered.error.messageKey;
      // Понятная причина есть только у ошибок фона; прочие — общий текст.
      const message = key && key.startsWith('protocol.') ? this.translate(key) : null;
      return { ok: false, message };
    }
    // `lock.png` не обновлён (не удался рендер на сегодня) — сбой: на экране остались бы старые обои.
    if (!rendered.value.lockUpdated) return { ok: false, message: null };
    return this.acceptPack(rendered.value, revisionAtStart, dayAtStart, record);
  }

  private async acceptPack(
    value: WallpaperRenderResult,
    revisionAtStart: number,
    dayAtStart: { day: LocalDateString; zone: string },
    record: WallpaperStatusRecord | null,
  ): Promise<PackOutcome> {
    const profileId = value.profile.id;
    const failedDates = value.failed.map((failure) => failure.date);
    const fingerprint = value.fingerprint ?? null;
    // Пакет не изменился: время сохранения — прежнее.
    const savedAt = value.unchanged && record?.savedAt ? record.savedAt : this.nowIso();
    // Неполный пакет не считается свежим: следующее нажатие нарисует его заново.
    this.saved = failedDates.length === 0 ? { revision: revisionAtStart, ...dayAtStart, profileId, fingerprint } : null;
    // После перезапуска: установлен ли этот пакет (подтверждение позже сохранения).
    if (this.confirmedFingerprint === null && value.unchanged && record?.confirmedAt && record.savedAt && record.confirmedAt >= record.savedAt) {
      const confirmed = parseInstant(record.confirmedAt);
      if (confirmed && floatingFromDate(confirmed, this.zoneOrUndefined()).date === dayAtStart.day) this.confirmedFingerprint = fingerprint;
    }
    if (!value.unchanged) {
      await this.persist(profileId, { savedAt, fingerprint: failedDates.length === 0 ? fingerprint : null });
    } else if (record?.fingerprint !== fingerprint) {
      await this.persist(profileId, { fingerprint });
    }
    return { ok: true, profileId, savedAt, failedDates, todayFailed: failedDates.includes(dayAtStart.day) };
  }

  private zoneOrUndefined(): string | undefined {
    const zone = this.deps.clock.timeZone();
    return isValidTimeZone(zone) ? zone : undefined;
  }

  /** День и зона рендера (как в сервисе обоев: неверная зона — зона устройства). */
  private currentDay(): { day: LocalDateString; zone: string } {
    const zone = this.deps.clock.timeZone();
    return { day: floatingFromDate(this.deps.clock.now(), this.zoneOrUndefined()).date, zone };
  }

  private currentDayKey(): string {
    const { day, zone } = this.currentDay();
    return `${day}|${zone}`;
  }

  /** Запуск синхронный до вызова `launcher.launch`; запись статуса — после. */
  private launchShortcut(profileId: string): Promise<void> {
    const name = this.deps.getShortcutName().trim();
    if (name === '') {
      this.failShortcut();
      return Promise.resolve();
    }
    const runId = this.deps.createRunId?.() ?? createRunId(this.deps.clock.now().getTime());
    const expectedFile = datedFileName(this.currentDay().day);
    let outcome: ReturnType<ProfileShortcutLauncher['launch']>;
    try {
      outcome = this.deps.launcher.launch(name, { profileId, runId, expectedFile });
    } catch {
      this.failShortcut();
      return Promise.resolve();
    }
    if (outcome.ok) {
      const at = this.nowIso();
      this.pending = { runId, profileId, fingerprint: this.saved?.fingerprint ?? null };
      this.setState({ kind: 'launched', at });
      return this.persist(profileId, { launchedAt: at, runId, errorMessage: null });
    }
    if (outcome.reason === 'recently-launched') {
      this.deps.notifier.show(this.translate('protocol.shortcut.recentlyLaunched'));
    } else {
      this.deps.notifier.show(this.translate('protocol.shortcut.unsupported'));
    }
    return Promise.resolve();
  }

  private failShortcut(): void {
    this.setState({ kind: 'failed', reason: 'shortcut' });
    this.deps.notifier.show(this.translate('protocol.wallpaper.failedShortcut'));
  }

  /** Сбой записи `companion.json` не меняет состояние баннера. */
  private async persist(profileId: string, patch: Partial<Omit<WallpaperStatusRecord, 'profileId'>>): Promise<void> {
    const deviceName = this.deps.getDeviceName?.() ?? null;
    try {
      await this.deps.companion.updateWallpaperStatus(profileId, deviceName === null ? patch : { ...patch, deviceName });
    } catch {
      // Статус — вспомогательные данные; обои уже сохранены.
    }
  }

  private nowIso(): string {
    return this.deps.clock.now().toISOString();
  }

  private setState(next: WallpaperBannerState): void {
    this.state = next;
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener(this.state);
  }
}

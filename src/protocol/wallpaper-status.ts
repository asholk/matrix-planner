/**
 * Статус обоев и баннер «Обновить экран блокировки» (ТЗ §4.5, §5.5).
 *
 * Разные события не смешиваются: «данные изменены» (ревизия), «PNG сохранены»,
 * «команда запущена», «подтверждено» (`x-success`), «ошибка» (`x-error`/сбой).
 * Время событий хранится в `companion.json` через `CompanionStore`.
 *
 * Жест пользователя: если PNG уже соответствуют данным, быстрая команда
 * запускается синхронно, до первого `await`. Иначе — после рендера; если
 * WebView отклонит такой переход, повторное нажатие запустит команду сразу.
 */

import type {
  BannerDescription,
  Clock,
  CompanionStore,
  FormatPreferencesProvider,
  Notifier,
  PlatformInfo,
  ShortcutLauncher,
  WallpaperBannerState,
  WallpaperService,
  WallpaperStatusTracker,
} from '../app/contracts';
import { registerDictionary, t } from '../i18n';
import { enProtocol } from '../i18n/en/protocol';
import { ruProtocol } from '../i18n/ru/protocol';
import { floatingFromDate, formatTimeLabel, parseDateParts } from '../model/dates';
import type { CompanionState, LocalDateString, Unsubscribe, WallpaperStatusRecord } from '../model/types';

registerDictionary('ru', 'protocol', ruProtocol);
registerDictionary('en', 'protocol', enProtocol);

export type WallpaperActionKind = 'update' | 'save';
type Translate = (key: string, params?: Record<string, string | number>) => string;

// ===========================================================================
// Чистые функции: тексты баннера и статуса
// ===========================================================================

export type { BannerDescription };

export function describeBanner(state: WallpaperBannerState, actionKind: WallpaperActionKind, translate: Translate = t): BannerDescription {
  const actionLabel = translate(actionKind === 'update' ? 'protocol.wallpaper.actionUpdate' : 'protocol.wallpaper.actionSave');
  const base = { actionLabel, helpLabel: null, attention: false };
  switch (state.kind) {
    case 'idle':
      return { ...base, text: actionLabel };
    case 'dirty':
      return {
        ...base,
        attention: true,
        text: translate(actionKind === 'update' ? 'protocol.wallpaper.dirtyUpdate' : 'protocol.wallpaper.dirtySave'),
      };
    case 'rendering':
      return { ...base, text: translate('protocol.wallpaper.rendering') };
    case 'saved':
      return { ...base, text: translate('protocol.wallpaper.saved') };
    case 'launched':
      return { ...base, text: translate('protocol.wallpaper.launched') };
    case 'confirmed':
      return { ...base, text: translate('protocol.wallpaper.confirmed') };
    case 'failed': {
      if (state.reason === 'render') return { ...base, attention: true, text: translate('protocol.wallpaper.failedRender') };
      const key = state.reason === 'shortcut' ? 'protocol.wallpaper.failedShortcut' : 'protocol.wallpaper.failedCallback';
      return { ...base, attention: true, text: translate(key), helpLabel: translate('protocol.wallpaper.howToSetUp') };
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

// ===========================================================================
// Трекер
// ===========================================================================

export interface WallpaperStatusDeps {
  wallpaper: Pick<WallpaperService, 'renderAll' | 'resolveProfile'>;
  companion: Pick<CompanionStore, 'getState' | 'updateWallpaperStatus'>;
  launcher: ShortcutLauncher;
  platform: Pick<PlatformInfo, 'isIos'>;
  clock: Clock;
  notifier: Notifier;
  /** Название быстрой команды из настроек (`wallpaper.shortcutName`). */
  getShortcutName(): string;
  format?: FormatPreferencesProvider;
  /** Имя устройства для `companion.json` (необязательно). */
  getDeviceName?(): string | null;
  translate?: Translate;
}

export class PlannerWallpaperStatusTracker implements WallpaperStatusTracker {
  private state: WallpaperBannerState = { kind: 'idle' };
  private revision = 0;
  /** Ревизия данных, по которой сохранены PNG; `null` — в этом сеансе не сохранялись. */
  private savedRevision: number | null = null;
  private running = false;
  private readonly listeners = new Set<(state: WallpaperBannerState) => void>();

  constructor(private readonly deps: WallpaperStatusDeps) {}

  getState(): WallpaperBannerState {
    return this.state;
  }

  getActionKind(): WallpaperActionKind {
    return this.deps.platform.isIos ? 'update' : 'save';
  }

  getDataRevision(): number {
    return this.revision;
  }

  /** PNG соответствуют текущим данным. */
  isFresh(): boolean {
    return this.savedRevision !== null && this.savedRevision === this.revision;
  }

  markDataChanged(): void {
    this.revision += 1;
    // Во время рендера состояние выставит run() по сравнению ревизий.
    if (this.state.kind !== 'rendering') this.setState({ kind: 'dirty' });
  }

  describe(): BannerDescription {
    return describeBanner(this.state, this.getActionKind(), this.translate);
  }

  /** Строка статуса карточки «Текущий» по данным `companion.json`. */
  getStatusText(): string {
    const profileId = this.deps.wallpaper.resolveProfile().id;
    return formatWallpaperStatus(wallpaperRecordOf(this.deps.companion.getState(), profileId), {
      now: this.deps.clock.now(),
      timeZone: this.deps.clock.timeZone(),
      hour12: this.deps.format?.get().hour12 ?? false,
      actionKind: this.getActionKind(),
      translate: this.translate,
    });
  }

  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const kind = this.getActionKind();
      // Файлы актуальны — запуск без await, пока жест пользователя действителен.
      if (kind === 'update' && this.isFresh()) {
        await this.launchShortcut(this.deps.wallpaper.resolveProfile().id);
        return;
      }

      const revisionAtStart = this.revision;
      this.setState({ kind: 'rendering' });
      let rendered: Awaited<ReturnType<WallpaperService['renderAll']>>;
      try {
        rendered = await this.deps.wallpaper.renderAll();
      } catch {
        rendered = { ok: false, error: { code: 'unknown' } };
      }
      // `lock.png` не обновлён (не удался рендер на сегодня) — тоже сбой: на экране остались бы старые обои.
      if (!rendered.ok || !rendered.value.lockUpdated) {
        this.setState({ kind: 'failed', reason: 'render' });
        this.deps.notifier.show(this.translate('protocol.wallpaper.failedRender'));
        return;
      }

      const profileId = rendered.value.profile.id;
      const savedAt = this.nowIso();
      this.savedRevision = revisionAtStart;
      await this.persist(profileId, { savedAt });

      if (kind === 'save') {
        this.setState(this.isFresh() ? { kind: 'saved', at: savedAt } : { kind: 'dirty' });
        this.deps.notifier.show(this.translate('protocol.wallpaper.saved'));
        return;
      }
      this.setState({ kind: 'saved', at: savedAt });
      await this.launchShortcut(profileId);
    } finally {
      this.running = false;
    }
  }

  async onWallpaperCallback(result: 'done' | 'failed'): Promise<void> {
    const profileId = this.deps.wallpaper.resolveProfile().id;
    const at = this.nowIso();
    if (result === 'done') {
      // Данные могли измениться, пока работала команда: тогда снова «есть изменения».
      this.setState(this.savedRevision !== null && !this.isFresh() ? { kind: 'dirty' } : { kind: 'confirmed', at });
      this.deps.notifier.show(this.translate('protocol.wallpaper.confirmed'));
      await this.persist(profileId, { confirmedAt: at });
    } else {
      this.setState({ kind: 'failed', reason: 'callback-error' });
      this.deps.notifier.show(this.translate('protocol.wallpaper.failedCallback'));
      await this.persist(profileId, { failedAt: at });
    }
  }

  onChange(listener: (state: WallpaperBannerState) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // -------------------------------------------------------------------------

  private readonly translate: Translate = (key, params) => (this.deps.translate ?? t)(key, params);

  /** Запуск синхронный до вызова `launcher.launch`; запись статуса — после. */
  private async launchShortcut(profileId: string): Promise<void> {
    const name = this.deps.getShortcutName().trim();
    if (name === '') {
      this.failShortcut();
      return;
    }
    let outcome: ReturnType<ShortcutLauncher['launch']>;
    try {
      outcome = this.deps.launcher.launch(name);
    } catch {
      this.failShortcut();
      return;
    }
    if (outcome.ok) {
      const at = this.nowIso();
      this.setState({ kind: 'launched', at });
      await this.persist(profileId, { launchedAt: at });
      return;
    }
    if (outcome.reason === 'recently-launched') {
      this.deps.notifier.show(this.translate('protocol.shortcut.recentlyLaunched'));
    } else {
      this.deps.notifier.show(this.translate('protocol.shortcut.unsupported'));
    }
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
    for (const listener of [...this.listeners]) listener(next);
  }
}

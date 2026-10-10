/**
 * Баннер «Обновить экран блокировки» над панелью вкладок (ТЗ §4.1, §4.5; кадр 16)
 * и окно «Как настроить». Состояние и действие — `WallpaperStatusTracker`.
 *
 * Нажатие вызывает `tracker.run()` синхронно в обработчике клика: трекер
 * открывает `shortcuts://` до первого `await`, пока жест пользователя действителен.
 */

import { setIcon } from 'obsidian';
import type {
  BannerController,
  BannerFactory,
  SheetPresenter,
  WallpaperBannerState,
  WallpaperStatusTracker,
} from '../app/contracts';
import { registerDictionary, t } from '../i18n';
import { enLockscreen } from '../i18n/en/lockscreen';
import { ruLockscreen } from '../i18n/ru/lockscreen';
import type { Unsubscribe } from '../model/types';
import { describeBanner, type BannerDescription } from '../protocol/wallpaper-status';

registerDictionary('ru', 'lockscreen', ruLockscreen);
registerDictionary('en', 'lockscreen', enLockscreen);

type Translate = (key: string, params?: Record<string, string | number>) => string;
export type WallpaperActionKind = 'update' | 'save';

/**
 * Методы `PlannerWallpaperStatusTracker`, которых пока нет в контракте
 * (S2.T5 → добавить в `WallpaperStatusTracker`). Необязательны: без них — запасной путь.
 */
export interface WallpaperStatusTrackerExt extends WallpaperStatusTracker {
  describe?(): BannerDescription;
  /** Строка статуса карточки «Текущий». */
  getStatusText?(): string;
  /** PNG соответствуют текущим данным. */
  isFresh?(): boolean;
}

// ===========================================================================
// Чистая модель баннера
// ===========================================================================

export type BannerTone = 'neutral' | 'attention' | 'success' | 'error';

export interface BannerViewModel {
  /** Крупная строка: действие («Обновить экран блокировки» / «Сохранить обои»). */
  title: string;
  /** Пояснение под действием; `null`, если совпадает с действием. */
  subtitle: string | null;
  actionKind: WallpaperActionKind;
  icon: string;
  /** Идёт рендер — повторное нажатие игнорируется. */
  busy: boolean;
  tone: BannerTone;
  /** Подпись «Как настроить» (ошибка быстрой команды) или `null`. */
  helpLabel: string | null;
  /** Подпись кнопки для экранного диктора. */
  ariaLabel: string;
}

function toneOf(state: WallpaperBannerState): BannerTone {
  switch (state.kind) {
    case 'dirty':
      return 'attention';
    case 'failed':
      return 'error';
    case 'confirmed':
      return 'success';
    default:
      return 'neutral';
  }
}

function iconOf(state: WallpaperBannerState, actionKind: WallpaperActionKind): string {
  switch (state.kind) {
    case 'rendering':
      return 'loader';
    case 'confirmed':
      return 'check';
    case 'failed':
      return 'alert-triangle';
    default:
      return actionKind === 'update' ? 'refresh-cw' : 'download';
  }
}

/**
 * Что показывает баннер. «Сохранено» не означает «установлено»: на iPhone/iPad
 * после сохранения PNG и запуска команды баннер не пишет «обновлён» без `x-success`.
 */
export function bannerViewModel(
  state: WallpaperBannerState,
  actionKind: WallpaperActionKind,
  translate: Translate = t,
  description: BannerDescription = describeBanner(state, actionKind, translate),
): BannerViewModel {
  const subtitle = description.text === description.actionLabel ? null : description.text;
  return {
    title: description.actionLabel,
    subtitle,
    actionKind,
    icon: iconOf(state, actionKind),
    busy: state.kind === 'rendering',
    tone: toneOf(state),
    helpLabel: description.helpLabel,
    ariaLabel: subtitle ? `${description.actionLabel}. ${subtitle}` : description.actionLabel,
  };
}

/** Модель баннера по трекеру (использует `describe()`, если он есть). */
export function bannerViewModelOf(tracker: WallpaperStatusTrackerExt, translate: Translate = t): BannerViewModel {
  const state = tracker.getState();
  const actionKind = tracker.getActionKind();
  return bannerViewModel(state, actionKind, translate, tracker.describe?.() ?? describeBanner(state, actionKind, translate));
}

/** Строка статуса «Текущий»: из трекера или запасной текст по состоянию баннера. */
export function statusTextOf(tracker: WallpaperStatusTrackerExt, translate: Translate = t): string {
  if (tracker.getStatusText) {
    try {
      return tracker.getStatusText();
    } catch {
      // Ниже — запасной вариант.
    }
  }
  const state = tracker.getState();
  if (state.kind === 'idle') {
    return translate(tracker.getActionKind() === 'update' ? 'protocol.wallpaper.status.neverConfirmed' : 'protocol.wallpaper.status.neverSaved');
  }
  return describeBanner(state, tracker.getActionKind(), translate).text;
}

/** Нужно ли выделить статус: нет подтверждения или есть несохранённые изменения. */
export function statusNeedsAttention(tracker: WallpaperStatusTrackerExt): boolean {
  const state = tracker.getState();
  if (state.kind === 'failed' || state.kind === 'dirty') return true;
  if (tracker.getActionKind() === 'save') return false;
  return state.kind !== 'confirmed';
}

// ===========================================================================
// «Как настроить»
// ===========================================================================

export interface WallpaperHelpContext {
  actionKind: WallpaperActionKind;
  profileId: string;
  shortcutName: string;
}

/** Инструкция по быстрой команде (краткое содержание docs/shortcuts.md). */
export function openWallpaperHelp(sheets: SheetPresenter, context: WallpaperHelpContext): void {
  sheets.open({
    title: t('lockscreen.help.title'),
    submitLabel: null,
    fullScreenOnPhone: false,
    render: (contentEl) => {
      const root = contentEl.createDiv({ cls: 'mp-ls-help' });
      root.createEl('p', { text: t('lockscreen.help.intro', { profile: context.profileId }) });
      const ios = (): void => {
        root.createEl('h3', { text: t('lockscreen.help.iosTitle') });
        const list = root.createEl('ol');
        list.createEl('li', { text: t('lockscreen.help.ios1', { shortcut: context.shortcutName }) });
        list.createEl('li', { text: t('lockscreen.help.ios2') });
        list.createEl('li', { text: t('lockscreen.help.ios3') });
        list.createEl('li', { text: t('lockscreen.help.ios4') });
      };
      const other = (): void => {
        root.createEl('h3', { text: t('lockscreen.help.otherTitle') });
        root.createEl('p', { text: t('lockscreen.help.other1') });
      };
      // Сначала — инструкция для текущего устройства.
      if (context.actionKind === 'update') {
        ios();
        other();
      } else {
        other();
        ios();
      }
      root.createEl('p', { cls: 'mp-ls-help-docs', text: t('lockscreen.help.docs') });
    },
  });
}

// ===========================================================================
// Контроллер баннера
// ===========================================================================

export interface UpdateBannerDeps {
  status: WallpaperStatusTrackerExt;
  sheets: SheetPresenter;
  /** Профиль и название команды для «Как настроить». */
  getHelpContext(): Omit<WallpaperHelpContext, 'actionKind'>;
}

/** Фабрика для `PlannerViewOptions.banner`. */
export function createUpdateBanner(deps: UpdateBannerDeps): BannerFactory {
  return () => new UpdateBanner(deps);
}

export class UpdateBanner implements BannerController {
  private rootEl: HTMLElement | null = null;
  private unsubscribe: Unsubscribe | null = null;

  constructor(private readonly deps: UpdateBannerDeps) {}

  mount(containerEl: HTMLElement): void {
    this.unmount();
    this.rootEl = containerEl.createDiv({ cls: 'mp-ls-banner', attr: { role: 'region', 'aria-label': t('lockscreen.banner.label') } });
    this.unsubscribe = this.deps.status.onChange(() => this.render());
    this.render();
  }

  unmount(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.rootEl?.remove();
    this.rootEl = null;
  }

  private render(): void {
    const root = this.rootEl;
    if (!root) return;
    const model = bannerViewModelOf(this.deps.status);
    root.empty();
    root.dataset.tone = model.tone;

    const action = root.createEl('button', {
      cls: 'mp-ls-banner-action',
      attr: { type: 'button', 'aria-label': model.ariaLabel, 'aria-busy': model.busy ? 'true' : 'false' },
    });
    action.toggleClass('is-busy', model.busy);
    const iconEl = action.createSpan({ cls: 'mp-ls-banner-icon', attr: { 'aria-hidden': 'true' } });
    setIcon(iconEl, model.icon);
    const text = action.createSpan({ cls: 'mp-ls-banner-text' });
    text.createSpan({ cls: 'mp-ls-banner-title', text: model.title });
    if (model.subtitle) text.createSpan({ cls: 'mp-ls-banner-subtitle', text: model.subtitle });
    action.addEventListener('click', () => this.onAction());

    if (model.helpLabel) {
      const help = root.createEl('button', {
        cls: 'mp-ls-banner-help',
        text: model.helpLabel,
        attr: { type: 'button' },
      });
      help.addEventListener('click', () => {
        openWallpaperHelp(this.deps.sheets, { ...this.deps.getHelpContext(), actionKind: this.deps.status.getActionKind() });
      });
    }
  }

  /** Синхронный вызов: никаких `await` до `run()`. */
  private onAction(): void {
    if (this.deps.status.getState().kind === 'rendering') return;
    void this.deps.status.run();
  }
}

/**
 * Запуск быстрой команды по x-callback-url (ТЗ §4.5 шаг 2, §5.5).
 *
 * Ссылка открывается только синхронно внутри обработчика нажатия: WKWebView
 * блокирует переходы на внешние схемы без жеста пользователя.
 * Способ — `window.open(url)`: в мобильном Obsidian он передаёт внешние схемы
 * системе (UIApplication.open). `location.href` не используем: переход
 * основного WebView на чужую схему может выгрузить страницу приложения или
 * молча игнорироваться. Риск: поведение `window.open` для `shortcuts://` — пункт
 * проверки этапа 0 (ТЗ §8.1.4); запасной путь — клик по временной ссылке `<a>`.
 */

import type { Clock, LinkBuilder, PlatformInfo, ShortcutLauncher } from '../app/contracts';

/** Повторный запуск в течение этого времени пропускается (ТЗ §5.5). */
export const RELAUNCH_GUARD_MS = 10_000;

export type UrlOpener = (url: string) => void;

export interface ShortcutLauncherDeps {
  links: Pick<LinkBuilder, 'shortcutRunUrl'>;
  platform: Pick<PlatformInfo, 'isIos'>;
  clock: Pick<Clock, 'now'>;
  /** По умолчанию — `openExternalUrl`. */
  open?: UrlOpener;
  guardMs?: number;
}

/** Открывает внешнюю ссылку: `window.open`, при недоступности — клик по `<a>`. */
export function openExternalUrl(url: string): void {
  if (typeof window !== 'undefined' && typeof window.open === 'function') {
    window.open(url);
    return;
  }
  if (typeof document !== 'undefined') {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.rel = 'noopener';
    anchor.click();
    return;
  }
  throw new Error('No way to open external URL');
}

export class XCallbackShortcutLauncher implements ShortcutLauncher {
  private lastLaunchMs: number | null = null;

  constructor(private readonly deps: ShortcutLauncherDeps) {}

  /** Бросает исключение, только если открыть ссылку не удалось. */
  launch(shortcutName: string): { ok: true } | { ok: false; reason: 'unsupported' | 'recently-launched' } {
    if (!this.deps.platform.isIos) return { ok: false, reason: 'unsupported' };
    const now = this.deps.clock.now().getTime();
    const guard = this.deps.guardMs ?? RELAUNCH_GUARD_MS;
    // Часы ушли назад — защиту не применяем.
    if (this.lastLaunchMs !== null && now >= this.lastLaunchMs && now - this.lastLaunchMs < guard) {
      return { ok: false, reason: 'recently-launched' };
    }
    const url = this.deps.links.shortcutRunUrl(shortcutName);
    (this.deps.open ?? openExternalUrl)(url);
    this.lastLaunchMs = now;
    return { ok: true };
  }

  /** Время последнего запуска (мс) или `null`. */
  getLastLaunchMs(): number | null {
    return this.lastLaunchMs;
  }
}

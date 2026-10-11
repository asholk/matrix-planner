/**
 * Тактильный отклик на действия. У каждого действия свой «рисунок».
 *
 * Способы (первый доступный):
 * 1. Нативный модуль Capacitor Haptics, если его отдаёт мобильный Obsidian (`window.Capacitor.Plugins.Haptics`) —
 *    разные виды отклика iOS: impact light/medium/heavy, notification success/warning/error, selection.
 * 2. iOS WebView: переключатель `<input type="checkbox" switch>` даёт системный «тик» при переключении
 *    (Safari/WebKit iOS 17.4+). Вид отклика один, поэтому действия различаются числом и ритмом тиков.
 * 3. Android и прочие: `navigator.vibrate` с шаблоном по действию.
 * Нет ни одного способа — тихо ничего не делаем.
 */

/** Действия с собственным откликом. */
export type HapticKind =
  /** Лёгкое касание: открыть форму, вкладку, меню. */
  | 'tap'
  /** Выбор в группе: квадрант, цвет, режим, переключатель. */
  | 'select'
  /** Задача выполнена, форма сохранена. */
  | 'success'
  /** Отмена («Вернуть», «Вернуть в работу»). */
  | 'undo'
  /** Карточка поднята для перетаскивания. */
  | 'lift'
  /** Карточка опущена в другой квадрант. */
  | 'drop'
  /** Палец пересёк порог свайпа / вошёл в зону удаления. */
  | 'threshold'
  /** Удаление. */
  | 'delete'
  /** Предупреждение (подтверждение, конфликт). */
  | 'warning'
  /** Ошибка (не сохранено, нет связи). */
  | 'error';

type ImpactStyle = 'LIGHT' | 'MEDIUM' | 'HEAVY';
type NotificationType = 'SUCCESS' | 'WARNING' | 'ERROR';

interface CapacitorHaptics {
  impact?(options: { style: ImpactStyle }): Promise<void> | void;
  notification?(options: { type: NotificationType }): Promise<void> | void;
  selectionStart?(): Promise<void> | void;
  selectionChanged?(): Promise<void> | void;
  selectionEnd?(): Promise<void> | void;
}

/** Нативный отклик по действию. */
export const NATIVE_HAPTICS: Readonly<Record<HapticKind, { impact?: ImpactStyle; notification?: NotificationType; selection?: true }>> = {
  tap: { impact: 'LIGHT' },
  select: { selection: true },
  success: { notification: 'SUCCESS' },
  undo: { impact: 'MEDIUM' },
  lift: { impact: 'MEDIUM' },
  drop: { impact: 'LIGHT' },
  threshold: { selection: true },
  delete: { impact: 'HEAVY' },
  warning: { notification: 'WARNING' },
  error: { notification: 'ERROR' },
};

/** Ритм тиков iOS-переключателя: задержки (мс) от начала для каждого тика. */
export const TICK_PATTERNS: Readonly<Record<HapticKind, readonly number[]>> = {
  tap: [0],
  select: [0],
  success: [0, 110],
  undo: [0, 70],
  lift: [0],
  drop: [0],
  threshold: [0],
  delete: [0, 60, 120],
  warning: [0, 160],
  error: [0, 80, 160],
};

/** Шаблоны `navigator.vibrate` (мс: вибрация, пауза, вибрация…). */
export const VIBRATE_PATTERNS: Readonly<Record<HapticKind, number | readonly number[]>> = {
  tap: 8,
  select: 6,
  success: [12, 60, 18],
  undo: [10, 40, 10],
  lift: 22,
  drop: 12,
  threshold: 6,
  delete: [30, 50, 30],
  warning: [20, 80, 20],
  error: [40, 60, 40, 60, 40],
};

export interface HapticsDeps {
  /** Включён ли отклик (настройка). */
  enabled(): boolean;
  /** Окно (для тестов — подмена). */
  win?: Window;
}

export interface Haptics {
  play(kind: HapticKind): void;
  /** Какой способ используется (для настроек и диагностики). */
  method(): 'native' | 'ios-switch' | 'vibrate' | 'none';
}

interface CapacitorWindow {
  Capacitor?: { Plugins?: { Haptics?: CapacitorHaptics }; getPlatform?(): string };
}

function isIos(win: Window): boolean {
  const ua = win.navigator?.userAgent ?? '';
  const iPadOs = /Macintosh/.test(ua) && (win.navigator?.maxTouchPoints ?? 0) > 1;
  return /iPhone|iPad|iPod/.test(ua) || iPadOs;
}

export function createHaptics(deps: HapticsDeps): Haptics {
  const win = deps.win ?? window;
  let switchLabel: HTMLLabelElement | null = null;

  const native = (): CapacitorHaptics | null => (win as unknown as CapacitorWindow).Capacitor?.Plugins?.Haptics ?? null;

  const ensureSwitch = (): HTMLLabelElement | null => {
    if (switchLabel?.isConnected) return switchLabel;
    const body = win.document?.body;
    if (!body) return null;
    const label = body.createEl('label', { cls: 'mp-haptic-switch', attr: { 'aria-hidden': 'true' } });
    label.createEl('input', { type: 'checkbox', attr: { switch: '', tabindex: '-1' } });
    switchLabel = label;
    return label;
  };

  const method = (): ReturnType<Haptics['method']> => {
    if (native()) return 'native';
    if (isIos(win)) return 'ios-switch';
    if (typeof win.navigator?.vibrate === 'function') return 'vibrate';
    return 'none';
  };

  const play = (kind: HapticKind): void => {
    if (!deps.enabled()) return;
    try {
      const h = native();
      if (h) {
        const spec = NATIVE_HAPTICS[kind];
        if (spec.notification && h.notification) void h.notification({ type: spec.notification });
        else if (spec.selection && h.selectionChanged) {
          void h.selectionStart?.();
          void h.selectionChanged();
          void h.selectionEnd?.();
        } else if (h.impact) void h.impact({ style: spec.impact ?? 'LIGHT' });
        return;
      }
      if (isIos(win)) {
        const label = ensureSwitch();
        if (!label) return;
        for (const delay of TICK_PATTERNS[kind]) {
          if (delay === 0) label.click();
          else win.setTimeout(() => label.click(), delay);
        }
        return;
      }
      const pattern = VIBRATE_PATTERNS[kind];
      win.navigator?.vibrate?.(typeof pattern === 'number' ? pattern : [...pattern]);
    } catch {
      // Отклик не критичен — ошибки не показываем.
    }
  };

  return { play, method };
}

/** Заглушка для тестов и платформ без отклика. */
export const NO_HAPTICS: Haptics = { play: () => undefined, method: () => 'none' };

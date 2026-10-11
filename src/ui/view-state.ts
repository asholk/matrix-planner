/**
 * Состояние вида «Планировщик» (S1.T4). Чистая логика: без `obsidian` и DOM.
 * Все функции возвращают новое состояние и не меняют исходное.
 */

import type { AddContext } from '../app/contracts';
import type { LocalDateString, PlannerTabId, QuadrantKey } from '../model/types';

/** Порядок вкладок на нижней панели. */
export const PLANNER_TAB_ORDER: readonly PlannerTabId[] = ['tasks', 'calendar', 'lockscreen'];

/** Ширина, начиная с которой «Задачи» и «Календарь» показываются рядом (ТЗ §7.1). */
export const SPLIT_MIN_WIDTH = 900;

/** Пара вкладок, которые в широкой раскладке стоят рядом. */
export const SPLIT_TABS: readonly PlannerTabId[] = ['tasks', 'calendar'];

const QUADRANTS: readonly QuadrantKey[] = ['do', 'plan', 'urgent', 'someday'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface FocusRequest {
  date?: LocalDateString;
}

export interface PlannerViewState {
  activeTab: PlannerTabId;
  /** Подключённые вкладки (в порядке панели). */
  available: readonly PlannerTabId[];
  /** Контекст «+» каждой вкладки: выбранный день и квадрант. */
  addContexts: Partial<Record<PlannerTabId, AddContext>>;
  /** Запросы `focus`, пришедшие до монтирования вкладки. */
  pendingFocus: Partial<Record<PlannerTabId, FocusRequest>>;
  /** Две колонки: «Задачи» и «Календарь» рядом. */
  split: boolean;
}

/** Сохраняемая часть состояния (`ItemView.getState`). */
export interface PersistedViewState {
  tab: PlannerTabId;
  /** Выбранный день вкладок, у которых он есть. */
  dates?: Partial<Record<PlannerTabId, LocalDateString>>;
}

export const EMPTY_ADD_CONTEXT: AddContext = Object.freeze({ date: null, quadrant: null });

export function isPlannerTabId(value: unknown): value is PlannerTabId {
  return typeof value === 'string' && (PLANNER_TAB_ORDER as readonly string[]).includes(value);
}

function isDate(value: unknown): value is LocalDateString {
  return typeof value === 'string' && DATE_RE.test(value);
}

function normalizeContext(context: AddContext): AddContext {
  return {
    date: isDate(context.date) ? context.date : null,
    quadrant: context.quadrant && QUADRANTS.includes(context.quadrant) ? context.quadrant : null,
  };
}

/** Упорядочивает и очищает список доступных вкладок. */
export function normalizeAvailable(tabs: Iterable<PlannerTabId>): PlannerTabId[] {
  const set = new Set(tabs);
  return PLANNER_TAB_ORDER.filter((tab) => set.has(tab));
}

/** Предпочтённая вкладка, если доступна, иначе первая доступная (или сама предпочтённая, если нет ни одной). */
export function resolveTab(preferred: PlannerTabId, available: readonly PlannerTabId[]): PlannerTabId {
  if (available.includes(preferred)) return preferred;
  return available[0] ?? preferred;
}

export function createViewState(params: {
  available: Iterable<PlannerTabId>;
  initialTab: PlannerTabId;
}): PlannerViewState {
  const available = normalizeAvailable(params.available);
  return {
    activeTab: resolveTab(params.initialTab, available),
    available,
    addContexts: {},
    pendingFocus: {},
    split: false,
  };
}

/** Переключает вкладку. Недоступная вкладка игнорируется (состояние не меняется). */
export function switchTab(state: PlannerViewState, tab: PlannerTabId): PlannerViewState {
  if (!state.available.includes(tab) || state.activeTab === tab) return state;
  return { ...state, activeTab: tab };
}

export function setAddContext(state: PlannerViewState, tab: PlannerTabId, context: AddContext): PlannerViewState {
  return { ...state, addContexts: { ...state.addContexts, [tab]: normalizeContext(context) } };
}

/** Контекст «+» вкладки (по умолчанию — активной). Возвращает копию. */
export function getAddContext(state: PlannerViewState, tab: PlannerTabId = state.activeTab): AddContext {
  const context = state.addContexts[tab] ?? EMPTY_ADD_CONTEXT;
  return { date: context.date, quadrant: context.quadrant };
}

/**
 * Внешний запрос показать вкладку (команда, ссылка). Переключает вкладку и
 * запоминает дату; выбранный день сразу попадает в контекст «+».
 */
export function requestFocus(state: PlannerViewState, tab: PlannerTabId, request: FocusRequest = {}): PlannerViewState {
  if (!state.available.includes(tab)) return state;
  let next = switchTab(state, tab);
  next = { ...next, pendingFocus: { ...next.pendingFocus, [tab]: { ...request } } };
  if (request.date && isDate(request.date)) {
    next = setAddContext(next, tab, { ...getAddContext(next, tab), date: request.date });
  }
  return next;
}

/** Забирает отложенный запрос вкладки: `[новое состояние, запрос | null]`. */
export function takePendingFocus(state: PlannerViewState, tab: PlannerTabId): [PlannerViewState, FocusRequest | null] {
  const request = state.pendingFocus[tab];
  if (!request) return [state, null];
  const pendingFocus = { ...state.pendingFocus };
  delete pendingFocus[tab];
  return [{ ...state, pendingFocus }, request];
}

/** Нужна ли раскладка в две колонки. `minWidth === null` — выключено. */
export function shouldSplit(width: number, minWidth: number | null, available: readonly PlannerTabId[]): boolean {
  if (minWidth === null || !Number.isFinite(width) || width < minWidth) return false;
  return SPLIT_TABS.every((tab) => available.includes(tab));
}

export function setWidth(state: PlannerViewState, width: number, minWidth: number | null = SPLIT_MIN_WIDTH): PlannerViewState {
  const split = shouldSplit(width, minWidth, state.available);
  return split === state.split ? state : { ...state, split };
}

/** Вкладки, панели которых сейчас видны (в порядке панели). */
export function visibleTabs(state: PlannerViewState): PlannerTabId[] {
  if (state.split && SPLIT_TABS.includes(state.activeTab)) return [...SPLIT_TABS];
  return [state.activeTab];
}

export type TabNavigationKey = 'next' | 'prev' | 'first' | 'last';

/** Перевод клавиши панели вкладок в направление (роль `tablist`). */
export function navigationKeyFor(key: string): TabNavigationKey | null {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return 'next';
    case 'ArrowLeft':
    case 'ArrowUp':
      return 'prev';
    case 'Home':
      return 'first';
    case 'End':
      return 'last';
    default:
      return null;
  }
}

/** Соседняя доступная вкладка с переходом по кругу. */
export function adjacentTab(state: PlannerViewState, from: PlannerTabId, direction: TabNavigationKey): PlannerTabId {
  const list = state.available;
  if (list.length === 0) return from;
  if (direction === 'first') return list[0] ?? from;
  if (direction === 'last') return list[list.length - 1] ?? from;
  const index = list.indexOf(from);
  if (index < 0) return list[0] ?? from;
  const step = direction === 'next' ? 1 : -1;
  return list[(index + step + list.length) % list.length] ?? from;
}

export function serializeViewState(state: PlannerViewState): PersistedViewState {
  const dates: Partial<Record<PlannerTabId, LocalDateString>> = {};
  for (const tab of PLANNER_TAB_ORDER) {
    const date = state.addContexts[tab]?.date;
    if (date) dates[tab] = date;
  }
  return Object.keys(dates).length > 0 ? { tab: state.activeTab, dates } : { tab: state.activeTab };
}

/** Восстанавливает сохранённое состояние; некорректные поля пропускаются. */
export function restoreViewState(state: PlannerViewState, raw: unknown): PlannerViewState {
  if (!raw || typeof raw !== 'object') return state;
  const record = raw as Record<string, unknown>;
  let next = state;
  if (isPlannerTabId(record.tab)) next = switchTab(next, record.tab);
  const dates = record.dates;
  if (dates && typeof dates === 'object') {
    for (const [tab, date] of Object.entries(dates as Record<string, unknown>)) {
      if (!isPlannerTabId(tab) || !isDate(date)) continue;
      next = setAddContext(next, tab, { ...getAddContext(next, tab), date });
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Свайпы шторок Obsidian (доработка 006, §3)
// ---------------------------------------------------------------------------

/** Ширина полосы у края экрана, где свайп остаётся Obsidian (открыть шторку), px. */
export const SIDEBAR_EDGE_PX = 16;

/**
 * Касание у самого края экрана: такой свайп отдаём Obsidian (шторки). Остальные
 * горизонтальные жесты внутри вида — наши (свайп карточки, перетаскивание).
 */
export function isSidebarEdgeTouch(x: number, viewportWidth: number, edge: number = SIDEBAR_EDGE_PX): boolean {
  if (!Number.isFinite(x) || viewportWidth <= 0) return false;
  return x <= edge || x >= viewportWidth - edge;
}

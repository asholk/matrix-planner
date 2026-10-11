/**
 * Лист «Статистика» (через `SheetPresenter`, как формы; на телефоне — во весь экран):
 * карточки «N дней подряд» и «выполнено на этой неделе», диаграмма по дням недели,
 * «Недавно выполненные» и кнопка «Итоги» (сводка недели → «Поделиться» или буфер обмена).
 * Пока лист открыт, он обновляется по изменениям индекса.
 */

import { setIcon } from 'obsidian';
import type {
  Clock,
  FormatPreferencesProvider,
  NoteIndex,
  Notifier,
  PlannerActions,
  SheetHandle,
  SheetPresenter,
} from '../app/contracts';
import { QUADRANT_KEYS, type MatrixConfig, type QuadrantKey } from '../model/types';
import { DEFAULT_QUADRANT_STYLE } from '../model/defaults';
import { localDateOf } from '../model/dates';
import { registerDictionary, t, tPlural } from '../i18n';
import { ruStats } from '../i18n/ru/stats';
import { enStats } from '../i18n/en/stats';
import { quadrantColorOverrides } from '../tasks/tasks-presenter';
import {
  buildStats,
  buildWeekSummary,
  capitalize,
  formatCompletionMoment,
  formatDateRange,
  formatDayMonth,
  weekdayName,
  type CompletionRecord,
  type StatsModel,
  type SummaryStrings,
} from './stats';

registerDictionary('ru', 'stats', ruStats);
registerDictionary('en', 'stats', enStats);

export interface StatsSheetDeps {
  sheets: SheetPresenter;
  index: Pick<NoteIndex, 'getTasks' | 'getMatrix' | 'onChange'>;
  clock: Clock;
  format: FormatPreferencesProvider;
  notifier: Notifier;
  actions: Pick<PlannerActions, 'openTaskForm' | 'openNote'>;
}

/** Открыть лист «Статистика». */
export function openStatsSheet(deps: StatsSheetDeps): SheetHandle {
  let unsubscribe: (() => void) | null = null;
  let timer: number | null = null;
  let handleRef: SheetHandle | null = null;
  const handle = deps.sheets.open({
    title: t('stats.title'),
    submitLabel: null,
    fullScreenOnPhone: true,
    cls: 'mp-stats-sheet',
    headerAction: {
      icon: 'share',
      label: t('stats.summary.button'),
      onClick: () => void shareSummary(deps),
    },
    render: (contentEl, sheet) => {
      handleRef = sheet;
      const root = contentEl.createDiv({ cls: 'mp-stats' });
      const draw = (): void => renderStats(root, deps, () => handleRef?.close());
      draw();
      unsubscribe = deps.index.onChange(() => {
        if (timer !== null) return;
        timer = window.setTimeout(() => {
          timer = null;
          draw();
        }, 0);
      });
    },
    onClose: () => {
      unsubscribe?.();
      unsubscribe = null;
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    },
  });
  handleRef = handle;
  return handle;
}

function currentModel(deps: StatsSheetDeps): StatsModel {
  const today = localDateOf(deps.clock.now(), deps.clock.timeZone());
  return buildStats({ tasks: deps.index.getTasks(), today, weekStart: deps.format.get().weekStart });
}

function quadrantInfo(matrix: MatrixConfig, key: QuadrantKey): { title: string; icon: string } {
  const config = matrix.byKey[key];
  return { title: config?.title ?? key, icon: config?.icon ?? DEFAULT_QUADRANT_STYLE[key].icon };
}

function renderStats(root: HTMLElement, deps: StatsSheetDeps, close: () => void): void {
  const scrollParent = root.parentElement;
  const scrollTop = scrollParent?.scrollTop ?? 0;
  root.empty();
  const model = currentModel(deps);
  const matrix = deps.index.getMatrix();
  const { language, hour12 } = deps.format.get();
  // Цвета квадрантов из «Матрица.md».
  const vars = quadrantColorOverrides(matrix);
  for (const key of QUADRANT_KEYS) {
    for (const name of [`--mp-q-${key}`, `--mp-q-${key}-bg`]) {
      if (vars[name]) root.style.setProperty(name, vars[name]);
      else root.style.removeProperty(name);
    }
  }

  // --- Карточки серии и недели ---
  const cards = root.createDiv({ cls: 'mp-stats-cards' });
  summaryCard(cards, 'mp-stats-streak', 'flame', String(model.streak), tPlural('stats.streak.label', model.streak));
  summaryCard(cards, 'mp-stats-week', 'check', String(model.weekCount), t('stats.week.label'));

  // --- Диаграмма ---
  const chartCard = root.createEl('section', { cls: 'mp-stats-panel mp-stats-chart-card' });
  const chartTitle = chartCard.createDiv({ cls: 'mp-stats-chart-title' });
  chartTitle.setText(`${t('stats.chart.title')} · ${t('stats.chart.period')}`);
  const chart = chartCard.createDiv({ cls: 'mp-stats-chart', attr: { role: 'list', 'aria-label': t('stats.chart.label') } });
  const max = Math.max(1, ...model.week.map((day) => day.count));
  for (const day of model.week) {
    const dayName = `${capitalize(weekdayName(day.date, language, 'long'))}, ${formatDayMonth(day.date, language)}`;
    const column = chart.createDiv({
      cls: 'mp-stats-bar-col',
      attr: { role: 'listitem', 'aria-label': tPlural('stats.chart.day', day.count, { day: dayName }) },
    });
    column.toggleClass('is-today', day.today);
    const track = column.createDiv({ cls: 'mp-stats-bar-track', attr: { 'aria-hidden': 'true' } });
    if (day.count > 0) {
      track.createDiv({ cls: 'mp-stats-bar-value', text: String(day.count) });
      const bar = track.createDiv({ cls: 'mp-stats-bar' });
      bar.setCssProps({ '--mp-bar-ratio': String(day.count / max) });
    } else {
      track.createDiv({ cls: 'mp-stats-bar is-empty' });
    }
    column.createDiv({ cls: 'mp-stats-bar-day', text: capitalize(weekdayName(day.date, language, 'narrow')), attr: { 'aria-hidden': 'true' } });
  }

  // --- Недавно выполненные ---
  root.createEl('h3', { cls: 'mp-stats-section-title', text: t('stats.recent.title') });
  const list = root.createDiv({ cls: 'mp-stats-recent', attr: { role: 'list' } });
  if (model.recent.length === 0) {
    list.createDiv({ cls: 'mp-stats-empty', text: t('stats.recent.empty'), attr: { role: 'listitem' } });
  }
  for (const record of model.recent) renderRecent(list, record, matrix, language, hour12, deps, close);

  if (scrollParent) scrollParent.scrollTop = scrollTop;
}

function summaryCard(parent: HTMLElement, cls: string, icon: string, value: string, label: string): void {
  const card = parent.createDiv({ cls: ['mp-stats-panel', 'mp-stats-card', cls] });
  setIcon(card.createSpan({ cls: 'mp-stats-card-icon', attr: { 'aria-hidden': 'true' } }), icon);
  const text = card.createDiv({ cls: 'mp-stats-card-text' });
  text.createDiv({ cls: 'mp-stats-card-value', text: value });
  text.createDiv({ cls: 'mp-stats-card-label', text: label });
}

function renderRecent(
  list: HTMLElement,
  record: CompletionRecord,
  matrix: MatrixConfig,
  language: string,
  hour12: boolean,
  deps: StatsSheetDeps,
  close: () => void,
): void {
  const quadrant = quadrantInfo(matrix, record.quadrant);
  const date = formatCompletionMoment(record.date, record.time, language, hour12);
  let label = t('stats.recent.item', { title: record.title, date, quadrant: quadrant.title });
  if (record.archived) label += `, ${t('stats.recent.archived')}`;
  const row = list.createDiv({ cls: 'mp-stats-recent-row', attr: { role: 'listitem' } });
  const item = row.createEl('button', {
    cls: ['mp-stats-recent-item', `mp-q-${record.quadrant}`],
    attr: { type: 'button', 'aria-label': label },
  });
  setIcon(item.createSpan({ cls: 'mp-stats-recent-icon', attr: { 'aria-hidden': 'true' } }), quadrant.icon);
  const text = item.createDiv({ cls: 'mp-stats-recent-text', attr: { 'aria-hidden': 'true' } });
  text.createDiv({ cls: 'mp-stats-recent-title', text: record.title });
  text.createDiv({ cls: 'mp-stats-recent-date', text: date });
  setIcon(item.createSpan({ cls: 'mp-stats-recent-check', attr: { 'aria-hidden': 'true' } }), 'check');
  item.addEventListener('click', () => {
    if (!record.archived) {
      deps.actions.openTaskForm({ mode: 'edit', id: record.taskId });
      return;
    }
    // Архивная задача — открыть заметку; лист закрывается, чтобы её было видно.
    close();
    void deps.actions.openNote(record.path);
  });
}

// ---------------------------------------------------------------------------
// Итоги недели
// ---------------------------------------------------------------------------

export function summaryStrings(language: string, matrix: MatrixConfig): SummaryStrings {
  return {
    header: (range, done, streak) => t('stats.summary.header', { range, done, streak }),
    tasks: (count) => tPlural('stats.summary.tasks', count),
    days: (count) => tPlural('stats.summary.dayCount', count),
    quadrantsLabel: t('stats.summary.quadrants'),
    daysLabel: t('stats.summary.days'),
    quadrantTitle: (key) => quadrantInfo(matrix, key).title,
    weekday: (date) => capitalize(weekdayName(date, language, 'short')).replace(/\.$/, ''),
    range: (from, to) => formatDateRange(from, to, language),
  };
}

interface ShareNavigator {
  share?: (data: { text: string }) => Promise<void>;
  clipboard?: { writeText(text: string): Promise<void> };
}

/** «Поделиться» (iOS/Android), иначе — копирование в буфер обмена с уведомлением. */
async function shareSummary(deps: StatsSheetDeps): Promise<void> {
  const model = currentModel(deps);
  const text = buildWeekSummary(model, summaryStrings(deps.format.get().language, deps.index.getMatrix()));
  const nav: ShareNavigator | undefined = typeof navigator === 'undefined' ? undefined : navigator;
  if (typeof nav?.share === 'function') {
    try {
      await nav.share({ text });
      return;
    } catch (error) {
      // Пользователь закрыл окно «Поделиться» — ничего не делаем.
      if (error instanceof Error && error.name === 'AbortError') return;
    }
  }
  try {
    if (!nav?.clipboard) throw new Error('Clipboard unavailable');
    await nav.clipboard.writeText(text);
    deps.notifier.show(t('stats.summary.copied'));
  } catch (error) {
    console.warn('[matrix-planner] cannot share summary', error);
    deps.notifier.show(t('stats.summary.failed'));
  }
}

import { describe, expect, it } from 'vitest';
import {
  adjacentTab,
  createViewState,
  getAddContext,
  navigationKeyFor,
  requestFocus,
  restoreViewState,
  serializeViewState,
  setAddContext,
  setWidth,
  shouldSplit,
  switchTab,
  takePendingFocus,
  visibleTabs,
} from '../../src/ui/view-state';
import type { PlannerViewState } from '../../src/ui/view-state';
import type { PlannerTabId } from '../../src/model/types';

const ALL: readonly PlannerTabId[] = ['tasks', 'calendar', 'lockscreen'];

function fresh(initialTab: PlannerTabId = 'tasks', available: readonly PlannerTabId[] = ALL): PlannerViewState {
  return createViewState({ available, initialTab });
}

describe('view-state: вкладки', () => {
  it('начальная вкладка из опций', () => {
    expect(fresh('calendar').activeTab).toBe('calendar');
  });

  it('недоступная начальная вкладка → первая доступная', () => {
    expect(fresh('lockscreen', ['tasks', 'calendar']).activeTab).toBe('tasks');
  });

  it('список доступных упорядочен по панели', () => {
    const state = createViewState({ available: ['lockscreen', 'tasks'], initialTab: 'tasks' });
    expect(state.available).toEqual(['tasks', 'lockscreen']);
  });

  it('переключение вкладки не меняет исходное состояние', () => {
    const state = fresh();
    const next = switchTab(state, 'calendar');
    expect(next.activeTab).toBe('calendar');
    expect(state.activeTab).toBe('tasks');
  });

  it('переключение на недоступную вкладку игнорируется', () => {
    const state = fresh('tasks', ['tasks', 'calendar']);
    expect(switchTab(state, 'lockscreen')).toBe(state);
  });

  it('повторное переключение на ту же вкладку возвращает то же состояние', () => {
    const state = fresh();
    expect(switchTab(state, 'tasks')).toBe(state);
  });

  it('клавиатура панели: стрелки по кругу, Home/End', () => {
    const state = fresh();
    expect(navigationKeyFor('ArrowRight')).toBe('next');
    expect(navigationKeyFor('ArrowLeft')).toBe('prev');
    expect(navigationKeyFor('Home')).toBe('first');
    expect(navigationKeyFor('End')).toBe('last');
    expect(navigationKeyFor('a')).toBeNull();
    expect(adjacentTab(state, 'tasks', 'next')).toBe('calendar');
    expect(adjacentTab(state, 'lockscreen', 'next')).toBe('tasks');
    expect(adjacentTab(state, 'tasks', 'prev')).toBe('lockscreen');
    expect(adjacentTab(state, 'calendar', 'first')).toBe('tasks');
    expect(adjacentTab(state, 'calendar', 'last')).toBe('lockscreen');
  });

  it('клавиатура пропускает недоступные вкладки', () => {
    const state = fresh('tasks', ['tasks', 'lockscreen']);
    expect(adjacentTab(state, 'tasks', 'next')).toBe('lockscreen');
  });
});

describe('view-state: контекст «+»', () => {
  it('пустой контекст по умолчанию', () => {
    expect(getAddContext(fresh())).toEqual({ date: null, quadrant: null });
  });

  it('контекст хранится отдельно для каждой вкладки', () => {
    let state = fresh();
    state = setAddContext(state, 'tasks', { date: null, quadrant: 'plan' });
    state = setAddContext(state, 'calendar', { date: '2026-10-21', quadrant: null });
    expect(getAddContext(state)).toEqual({ date: null, quadrant: 'plan' });
    state = switchTab(state, 'calendar');
    expect(getAddContext(state)).toEqual({ date: '2026-10-21', quadrant: null });
    state = switchTab(state, 'tasks');
    expect(getAddContext(state).quadrant).toBe('plan');
  });

  it('выбранный день календаря сохраняется при переключении вкладок', () => {
    let state = switchTab(fresh(), 'calendar');
    state = setAddContext(state, 'calendar', { date: '2026-10-10', quadrant: null });
    state = switchTab(state, 'lockscreen');
    state = switchTab(state, 'calendar');
    expect(getAddContext(state).date).toBe('2026-10-10');
  });

  it('некорректные дата и квадрант отбрасываются', () => {
    const state = setAddContext(fresh(), 'tasks', {
      date: '10.10.2026',
      quadrant: 'nope' as unknown as 'do',
    });
    expect(getAddContext(state)).toEqual({ date: null, quadrant: null });
  });

  it('getAddContext возвращает копию', () => {
    const state = setAddContext(fresh(), 'tasks', { date: '2026-10-10', quadrant: 'do' });
    const context = getAddContext(state);
    context.date = '2000-01-01';
    expect(getAddContext(state).date).toBe('2026-10-10');
  });
});

describe('view-state: внешний запрос вкладки', () => {
  it('showTab с датой переключает вкладку, подставляет день в «+» и откладывает focus', () => {
    let state = requestFocus(fresh(), 'calendar', { date: '2026-10-21' });
    expect(state.activeTab).toBe('calendar');
    expect(getAddContext(state).date).toBe('2026-10-21');
    const [next, request] = takePendingFocus(state, 'calendar');
    expect(request).toEqual({ date: '2026-10-21' });
    state = next;
    expect(takePendingFocus(state, 'calendar')[1]).toBeNull();
  });

  it('запрос недоступной вкладки игнорируется', () => {
    const state = fresh('tasks', ['tasks']);
    expect(requestFocus(state, 'calendar', { date: '2026-10-21' })).toBe(state);
  });

  it('запрос без даты не трогает контекст', () => {
    let state = setAddContext(fresh(), 'calendar', { date: '2026-10-05', quadrant: null });
    state = requestFocus(state, 'calendar');
    expect(getAddContext(state).date).toBe('2026-10-05');
  });
});

describe('view-state: две колонки', () => {
  it('включается с 900 px при наличии задач и календаря', () => {
    expect(shouldSplit(899, 900, ALL)).toBe(false);
    expect(shouldSplit(900, 900, ALL)).toBe(true);
    expect(shouldSplit(1200, 900, ['tasks', 'lockscreen'])).toBe(false);
    expect(shouldSplit(1200, null, ALL)).toBe(false);
  });

  it('видимые панели в широкой раскладке', () => {
    let state = setWidth(fresh(), 1024);
    expect(state.split).toBe(true);
    expect(visibleTabs(state)).toEqual(['tasks', 'calendar']);
    state = switchTab(state, 'lockscreen');
    expect(visibleTabs(state)).toEqual(['lockscreen']);
    state = setWidth(switchTab(state, 'calendar'), 600);
    expect(visibleTabs(state)).toEqual(['calendar']);
  });

  it('setWidth без изменения раскладки возвращает то же состояние', () => {
    const state = fresh();
    expect(setWidth(state, 500)).toBe(state);
  });
});

describe('view-state: сохранение', () => {
  it('сериализация и восстановление вкладки и выбранного дня', () => {
    let state = switchTab(fresh(), 'calendar');
    state = setAddContext(state, 'calendar', { date: '2026-10-21', quadrant: null });
    const saved = serializeViewState(state);
    expect(saved).toEqual({ tab: 'calendar', dates: { calendar: '2026-10-21' } });
    const restored = restoreViewState(fresh(), JSON.parse(JSON.stringify(saved)));
    expect(restored.activeTab).toBe('calendar');
    expect(getAddContext(restored).date).toBe('2026-10-21');
  });

  it('без выбранных дней сохраняется только вкладка', () => {
    expect(serializeViewState(fresh())).toEqual({ tab: 'tasks' });
  });

  it('мусор в сохранённом состоянии игнорируется', () => {
    const state = fresh();
    expect(restoreViewState(state, null)).toBe(state);
    expect(restoreViewState(state, 'x')).toBe(state);
    const restored = restoreViewState(state, { tab: 'settings', dates: { calendar: 'bad', foo: '2026-01-01' } });
    expect(restored.activeTab).toBe('tasks');
    expect(getAddContext(restored, 'calendar').date).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import {
  addContextFor,
  goToday,
  headerMonth,
  initCalendarState,
  isFilterNarrowed,
  moveSelection,
  refreshToday,
  selectDate,
  setMode,
  setMonthYear,
  shiftPeriod,
  showTodayButton,
  swipeDirection,
  toggleSource,
  visibleRange,
} from '../../src/calendar/calendar-state';
import { monthGridRange } from '../../src/calendar/month-layout';
import type { CalendarMode, CalendarSourceFilter } from '../../src/model/types';

const TODAY = '2026-10-10';

describe('calendar-state: выбор дня и «Сегодня»', () => {
  it('по умолчанию выбран сегодняшний день; неверная дата не принимается', () => {
    expect(initCalendarState(TODAY).selected).toBe(TODAY);
    expect(initCalendarState(TODAY, 'list', 'не дата').selected).toBe(TODAY);
    expect(initCalendarState(TODAY, 'month', '2026-10-21')).toEqual({ today: TODAY, mode: 'month', selected: '2026-10-21' });
  });

  it('выбор дня и возврат к сегодняшнему', () => {
    const state = selectDate(initCalendarState(TODAY), '2026-10-21');
    expect(state.selected).toBe('2026-10-21');
    expect(showTodayButton(state)).toBe(true);
    const back = goToday(state);
    expect(back.selected).toBe(TODAY);
    expect(showTodayButton(back)).toBe(false);
  });

  it('повторный выбор того же дня не создаёт новое состояние', () => {
    const state = initCalendarState(TODAY);
    expect(selectDate(state, TODAY)).toBe(state);
    expect(selectDate(state, '2026-02-30')).toBe(state);
  });

  it('смена суток переносит выбор только если был выбран прежний «сегодня»', () => {
    const onToday = initCalendarState(TODAY);
    expect(refreshToday(onToday, '2026-10-11')).toEqual({ today: '2026-10-11', mode: 'list', selected: '2026-10-11' });
    const elsewhere = selectDate(onToday, '2026-10-20');
    expect(refreshToday(elsewhere, '2026-10-11').selected).toBe('2026-10-20');
    expect(refreshToday(onToday, TODAY)).toBe(onToday);
  });
});

describe('calendar-state: согласованность режимов', () => {
  const modes: CalendarMode[] = ['list', 'timeline', 'month'];

  it('смена режима сохраняет выбранный день и месяц заголовка', () => {
    let state = selectDate(initCalendarState(TODAY), '2026-10-21');
    for (const mode of modes) {
      state = setMode(state, mode);
      expect(state.mode).toBe(mode);
      expect(state.selected).toBe('2026-10-21');
      expect(headerMonth(state)).toEqual({ year: 2026, month: 10 });
      expect(addContextFor(state)).toEqual({ date: '2026-10-21', quadrant: null });
    }
  });

  it('диапазон данных любого режима содержит выбранный день', () => {
    for (const mode of modes) {
      for (const weekStart of [0, 1] as const) {
        const state = setMode(selectDate(initCalendarState(TODAY), '2026-11-01'), mode);
        const range = visibleRange(state, weekStart);
        expect(range.from <= state.selected && state.selected <= range.to).toBe(true);
      }
    }
  });

  it('неделя — 7 дней от начала недели, месяц — сетка месяца', () => {
    const list = initCalendarState(TODAY);
    expect(visibleRange(list, 1)).toEqual({ from: '2026-10-05', to: '2026-10-11' });
    expect(visibleRange(list, 0)).toEqual({ from: '2026-10-04', to: '2026-10-10' });
    expect(visibleRange(setMode(list, 'month'), 1)).toEqual(monthGridRange(2026, 10, 1));
  });

  it('неизвестный режим игнорируется', () => {
    const state = initCalendarState(TODAY);
    expect(setMode(state, 'week' as CalendarMode)).toBe(state);
  });
});

describe('calendar-state: прокрутка и выбор месяца/года', () => {
  it('в «Списке» и «Временной шкале» период — неделя', () => {
    const state = initCalendarState(TODAY, 'timeline');
    expect(shiftPeriod(state, 1).selected).toBe('2026-10-17');
    expect(shiftPeriod(state, -2).selected).toBe('2026-09-26');
    expect(shiftPeriod(state, 0)).toBe(state);
  });

  it('в «Месяце» период — месяц с прижатием дня к концу месяца', () => {
    const state = selectDate(initCalendarState(TODAY, 'month'), '2026-01-31');
    expect(shiftPeriod(state, 1).selected).toBe('2026-02-28');
    expect(shiftPeriod(state, -1).selected).toBe('2025-12-31');
  });

  it('выбор месяца и года сохраняет день, прижимая его к концу месяца', () => {
    const state = selectDate(initCalendarState(TODAY), '2026-10-31');
    expect(setMonthYear(state, 2027, 2).selected).toBe('2027-02-28');
    expect(setMonthYear(state, 2028, 2).selected).toBe('2028-02-29');
    expect(setMonthYear(state, 2026, 13)).toBe(state);
  });

  it('стрелки клавиатуры переходят через границу недели', () => {
    const state = selectDate(initCalendarState(TODAY), '2026-10-11');
    expect(moveSelection(state, 1).selected).toBe('2026-10-12');
    expect(moveSelection(state, -7).selected).toBe('2026-10-04');
  });

  it('свайп: влево — следующая неделя, вправо — предыдущая; вертикальный и короткий — нет', () => {
    expect(swipeDirection(-80, 5)).toBe(1);
    expect(swipeDirection(80, -5)).toBe(-1);
    expect(swipeDirection(20, 0)).toBe(0);
    expect(swipeDirection(-60, 70)).toBe(0);
  });
});

describe('calendar-state: фильтр источников', () => {
  const all: CalendarSourceFilter = { tasks: true, events: true, notes: true, external: true };

  it('переключение источника не меняет остальные и не мутирует исходный фильтр', () => {
    const next = toggleSource(all, 'notes');
    expect(next).toEqual({ tasks: true, events: true, notes: false, external: true });
    expect(all.notes).toBe(true);
    expect(toggleSource(next, 'notes')).toEqual(all);
  });

  it('фильтр считается суженным, если скрыт хотя бы один источник', () => {
    expect(isFilterNarrowed(all)).toBe(false);
    expect(isFilterNarrowed(toggleSource(all, 'external'))).toBe(true);
  });
});

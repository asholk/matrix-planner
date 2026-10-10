import { describe, expect, it } from 'vitest';
import {
  addDays,
  applyValue,
  buildMonthGrid,
  chooseMonth,
  daysInMonth,
  initDatePickerState,
  isLocalDate,
  monthNames,
  monthTitle,
  moveFocus,
  quickDates,
  selectDate,
  shiftMonth,
  shiftYear,
  shiftYearMonth,
  toggleMode,
  weekdayLabels,
} from '../../src/ui/controls/date-picker';

const TODAY = '2026-10-10';

describe('date-picker: начальное состояние', () => {
  it('без значения показывает месяц сегодняшнего дня', () => {
    const state = initDatePickerState(null, TODAY);
    expect(state.value).toBeNull();
    expect(state.view).toEqual({ year: 2026, month: 9 });
    expect(state.focusDate).toBe(TODAY);
    expect(state.mode).toBe('days');
  });

  it('со значением показывает его месяц', () => {
    const state = initDatePickerState('2027-02-14', TODAY);
    expect(state.view).toEqual({ year: 2027, month: 1 });
    expect(state.focusDate).toBe('2027-02-14');
  });

  it('некорректное значение отбрасывается', () => {
    expect(initDatePickerState('2026-02-30', TODAY).value).toBeNull();
    expect(isLocalDate('2026-13-01')).toBe(false);
    expect(isLocalDate('2028-02-29')).toBe(true);
  });
});

describe('date-picker: смена месяца и года', () => {
  it('стрелки листают месяцы через границу года', () => {
    let state = initDatePickerState(null, '2026-12-15');
    state = shiftMonth(state, 1);
    expect(state.view).toEqual({ year: 2027, month: 0 });
    state = shiftMonth(state, -2);
    expect(state.view).toEqual({ year: 2026, month: 10 });
  });

  it('31-е число переходит на последний день короткого месяца, значение не меняется', () => {
    const state = shiftMonth(initDatePickerState('2026-01-31', TODAY), 1);
    expect(state.focusDate).toBe('2026-02-28');
    expect(state.value).toBe('2026-01-31');
  });

  it('29 февраля високосного года → 28 февраля через год', () => {
    const state = shiftYear(initDatePickerState('2028-02-29', TODAY), 1);
    expect(state.view).toEqual({ year: 2029, month: 1 });
    expect(state.focusDate).toBe('2029-02-28');
  });

  it('режим месяцев: выбор месяца возвращает к дням', () => {
    let state = toggleMode(initDatePickerState(null, TODAY));
    expect(state.mode).toBe('months');
    state = shiftYear(state, 1);
    state = chooseMonth(state, 2);
    expect(state.mode).toBe('days');
    expect(state.view).toEqual({ year: 2027, month: 2 });
  });

  it('год ограничен диапазоном', () => {
    expect(shiftYearMonth({ year: 2999, month: 11 }, 1)).toEqual({ year: 2999, month: 11 });
    expect(shiftYearMonth({ year: 1900, month: 0 }, -1)).toEqual({ year: 1900, month: 0 });
  });
});

describe('date-picker: выбор и значение', () => {
  it('выбор дня меняет значение и показывает его месяц', () => {
    let state = shiftMonth(initDatePickerState(null, TODAY), 3);
    state = selectDate(state, '2026-10-21');
    expect(state.value).toBe('2026-10-21');
    expect(state.view).toEqual({ year: 2026, month: 9 });
  });

  it('очистка оставляет видимый месяц', () => {
    const state = selectDate(initDatePickerState('2026-10-21', TODAY), null);
    expect(state.value).toBeNull();
    expect(state.view).toEqual({ year: 2026, month: 9 });
  });

  it('внешний setValue', () => {
    let state = initDatePickerState(null, TODAY);
    state = applyValue(state, '2027-03-05');
    expect(state.value).toBe('2027-03-05');
    expect(state.view).toEqual({ year: 2027, month: 2 });
    expect(applyValue(state, null).value).toBeNull();
  });

  it('быстрые варианты: сегодня, завтра, через неделю (через границу месяца)', () => {
    expect(quickDates('2026-10-30')).toEqual({ today: '2026-10-30', tomorrow: '2026-10-31', nextWeek: '2026-11-06' });
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('date-picker: сетка месяца', () => {
  it('октябрь 2026 с понедельника — как на кадре 04', () => {
    const grid = buildMonthGrid({ year: 2026, month: 9 }, 1);
    expect(grid).toHaveLength(5);
    expect(grid[0]).toEqual([null, null, null, '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
    expect(grid[4]).toEqual(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', null]);
  });

  it('неделя с воскресенья сдвигает пустые ячейки', () => {
    const grid = buildMonthGrid({ year: 2026, month: 9 }, 0);
    expect(grid[0]?.slice(0, 5)).toEqual([null, null, null, null, '2026-10-01']);
  });

  it('февраль 2027 с понедельника занимает ровно 4 недели', () => {
    expect(buildMonthGrid({ year: 2027, month: 1 }, 1)).toHaveLength(4);
    expect(daysInMonth(2028, 1)).toBe(29);
  });

  it('подписи на двух языках', () => {
    expect(monthTitle('ru', { year: 2026, month: 9 })).toMatch(/^Октябрь 2026/);
    expect(monthTitle('en', { year: 2026, month: 9 })).toBe('October 2026');
    expect(monthNames('ru')[0]).toBe('Январь');
    expect(weekdayLabels('en', 1)[0]).toBe('Mon');
    expect(weekdayLabels('en', 0)[0]).toBe('Sun');
  });
});

describe('date-picker: клавиатура', () => {
  const base = initDatePickerState(null, '2026-10-01');

  it('стрелки двигают фокус и переводят месяц', () => {
    const left = moveFocus(base, 'ArrowLeft', 1);
    expect(left?.focusDate).toBe('2026-09-30');
    expect(left?.view).toEqual({ year: 2026, month: 8 });
    expect(moveFocus(base, 'ArrowDown', 1)?.focusDate).toBe('2026-10-08');
    expect(moveFocus(base, 'ArrowUp', 1)?.focusDate).toBe('2026-09-24');
  });

  it('PageDown — месяц, Shift+PageDown — год', () => {
    expect(moveFocus(base, 'PageDown', 1)?.focusDate).toBe('2026-11-01');
    expect(moveFocus(base, 'PageDown', 1, true)?.focusDate).toBe('2027-10-01');
  });

  it('Home/End — границы недели с учётом начала недели', () => {
    // 2026-10-01 — четверг.
    expect(moveFocus(base, 'Home', 1)?.focusDate).toBe('2026-09-28');
    expect(moveFocus(base, 'End', 1)?.focusDate).toBe('2026-10-04');
    expect(moveFocus(base, 'Home', 0)?.focusDate).toBe('2026-09-27');
  });

  it('прочие клавиши не обрабатываются', () => {
    expect(moveFocus(base, 'a', 1)).toBeNull();
  });
});

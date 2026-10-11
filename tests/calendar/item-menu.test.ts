import { describe, expect, it, vi } from 'vitest';
import { Menu } from '../__mocks__/obsidian';
import { setLanguageOverride } from '../../src/i18n';
import { calendarItemMenu } from '../../src/calendar/item-menu';
import { shiftEventPatch } from '../../src/events/event-draft';
import { addTaskMenuItems, type TaskMenuDeps } from '../../src/tasks/task-menu';
import { defaultMatrixConfig } from '../../src/model/defaults';
import type { OpResult } from '../../src/model/types';

const OK: OpResult = { ok: true, value: undefined, changed: true };

describe('calendarItemMenu', () => {
  it('событие-заметка: «Открыть заметку», «Изменить», «Перенести на завтра», «Удалить»', () => {
    expect(calendarItemMenu({ source: 'event' })?.map((e) => e.action)).toEqual(['open-note', 'edit', 'postpone', 'delete']);
    expect(calendarItemMenu({ source: 'event' })?.find((e) => e.action === 'delete')?.warning).toBe(true);
  });

  it('быстрая заметка: «Открыть заметку», «Удалить»; внешнее событие — только «Открыть»', () => {
    expect(calendarItemMenu({ source: 'note' })?.map((e) => e.action)).toEqual(['open-note', 'delete']);
    expect(calendarItemMenu({ source: 'external' })?.map((e) => e.action)).toEqual(['view']);
  });

  it('задача — меню вкладки «Задачи» (null)', () => {
    expect(calendarItemMenu({ source: 'task' })).toBeNull();
  });
});

describe('shiftEventPatch: «Перенести на завтра»', () => {
  it('событие со временем: начало и конец +1 день, время сохраняется', () => {
    const patch = shiftEventPatch({ allDay: false, start: { date: '2026-10-31', time: '23:00' }, end: { date: '2026-11-01', time: '00:30' } }, 1);
    expect(patch).toEqual({ allDay: false, start: { date: '2026-11-01', time: '23:00' }, end: { date: '2026-11-02', time: '00:30' } });
  });

  it('событие на весь день: конец в патче — включительный последний день', () => {
    // В заметке end исключительный: 10–11 октября хранится как start 10, end 12.
    const patch = shiftEventPatch({ allDay: true, start: { date: '2026-10-10', time: null }, end: { date: '2026-10-12', time: null } }, 1);
    expect(patch).toEqual({ allDay: true, start: { date: '2026-10-11', time: null }, end: { date: '2026-10-12', time: null } });
  });
});

describe('addTaskMenuItems: меню задачи на вкладках «Задачи» и «Календарь»', () => {
  function setup(done = false) {
    setLanguageOverride('ru');
    const tasks = {
      moveToQuadrant: vi.fn(async () => OK),
      postponeToTomorrow: vi.fn(async () => OK),
      uncomplete: vi.fn(async () => OK),
      delete: vi.fn(async () => OK),
    };
    const openNote = vi.fn();
    const messages: Array<string | undefined> = [];
    const deps: TaskMenuDeps = {
      tasks,
      matrix: () => defaultMatrixConfig('ru'),
      openNote,
      run: (op, message) => {
        messages.push(message);
        void op();
      },
    };
    const menu = new Menu();
    addTaskMenuItems(menu as never, { taskId: 'T1', path: 'Задачи/T1.md', quadrant: 'do', done, instanceDate: '2026-10-10' }, deps);
    return { menu, tasks, openNote, messages };
  }

  it('пункты: открыть, три квадранта, на завтра, удалить', () => {
    const { menu } = setup();
    const titles = menu.menuItems.map((item) => item.title);
    expect(titles[0]).toBe('Открыть заметку');
    expect(titles.filter((title) => title.startsWith('Перенести в квадрант'))).toHaveLength(3);
    expect(titles.slice(-2)).toEqual(['Перенести на завтра', 'Удалить']);
    expect(menu.menuItems.at(-1)?.isWarning).toBe(true);
  });

  it('действия вызывают сервис задач и открытие заметки', () => {
    const { menu, tasks, openNote, messages } = setup();
    for (const item of menu.menuItems) item.click();
    expect(openNote).toHaveBeenCalledWith('Задачи/T1.md');
    expect(tasks.moveToQuadrant).toHaveBeenCalledTimes(3);
    expect(tasks.postponeToTomorrow).toHaveBeenCalledWith('T1');
    expect(tasks.delete).toHaveBeenCalledWith('T1');
    expect(messages.at(-1)).toBe('Задача удалена в корзину');
  });

  it('выполненная — «Вернуть в работу» с датой повторения', () => {
    const { menu, tasks } = setup(true);
    menu.menuItems.find((item) => item.title === 'Вернуть в работу')?.click();
    expect(tasks.uncomplete).toHaveBeenCalledWith('T1', '2026-10-10');
  });
});

describe('строка дня: меню и нажатие', () => {
  it('ПКМ и Shift+F10 открывают меню, нажатие — элемент', async () => {
    const { MockElement } = await import('../__mocks__/obsidian');
    const { renderItemRow } = await import('../../src/calendar/day-list');
    const item = { key: 'event:E1:x@2026-10-10', source: 'event', eventId: 'E1', title: 'Встреча' } as never;
    const row = {
      key: 'event:E1:x@2026-10-10', item, source: 'event', title: 'Встреча', color: '#007AFF', action: { kind: 'event', eventId: 'E1' },
      timeLabel: '10:00', rangeLabel: '10:00–11:00', allDay: false, checkable: false, completed: false, overdue: false,
      recurring: false, readOnly: false, continues: false, icon: null, quadrant: null, calendarId: null,
    } as never;
    const open = vi.fn();
    const menu = vi.fn();
    const parent = new MockElement('div');
    const el = renderItemRow(parent as never, row, {
      isMobile: true,
      quadrantTitle: () => '',
      calendarTitle: () => null,
      handlers: { open, menu, toggle: () => undefined, isBusy: () => false },
    }, true) as unknown as InstanceType<typeof MockElement>;
    const card = el.findAllByClass('mp-cal-row-card')[0];
    card?.dispatch('contextmenu', { type: 'contextmenu', clientX: 3, clientY: 4, preventDefault: () => undefined, stopPropagation: () => undefined });
    expect(menu).toHaveBeenCalledWith(item, expect.objectContaining({ clientX: 3 }));
    card?.dispatch('click', { type: 'click', stopPropagation: () => undefined });
    expect(open).toHaveBeenCalledWith(item);
  });
});

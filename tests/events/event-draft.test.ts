import { describe, expect, it } from 'vitest';
import type { EventService } from '../../src/app/contracts';
import type { EventDraft, EventPatch, OpResult, PlannerEvent } from '../../src/model/types';
import { EVENT_COLORS } from '../../src/model/types';
import { parseEvent } from '../../src/model/properties';
import { okResult } from '../../src/storage/note-repository';
import {
  EVENT_COLOR_OPTIONS,
  EventDraftController,
  createEventDraftState,
  defaultEventSlot,
  draftStateFromEvent,
  exclusiveEndDate,
  inclusiveEndDate,
  isPatchEmpty,
  scheduleError,
  setAllDay,
  setColor,
  setEnd,
  setStart,
  setTitle,
  toEventDraft,
  toEventPatch,
  validateEventDraft,
} from '../../src/events/event-draft';

const NOW = { date: '2026-10-10', time: '13:20' };

function event(fm: Record<string, unknown>): PlannerEvent {
  const parsed = parseEvent({
    path: 'Планировщик/События/Концерт.md',
    title: 'Концерт',
    mtime: 1,
    frontmatter: { type: 'event', id: '01EVENT', ...fm },
    archived: false,
    deletedInCalendar: false,
  });
  if (parsed.kind !== 'event') throw new Error('ожидалось событие');
  return parsed;
}

describe('время по умолчанию', () => {
  it('сегодня — ближайший целый час, длительность 1 час', () => {
    const slot = defaultEventSlot(NOW, null);
    expect(slot.start).toEqual({ date: '2026-10-10', time: '14:00' });
    expect(slot.end).toEqual({ date: '2026-10-10', time: '15:00' });
  });

  it('ровно целый час остаётся как есть', () => {
    expect(defaultEventSlot({ date: '2026-10-10', time: '13:00' }, '2026-10-10').start.time).toBe('13:00');
  });

  it('поздний вечер не уводит начало на следующий день', () => {
    const slot = defaultEventSlot({ date: '2026-10-10', time: '23:40' }, null);
    expect(slot.start).toEqual({ date: '2026-10-10', time: '23:00' });
    expect(slot.end).toEqual({ date: '2026-10-11', time: '00:00' });
  });

  it('выбранный другой день — 09:00 этого дня', () => {
    const state = createEventDraftState({ now: NOW, date: '2026-10-21' });
    expect([state.startDate, state.startTime, state.endDate, state.endTime]).toEqual(['2026-10-21', '09:00', '2026-10-21', '10:00']);
  });

  it('новое событие: синий цвет, без повтора, календарь «Планировщик»', () => {
    const state = createEventDraftState({ now: NOW });
    expect(state.color).toBe('blue');
    expect(state.repeat).toBe('none');
    expect(state.calendarId).toBeNull();
    expect(state.allDay).toBe(false);
  });
});

describe('конец позже начала', () => {
  it('конец раньше или равен началу — ошибка', () => {
    let state = setTitle(createEventDraftState({ now: NOW }), 'Встреча');
    expect(validateEventDraft(state).valid).toBe(true);
    state = setEnd(state, state.startDate, state.startTime);
    expect(validateEventDraft(state).errors.end).toBe('before-start');
    state = setEnd(state, state.startDate, '08:00');
    expect(validateEventDraft(state).valid).toBe(false);
  });

  it('смена начала сдвигает конец с сохранением длительности', () => {
    const state = setStart(createEventDraftState({ now: NOW }), '2026-10-21', '18:30');
    expect([state.endDate, state.endTime]).toEqual(['2026-10-21', '19:30']);
  });

  it('событие через полночь допустимо', () => {
    const state = setTitle(setStart(createEventDraftState({ now: NOW }), '2026-10-21', '23:30'), 'Ночь');
    expect([state.endDate, state.endTime]).toEqual(['2026-10-22', '00:30']);
    expect(validateEventDraft(state).valid).toBe(true);
  });

  it('пустое название — ошибка', () => {
    expect(validateEventDraft(createEventDraftState({ now: NOW })).errors.title).toBe('required');
  });

  it('scheduleError для событий на весь день сравнивает включительные даты', () => {
    const day = { date: '2026-10-21', time: null };
    expect(scheduleError({ allDay: true, start: day, end: day })).toBeNull();
    expect(scheduleError({ allDay: true, start: day, end: { date: '2026-10-20', time: null } })).toBe('end');
    expect(scheduleError({ allDay: false, start: { date: '2026-10-21', time: '10:00' }, end: { date: '2026-10-21', time: '10:00' } })).toBe('end');
  });
});

describe('«Весь день» и исключительный конец', () => {
  it('перевод конца: включительный ↔ исключительный', () => {
    expect(exclusiveEndDate('2026-10-21')).toBe('2026-10-22');
    expect(inclusiveEndDate('2026-10-21', '2026-10-22')).toBe('2026-10-21');
    // Повреждённый конец не уводит последний день раньше начала.
    expect(inclusiveEndDate('2026-10-21', '2026-10-21')).toBe('2026-10-21');
  });

  it('событие на 21 окт. из свойств показывается в форме одним днём', () => {
    const state = draftStateFromEvent(event({ start: '2026-10-21', end: '2026-10-22', all_day: true }), '', NOW);
    expect(state.allDay).toBe(true);
    expect([state.startDate, state.endDate]).toEqual(['2026-10-21', '2026-10-21']);
    expect(toEventDraft(state).end).toEqual({ date: '2026-10-21', time: null });
  });

  it('включение «Весь день» оставляет даты; конец в 00:00 не добавляет день', () => {
    const base = setStart(createEventDraftState({ now: NOW }), '2026-10-21', '23:00');
    const allDay = setAllDay(base, true);
    expect([allDay.startDate, allDay.endDate]).toEqual(['2026-10-21', '2026-10-21']);
    expect(toEventDraft(allDay).start.time).toBeNull();
  });

  it('выключение «Весь день» возвращает время; однодневное событие получает час', () => {
    const base = createEventDraftState({ now: NOW, date: '2026-10-21' });
    const back = setAllDay(setAllDay(base, true), false);
    expect([back.startTime, back.endDate, back.endTime]).toEqual(['09:00', '2026-10-21', '10:00']);
  });

  it('смена начала события на весь день сдвигает последний день', () => {
    let state = setAllDay(createEventDraftState({ now: NOW, date: '2026-10-21' }), true);
    state = setEnd(state, '2026-10-23');
    state = setStart(state, '2026-10-25');
    expect([state.startDate, state.endDate]).toEqual(['2026-10-25', '2026-10-27']);
  });
});

describe('цвета', () => {
  it('8 цветов в порядке палитры', () => {
    expect(EVENT_COLOR_OPTIONS).toEqual(['blue', 'red', 'orange', 'yellow', 'green', 'teal', 'sky', 'purple']);
    expect(EVENT_COLOR_OPTIONS).toEqual(EVENT_COLORS);
  });

  it('неизвестный цвет игнорируется', () => {
    const state = createEventDraftState({ now: NOW });
    expect(setColor(state, 'pink' as never)).toBe(state);
    expect(setColor(state, 'purple').color).toBe('purple');
  });
});

describe('правка всей серии', () => {
  const series = event({ start: '2026-10-21T09:00', end: '2026-10-21T10:00', repeat: 'weekly', color: 'green', icon: 'star' });

  it('без изменений патч пуст', () => {
    expect(isPatchEmpty(toEventPatch(draftStateFromEvent(series, 'тело', NOW)))).toBe(true);
  });

  it('изменение начала передаёт начало, конец и «Весь день» вместе', () => {
    const state = setStart(draftStateFromEvent(series, 'тело', NOW), '2026-10-22', '11:00');
    expect(toEventPatch(state)).toEqual({
      allDay: false,
      start: { date: '2026-10-22', time: '11:00' },
      end: { date: '2026-10-22', time: '12:00' },
    });
  });

  it('тело не попадает в патч, пока не загружено', () => {
    const state = draftStateFromEvent(series, null, NOW);
    expect(state.bodyLoaded).toBe(false);
    expect(toEventPatch(setTitle(state, 'Новое'))).toEqual({ title: 'Новое' });
  });
});

describe('EventDraftController', () => {
  function fakeEvents() {
    const calls: Array<EventDraft | EventPatch> = [];
    let release: (() => void) | null = null;
    const service: Pick<EventService, 'create' | 'update'> = {
      create: (draft) =>
        new Promise<OpResult<PlannerEvent | null>>((resolve) => {
          calls.push(draft);
          release = () => resolve(okResult(null));
        }),
      update: async (_id, patch) => {
        calls.push(patch);
        return okResult(undefined);
      },
    };
    return { service, calls, release: () => release?.() };
  }

  it('повторное «Готово» не создаёт второе событие', async () => {
    const fake = fakeEvents();
    const controller = new EventDraftController(setTitle(createEventDraftState({ now: NOW }), 'Концерт'), fake.service);
    const first = controller.submit();
    expect(await controller.submit()).toEqual({ ok: false, reason: 'busy' });
    fake.release();
    expect((await first).ok).toBe(true);
    expect(await controller.submit()).toEqual({ ok: false, reason: 'busy' });
    expect(fake.calls).toHaveLength(1);
  });

  it('невалидный черновик не отправляется', async () => {
    const fake = fakeEvents();
    const controller = new EventDraftController(createEventDraftState({ now: NOW }), fake.service);
    expect(controller.canSubmit()).toBe(false);
    expect(await controller.submit()).toEqual({ ok: false, reason: 'invalid' });
    expect(fake.calls).toHaveLength(0);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockElement } from '../__mocks__/obsidian';
import { setLanguageOverride, t } from '../../src/i18n';
import type { SheetHandle, SheetOptions } from '../../src/app/contracts';
import { createDefaultSettings } from '../../src/settings/defaults';
import { calendarHintKey, isEventDraftDirty, openEventForm, type EventFormDeps, type EventFormOptions } from '../../src/events/event-form';
import { createEventDraftState, setColor, setTitle } from '../../src/events/event-draft';
import { isNoteFormDirty, openNoteForm, type NoteFormDeps } from '../../src/notes/note-form';
import type { HapticKind } from '../../src/ui/haptics';

const NOW = { date: '2026-10-11', time: '10:20' };

function fakeSheets() {
  const content = new MockElement();
  const handle = { submit: vi.fn(), close: vi.fn(), requestClose: vi.fn(async () => true) };
  let opened: SheetOptions | null = null;
  const sheets = {
    open: (options: SheetOptions): SheetHandle => {
      opened = options;
      const sheetHandle: SheetHandle = { setSubmitEnabled: () => undefined, setBusy: () => undefined, ...handle };
      options.render(content as unknown as HTMLElement, sheetHandle);
      return sheetHandle;
    },
  };
  return { sheets, content, handle, options: () => opened as unknown as SheetOptions };
}

function eventDeps(sheets: ReturnType<typeof fakeSheets>['sheets'], haptics: HapticKind[]): EventFormDeps {
  return {
    events: {
      create: async () => ({ ok: true, changed: true, value: null }),
      update: async () => ({ ok: true, changed: true, value: undefined }),
      delete: async () => ({ ok: true, changed: true, value: undefined }),
      getWritableCalendars: () => [{ calendarId: null, title: 'Планировщик', color: '#888' }],
    },
    index: { getById: () => undefined },
    repository: { readBody: async () => ({ ok: true, changed: false, value: '' }) },
    sheets,
    datePicker: () => ({ setValue: () => undefined, destroy: () => undefined }),
    clock: { now: () => new Date('2026-10-11T07:20:00Z'), timeZone: () => 'Europe/Moscow' },
    format: { get: () => ({ language: 'ru', weekStart: 1, hour12: false }) },
    notifier: { show: () => undefined },
    settings: { get: () => createDefaultSettings() },
    calendarCache: { getCalendars: () => [] },
    platform: { isMobile: true },
    haptics: { play: (kind: HapticKind) => haptics.push(kind) },
  } as unknown as EventFormDeps;
}

// Точка календаря: глобальный `createSpan` Obsidian и `prepend` (в моке DOM их нет).
vi.stubGlobal('createSpan', (info?: unknown) => new MockElement().createSpan(info as never));
const proto = MockElement.prototype as unknown as { prepend?: (child: MockElement) => void };
proto.prepend ??= function (this: MockElement, child: MockElement) {
  child.parent = this;
  this.children.unshift(child);
};

beforeEach(() => setLanguageOverride('ru'));
afterEach(() => setLanguageOverride(null));

describe('форма события: подсказка календаря (006, §4)', () => {
  it('без синхронизации — «Подключите „Календарь iOS“…», с синхронизацией — без подсказки', () => {
    expect(calendarHintKey({ isConfigured: () => false, openSettings: () => undefined })).toBe('events.calendarConnectHint');
    expect(calendarHintKey({ isConfigured: () => true, openSettings: () => undefined })).toBeNull();
    expect(calendarHintKey(undefined)).toBeNull();
    expect(t('events.calendarConnectHint')).toBe('Подключите «Календарь iOS» в настройках, чтобы выбрать календарь iPhone.');
  });

  it('устаревшая подсказка про компаньон удалена', () => {
    expect(t('events.calendarHint')).toBe('events.calendarHint');
  });

  it('ссылка «Настройки» закрывает форму и открывает вкладку «Настройки»', async () => {
    const fake = fakeSheets();
    const openSettings = vi.fn();
    const options: EventFormOptions = { calendarSync: { isConfigured: () => false, openSettings } };
    openEventForm(eventDeps(fake.sheets, []), { mode: 'create' }, options);
    const link = fake.content.findAllByClass('mp-event-form-hint-link')[0];
    expect(link?.getText()).toBe('Настройки');
    link?.dispatch('click');
    await vi.waitFor(() => expect(openSettings).toHaveBeenCalledTimes(1));
    expect(fake.handle.requestClose).toHaveBeenCalledTimes(1);
  });

  it('синхронизация настроена — подсказки нет', () => {
    const fake = fakeSheets();
    openEventForm(eventDeps(fake.sheets, []), { mode: 'create' }, { calendarSync: { isConfigured: () => true, openSettings: () => undefined } });
    expect(fake.content.findAllByClass('mp-event-form-calendar-hint')).toHaveLength(0);
  });
});

describe('форма события: черновик, Enter, время с шкалы', () => {
  it('изменённость нового события', () => {
    const base = createEventDraftState({ now: NOW });
    expect(isEventDraftDirty(base, base)).toBe(false);
    expect(isEventDraftDirty(setTitle(base, 'Йога'), base)).toBe(true);
    expect(isEventDraftDirty(setColor(base, 'red'), base)).toBe(true);
  });

  it('начало из долгого нажатия: выбранный день и время, длительность 1 ч', () => {
    const state = createEventDraftState({ now: NOW, date: '2026-10-14', time: '14:15' });
    expect([state.startDate, state.startTime, state.endDate, state.endTime]).toEqual(['2026-10-14', '14:15', '2026-10-14', '15:15']);
    const late = createEventDraftState({ now: NOW, date: '2026-10-14', time: '23:45' });
    expect([late.endDate, late.endTime]).toEqual(['2026-10-15', '00:45']);
  });

  it('Enter в названии сохраняет; выбор цвета — select; isDirty передан листу', () => {
    const fake = fakeSheets();
    const haptics: HapticKind[] = [];
    openEventForm(eventDeps(fake.sheets, haptics), { mode: 'create' });
    expect(haptics).toEqual(['tap']);
    const title = fake.content.findAllByClass('mp-task-form-title')[0];
    if (!title) throw new Error('нет названия');
    expect(title.getAttribute('enterkeyhint')).toBe('done');
    title.value = 'Йога';
    title.dispatch('input');
    expect(fake.options().isDirty?.()).toBe(true);
    title.dispatch('keydown', { key: 'Enter', isComposing: false, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, preventDefault: () => undefined });
    expect(fake.handle.submit).toHaveBeenCalledTimes(1);
    fake.content.findAllByClass('mp-event-form-swatch')[2]?.dispatch('click');
    expect(haptics.at(-1)).toBe('select');
  });
});

describe('форма заметки (006, §6, §9)', () => {
  it('изменённость: создание и правка', () => {
    expect(isNoteFormDirty({ title: '', body: '', bodyLoaded: true, date: '2026-10-11' }, null, '2026-10-11')).toBe(false);
    expect(isNoteFormDirty({ title: 'Идея', body: '', bodyLoaded: true, date: '2026-10-11' }, null, '2026-10-11')).toBe(true);
    expect(isNoteFormDirty({ title: '', body: '', bodyLoaded: true, date: null }, null, '2026-10-11')).toBe(true);
    const initial = { title: 'Идея', body: 'текст', date: null };
    expect(isNoteFormDirty({ title: 'Идея', body: 'текст', bodyLoaded: true, date: null }, initial, null)).toBe(false);
    expect(isNoteFormDirty({ title: 'Идея 2', body: 'текст', bodyLoaded: true, date: null }, initial, null)).toBe(true);
  });

  it('Enter в названии сохраняет заметку', () => {
    const fake = fakeSheets();
    const deps = {
      index: { getById: () => undefined },
      repository: { readBody: async () => ({ ok: true, changed: false, value: '' }) },
      sheets: fake.sheets,
      datePicker: () => ({ setValue: () => undefined, destroy: () => undefined }),
      clock: { now: () => new Date('2026-10-11T07:20:00Z'), timeZone: () => 'Europe/Moscow' },
      format: { get: () => ({ language: 'ru', weekStart: 1, hour12: false }) },
      notifier: { show: () => undefined },
      notes: { create: async () => ({ ok: true, changed: true, value: 'x.md' }) },
      openNote: async () => undefined,
    } as unknown as NoteFormDeps;
    openNoteForm(deps, { mode: 'create' });
    const title = fake.content.findAllByClass('mp-task-form-title')[0];
    if (!title) throw new Error('нет названия');
    expect(title.getAttribute('enterkeyhint')).toBe('done');
    title.value = 'Идея';
    title.dispatch('input');
    title.dispatch('keydown', { key: 'Enter', isComposing: false, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, preventDefault: () => undefined });
    expect(fake.handle.submit).toHaveBeenCalledTimes(1);
  });
});

describe('форма события со шкалы: «Сбросить изменения?» только после правки пользователя (007)', () => {
  it('открыта долгим нажатием на шкале и закрыта без правок — не спрашивает', () => {
    const fake = fakeSheets();
    openEventForm(eventDeps(fake.sheets, []), { mode: 'create', date: '2026-10-14', time: '14:15' } as never);
    // Подстановка без участия пользователя (например, календарь после загрузки) не делает форму изменённой.
    expect(fake.options().isDirty?.()).toBe(false);
  });

  it('после ввода в название — спрашивает', () => {
    const fake = fakeSheets();
    openEventForm(eventDeps(fake.sheets, []), { mode: 'create', date: '2026-10-14', time: '14:15' } as never);
    const title = fake.content.findAllByClass('mp-task-form-title')[0];
    if (!title) throw new Error('нет названия');
    title.value = 'Йога';
    title.dispatch('input');
    expect(fake.options().isDirty?.()).toBe(true);
  });
});

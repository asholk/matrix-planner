/**
 * Чтение `_system/calendar-cache.json` (ТЗ §5.4.4). Только чтение: файл пишет компаньон
 * основного устройства, `SystemJsonStore` запись этого файла запрещает.
 *
 * Состояние хранится в памяти; `refresh` перечитывает файл (по событиям хранилища из `watch`
 * или вручную). Флаг `stale` пересчитывается по часам при каждом `getState`.
 */

import type { App } from 'obsidian';
import type { CalendarCacheReader, Clock, SystemJsonStore } from '../app/contracts';
import { registerDictionary } from '../i18n';
import { watchSystemFile } from '../storage/system-records';
import { enCache } from '../i18n/en/cache';
import { ruCache } from '../i18n/ru/cache';
import {
  SYSTEM_FILES,
  type CacheCoverage,
  type CachedCalendar,
  type CalendarCacheState,
  type LocalDateString,
  type Unsubscribe,
} from '../model/types';
import { cacheCoverage, DEFAULT_CACHE_STALE_MS, isCacheStale, parseCalendarCache, toCacheState } from './cache-schema';

registerDictionary('ru', 'cache', ruCache);
registerDictionary('en', 'cache', enCache);

export interface CalendarCacheReaderDeps {
  store: Pick<SystemJsonStore, 'read' | 'path'>;
  clock: Clock;
  /** Порог устаревания, мс (по умолчанию 48 ч). */
  staleAfterMs?: number;
}

const EMPTY_CALENDARS: readonly CachedCalendar[] = Object.freeze([]);

export class SystemCalendarCacheReader implements CalendarCacheReader {
  private state: CalendarCacheState = { status: 'missing' };
  /** Сериализованный исходный JSON последнего чтения — чтобы не оповещать без изменений. */
  private signature = 'missing';
  private readonly listeners = new Set<(state: CalendarCacheState) => void>();
  private inFlight: Promise<CalendarCacheState> | null = null;
  private rerun = false;
  /** Исходный JSON и зона последнего успешного разбора — для пересчёта при смене зоны. */
  private parsed: { value: unknown; timeZone: string } | null = null;
  private notifyScheduled = false;

  constructor(private readonly deps: CalendarCacheReaderDeps) {}

  getState(): CalendarCacheState {
    this.checkTimeZone();
    const state = this.state;
    if (state.status !== 'ok') return state;
    const stale = isCacheStale(state.data, this.deps.clock.now().getTime(), this.staleAfterMs());
    if (stale !== state.stale) this.state = { ...state, stale };
    return this.state;
  }

  /** Повторные вызовы во время чтения объединяются: после текущего выполняется ещё одно. */
  refresh(): Promise<CalendarCacheState> {
    if (this.inFlight) {
      this.rerun = true;
      return this.inFlight;
    }
    const run = async (): Promise<CalendarCacheState> => {
      try {
        do {
          this.rerun = false;
          await this.readOnce();
        } while (this.rerun);
      } finally {
        this.inFlight = null;
      }
      return this.getState();
    };
    this.inFlight = run();
    return this.inFlight;
  }

  coverage(date: LocalDateString): CacheCoverage {
    this.checkTimeZone();
    return cacheCoverage(this.state, date);
  }

  /**
   * Зона устройства сменилась после разбора — время событий пересчитывается из сохранённого
   * JSON, подписчики оповещаются (асинхронно, чтобы не вызывать перерисовку внутри отрисовки).
   * Возвращает `true`, если состояние пересчитано.
   */
  checkTimeZone(): boolean {
    const parsed = this.parsed;
    if (!parsed) return false;
    const timeZone = this.deps.clock.timeZone();
    if (timeZone === parsed.timeZone) return false;
    this.parsed = { value: parsed.value, timeZone };
    this.signature = `ok:${timeZone}:${JSON.stringify(parsed.value)}`;
    this.state = toCacheState(parseCalendarCache(parsed.value, { timeZone }), this.deps.clock.now().getTime(), this.staleAfterMs());
    this.scheduleNotify();
    return true;
  }

  getCalendars(): readonly CachedCalendar[] {
    this.checkTimeZone();
    return this.state.status === 'ok' ? this.state.data.calendars : EMPTY_CALENDARS;
  }

  onChange(listener: (state: CalendarCacheState) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Подписка на изменения файла кэша в хранилище (синхронизация, запись компаньона).
   * Возвращает отписку; вызывающий регистрирует её в `plugin.register`.
   */
  watch(app: App): Unsubscribe {
    return watchSystemFile(app, () => this.deps.store.path(SYSTEM_FILES.calendarCache), () => void this.refresh());
  }

  // -------------------------------------------------------------------------

  private staleAfterMs(): number {
    return this.deps.staleAfterMs ?? DEFAULT_CACHE_STALE_MS;
  }

  private async readOnce(): Promise<void> {
    const read = await this.deps.store.read(SYSTEM_FILES.calendarCache);
    let next: CalendarCacheState;
    let signature: string;
    if (read.status === 'ok') {
      // Зона входит в подпись: при её смене время событий пересчитывается.
      const timeZone = this.deps.clock.timeZone();
      signature = `ok:${timeZone}:${JSON.stringify(read.value)}`;
      if (signature === this.signature) return;
      const parsed = parseCalendarCache(read.value, { timeZone });
      next = toCacheState(parsed, this.deps.clock.now().getTime(), this.staleAfterMs());
      this.parsed = { value: read.value, timeZone };
    } else {
      next = read;
      signature = read.status === 'corrupt' ? `corrupt:${read.detail}` : 'missing';
      if (signature === this.signature) return;
      this.parsed = null;
    }
    this.signature = signature;
    this.state = next;
    this.emit(next);
  }

  private scheduleNotify(): void {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      this.emit(this.getState());
    });
  }

  private emit(next: CalendarCacheState): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(next);
      } catch (error) {
        console.error('[matrix-planner] calendar cache listener failed', error);
      }
    }
  }
}

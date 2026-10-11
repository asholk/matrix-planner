import { describe, expect, it, vi } from 'vitest';
import type { PlannerSettings, WeatherSettings } from '../../src/model/types';
import { createDefaultSettings } from '../../src/settings/defaults';
import {
  WEATHER_CACHE_MS,
  WEATHER_ERROR_RETRY_MS,
  WeatherService,
  parseCachedSnapshot,
} from '../../src/weather/weather-service';
import type { GeolocationProvider, WeatherCacheStore, WeatherSnapshot } from '../../src/weather/weather-types';

const FORECAST = {
  current: { temperature_2m: 11.3, weather_code: 3 },
  daily: { temperature_2m_max: [12.4], temperature_2m_min: [7.2], weather_code: [3] },
};

const MOSCOW: Partial<WeatherSettings> = { city: 'Москва, Россия', latitude: 55.75, longitude: 37.62 };

function setup(options: { weather?: Partial<WeatherSettings>; geolocation?: GeolocationProvider; cached?: unknown; http?: (url: string) => Promise<unknown> } = {}) {
  let settings: PlannerSettings = createDefaultSettings();
  settings.weather = { ...settings.weather, ...options.weather };
  const listeners = new Set<(next: PlannerSettings, previous: PlannerSettings) => void>();
  const store = {
    get: () => settings,
    onChange: (listener: (next: PlannerSettings, previous: PlannerSettings) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const updateWeather = (patch: Partial<WeatherSettings>): void => {
    const previous = settings;
    settings = { ...settings, weather: { ...settings.weather, ...patch } };
    for (const listener of listeners) listener(settings, previous);
  };
  let now = Date.UTC(2026, 9, 11, 9, 0);
  let today = '2026-10-11';
  const http = vi.fn(options.http ?? (async (_url: string) => FORECAST));
  const saved: unknown[] = [];
  const cache: WeatherCacheStore = { load: () => options.cached ?? null, save: (value) => saved.push(value) };
  const service = new WeatherService({
    settings: store,
    http,
    geolocation: options.geolocation,
    cache,
    now: () => now,
    today: () => today,
  });
  return {
    service,
    http,
    saved,
    updateWeather,
    advance: (ms: number) => (now += ms),
    setToday: (value: string) => (today = value),
    now: () => now,
  };
}

describe('WeatherService', () => {
  it('успех: запрос по координатам города и снимок в кэше', async () => {
    const ctx = setup({ weather: MOSCOW });
    const state = await ctx.service.refresh();
    expect(ctx.http).toHaveBeenCalledTimes(1);
    expect(ctx.http.mock.calls[0]?.[0]).toContain('latitude=55.75&longitude=37.62');
    expect(state).toMatchObject({ kind: 'ready', snapshot: { temperature: 11.3, code: 3, min: 7.2, max: 12.4, source: 'city', day: '2026-10-11' } });
    expect(ctx.saved).toHaveLength(1);
  });

  it('кэш 30 минут: повторные запросы не уходят, после срока — уходят', async () => {
    const ctx = setup({ weather: MOSCOW });
    await ctx.service.refresh();
    ctx.advance(WEATHER_CACHE_MS - 1000);
    await ctx.service.refresh();
    expect(ctx.http).toHaveBeenCalledTimes(1);
    ctx.advance(2000);
    await ctx.service.refresh();
    expect(ctx.http).toHaveBeenCalledTimes(2);
  });

  it('смена суток делает кэш устаревшим', async () => {
    const ctx = setup({ weather: MOSCOW });
    await ctx.service.refresh();
    ctx.setToday('2026-10-12');
    ctx.advance(60_000);
    await ctx.service.refresh();
    expect(ctx.http).toHaveBeenCalledTimes(2);
  });

  it('параллельные вызовы делят один запрос', async () => {
    const ctx = setup({ weather: MOSCOW });
    await Promise.all([ctx.service.refresh(), ctx.service.refresh(), ctx.service.refresh()]);
    expect(ctx.http).toHaveBeenCalledTimes(1);
  });

  it('ошибка: состояние error, повтор не раньше чем через 5 минут', async () => {
    const ctx = setup({ weather: MOSCOW, http: async () => Promise.reject(new Error('offline')) });
    expect((await ctx.service.refresh()).kind).toBe('error');
    await ctx.service.refresh();
    expect(ctx.http).toHaveBeenCalledTimes(1);
    ctx.advance(WEATHER_ERROR_RETRY_MS + 1);
    await ctx.service.refresh();
    expect(ctx.http).toHaveBeenCalledTimes(2);
  });

  it('ошибка при уже показанной погоде того же дня — погода остаётся', async () => {
    let fail = false;
    const ctx = setup({ weather: MOSCOW, http: async () => (fail ? Promise.reject(new Error('offline')) : FORECAST) });
    await ctx.service.refresh();
    fail = true;
    ctx.advance(WEATHER_CACHE_MS + 1);
    expect((await ctx.service.refresh()).kind).toBe('ready');
  });

  it('неполный ответ — ошибка', async () => {
    const ctx = setup({ weather: MOSCOW, http: async () => ({ current: {} }) });
    expect((await ctx.service.refresh()).kind).toBe('error');
  });

  it('кэш из локального хранилища показывается сразу при запуске', () => {
    const cached: WeatherSnapshot = {
      fetchedAt: Date.UTC(2026, 9, 11, 8, 50),
      day: '2026-10-11',
      latitude: 55.75,
      longitude: 37.62,
      source: 'city',
      units: 'celsius',
      temperature: 10,
      code: 0,
      min: 5,
      max: 12,
    };
    const ctx = setup({ weather: MOSCOW, cached });
    expect(ctx.service.getState()).toEqual({ kind: 'ready', snapshot: cached });
    // Свежий кэш — без запроса.
    return ctx.service.refresh().then(() => expect(ctx.http).not.toHaveBeenCalled());
  });

  it('кэш другого города или единиц не используется', () => {
    const cached = { fetchedAt: 1, day: '2026-10-11', latitude: 1, longitude: 2, source: 'city', units: 'celsius', temperature: 1, code: 0, min: 0, max: 2 };
    expect(setup({ weather: MOSCOW, cached }).service.getState().kind).toBe('loading');
    expect(parseCachedSnapshot({ junk: true })).toBeNull();
  });

  it('без города — геолокация; нет позиции — no-location', async () => {
    const geo = vi.fn(async () => ({ latitude: 59.94, longitude: 30.31 }));
    const ctx = setup({ geolocation: geo });
    const state = await ctx.service.refresh();
    expect(geo).toHaveBeenCalledTimes(1);
    expect(state).toMatchObject({ kind: 'ready', snapshot: { source: 'geolocation', latitude: 59.94 } });

    const none = setup({ geolocation: async () => null });
    expect((await none.service.refresh()).kind).toBe('no-location');
    expect(none.http).not.toHaveBeenCalled();
    const noApi = setup();
    expect((await noApi.service.refresh()).kind).toBe('no-location');
  });

  it('выключенная погода — off без запросов', async () => {
    const ctx = setup({ weather: { ...MOSCOW, enabled: false } });
    expect((await ctx.service.refresh()).kind).toBe('off');
    expect(ctx.http).not.toHaveBeenCalled();
  });

  it('смена города в настройках — новый запрос сразу', async () => {
    const ctx = setup({ weather: MOSCOW });
    await ctx.service.refresh();
    ctx.updateWeather({ city: 'Санкт-Петербург, Россия', latitude: 59.94, longitude: 30.31 });
    await vi.waitFor(() => expect(ctx.http).toHaveBeenCalledTimes(2));
    expect(ctx.http.mock.calls[1]?.[0]).toContain('latitude=59.94');
  });

  it('геокодинг: найденный город и пустой ответ', async () => {
    const ctx = setup({
      http: async (url) =>
        url.includes('name=%D0%9C') ? { results: [{ name: 'Москва', country: 'Россия', latitude: 55.75, longitude: 37.62 }] } : {},
    });
    expect(await ctx.service.geocode('Москва', 'ru')).toMatchObject({ label: 'Москва, Россия', latitude: 55.75 });
    expect(ctx.http.mock.calls[0]?.[0]).toContain('geocoding-api.open-meteo.com/v1/search?name=');
    expect(await ctx.service.geocode('Нигде', 'ru')).toBeNull();
    expect(await ctx.service.geocode('  ', 'ru')).toBeNull();
  });

  it('геокодинг: сетевая ошибка пробрасывается', async () => {
    const ctx = setup({ http: async () => Promise.reject(new Error('offline')) });
    await expect(ctx.service.geocode('Москва', 'ru')).rejects.toThrow('offline');
  });
});

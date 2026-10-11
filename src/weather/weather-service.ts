/**
 * Погода на сегодня для шапки «Задач»: Open-Meteo без ключа через `requestUrl`.
 *
 * Местоположение — координаты города из настроек, иначе геолокация устройства.
 * Кэш — 30 минут в памяти и в локальном хранилище устройства (показ сразу при запуске);
 * чаще кэша запросы не уходят, после ошибки — не чаще раза в 5 минут.
 * Один экземпляр на плагин (compose-core).
 */

import { requestUrl } from 'obsidian';
import type { SettingsStore } from '../app/contracts';
import type { LocalDateString, PlannerSettings, Unsubscribe } from '../model/types';
import { forecastUrl, geocodingUrl, parseForecast, parseGeocoding } from './weather-format';
import type {
  GeocodeResult,
  GeolocationProvider,
  WeatherCacheStore,
  WeatherCoordinates,
  WeatherHttp,
  WeatherLocationSource,
  WeatherProvider,
  WeatherSettings,
  WeatherSnapshot,
  WeatherState,
} from './weather-types';

/** Срок годности результата, мс. */
export const WEATHER_CACHE_MS = 30 * 60_000;
/** Повтор после ошибки, мс. */
export const WEATHER_ERROR_RETRY_MS = 5 * 60_000;
/** Таймаут геолокации, мс. */
export const GEOLOCATION_TIMEOUT_MS = 8_000;
/** Допустимый возраст позиции геолокации, мс. */
export const GEOLOCATION_MAX_AGE_MS = 60 * 60_000;
/** Ключ локального хранилища устройства. */
export const WEATHER_STORAGE_KEY = 'matrix-planner-weather';

export interface WeatherServiceDeps {
  settings: Pick<SettingsStore, 'get' | 'onChange'>;
  http: WeatherHttp;
  geolocation?: GeolocationProvider;
  cache?: WeatherCacheStore;
  /** Текущее время, мс. */
  now(): number;
  /** Сегодняшняя дата устройства. */
  today(): LocalDateString;
  log?(message: string, error?: unknown): void;
}

interface ResolvedLocation extends WeatherCoordinates {
  source: WeatherLocationSource;
}

/** Совпадение координат с точностью ~100 м. */
function sameCoordinates(a: WeatherCoordinates, b: WeatherCoordinates): boolean {
  return Math.abs(a.latitude - b.latitude) < 0.001 && Math.abs(a.longitude - b.longitude) < 0.001;
}

function hasCityCoordinates(settings: WeatherSettings): settings is WeatherSettings & { latitude: number; longitude: number } {
  return settings.latitude !== null && settings.longitude !== null;
}

/** Снимок подходит к текущим настройкам (тот же город или режим геолокации, те же единицы). */
export function snapshotMatches(snapshot: WeatherSnapshot, settings: WeatherSettings): boolean {
  if (snapshot.units !== settings.units) return false;
  if (hasCityCoordinates(settings)) return snapshot.source === 'city' && sameCoordinates(snapshot, settings);
  return snapshot.source === 'geolocation';
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Разбор снимка из локального хранилища; мусор — `null`. */
export function parseCachedSnapshot(raw: unknown): WeatherSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const fields = ['fetchedAt', 'latitude', 'longitude', 'temperature', 'code', 'min', 'max'].map((key) => num(value[key]));
  if (fields.some((field) => field === null)) return null;
  const [fetchedAt, latitude, longitude, temperature, code, min, max] = fields as number[];
  const day = value.day;
  const source = value.source;
  const units = value.units;
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  if (source !== 'city' && source !== 'geolocation') return null;
  if (units !== 'celsius' && units !== 'fahrenheit') return null;
  return { fetchedAt, day, latitude, longitude, source, units, temperature, code, min, max };
}

function weatherChanged(next: Readonly<PlannerSettings>, previous: Readonly<PlannerSettings>): boolean {
  return JSON.stringify(next.weather) !== JSON.stringify(previous.weather);
}

export class WeatherService implements WeatherProvider {
  private state: WeatherState;
  private snapshot: WeatherSnapshot | null;
  private inflight: Promise<WeatherState> | null = null;
  /** Последняя неудача: ключ местоположения и время — для паузы перед повтором. */
  private lastFailure: { key: string; at: number } | null = null;
  /** Позиция геолокации этого запуска. */
  private position: WeatherCoordinates | null = null;
  private readonly listeners = new Set<(state: WeatherState) => void>();
  private readonly unsubscribe: Unsubscribe;
  private disposed = false;

  constructor(private readonly deps: WeatherServiceDeps) {
    let cached: WeatherSnapshot | null = null;
    try {
      cached = parseCachedSnapshot(deps.cache?.load());
    } catch (error) {
      deps.log?.('Cannot read weather cache', error);
    }
    this.snapshot = cached;
    this.state = this.initialState();
    this.unsubscribe = deps.settings.onChange((next, previous) => {
      if (!weatherChanged(next, previous)) return;
      this.lastFailure = null;
      void this.refresh({ force: true });
    });
  }

  getState(): WeatherState {
    return this.state;
  }

  onChange(listener: (state: WeatherState) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.listeners.clear();
  }

  /** Обновить, если кэш устарел. Параллельные вызовы делят один запрос. */
  refresh(options: { force?: boolean } = {}): Promise<WeatherState> {
    if (this.disposed) return Promise.resolve(this.state);
    const settings = this.settings();
    if (!settings.enabled) {
      this.setState({ kind: 'off' });
      return Promise.resolve(this.state);
    }
    if (this.inflight) return this.inflight;
    const now = this.deps.now();
    const usable = this.usableSnapshot(settings);
    if (!options.force && usable && now - usable.fetchedAt < WEATHER_CACHE_MS && now >= usable.fetchedAt) {
      this.setState({ kind: 'ready', snapshot: usable });
      return Promise.resolve(this.state);
    }
    const failureKey = this.locationKey(settings);
    if (!options.force && this.lastFailure && this.lastFailure.key === failureKey && now - this.lastFailure.at < WEATHER_ERROR_RETRY_MS) {
      return Promise.resolve(this.state);
    }
    const run = this.load(settings).finally(() => {
      this.inflight = null;
    });
    this.inflight = run;
    return run;
  }

  /** Поиск города (геокодинг Open-Meteo). Сетевые ошибки пробрасываются. */
  async geocode(name: string, language: string): Promise<GeocodeResult | null> {
    if (name.trim() === '') return null;
    return parseGeocoding(await this.deps.http(geocodingUrl(name, language)));
  }

  /** Запросить геолокацию сейчас (кнопка «Использовать геолокацию»). */
  async locate(): Promise<WeatherCoordinates | null> {
    const position = await this.requestPosition();
    if (position) this.position = position;
    return position;
  }

  // --- Внутреннее ---

  private settings(): WeatherSettings {
    return this.deps.settings.get().weather;
  }

  private initialState(): WeatherState {
    const settings = this.settings();
    if (!settings.enabled) return { kind: 'off' };
    const usable = this.usableSnapshot(settings);
    return usable ? { kind: 'ready', snapshot: usable } : { kind: 'loading' };
  }

  /** Снимок того же места, единиц и суток (возраст не проверяется). */
  private usableSnapshot(settings: WeatherSettings): WeatherSnapshot | null {
    const snapshot = this.snapshot;
    if (!snapshot || !snapshotMatches(snapshot, settings)) return null;
    if (snapshot.day !== this.deps.today()) return null;
    if (snapshot.source === 'geolocation' && this.position && !sameCoordinates(snapshot, this.position)) return null;
    return snapshot;
  }

  private locationKey(settings: WeatherSettings): string {
    return hasCityCoordinates(settings) ? `city:${settings.latitude},${settings.longitude},${settings.units}` : `geo:${settings.units}`;
  }

  private async resolveLocation(settings: WeatherSettings): Promise<ResolvedLocation | null> {
    if (hasCityCoordinates(settings)) return { latitude: settings.latitude, longitude: settings.longitude, source: 'city' };
    if (!this.position) this.position = await this.requestPosition();
    return this.position ? { ...this.position, source: 'geolocation' } : null;
  }

  private async requestPosition(): Promise<WeatherCoordinates | null> {
    if (!this.deps.geolocation) return null;
    try {
      return await this.deps.geolocation();
    } catch (error) {
      this.deps.log?.('Geolocation failed', error);
      return null;
    }
  }

  private async load(settings: WeatherSettings): Promise<WeatherState> {
    const key = this.locationKey(settings);
    // Пока идёт запрос, показанная погода остаётся.
    if (this.state.kind !== 'ready') this.setState({ kind: 'loading' });
    const location = await this.resolveLocation(settings);
    if (this.disposed) return this.state;
    if (!location) {
      this.lastFailure = { key, at: this.deps.now() };
      this.setState({ kind: 'no-location' });
      return this.state;
    }
    try {
      const parsed = parseForecast(await this.deps.http(forecastUrl(location, settings.units)));
      if (!parsed) throw new Error('Incomplete forecast response');
      if (this.disposed) return this.state;
      // Настройки могли смениться во время запроса — их обработает следующий вызов.
      if (this.locationKey(this.settings()) !== key) return this.state;
      const snapshot: WeatherSnapshot = {
        fetchedAt: this.deps.now(),
        day: this.deps.today(),
        latitude: location.latitude,
        longitude: location.longitude,
        source: location.source,
        units: settings.units,
        ...parsed,
      };
      this.snapshot = snapshot;
      this.lastFailure = null;
      this.saveCache(snapshot);
      this.setState({ kind: 'ready', snapshot });
    } catch (error) {
      this.deps.log?.('Cannot load weather', error);
      this.lastFailure = { key, at: this.deps.now() };
      const usable = this.usableSnapshot(this.settings());
      this.setState(usable ? { kind: 'ready', snapshot: usable } : { kind: 'error' });
    }
    return this.state;
  }

  private saveCache(snapshot: WeatherSnapshot): void {
    try {
      this.deps.cache?.save(snapshot);
    } catch (error) {
      this.deps.log?.('Cannot save weather cache', error);
    }
  }

  private setState(next: WeatherState): void {
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    this.state = next;
    for (const listener of [...this.listeners]) {
      try {
        listener(next);
      } catch (error) {
        this.deps.log?.('Weather listener failed', error);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Платформенные реализации
// ---------------------------------------------------------------------------

/** JSON через `requestUrl` (обходит CORS, работает на мобильных). */
export function createRequestUrlHttp(): WeatherHttp {
  return async (url) => {
    const response = await requestUrl({ url, method: 'GET', throw: false });
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
    return response.json as unknown;
  };
}

/** Геолокация браузера (WebView Obsidian); без API — `null`. */
export function createBrowserGeolocation(): GeolocationProvider {
  return () =>
    new Promise((resolve) => {
      const geolocation = typeof navigator === 'undefined' ? undefined : navigator.geolocation;
      if (!geolocation || typeof geolocation.getCurrentPosition !== 'function') {
        resolve(null);
        return;
      }
      let settled = false;
      const finish = (value: WeatherCoordinates | null): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(guard);
        resolve(value);
      };
      // Некоторые WebView не вызывают ни один обработчик, пока висит запрос разрешения.
      const guard = window.setTimeout(() => finish(null), GEOLOCATION_TIMEOUT_MS + 1_000);
      try {
        geolocation.getCurrentPosition(
          (position) => finish({ latitude: position.coords.latitude, longitude: position.coords.longitude }),
          () => finish(null),
          { enableHighAccuracy: false, timeout: GEOLOCATION_TIMEOUT_MS, maximumAge: GEOLOCATION_MAX_AGE_MS },
        );
      } catch {
        finish(null);
      }
    });
}

/** Часть `App` для локального хранилища устройства. */
export interface LocalStorageHost {
  loadLocalStorage(key: string): unknown;
  saveLocalStorage(key: string, data: unknown): void;
}

export function createLocalWeatherCache(host: LocalStorageHost): WeatherCacheStore {
  return {
    load: () => host.loadLocalStorage(WEATHER_STORAGE_KEY),
    save: (value) => host.saveLocalStorage(WEATHER_STORAGE_KEY, value),
  };
}

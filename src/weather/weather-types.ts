/**
 * Типы погоды в шапке вкладки «Задачи» (Open-Meteo, без ключа).
 * Чистый модуль: без `obsidian` и DOM.
 */

import type { LocalDateString, Unsubscribe, WeatherSettings, WeatherUnits } from '../model/types';

export type { WeatherSettings, WeatherUnits };

/** Состояние погоды по кодам WMO, сведённое к значкам и описаниям. */
export type WeatherCondition = 'clear' | 'partly-cloudy' | 'cloudy' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'thunderstorm';

export interface WeatherCoordinates {
  latitude: number;
  longitude: number;
}

/** Откуда взяты координаты: город из настроек или геолокация устройства. */
export type WeatherLocationSource = 'city' | 'geolocation';

/** Погода на сегодня (результат запроса, хранится в кэше). */
export interface WeatherSnapshot {
  /** Время получения, мс. */
  fetchedAt: number;
  /** Локальная дата устройства на момент получения: смена суток делает снимок устаревшим. */
  day: LocalDateString;
  latitude: number;
  longitude: number;
  source: WeatherLocationSource;
  units: WeatherUnits;
  /** Текущая температура. */
  temperature: number;
  /** Текущий код WMO. */
  code: number;
  /** Минимум и максимум за день. */
  min: number;
  max: number;
}

export type WeatherState =
  /** Погода выключена в настройках. */
  | { kind: 'off' }
  | { kind: 'loading' }
  | { kind: 'ready'; snapshot: WeatherSnapshot }
  /** Город не задан, геолокация недоступна или запрещена. */
  | { kind: 'no-location' }
  /** Ошибка сети или ответа. */
  | { kind: 'error' };

/** Найденный город (геокодинг Open-Meteo). */
export interface GeocodeResult extends WeatherCoordinates {
  name: string;
  country: string | null;
  /** «Москва, Россия». */
  label: string;
}

/** Сетевой запрос JSON; бросает исключение при сетевой ошибке и статусе не 2xx. */
export type WeatherHttp = (url: string) => Promise<unknown>;

/** Геолокация устройства; `null` — недоступна, запрещена или не успела. */
export type GeolocationProvider = () => Promise<WeatherCoordinates | null>;

/** Локальное хранилище устройства (`app.loadLocalStorage`) — не синхронизируется. */
export interface WeatherCacheStore {
  load(): unknown;
  save(value: unknown): void;
}

/** То, что нужно потребителям (шапка «Задач», настройки). */
export interface WeatherProvider {
  getState(): WeatherState;
  onChange(listener: (state: WeatherState) => void): Unsubscribe;
  /** Обновить, если кэш устарел (`force` — без учёта кэша). */
  refresh(options?: { force?: boolean }): Promise<WeatherState>;
}

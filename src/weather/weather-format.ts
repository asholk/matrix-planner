/**
 * Форматирование погоды: коды WMO → состояние и эмодзи, строка шапки
 * «☁️ +11°, облачно · ↓7° ↑12°», разбор ответов Open-Meteo и адреса запросов.
 * Чистый модуль: тексты описаний передаёт вызывающий (словарь `weather`).
 */

import type { GeocodeResult, WeatherCondition, WeatherCoordinates, WeatherUnits } from './weather-types';

export const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
export const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';

/** Код WMO (Open-Meteo `weather_code`) → состояние. Неизвестный код — «облачно». */
export function weatherCondition(code: number): WeatherCondition {
  if (code === 0 || code === 1) return 'clear';
  if (code === 2) return 'partly-cloudy';
  if (code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 57) return 'drizzle';
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95 && code <= 99) return 'thunderstorm';
  return 'cloudy';
}

const EMOJI: Readonly<Record<WeatherCondition, string>> = {
  clear: '☀️',
  'partly-cloudy': '⛅',
  cloudy: '☁️',
  fog: '🌫️',
  drizzle: '🌧️',
  rain: '🌧️',
  snow: '🌨️',
  thunderstorm: '⛈️',
};

export function weatherEmoji(condition: WeatherCondition): string {
  return EMOJI[condition];
}

/** Ключ словаря описания: `weather.conditions.<состояние>`. */
export function conditionKey(condition: WeatherCondition): string {
  return `weather.conditions.${condition}`;
}

/** Округлённая температура: «+11°», «−3°», «0°» (`signed` — со знаком плюс). */
export function formatTemperature(value: number, signed = true): string {
  const rounded = Math.round(value);
  // `Math.round(-0.4)` даёт -0: показываем «0°».
  if (rounded === 0) return '0°';
  if (rounded < 0) return `−${Math.abs(rounded)}°`;
  return signed ? `+${rounded}°` : `${rounded}°`;
}

export interface WeatherLineInput {
  temperature: number;
  code: number;
  min: number;
  max: number;
}

/** Строка шапки: «☁️ +11°, облачно · ↓7° ↑12°». */
export function formatWeatherLine(input: WeatherLineInput, description: string): string {
  const condition = weatherCondition(input.code);
  const range = `↓${formatTemperature(input.min, false)} ↑${formatTemperature(input.max, false)}`;
  return `${weatherEmoji(condition)} ${formatTemperature(input.temperature)}, ${description} · ${range}`;
}

/** Координаты для адреса: 4 знака (≈ 10 м) — одинаковые места дают одинаковый адрес. */
function coordinate(value: number): string {
  return String(Math.round(value * 10_000) / 10_000);
}

/** Адрес прогноза на сегодня. */
export function forecastUrl(location: WeatherCoordinates, units: WeatherUnits): string {
  const params = [
    `latitude=${coordinate(location.latitude)}`,
    `longitude=${coordinate(location.longitude)}`,
    'current=temperature_2m,weather_code',
    'daily=temperature_2m_max,temperature_2m_min,weather_code',
    'timezone=auto',
    'forecast_days=1',
  ];
  if (units === 'fahrenheit') params.push('temperature_unit=fahrenheit');
  return `${FORECAST_URL}?${params.join('&')}`;
}

/** Адрес поиска города. */
export function geocodingUrl(name: string, language: string): string {
  return `${GEOCODING_URL}?name=${encodeURIComponent(name.trim())}&count=1&language=${encodeURIComponent(language)}&format=json`;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function firstFinite(value: unknown): number | null {
  return Array.isArray(value) ? finite(value[0]) : null;
}

export interface ParsedForecast {
  temperature: number;
  code: number;
  min: number;
  max: number;
}

/** Разбор ответа прогноза; `null` — ответ неполный. */
export function parseForecast(json: unknown): ParsedForecast | null {
  if (!isRecord(json) || !isRecord(json.current) || !isRecord(json.daily)) return null;
  const temperature = finite(json.current.temperature_2m);
  const code = finite(json.current.weather_code) ?? firstFinite(json.daily.weather_code);
  const min = firstFinite(json.daily.temperature_2m_min);
  const max = firstFinite(json.daily.temperature_2m_max);
  if (temperature === null || code === null || min === null || max === null) return null;
  return { temperature, code, min, max };
}

/** Разбор ответа геокодинга; `null` — ничего не найдено. */
export function parseGeocoding(json: unknown): GeocodeResult | null {
  if (!isRecord(json) || !Array.isArray(json.results)) return null;
  const first: unknown = json.results[0];
  if (!isRecord(first)) return null;
  const latitude = finite(first.latitude);
  const longitude = finite(first.longitude);
  const name = typeof first.name === 'string' ? first.name.trim() : '';
  if (latitude === null || longitude === null || name === '') return null;
  const country = typeof first.country === 'string' && first.country.trim() !== '' ? first.country.trim() : null;
  return { name, country, latitude, longitude, label: country ? `${name}, ${country}` : name };
}

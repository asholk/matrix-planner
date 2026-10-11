import { describe, expect, it } from 'vitest';
import {
  forecastUrl,
  formatTemperature,
  formatWeatherLine,
  geocodingUrl,
  parseForecast,
  parseGeocoding,
  weatherCondition,
  weatherEmoji,
} from '../../src/weather/weather-format';

describe('коды WMO', () => {
  it('сводятся к состояниям и эмодзи', () => {
    const cases: Array<[number, string, string]> = [
      [0, 'clear', '☀️'],
      [1, 'clear', '☀️'],
      [2, 'partly-cloudy', '⛅'],
      [3, 'cloudy', '☁️'],
      [45, 'fog', '🌫️'],
      [53, 'drizzle', '🌧️'],
      [63, 'rain', '🌧️'],
      [81, 'rain', '🌧️'],
      [73, 'snow', '🌨️'],
      [86, 'snow', '🌨️'],
      [95, 'thunderstorm', '⛈️'],
      [99, 'thunderstorm', '⛈️'],
      [42, 'cloudy', '☁️'],
    ];
    for (const [code, condition, emoji] of cases) {
      expect(weatherCondition(code)).toBe(condition);
      expect(weatherEmoji(weatherCondition(code))).toBe(emoji);
    }
  });
});

describe('строка погоды', () => {
  it('температура со знаком', () => {
    expect(formatTemperature(11.4)).toBe('+11°');
    expect(formatTemperature(-2.6)).toBe('−3°');
    expect(formatTemperature(-0.4)).toBe('0°');
    expect(formatTemperature(7, false)).toBe('7°');
  });

  it('«☁️ +11°, облачно · ↓7° ↑12°»', () => {
    expect(formatWeatherLine({ temperature: 11.2, code: 3, min: 7.1, max: 12.4 }, 'облачно')).toBe('☁️ +11°, облачно · ↓7° ↑12°');
    expect(formatWeatherLine({ temperature: -5, code: 71, min: -8, max: -1 }, 'snow')).toBe('🌨️ −5°, snow · ↓−8° ↑−1°');
  });
});

describe('Open-Meteo', () => {
  it('адреса запросов', () => {
    expect(forecastUrl({ latitude: 55.75222, longitude: 37.61556 }, 'celsius')).toBe(
      'https://api.open-meteo.com/v1/forecast?latitude=55.7522&longitude=37.6156&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=auto&forecast_days=1',
    );
    expect(forecastUrl({ latitude: 1, longitude: 2 }, 'fahrenheit')).toContain('&temperature_unit=fahrenheit');
    expect(geocodingUrl(' Москва ', 'ru')).toBe(
      'https://geocoding-api.open-meteo.com/v1/search?name=%D0%9C%D0%BE%D1%81%D0%BA%D0%B2%D0%B0&count=1&language=ru&format=json',
    );
  });

  it('разбор прогноза', () => {
    const json = {
      current: { temperature_2m: 11.3, weather_code: 3 },
      daily: { temperature_2m_max: [12.4], temperature_2m_min: [7.2], weather_code: [61] },
    };
    expect(parseForecast(json)).toEqual({ temperature: 11.3, code: 3, min: 7.2, max: 12.4 });
    expect(parseForecast({ current: {}, daily: {} })).toBeNull();
    expect(parseForecast(null)).toBeNull();
  });

  it('разбор геокодинга', () => {
    expect(parseGeocoding({ results: [{ name: 'Москва', country: 'Россия', latitude: 55.75, longitude: 37.62 }] })).toEqual({
      name: 'Москва',
      country: 'Россия',
      latitude: 55.75,
      longitude: 37.62,
      label: 'Москва, Россия',
    });
    expect(parseGeocoding({ generationtime_ms: 0.5 })).toBeNull();
    expect(parseGeocoding({ results: [{ name: 'X' }] })).toBeNull();
  });
});

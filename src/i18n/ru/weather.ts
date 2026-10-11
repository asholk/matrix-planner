import type { Dictionary } from '../index';

/** Погода в шапке «Задач» и раздел настроек «Погода». */
export const ruWeather = {
  unavailable: 'Погода недоступна',
  label: 'Погода: {value}',
  conditions: {
    clear: 'ясно',
    'partly-cloudy': 'переменная облачность',
    cloudy: 'облачно',
    fog: 'туман',
    drizzle: 'морось',
    rain: 'дождь',
    snow: 'снег',
    thunderstorm: 'гроза',
  },
  settings: {
    heading: 'Погода',
    desc: 'Погода загружается с open-meteo.com по координатам города.',
    enabled: {
      name: 'Показывать погоду',
      desc: 'Строка с погодой под датой на вкладке «Задачи».',
    },
    city: {
      name: 'Город',
      desc: 'Без города используется геолокация устройства.',
      placeholder: 'Москва',
      find: 'Найти',
      searching: 'Поиск…',
      found: 'Найдено: {city}',
      notFound: 'Город не найден',
      failed: 'Не удалось найти город. Проверьте подключение к интернету',
      current: 'Сейчас: {city}',
      hint: 'Укажите город: геолокация недоступна',
    },
    geolocation: {
      name: 'Использовать геолокацию',
      desc: 'Определять место по геолокации устройства вместо города.',
      button: 'Использовать',
      ok: 'Местоположение определено',
      failed: 'Не удалось определить местоположение. Укажите город',
    },
    units: {
      name: 'Единицы',
      celsius: 'Градусы Цельсия (°C)',
      fahrenheit: 'Градусы Фаренгейта (°F)',
    },
  },
} satisfies Dictionary;

import type { Dictionary } from '../index';

/** Weather in the Tasks header and the Weather settings section. */
export const enWeather = {
  unavailable: 'Weather unavailable',
  label: 'Weather: {value}',
  conditions: {
    clear: 'clear',
    'partly-cloudy': 'partly cloudy',
    cloudy: 'cloudy',
    fog: 'fog',
    drizzle: 'drizzle',
    rain: 'rain',
    snow: 'snow',
    thunderstorm: 'thunderstorm',
  },
  settings: {
    heading: 'Weather',
    desc: 'Weather is loaded from open-meteo.com using the city coordinates.',
    enabled: {
      name: 'Show weather',
      desc: 'A weather line under the date on the Tasks tab.',
    },
    city: {
      name: 'City',
      desc: 'Without a city, the device location is used.',
      placeholder: 'London',
      find: 'Find',
      searching: 'Searching…',
      found: 'Found: {city}',
      notFound: 'City not found',
      failed: 'Could not find the city. Check your internet connection',
      current: 'Current: {city}',
      hint: 'Enter a city: location is unavailable',
    },
    geolocation: {
      name: 'Use location',
      desc: 'Use the device location instead of a city.',
      button: 'Use',
      ok: 'Location found',
      failed: 'Could not get the location. Enter a city',
    },
    units: {
      name: 'Units',
      celsius: 'Celsius (°C)',
      fahrenheit: 'Fahrenheit (°F)',
    },
  },
} satisfies Dictionary;

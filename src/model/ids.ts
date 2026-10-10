/**
 * ULID без внешних зависимостей: 48 бит времени (мс) + 80 бит случайности,
 * 26 символов Crockford base32. Монотонный: в пределах одной миллисекунды
 * (и при отставании часов) случайная часть увеличивается на 1.
 * ID не зависит от имени файла.
 */

import type { IdGenerator } from '../app/contracts';
import type { ItemId } from './types';

export const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;
const MAX_TIME = 2 ** 48 - 1;
const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** Заполняет массив случайными байтами. */
export type RandomSource = (bytes: Uint8Array) => void;

export interface UlidGeneratorOptions {
  /** Текущее время, мс (по умолчанию `Date.now`). */
  now?: () => number;
  /** Источник случайности (по умолчанию Web Crypto, иначе `Math.random`). */
  random?: RandomSource;
}

function defaultRandom(bytes: Uint8Array): void {
  // Web Crypto есть в Obsidian (desktop и mobile); запасной вариант — Math.random.
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
    return;
  }
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
}

/** Время → 10 символов base32. */
export function encodeTime(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_TIME) throw new RangeError(`Invalid ULID time: ${ms}`);
  let value = ms;
  let out = '';
  for (let i = 0; i < TIME_LENGTH; i++) {
    const digit = value % 32;
    out = ULID_ALPHABET.charAt(digit) + out;
    value = (value - digit) / 32;
  }
  return out;
}

/** Время создания ULID, мс; `null` — не ULID. */
export function decodeTime(id: string): number | null {
  if (!isUlid(id)) return null;
  let value = 0;
  for (let i = 0; i < TIME_LENGTH; i++) value = value * 32 + ULID_ALPHABET.indexOf(id.charAt(i));
  return value;
}

export function isUlid(value: unknown): value is ItemId {
  return typeof value === 'string' && ULID_RE.test(value);
}

/** 16 случайных цифр base32 (по 5 бит из каждого байта). */
function randomDigits(random: RandomSource): number[] {
  const bytes = new Uint8Array(RANDOM_LENGTH);
  random(bytes);
  return Array.from(bytes, (b) => b & 31);
}

/** Увеличивает число в base32 на 1; `false` — переполнение. */
function increment(digits: number[]): boolean {
  for (let i = digits.length - 1; i >= 0; i--) {
    const digit = digits[i];
    if (digit < 31) {
      digits[i] = digit + 1;
      return true;
    }
    digits[i] = 0;
  }
  return false;
}

export function createUlidGenerator(options: UlidGeneratorOptions = {}): IdGenerator {
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? defaultRandom;
  let lastTime = -1;
  let lastRandom: number[] = [];

  return {
    next(): ItemId {
      let time = Math.floor(now());
      if (time <= lastTime) {
        time = lastTime;
        if (!increment(lastRandom)) {
          // Переполнение случайной части — переходим к следующей миллисекунде.
          time = lastTime + 1;
          lastRandom = randomDigits(random);
        }
      } else {
        lastRandom = randomDigits(random);
      }
      lastTime = time;
      return encodeTime(time) + lastRandom.map((d) => ULID_ALPHABET.charAt(d)).join('');
    },
  };
}

/** Одиночный ULID (без гарантии монотонности между вызовами разных генераторов). */
export function ulid(time: number = Date.now(), random: RandomSource = defaultRandom): ItemId {
  return createUlidGenerator({ now: () => time, random }).next();
}

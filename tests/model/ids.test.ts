import { describe, expect, it } from 'vitest';
import { createUlidGenerator, decodeTime, encodeTime, isUlid, ulid } from '../../src/model/ids';

function fixedRandom(value: number) {
  return (bytes: Uint8Array) => bytes.fill(value);
}

describe('ULID', () => {
  it('encodes time in the first 10 characters', () => {
    expect(encodeTime(0)).toBe('0000000000');
    expect(encodeTime(1469918176385)).toBe('01ARYZ6S41');
    expect(decodeTime(ulid(1469918176385, fixedRandom(0)))).toBe(1469918176385);
  });

  it('produces 26 Crockford base32 characters', () => {
    const id = createUlidGenerator().next();
    expect(id).toHaveLength(26);
    expect(isUlid(id)).toBe(true);
    expect(isUlid('01JA7Q3K8Z6Y2V5N4M0C1B2D3E')).toBe(true);
    expect(isUlid('01JA7Q3K8Z6Y2V5N4M0C1B2D3')).toBe(false);
    expect(isUlid('01JA7Q3K8Z6Y2V5N4M0C1B2D3I')).toBe(false);
    expect(isUlid(42)).toBe(false);
  });

  it('is monotonic within the same millisecond', () => {
    const gen = createUlidGenerator({ now: () => 1000, random: fixedRandom(31) });
    const a = gen.next();
    const b = gen.next();
    const c = gen.next();
    expect(a < b && b < c).toBe(true);
    // Переполнение случайной части переходит на следующую миллисекунду.
    expect(decodeTime(b)).toBe(1001);
  });

  it('stays ordered when the clock goes back', () => {
    let time = 5000;
    const gen = createUlidGenerator({ now: () => time, random: fixedRandom(7) });
    const a = gen.next();
    time = 4000;
    const b = gen.next();
    expect(b > a).toBe(true);
    expect(decodeTime(b)).toBe(5000);
  });

  it('generates unique ids', () => {
    const gen = createUlidGenerator();
    const ids = new Set(Array.from({ length: 1000 }, () => gen.next()));
    expect(ids.size).toBe(1000);
  });

  it('rejects out-of-range time', () => {
    expect(() => encodeTime(-1)).toThrow(RangeError);
    expect(() => encodeTime(2 ** 48)).toThrow(RangeError);
  });
});

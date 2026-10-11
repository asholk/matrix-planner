import { describe, it, expect } from 'vitest';
import fixtures from '../../fixtures/wallpaper.json';
import {
  KNOWN_PROFILES,
  NOTIFICATIONS_TOP,
  SAFE_BOTTOM,
  SAFE_TOP,
  contentBand,
  defaultProfile,
  detectProfile,
  findProfileBySize,
  parseProfileId,
  resolveProfile,
  screenPixelSize,
} from '../../src/wallpaper/profiles';

describe('wallpaper profiles', () => {
  for (const screen of fixtures.screens) {
    it(`auto profile: ${screen.name}`, () => {
      expect(detectProfile(screen).id).toBe(screen.expectedId);
    });
  }

  it('knows the three reference iPhone sizes', () => {
    for (const p of fixtures.profiles) {
      const profile = findProfileBySize(p.width, p.height);
      expect(profile?.id).toBe(p.id);
      expect(profile?.width).toBe(p.width);
      expect(profile?.height).toBe(p.height);
    }
  });

  it('profile ids are unique and portrait', () => {
    const ids = new Set(KNOWN_PROFILES.map((p) => p.id));
    expect(ids.size).toBe(KNOWN_PROFILES.length);
    for (const p of KNOWN_PROFILES) {
      expect(p.id).toBe(`iphone-${p.width}x${p.height}`);
      expect(p.height).toBeGreaterThan(p.width);
    }
  });

  it('screen size tolerates rounding and landscape', () => {
    expect(screenPixelSize(852, 393, 3)).toEqual({ width: 1179, height: 2556 });
    expect(findProfileBySize(1178, 2557)?.id).toBe('iphone-1179x2556');
    expect(screenPixelSize(100, 200, 0)).toEqual({ width: 100, height: 200 });
  });

  it('falls back to the default profile without screen info', () => {
    expect(detectProfile(null).id).toBe(defaultProfile().id);
    expect(detectProfile({ width: 0, height: 0, devicePixelRatio: 3 }).id).toBe('iphone-1179x2556');
  });

  it('manual profile wins over auto; unknown id falls back to auto', () => {
    const screen = { width: 393, height: 852, devicePixelRatio: 3 };
    expect(resolveProfile('iphone-1080x2340', screen).id).toBe('iphone-1080x2340');
    expect(resolveProfile('auto', screen).id).toBe('iphone-1179x2556');
    expect(resolveProfile('garbage', screen).id).toBe('iphone-1179x2556');
    const custom = resolveProfile('screen-1082x2402', screen);
    expect(custom).toMatchObject({ id: 'screen-1082x2402', width: 1082, height: 2402 });
  });

  it('on a computer auto gives the default iPhone, not the monitor size', () => {
    const monitor = { width: 1440, height: 900, devicePixelRatio: 1.7786 };
    expect(resolveProfile('auto', monitor).id).toBe('screen-1601x2561');
    expect(resolveProfile('auto', monitor, { mobile: true }).id).toBe('screen-1601x2561');
    expect(resolveProfile('auto', monitor, { mobile: false }).id).toBe(defaultProfile().id);
    expect(resolveProfile('garbage', monitor, { mobile: false }).id).toBe(defaultProfile().id);
    expect(resolveProfile('iphone-1206x2622', monitor, { mobile: false }).id).toBe('iphone-1206x2622');
    expect(resolveProfile('screen-1080x2400', monitor, { mobile: false }).id).toBe('screen-1080x2400');
  });

  it('parseProfileId rejects landscape and malformed ids', () => {
    expect(parseProfileId('screen-2400x1080')).toBeNull();
    expect(parseProfileId('iphone-axb')).toBeNull();
  });

  it('safe zones: content from 31% (27% without widgets), notifications from 70%, hard limit 84%', () => {
    expect(SAFE_TOP).toBe(0.31);
    expect(SAFE_BOTTOM).toBe(0.84);
    expect(NOTIFICATIONS_TOP).toBe(0.7);
    for (const profile of KNOWN_PROFILES) {
      const band = contentBand(profile);
      expect(band.top).toBe(Math.ceil(profile.height * 0.31));
      expect(band.softBottom).toBe(Math.floor(profile.height * 0.7));
      expect(band.bottom).toBe(Math.floor(profile.height * 0.84));
      const low = contentBand(profile, 'no-widgets');
      expect(low.top).toBe(Math.ceil(profile.height * 0.27));
      expect(low.bottom).toBe(band.bottom);
    }
  });

  it('soft bottom never goes above the content top', () => {
    const odd = { ...KNOWN_PROFILES[0], safeTop: 0.75, safeBottom: 0.9 };
    const band = contentBand(odd);
    expect(band.softBottom).toBeGreaterThanOrEqual(band.top);
    expect(band.softBottom).toBeLessThanOrEqual(band.bottom);
  });
});

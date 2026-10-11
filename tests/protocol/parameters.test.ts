import { describe, expect, it } from 'vitest';
import { linkToParams, parseLinkParams } from '../../src/protocol/parameters';

const ID = '01JABCDEFGHJKMNPQRSTVWXYZ0';

describe('parseLinkParams', () => {
  it('treats action=planner from Obsidian as no action', () => {
    expect(parseLinkParams({ action: 'planner', vault: 'V', view: 'tasks' })).toEqual({ ok: true, link: { action: 'view', view: 'tasks' } });
    expect(parseLinkParams({ action: 'planner', vault: 'V' })).toEqual({ ok: false, messageKey: 'protocol.errors.missingAction' });
  });

  it('prefers do= over action= (Obsidian puts the handler name into action)', () => {
    expect(parseLinkParams({ action: 'planner', vault: 'V', do: 'new-task', quadrant: 'do' })).toEqual({
      ok: true,
      link: { action: 'new-task', quadrant: 'do', date: null },
    });
    expect(parseLinkParams({ action: 'planner', do: 'open', id: ID })).toEqual({ ok: true, link: { action: 'open', id: ID } });
  });

  it('accepts every view and rejects unknown', () => {
    for (const view of ['tasks', 'calendar', 'lockscreen']) {
      expect(parseLinkParams({ view })).toEqual({ ok: true, link: { action: 'view', view } });
    }
    expect(parseLinkParams({ view: 'settings' })).toEqual({ ok: false, messageKey: 'protocol.errors.invalidView' });
  });

  it('parses new-task with optional quadrant and date', () => {
    expect(parseLinkParams({ action: 'new-task', quadrant: 'do', date: '2026-10-21' })).toEqual({
      ok: true,
      link: { action: 'new-task', quadrant: 'do', date: '2026-10-21' },
    });
    expect(parseLinkParams({ action: 'new-task' })).toEqual({ ok: true, link: { action: 'new-task', quadrant: null, date: null } });
    expect(parseLinkParams({ action: 'new-task', quadrant: '' })).toEqual({ ok: true, link: { action: 'new-task', quadrant: null, date: null } });
  });

  it('rejects bad quadrant and impossible dates', () => {
    expect(parseLinkParams({ action: 'new-task', quadrant: 'важно' })).toEqual({ ok: false, messageKey: 'protocol.errors.invalidQuadrant' });
    expect(parseLinkParams({ action: 'new-task', date: '2026-02-30' })).toEqual({ ok: false, messageKey: 'protocol.errors.invalidDate' });
    expect(parseLinkParams({ action: 'new-task', date: '21.10.2026' })).toEqual({ ok: false, messageKey: 'protocol.errors.invalidDate' });
  });

  it('validates open id and normalizes case', () => {
    expect(parseLinkParams({ action: 'open', id: ID })).toEqual({ ok: true, link: { action: 'open', id: ID } });
    expect(parseLinkParams({ action: 'open', id: ID.toLowerCase() })).toEqual({ ok: true, link: { action: 'open', id: ID } });
    expect(parseLinkParams({ action: 'open', id: ` ${ID.toLowerCase()} ` })).toEqual({ ok: true, link: { action: 'open', id: ID } });
    expect(parseLinkParams({ action: 'open' })).toEqual({ ok: false, messageKey: 'protocol.errors.missingId' });
    expect(parseLinkParams({ action: 'open', id: 'Задача' })).toEqual({ ok: false, messageKey: 'protocol.errors.invalidId' });
  });

  it('parses wallpaper callbacks and rejects unknown actions', () => {
    expect(parseLinkParams({ action: 'wallpaper-done', vault: 'V' })).toEqual({ ok: true, link: { action: 'wallpaper-done' } });
    expect(parseLinkParams({ action: 'wallpaper-failed' })).toEqual({ ok: true, link: { action: 'wallpaper-failed' } });
    expect(parseLinkParams({ action: 'planner', do: 'wallpaper-cancelled' })).toEqual({ ok: true, link: { action: 'wallpaper-cancelled' } });
    expect(parseLinkParams({ action: 'delete', id: ID })).toEqual({ ok: false, messageKey: 'protocol.errors.unknownAction' });
  });

  it('ignores extra parameters', () => {
    expect(parseLinkParams({ action: 'wallpaper-done', foo: 'bar', 'x-source': 'Shortcuts' })).toEqual({ ok: true, link: { action: 'wallpaper-done' } });
  });
});

describe('linkToParams', () => {
  it('omits empty new-task fields', () => {
    expect(linkToParams({ action: 'new-task', quadrant: null, date: '2026-10-21' })).toEqual([
      ['do', 'new-task'],
      ['date', '2026-10-21'],
    ]);
  });

  it('is the inverse of parseLinkParams', () => {
    const links = [
      { action: 'view', view: 'lockscreen' },
      { action: 'new-task', quadrant: 'urgent', date: '2028-02-29' },
      { action: 'open', id: ID },
      { action: 'wallpaper-done' },
      { action: 'wallpaper-failed' },
      { action: 'wallpaper-cancelled' },
    ] as const;
    for (const link of links) {
      expect(parseLinkParams(Object.fromEntries(linkToParams(link)))).toEqual({ ok: true, link });
    }
  });
});

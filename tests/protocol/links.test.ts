import { describe, expect, it } from 'vitest';
import { buildPlannerUrl, buildShortcutRunUrl, createLinkBuilder, parsePlannerUrl, parseQuery } from '../../src/protocol/links';

const ID = '01JABCDEFGHJKMNPQRSTVWXYZ0';

function queryOf(url: string): Record<string, string> {
  const parsed = parseQuery(url.slice(url.indexOf('?') + 1));
  if (!parsed) throw new Error('bad query');
  return parsed;
}

describe('buildPlannerUrl', () => {
  it('builds all link kinds with vault first', () => {
    expect(buildPlannerUrl('Work', { action: 'view', view: 'calendar' })).toBe('obsidian://planner?vault=Work&view=calendar');
    expect(buildPlannerUrl('Work', { action: 'new-task', quadrant: 'do', date: '2026-10-21' })).toBe(
      'obsidian://planner?vault=Work&do=new-task&quadrant=do&date=2026-10-21',
    );
    expect(buildPlannerUrl('Work', { action: 'new-task', quadrant: null, date: null })).toBe('obsidian://planner?vault=Work&do=new-task');
    expect(buildPlannerUrl('Work', { action: 'open', id: ID })).toBe(`obsidian://planner?vault=Work&do=open&id=${ID}`);
    expect(buildPlannerUrl('Work', { action: 'wallpaper-done' })).toBe('obsidian://planner?vault=Work&do=wallpaper-done');
    expect(buildPlannerUrl('Work', { action: 'wallpaper-failed' })).toBe('obsidian://planner?vault=Work&do=wallpaper-failed');
  });

  it('encodes cyrillic, spaces, & and ? in the vault name', () => {
    const vault = 'Мои заметки & план?';
    const url = buildPlannerUrl(vault, { action: 'view', view: 'tasks' });
    expect(url).toBe(`obsidian://planner?vault=${encodeURIComponent(vault)}&view=tasks`);
    expect(url).not.toContain(' ');
    expect(url.split('?')).toHaveLength(2);
    expect(queryOf(url).vault).toBe(vault);
  });

  it('round-trips through parsePlannerUrl', () => {
    const vault = 'Хранилище #1 = A&B?';
    const url = buildPlannerUrl(vault, { action: 'new-task', quadrant: 'someday', date: '2026-02-28' });
    const parsed = parsePlannerUrl(url);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.vault).toBe(vault);
    expect(parsed.result).toEqual({ ok: true, link: { action: 'new-task', quadrant: 'someday', date: '2026-02-28' } });
  });
});

describe('buildShortcutRunUrl', () => {
  it('encodes name and callbacks; vault is in both callbacks', () => {
    const vault = 'Мои заметки & план?';
    const url = buildShortcutRunUrl(vault, 'Обои Планировщика');
    expect(url.startsWith('shortcuts://x-callback-url/run-shortcut?name=')).toBe(true);
    // Внешний запрос содержит ровно три параметра — внутренние `&`/`?` закодированы.
    const query = url.slice(url.indexOf('?') + 1);
    expect(query.split('&')).toHaveLength(3);
    expect(url.split('?')).toHaveLength(2);

    const outer = queryOf(url);
    expect(outer.name).toBe('Обои Планировщика');
    expect(outer['x-success']).toBe(buildPlannerUrl(vault, { action: 'wallpaper-done' }));
    expect(outer['x-error']).toBe(buildPlannerUrl(vault, { action: 'wallpaper-failed' }));

    const success = parsePlannerUrl(outer['x-success']!);
    const error = parsePlannerUrl(outer['x-error']!);
    expect(success.ok && success.vault).toBe(vault);
    expect(error.ok && error.vault).toBe(vault);
    expect(success.ok && success.result).toEqual({ ok: true, link: { action: 'wallpaper-done' } });
    expect(error.ok && error.result).toEqual({ ok: true, link: { action: 'wallpaper-failed' } });
  });

  it('adds the launch profile to both callbacks', () => {
    const outer = queryOf(buildShortcutRunUrl('Хранилище', 'A', { profileId: 'iphone-1179x2556' }));
    expect(outer['x-success']).toBe(buildPlannerUrl('Хранилище', { action: 'wallpaper-done' }, [['profile', 'iphone-1179x2556']]));
    for (const callback of [outer['x-success']!, outer['x-error']!]) {
      const parsed = parsePlannerUrl(callback);
      expect(parsed.ok && parsed.params.profile).toBe('iphone-1179x2556');
      expect(parsed.ok && parsed.params.do).toMatch(/^wallpaper-(done|failed)$/);
    }
    const viaBuilder = createLinkBuilder(() => 'Хранилище').shortcutRunUrl('A', { profileId: 'iphone-1179x2556' });
    expect(viaBuilder).toBe(buildShortcutRunUrl('Хранилище', 'A', { profileId: 'iphone-1179x2556' }));
  });

  it('encodes & and ? in shortcut name', () => {
    const outer = queryOf(buildShortcutRunUrl('V', 'A&B?C=D'));
    expect(outer.name).toBe('A&B?C=D');
  });
});

describe('parsePlannerUrl', () => {
  it('reads the action from do= even when Obsidian puts its handler name into action', () => {
    const parsed = parsePlannerUrl(`obsidian://planner?vault=A&do=open&id=${ID}`);
    expect(parsed.ok && parsed.result).toEqual({ ok: true, link: { action: 'open', id: ID } });
    // Старый формат `action=` по-прежнему принимается.
    const legacy = parsePlannerUrl('obsidian://planner?vault=A&action=wallpaper-done');
    expect(legacy.ok && legacy.result).toEqual({ ok: true, link: { action: 'wallpaper-done' } });
  });

  it('rejects foreign and malformed links', () => {
    expect(parsePlannerUrl('obsidian://open?vault=A')).toEqual({ ok: false, messageKey: 'protocol.errors.notPlannerLink' });
    expect(parsePlannerUrl('obsidian://planner?vault=%E0%A4%A')).toEqual({ ok: false, messageKey: 'protocol.errors.malformed' });
  });

  it('reports invalid parameters', () => {
    const parsed = parsePlannerUrl('obsidian://planner?vault=A&view=settings');
    expect(parsed.ok && parsed.result).toEqual({ ok: false, messageKey: 'protocol.errors.invalidView' });
  });
});

describe('createLinkBuilder', () => {
  it('reads the current vault name on every call', () => {
    let name = 'Первое';
    const builder = createLinkBuilder(() => name);
    expect(builder.build({ action: 'view', view: 'lockscreen' })).toContain(`vault=${encodeURIComponent('Первое')}`);
    name = 'Второе';
    expect(builder.shortcutRunUrl('X')).toContain(encodeURIComponent(`vault=${encodeURIComponent('Второе')}`));
  });
});

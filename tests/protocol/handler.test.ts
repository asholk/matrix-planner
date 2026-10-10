import { describe, expect, it, vi } from 'vitest';
import type { TaskFormRequest } from '../../src/app/contracts';
import type { PlannerItem, PlannerTabId } from '../../src/model/types';
import { PlannerProtocolHandler } from '../../src/protocol/handler';

const ID = '01JABCDEFGHJKMNPQRSTVWXYZ0';

function setup(options: { ready?: boolean; known?: string[] } = {}) {
  let resolveReady: () => void = () => undefined;
  const ready = options.ready === false ? new Promise<void>((resolve) => (resolveReady = resolve)) : Promise.resolve();
  const known = new Set(options.known ?? []);
  const messages: string[] = [];
  const calls: string[] = [];
  const callbacks: Array<'done' | 'failed'> = [];
  const forms: TaskFormRequest[] = [];
  const handler = new PlannerProtocolHandler({
    index: {
      whenReady: () => ready,
      getById: (id) => (known.has(id) ? ({ id } as unknown as PlannerItem) : undefined),
    },
    actions: {
      showTab: async (tab: PlannerTabId) => {
        calls.push(`tab:${tab}`);
      },
      openTaskForm: (request) => {
        forms.push(request);
      },
      openItem: async (id) => {
        calls.push(`open:${id}`);
      },
    },
    notifier: { show: (message) => messages.push(message) },
    wallpaperStatus: {
      onWallpaperCallback: async (result) => {
        callbacks.push(result);
      },
    },
    translate: (key) => key,
  });
  return { handler, messages, calls, callbacks, forms, resolveReady: () => resolveReady() };
}

describe('PlannerProtocolHandler', () => {
  it('switches tab for view links', async () => {
    const s = setup();
    await s.handler.handle({ action: 'planner', vault: 'V', view: 'calendar' });
    expect(s.calls).toEqual(['tab:calendar']);
    expect(s.messages).toEqual([]);
  });

  it('opens the task form with quadrant and date', async () => {
    const s = setup();
    await s.handler.handle({ action: 'new-task', vault: 'V', quadrant: 'do', date: '2026-10-21' });
    expect(s.forms).toEqual([{ mode: 'create', quadrant: 'do', date: '2026-10-21' }]);
  });

  it('defers processing until the index is ready (cold start)', async () => {
    const s = setup({ ready: false, known: [ID] });
    const pending = s.handler.handle({ action: 'open', vault: 'V', id: ID });
    await Promise.resolve();
    await Promise.resolve();
    expect(s.calls).toEqual([]);
    s.resolveReady();
    await pending;
    expect(s.calls).toEqual([`open:${ID}`]);
  });

  it('keeps link order while waiting', async () => {
    const s = setup({ ready: false, known: [ID] });
    const first = s.handler.handle({ view: 'tasks' });
    const second = s.handler.handle({ action: 'open', id: ID });
    s.resolveReady();
    await Promise.all([first, second]);
    expect(s.calls).toEqual(['tab:tasks', `open:${ID}`]);
  });

  it('reports unknown id', async () => {
    const s = setup();
    await s.handler.handle({ action: 'open', vault: 'V', id: ID });
    expect(s.calls).toEqual([]);
    expect(s.messages).toEqual(['common.errors.notFound']);
  });

  it('reports invalid parameters without waiting for the index', async () => {
    const s = setup({ ready: false });
    await s.handler.handle({ action: 'new-task', date: '2026-13-01' });
    expect(s.messages).toEqual(['protocol.errors.invalidDate']);
    expect(s.forms).toEqual([]);
  });

  it('passes wallpaper callbacks to the status tracker', async () => {
    const s = setup();
    await s.handler.handle({ action: 'wallpaper-done', vault: 'V' });
    await s.handler.handle({ action: 'wallpaper-failed', vault: 'V' });
    expect(s.callbacks).toEqual(['done', 'failed']);
  });

  it('shows a message when an action throws and keeps working', async () => {
    const s = setup();
    const showTab = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    const handler = new PlannerProtocolHandler({
      index: { whenReady: () => Promise.resolve(), getById: () => undefined },
      actions: { showTab, openTaskForm: () => undefined, openItem: async () => undefined },
      notifier: { show: (message) => s.messages.push(message) },
      translate: (key) => key,
    });
    await handler.handle({ view: 'tasks' });
    await handler.handle({ view: 'calendar' });
    expect(s.messages).toEqual(['protocol.errors.failed']);
    expect(showTab).toHaveBeenCalledTimes(2);
  });

  it('ignores wallpaper callbacks without a tracker', async () => {
    const messages: string[] = [];
    const handler = new PlannerProtocolHandler({
      index: { whenReady: () => Promise.resolve(), getById: () => undefined },
      actions: { showTab: async () => undefined, openTaskForm: () => undefined, openItem: async () => undefined },
      notifier: { show: (message) => messages.push(message) },
      translate: (key) => key,
    });
    await handler.handle({ action: 'wallpaper-done' });
    expect(messages).toEqual([]);
  });

  it('does nothing after dispose', async () => {
    const s = setup({ ready: false });
    const pending = s.handler.handle({ view: 'tasks' });
    s.handler.dispose();
    s.resolveReady();
    await pending;
    expect(s.calls).toEqual([]);
  });
});

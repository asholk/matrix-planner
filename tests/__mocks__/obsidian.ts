/**
 * Ручной мок модуля `obsidian` для vitest (алиас в vitest.config.ts).
 *
 * In-memory хранилище: Vault (+ adapter), FileManager, MetadataCache, Workspace,
 * Plugin/Component, ItemView, Modal, Setting, Notice, Menu и лёгкая DOM-заглушка
 * (тесты идут в окружении node, настоящего DOM нет).
 *
 * Использование в тестах:
 *   import { createMockApp } from '../__mocks__/obsidian';
 *   const app = createMockApp();
 *   await app.vault.create('Планировщик/Задачи/A.md', '---\ntype: task\n---\n');
 *   app.metadataCache.autoFlush = false;   // смоделировать задержку `changed`
 *   app.metadataCache.flush();             // доставить отложенные `changed`
 *   const obsidianApp = app as unknown as import('obsidian').App;
 *
 * Особенности:
 *  - getFileCache() возвращает frontmatter на момент последнего flush (как настоящий кэш);
 *  - по умолчанию `changed` доставляется в микрозадаче после записи (`autoFlush = true`);
 *  - fileManager.trashFile() переносит файл в `vault.trashed` (путь → содержимое);
 *  - Notice складывает сообщения в `Notice.messages`;
 *  - `failNextWrite(path)` — следующая запись по пути бросит ошибку.
 */

import { parse as parseYamlLib, stringify as stringifyYamlLib } from 'yaml';

// ===========================================================================
// Утилиты
// ===========================================================================

export function normalizePath(path: string): string {
  let result = path.replace(/\\/g, '/').replace(/ | /g, ' ');
  result = result.replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
  return result === '' ? '/' : result;
}

export function parseYaml(text: string): unknown {
  return parseYamlLib(text) as unknown;
}

export function stringifyYaml(value: unknown): string {
  return stringifyYamlLib(value);
}

export function setIcon(el: HTMLElement, iconName: string): void {
  el.setAttribute('data-icon', iconName);
}

export function getLanguage(): string {
  return mockState.language;
}

export function debounce<T extends unknown[]>(fn: (...args: T) => unknown, _wait?: number): ((...args: T) => void) & { cancel(): void; run(): void } {
  let lastArgs: T | null = null;
  const wrapped = (...args: T): void => {
    lastArgs = args;
    fn(...args);
  };
  return Object.assign(wrapped, {
    cancel: () => undefined,
    run: () => {
      if (lastArgs) fn(...lastArgs);
    },
  });
}

/** Изменяемое состояние мока (язык, платформа). Сбрасывается `resetMockState()`. */
export const mockState = {
  language: 'en',
};

/** Заглушка moment: только то, что нужно плагину (локаль). */
type MomentStub = ((input?: unknown) => { format(pattern?: string): string; toDate(): Date }) & {
  locale(locale?: string): string;
};
let momentLocale = 'en';
export const moment: MomentStub = Object.assign(
  (input?: unknown) => {
    const date = input instanceof Date ? input : new Date(typeof input === 'string' || typeof input === 'number' ? input : Date.now());
    return { format: () => date.toISOString(), toDate: () => date };
  },
  {
    locale(locale?: string): string {
      if (locale) momentLocale = locale;
      return momentLocale;
    },
  },
);

export const Platform = {
  isDesktop: true,
  isMobile: false,
  isDesktopApp: true,
  isMobileApp: false,
  isIosApp: false,
  isAndroidApp: false,
  isPhone: false,
  isTablet: false,
  isMacOS: false,
  isWin: true,
  isLinux: false,
  isSafari: false,
  resourcePathPrefix: 'app://mock/',
};

/** Сбрасывает глобальное состояние мока между тестами. */
export function resetMockState(): void {
  mockState.language = 'en';
  momentLocale = 'en';
  Object.assign(Platform, {
    isDesktop: true,
    isMobile: false,
    isDesktopApp: true,
    isMobileApp: false,
    isIosApp: false,
    isAndroidApp: false,
    isPhone: false,
    isTablet: false,
  });
  Notice.messages = [];
}

// ===========================================================================
// События
// ===========================================================================

export interface EventRef {
  owner: Events;
  name: string;
  callback: (...data: unknown[]) => unknown;
  ctx?: unknown;
}

export class Events {
  private handlers = new Map<string, EventRef[]>();

  on(name: string, callback: (...data: never[]) => unknown, ctx?: unknown): EventRef {
    const ref: EventRef = { owner: this, name, callback: callback as (...data: unknown[]) => unknown, ctx };
    const list = this.handlers.get(name) ?? [];
    list.push(ref);
    this.handlers.set(name, list);
    return ref;
  }

  off(name: string, callback: (...data: never[]) => unknown): void {
    const list = this.handlers.get(name);
    if (!list) return;
    this.handlers.set(
      name,
      list.filter((ref) => ref.callback !== (callback as unknown)),
    );
  }

  offref(ref: EventRef): void {
    const list = this.handlers.get(ref.name);
    if (!list) return;
    this.handlers.set(
      ref.name,
      list.filter((r) => r !== ref),
    );
  }

  trigger(name: string, ...data: unknown[]): void {
    for (const ref of [...(this.handlers.get(name) ?? [])]) {
      ref.callback.apply(ref.ctx, data);
    }
  }

  tryTrigger(ref: EventRef, data: unknown[]): void {
    ref.callback.apply(ref.ctx, data);
  }

  /** Число подписчиков (для проверок отписки в тестах). */
  listenerCount(name: string): number {
    return this.handlers.get(name)?.length ?? 0;
  }
}

// ===========================================================================
// DOM-заглушка
// ===========================================================================

type DomElementInfo = {
  cls?: string | string[];
  text?: string;
  attr?: Record<string, string | number | boolean | null>;
  title?: string;
  type?: string;
  value?: string;
  placeholder?: string;
};

/** Минимальный элемент с хелперами Obsidian (createDiv/createEl/empty/…). */
export class MockElement {
  tagName: string;
  children: MockElement[] = [];
  parent: MockElement | null = null;
  attributes = new Map<string, string>();
  classes = new Set<string>();
  textContent = '';
  value = '';
  checked = false;
  disabled = false;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  private listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
  }

  get className(): string {
    return [...this.classes].join(' ');
  }

  set className(value: string) {
    this.classes = new Set(value.split(/\s+/).filter(Boolean));
  }

  get classList(): { add(...c: string[]): void; remove(...c: string[]): void; contains(c: string): boolean; toggle(c: string, force?: boolean): boolean } {
    return {
      add: (...c) => this.addClass(...c),
      remove: (...c) => this.removeClass(...c),
      contains: (c) => this.classes.has(c),
      toggle: (c, force) => {
        this.toggleClass(c, force ?? !this.classes.has(c));
        return this.classes.has(c);
      },
    };
  }

  createEl(tag: string, info?: DomElementInfo | string, callback?: (el: MockElement) => void): MockElement {
    const el = new MockElement(tag);
    const options: DomElementInfo = typeof info === 'string' ? { cls: info } : info ?? {};
    if (options.cls) el.addClass(...(Array.isArray(options.cls) ? options.cls : options.cls.split(/\s+/)));
    if (options.text !== undefined) el.setText(options.text);
    if (options.title !== undefined) el.setAttribute('title', options.title);
    if (options.type !== undefined) el.setAttribute('type', options.type);
    if (options.placeholder !== undefined) el.setAttribute('placeholder', options.placeholder);
    if (options.value !== undefined) el.value = options.value;
    if (options.attr) {
      for (const [key, value] of Object.entries(options.attr)) {
        if (value !== null && value !== false) el.setAttribute(key, String(value));
      }
    }
    this.appendChild(el);
    callback?.(el);
    return el;
  }

  createDiv(info?: DomElementInfo | string, callback?: (el: MockElement) => void): MockElement {
    return this.createEl('div', info, callback);
  }

  createSpan(info?: DomElementInfo | string, callback?: (el: MockElement) => void): MockElement {
    return this.createEl('span', info, callback);
  }

  appendChild<T extends MockElement>(child: T): T {
    child.parent?.removeChild(child);
    child.parent = this;
    this.children.push(child);
    return child;
  }

  append(...nodes: Array<MockElement | string>): void {
    for (const node of nodes) {
      if (typeof node === 'string') this.textContent += node;
      else this.appendChild(node);
    }
  }

  removeChild(child: MockElement): void {
    this.children = this.children.filter((c) => c !== child);
    child.parent = null;
  }

  remove(): void {
    this.parent?.removeChild(this);
  }

  detach(): void {
    this.remove();
  }

  empty(): void {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.textContent = '';
  }

  setText(text: string): void {
    this.textContent = text;
  }

  getText(): string {
    return this.textContent + this.children.map((c) => c.getText()).join('');
  }

  addClass(...classes: string[]): void {
    for (const c of classes) if (c) this.classes.add(c);
  }

  addClasses(classes: string[]): void {
    this.addClass(...classes);
  }

  removeClass(...classes: string[]): void {
    for (const c of classes) this.classes.delete(c);
  }

  toggleClass(cls: string, value: boolean): void {
    if (value) this.classes.add(cls);
    else this.classes.delete(cls);
  }

  hasClass(cls: string): boolean {
    return this.classes.has(cls);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  setAttr(name: string, value: string | number | boolean | null): void {
    if (value === null || value === false) this.attributes.delete(name);
    else this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  getAttr(name: string): string | null {
    return this.getAttribute(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== listener),
    );
  }

  /** Вызывает обработчики события (для тестов). */
  dispatch(type: string, event: unknown = { type, preventDefault: () => undefined, stopPropagation: () => undefined }): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  dispatchEvent(event: { type: string }): boolean {
    this.dispatch(event.type, event);
    return true;
  }

  click(): void {
    this.dispatch('click');
  }

  focus(): void {
    this.dispatch('focus');
  }

  blur(): void {
    this.dispatch('blur');
  }

  setCssProps(props: Record<string, string>): void {
    Object.assign(this.style, props);
  }

  setCssStyles(props: Record<string, string>): void {
    Object.assign(this.style, props);
  }

  /** Поиск по классу среди потомков (для тестов). */
  findAllByClass(cls: string): MockElement[] {
    const found: MockElement[] = [];
    const walk = (el: MockElement): void => {
      for (const child of el.children) {
        if (child.classes.has(cls)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  querySelector(selector: string): MockElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  /** Поддерживает только `.class` и имя тега. */
  querySelectorAll(selector: string): MockElement[] {
    if (selector.startsWith('.')) return this.findAllByClass(selector.slice(1));
    const tag = selector.toUpperCase();
    const found: MockElement[] = [];
    const walk = (el: MockElement): void => {
      for (const child of el.children) {
        if (child.tagName === tag) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
}

function el(tag = 'div'): HTMLElement {
  return new MockElement(tag) as unknown as HTMLElement;
}

// ===========================================================================
// Файлы
// ===========================================================================

export interface FileStats {
  ctime: number;
  mtime: number;
  size: number;
}

export abstract class TAbstractFile {
  vault!: Vault;
  path = '';
  name = '';
  parent: TFolder | null = null;
}

export class TFile extends TAbstractFile {
  basename = '';
  extension = '';
  stat: FileStats = { ctime: 0, mtime: 0, size: 0 };
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];

  isRoot(): boolean {
    return this.path === '/';
  }
}

function splitPath(path: string): { parent: string; name: string } {
  const index = path.lastIndexOf('/');
  return index === -1 ? { parent: '/', name: path } : { parent: path.slice(0, index), name: path.slice(index + 1) };
}

function applyFileName(file: TFile, path: string): void {
  const { name } = splitPath(path);
  file.path = path;
  file.name = name;
  const dot = name.lastIndexOf('.');
  file.basename = dot > 0 ? name.slice(0, dot) : name;
  file.extension = dot > 0 ? name.slice(dot + 1) : '';
}

type FileContent = string | ArrayBuffer;

/** Счётчик времени изменений (монотонный, независимый от реальных часов). */
let mtimeCounter = 1_700_000_000_000;
function nextMtime(): number {
  mtimeCounter += 1000;
  return mtimeCounter;
}

// ===========================================================================
// Vault и adapter
// ===========================================================================

export class DataAdapter {
  constructor(private readonly vault: Vault) {}

  getName(): string {
    return this.vault.getName();
  }

  async exists(path: string): Promise<boolean> {
    const p = normalizePath(path);
    return this.vault.contents.has(p) || this.vault.folders.has(p);
  }

  async stat(path: string): Promise<{ type: 'file' | 'folder'; ctime: number; mtime: number; size: number } | null> {
    const p = normalizePath(path);
    const file = this.vault.getFileByPath(p);
    if (file) return { type: 'file', ...file.stat };
    if (this.vault.folders.has(p)) return { type: 'folder', ctime: 0, mtime: 0, size: 0 };
    return null;
  }

  async read(path: string): Promise<string> {
    const content = this.vault.contents.get(normalizePath(path));
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return typeof content === 'string' ? content : new TextDecoder().decode(content);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const content = this.vault.contents.get(normalizePath(path));
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return typeof content === 'string' ? new TextEncoder().encode(content).buffer : content;
  }

  async write(path: string, data: string): Promise<void> {
    this.vault.checkWriteFailure(path);
    this.vault.writeRaw(normalizePath(path), data, false);
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.vault.checkWriteFailure(path);
    this.vault.writeRaw(normalizePath(path), data, false);
  }

  async append(path: string, data: string): Promise<void> {
    const p = normalizePath(path);
    const current = (await this.exists(p)) ? await this.read(p) : '';
    await this.write(p, current + data);
  }

  async process(path: string, fn: (data: string) => string): Promise<string> {
    const next = fn(await this.read(path));
    await this.write(path, next);
    return next;
  }

  async mkdir(path: string): Promise<void> {
    this.vault.ensureFolderSync(normalizePath(path));
  }

  async remove(path: string): Promise<void> {
    const p = normalizePath(path);
    if (!this.vault.contents.has(p)) throw new Error(`ENOENT: ${path}`);
    this.vault.removeRaw(p, false);
  }

  async rmdir(path: string, recursive: boolean): Promise<void> {
    const p = normalizePath(path);
    const listing = await this.list(p);
    if (!recursive && (listing.files.length || listing.folders.length)) throw new Error(`ENOTEMPTY: ${path}`);
    for (const f of listing.files) this.vault.removeRaw(f, false);
    for (const d of listing.folders) await this.rmdir(d, true);
    this.vault.folders.delete(p);
  }

  async rename(from: string, to: string): Promise<void> {
    this.vault.renameRaw(normalizePath(from), normalizePath(to), false);
  }

  async copy(from: string, to: string): Promise<void> {
    const content = this.vault.contents.get(normalizePath(from));
    if (content === undefined) throw new Error(`ENOENT: ${from}`);
    this.vault.writeRaw(normalizePath(to), content, false);
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const p = normalizePath(path);
    const prefix = p === '/' ? '' : `${p}/`;
    const direct = (candidate: string): boolean => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes('/') && candidate !== p;
    return {
      files: [...this.vault.contents.keys()].filter(direct).sort(),
      folders: [...this.vault.folders].filter((f) => f !== '/' && direct(f)).sort(),
    };
  }

  getResourcePath(path: string): string {
    return `app://mock/${path}`;
  }
}

export class Vault extends Events {
  /** Содержимое файлов: путь → текст/бинарные данные. */
  readonly contents = new Map<string, FileContent>();
  readonly folders = new Set<string>(['/']);
  readonly files = new Map<string, TFile>();
  readonly folderObjects = new Map<string, TFolder>();
  /** Удалённые в корзину файлы: путь → содержимое. */
  readonly trashed = new Map<string, FileContent>();
  readonly adapter: DataAdapter;
  configDir = '.obsidian';
  private vaultName = 'Test vault';
  private failingWrites = new Set<string>();
  /** Вызывается при каждом изменении содержимого (MetadataCache подписывается). */
  onContentChange: ((file: TFile) => void) | null = null;
  onContentDelete: ((file: TFile, prev: FileContent) => void) | null = null;
  onContentRename: ((file: TFile, oldPath: string) => void) | null = null;

  constructor() {
    super();
    this.adapter = new DataAdapter(this);
    const root = new TFolder();
    root.vault = this;
    root.path = '/';
    root.name = '';
    this.folderObjects.set('/', root);
  }

  getName(): string {
    return this.vaultName;
  }

  setName(name: string): void {
    this.vaultName = name;
  }

  /** Следующая запись по пути завершится ошибкой. */
  failNextWrite(path: string): void {
    this.failingWrites.add(normalizePath(path));
  }

  checkWriteFailure(path: string): void {
    const p = normalizePath(path);
    if (this.failingWrites.has(p)) {
      this.failingWrites.delete(p);
      throw new Error(`Mock write failure: ${p}`);
    }
  }

  getRoot(): TFolder {
    return this.folderObjects.get('/') as TFolder;
  }

  ensureFolderSync(path: string): TFolder {
    const p = normalizePath(path);
    const existing = this.folderObjects.get(p);
    if (existing) return existing;
    const { parent, name } = splitPath(p);
    const parentFolder = this.ensureFolderSync(parent);
    const folder = new TFolder();
    folder.vault = this;
    folder.path = p;
    folder.name = name;
    folder.parent = parentFolder;
    parentFolder.children.push(folder);
    this.folders.add(p);
    this.folderObjects.set(p, folder);
    this.trigger('create', folder);
    return folder;
  }

  /** Низкоуровневая запись (создание или изменение). */
  writeRaw(path: string, content: FileContent, viaVault: boolean): TFile {
    const p = normalizePath(path);
    let file = this.files.get(p);
    const isNew = !file;
    if (!file) {
      file = new TFile();
      file.vault = this;
      applyFileName(file, p);
      const parent = this.ensureFolderSync(splitPath(p).parent);
      file.parent = parent;
      parent.children.push(file);
      file.stat.ctime = nextMtime();
      this.files.set(p, file);
    }
    this.contents.set(p, content);
    file.stat.mtime = nextMtime();
    file.stat.size = typeof content === 'string' ? content.length : content.byteLength;
    // Запись через adapter (viaVault=false) тоже порождает события: в Obsidian их доставляет watcher файловой системы.
    void viaVault;
    this.trigger(isNew ? 'create' : 'modify', file);
    this.onContentChange?.(file);
    return file;
  }

  removeRaw(path: string, toTrash: boolean): void {
    const p = normalizePath(path);
    const file = this.files.get(p);
    const content = this.contents.get(p);
    if (!file || content === undefined) throw new Error(`ENOENT: ${path}`);
    if (toTrash) this.trashed.set(p, content);
    this.contents.delete(p);
    this.files.delete(p);
    if (file.parent) file.parent.children = file.parent.children.filter((c) => c !== file);
    this.trigger('delete', file);
    this.onContentDelete?.(file, content);
  }

  renameRaw(from: string, to: string, _viaVault: boolean): TFile {
    const file = this.files.get(from);
    const content = this.contents.get(from);
    if (!file || content === undefined) throw new Error(`ENOENT: ${from}`);
    if (this.contents.has(to)) throw new Error(`EEXIST: ${to}`);
    this.contents.delete(from);
    this.files.delete(from);
    if (file.parent) file.parent.children = file.parent.children.filter((c) => c !== file);
    applyFileName(file, to);
    const parent = this.ensureFolderSync(splitPath(to).parent);
    file.parent = parent;
    parent.children.push(file);
    this.contents.set(to, content);
    this.files.set(to, file);
    this.trigger('rename', file, from);
    this.onContentRename?.(file, from);
    return file;
  }

  getFileByPath(path: string): TFile | null {
    return this.files.get(normalizePath(path)) ?? null;
  }

  getFolderByPath(path: string): TFolder | null {
    return this.folderObjects.get(normalizePath(path)) ?? null;
  }

  getAbstractFileByPath(path: string): TAbstractFile | null {
    return this.getFileByPath(path) ?? this.getFolderByPath(path);
  }

  getFiles(): TFile[] {
    return [...this.files.values()];
  }

  getMarkdownFiles(): TFile[] {
    return this.getFiles().filter((f) => f.extension === 'md');
  }

  getAllLoadedFiles(): TAbstractFile[] {
    return [...this.folderObjects.values(), ...this.files.values()];
  }

  async create(path: string, data: string): Promise<TFile> {
    const p = normalizePath(path);
    if (this.contents.has(p)) throw new Error('File already exists.');
    this.checkWriteFailure(p);
    return this.writeRaw(p, data, true);
  }

  async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
    const p = normalizePath(path);
    if (this.contents.has(p)) throw new Error('File already exists.');
    this.checkWriteFailure(p);
    return this.writeRaw(p, data, true);
  }

  async createFolder(path: string): Promise<TFolder> {
    const p = normalizePath(path);
    if (this.folders.has(p)) throw new Error('Folder already exists.');
    return this.ensureFolderSync(p);
  }

  async read(file: TFile): Promise<string> {
    return this.adapter.read(file.path);
  }

  async cachedRead(file: TFile): Promise<string> {
    return this.adapter.read(file.path);
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    return this.adapter.readBinary(file.path);
  }

  async modify(file: TFile, data: string): Promise<void> {
    this.assertExists(file);
    this.checkWriteFailure(file.path);
    this.writeRaw(file.path, data, true);
  }

  async modifyBinary(file: TFile, data: ArrayBuffer): Promise<void> {
    this.assertExists(file);
    this.checkWriteFailure(file.path);
    this.writeRaw(file.path, data, true);
  }

  async append(file: TFile, data: string): Promise<void> {
    await this.modify(file, (await this.read(file)) + data);
  }

  async process(file: TFile, fn: (data: string) => string): Promise<string> {
    this.assertExists(file);
    const next = fn(await this.read(file));
    this.checkWriteFailure(file.path);
    this.writeRaw(file.path, next, true);
    return next;
  }

  async rename(file: TAbstractFile, newPath: string): Promise<void> {
    this.renameRaw(file.path, normalizePath(newPath), true);
  }

  async delete(file: TAbstractFile): Promise<void> {
    this.removeRaw(file.path, false);
  }

  async trash(file: TAbstractFile, _system: boolean): Promise<void> {
    this.removeRaw(file.path, true);
  }

  private assertExists(file: TFile): void {
    if (!this.files.has(file.path)) throw new Error(`File does not exist: ${file.path}`);
  }
}

// ===========================================================================
// Frontmatter
// ===========================================================================

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n?---(?:\r?\n|$)/;

/** Разделяет текст заметки на frontmatter и тело. */
export function splitFrontmatter(text: string): { frontmatter: Record<string, unknown> | null; yaml: string | null; body: string; end: number } {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) return { frontmatter: null, yaml: null, body: text, end: 0 };
  const yaml = match[1] ?? '';
  let frontmatter: Record<string, unknown> | null = null;
  try {
    const parsed = parseYamlLib(yaml) as unknown;
    frontmatter = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    frontmatter = null;
  }
  return { frontmatter, yaml, body: text.slice(match[0].length), end: match[0].length };
}

/** Собирает текст заметки из свойств и тела. Пустые свойства — без блока. */
export function joinFrontmatter(frontmatter: Record<string, unknown>, body: string): string {
  if (Object.keys(frontmatter).length === 0) return body;
  return `---\n${stringifyYamlLib(frontmatter)}---\n${body}`;
}

export class FileManager {
  constructor(private readonly app: App) {}

  async processFrontMatter(file: TFile, fn: (frontmatter: Record<string, unknown>) => void): Promise<void> {
    const vault = this.app.vault;
    const text = await vault.read(file);
    const split = splitFrontmatter(text);
    if (split.yaml !== null && split.frontmatter === null) throw new Error('YAML parse error');
    const frontmatter = split.frontmatter ?? {};
    fn(frontmatter);
    vault.checkWriteFailure(file.path);
    vault.writeRaw(file.path, joinFrontmatter(frontmatter, split.body), true);
  }

  async trashFile(file: TAbstractFile): Promise<void> {
    this.app.vault.removeRaw(file.path, true);
  }

  async renameFile(file: TAbstractFile, newPath: string): Promise<void> {
    await this.app.vault.rename(file, newPath);
  }

  getNewFileParent(_sourcePath: string): TFolder {
    return this.app.vault.getRoot();
  }

  generateMarkdownLink(file: TFile, _sourcePath: string): string {
    return `[[${file.basename}]]`;
  }
}

// ===========================================================================
// MetadataCache
// ===========================================================================

export interface Pos {
  start: { line: number; col: number; offset: number };
  end: { line: number; col: number; offset: number };
}

export interface CachedMetadata {
  frontmatter?: Record<string, unknown>;
  frontmatterPosition?: Pos;
  tags?: Array<{ tag: string }>;
}

export class MetadataCache extends Events {
  /** true — `changed` доставляется микрозадачей после записи; false — только через `flush()`. */
  autoFlush = true;
  resolved = false;
  private readonly cache = new Map<string, CachedMetadata>();
  private readonly pending = new Set<string>();
  private scheduled = false;

  constructor(private readonly vault: Vault) {
    super();
    vault.onContentChange = (file) => this.enqueue(file.path);
    vault.onContentDelete = (file, prev) => {
      const prevCache = this.cache.get(file.path) ?? null;
      this.cache.delete(file.path);
      this.pending.delete(file.path);
      this.trigger('deleted', file, typeof prev === 'string' ? prev : '', prevCache);
    };
    vault.onContentRename = (file, oldPath) => {
      const cached = this.cache.get(oldPath);
      this.cache.delete(oldPath);
      if (cached) this.cache.set(file.path, cached);
      if (this.pending.delete(oldPath)) this.pending.add(file.path);
    };
  }

  private enqueue(path: string): void {
    this.pending.add(path);
    if (this.autoFlush && !this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        if (this.autoFlush) this.flush();
      });
    }
  }

  /** Доставляет отложенные `changed` (и `resolved`, если `resolveAfterFlush`). */
  flush(): void {
    const paths = [...this.pending];
    this.pending.clear();
    for (const path of paths) {
      const file = this.vault.getFileByPath(path);
      if (!file) continue;
      const content = this.vault.contents.get(path);
      const text = typeof content === 'string' ? content : '';
      const metadata = this.compute(text);
      if (file.extension === 'md') this.cache.set(path, metadata);
      this.trigger('changed', file, text, metadata);
    }
  }

  /** Число записей, ожидающих `changed`. */
  pendingCount(): number {
    return this.pending.size;
  }

  /** Индексирует всё хранилище и посылает `resolved` (холодный старт). */
  resolve(): void {
    this.pending.clear();
    for (const file of this.vault.getMarkdownFiles()) {
      const content = this.vault.contents.get(file.path);
      this.cache.set(file.path, this.compute(typeof content === 'string' ? content : ''));
    }
    this.resolved = true;
    this.trigger('resolved');
  }

  private compute(text: string): CachedMetadata {
    const split = splitFrontmatter(text);
    if (split.yaml === null) return {};
    const lines = text.slice(0, split.end).split('\n').length - 1;
    const metadata: CachedMetadata = {
      frontmatterPosition: {
        start: { line: 0, col: 0, offset: 0 },
        end: { line: Math.max(lines - 1, 0), col: 3, offset: split.end },
      },
    };
    if (split.frontmatter) metadata.frontmatter = split.frontmatter;
    return metadata;
  }

  getFileCache(file: TFile): CachedMetadata | null {
    return this.cache.get(file.path) ?? null;
  }

  getCache(path: string): CachedMetadata | null {
    return this.cache.get(normalizePath(path)) ?? null;
  }

  getFirstLinkpathDest(linkpath: string, _sourcePath: string): TFile | null {
    return this.vault.getFileByPath(linkpath.endsWith('.md') ? linkpath : `${linkpath}.md`);
  }
}

// ===========================================================================
// Компоненты, вид, workspace
// ===========================================================================

export class Component {
  private cleanups: Array<() => void> = [];
  private childrenComponents: Component[] = [];
  private loaded = false;

  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    void this.onload();
    for (const child of this.childrenComponents) child.load();
  }

  unload(): void {
    if (!this.loaded) return;
    this.loaded = false;
    for (const child of this.childrenComponents) child.unload();
    this.childrenComponents = [];
    const cleanups = this.cleanups;
    this.cleanups = [];
    for (const cleanup of cleanups.reverse()) cleanup();
    this.onunload();
  }

  onload(): void | Promise<void> {}

  onunload(): void {}

  addChild<T extends Component>(component: T): T {
    this.childrenComponents.push(component);
    if (this.loaded) component.load();
    return component;
  }

  removeChild<T extends Component>(component: T): T {
    this.childrenComponents = this.childrenComponents.filter((c) => c !== component);
    component.unload();
    return component;
  }

  register(cb: () => unknown): void {
    this.cleanups.push(() => void cb());
  }

  registerEvent(ref: EventRef): void {
    this.cleanups.push(() => ref.owner.offref(ref));
  }

  registerDomEvent(el: { addEventListener(type: string, cb: (e: never) => unknown): void; removeEventListener(type: string, cb: (e: never) => unknown): void }, type: string, callback: (e: never) => unknown): void {
    el.addEventListener(type, callback);
    this.cleanups.push(() => el.removeEventListener(type, callback));
  }

  registerInterval(id: number): number {
    this.cleanups.push(() => clearInterval(id));
    return id;
  }

  /** Число зарегистрированных очисток (для проверки утечек в тестах). */
  get registeredCount(): number {
    return this.cleanups.length;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }
}

export abstract class View extends Component {
  app: App;
  leaf: WorkspaceLeaf;
  containerEl: HTMLElement;
  icon = '';
  navigation = false;

  constructor(leaf: WorkspaceLeaf) {
    super();
    this.leaf = leaf;
    this.app = leaf.app;
    this.containerEl = el();
  }

  abstract getViewType(): string;
  abstract getDisplayText(): string;

  getIcon(): string {
    return this.icon;
  }

  getState(): Record<string, unknown> {
    return {};
  }

  async setState(_state: unknown, _result: unknown): Promise<void> {}

  async onOpen(): Promise<void> {}

  async onClose(): Promise<void> {}
}

export abstract class ItemView extends View {
  contentEl: HTMLElement;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    const container = this.containerEl as unknown as MockElement;
    container.createDiv('view-header');
    this.contentEl = container.createDiv('view-content') as unknown as HTMLElement;
  }

  addAction(icon: string, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement {
    const action = (this.containerEl as unknown as MockElement).createEl('a', { cls: 'view-action', attr: { 'aria-label': title, 'data-icon': icon } });
    action.addEventListener('click', (e) => void callback(e as MouseEvent));
    return action as unknown as HTMLElement;
  }
}

export class MarkdownView extends ItemView {
  file: TFile | null = null;
  editor: Editor = new Editor('');

  getViewType(): string {
    return 'markdown';
  }

  getDisplayText(): string {
    return this.file?.basename ?? '';
  }
}

/** Упрощённый редактор: целый текст и курсор. */
export class Editor {
  constructor(private text: string) {}

  getValue(): string {
    return this.text;
  }

  setValue(text: string): void {
    this.text = text;
  }

  getCursor(): { line: number; ch: number } {
    return { line: 0, ch: 0 };
  }

  replaceRange(replacement: string, from: { line: number; ch: number }, to?: { line: number; ch: number }): void {
    const lines = this.text.split('\n');
    const offset = (pos: { line: number; ch: number }): number => lines.slice(0, pos.line).reduce((sum, line) => sum + line.length + 1, 0) + pos.ch;
    const start = offset(from);
    const end = to ? offset(to) : start;
    this.text = this.text.slice(0, start) + replacement + this.text.slice(end);
  }

  lineCount(): number {
    return this.text.split('\n').length;
  }

  getLine(line: number): string {
    return this.text.split('\n')[line] ?? '';
  }
}

export interface ViewState {
  type: string;
  state?: Record<string, unknown>;
  active?: boolean;
}

type ViewCreator = (leaf: WorkspaceLeaf) => View;

export class WorkspaceLeaf extends Events {
  view: View | null = null;
  private viewState: ViewState = { type: 'empty' };
  detached = false;

  constructor(
    readonly app: App,
    private readonly workspace: Workspace,
  ) {
    super();
  }

  async setViewState(state: ViewState): Promise<void> {
    if (this.view) {
      await this.view.onClose();
      this.view.unload();
      this.view = null;
    }
    this.viewState = state;
    const creator = this.workspace.viewCreators.get(state.type);
    if (creator) {
      this.view = creator(this);
      this.view.load();
      if (state.state) await this.view.setState(state.state, {});
      await this.view.onOpen();
    }
    if (state.active) this.workspace.setActiveLeaf(this);
  }

  getViewState(): ViewState {
    return this.viewState;
  }

  async openFile(file: TFile): Promise<void> {
    await this.setViewState({ type: 'markdown', state: { file: file.path } });
    if (this.view instanceof MarkdownView) {
      this.view.file = file;
      this.view.editor.setValue(await this.app.vault.read(file));
    }
    this.workspace.setActiveLeaf(this);
  }

  getDisplayText(): string {
    return this.view?.getDisplayText() ?? '';
  }

  detach(): void {
    if (this.view) {
      void this.view.onClose();
      this.view.unload();
      this.view = null;
    }
    this.detached = true;
    this.workspace.removeLeaf(this);
  }
}

export class Workspace extends Events {
  readonly viewCreators = new Map<string, ViewCreator>();
  readonly leaves: WorkspaceLeaf[] = [];
  activeLeaf: WorkspaceLeaf | null = null;
  layoutReady = true;
  containerEl: HTMLElement = el();

  constructor(private readonly app: App) {
    super();
    this.viewCreators.set('markdown', (leaf) => new MarkdownView(leaf));
  }

  registerViewCreator(type: string, creator: ViewCreator): void {
    this.viewCreators.set(type, creator);
  }

  getLeavesOfType(type: string): WorkspaceLeaf[] {
    return this.leaves.filter((leaf) => leaf.getViewState().type === type);
  }

  getLeaf(_newLeaf?: boolean | 'tab' | 'split' | 'window'): WorkspaceLeaf {
    const leaf = new WorkspaceLeaf(this.app, this);
    this.leaves.push(leaf);
    return leaf;
  }

  getRightLeaf(_split: boolean): WorkspaceLeaf | null {
    return this.getLeaf(true);
  }

  async revealLeaf(leaf: WorkspaceLeaf): Promise<void> {
    this.setActiveLeaf(leaf);
  }

  setActiveLeaf(leaf: WorkspaceLeaf): void {
    this.activeLeaf = leaf;
    this.trigger('active-leaf-change', leaf);
  }

  removeLeaf(leaf: WorkspaceLeaf): void {
    const index = this.leaves.indexOf(leaf);
    if (index !== -1) this.leaves.splice(index, 1);
    if (this.activeLeaf === leaf) this.activeLeaf = null;
  }

  detachLeavesOfType(type: string): void {
    for (const leaf of this.getLeavesOfType(type)) leaf.detach();
  }

  getActiveViewOfType<T extends View>(type: abstract new (...args: never[]) => T): T | null {
    const view = this.activeLeaf?.view;
    return view instanceof type ? (view as T) : null;
  }

  getActiveFile(): TFile | null {
    const view = this.activeLeaf?.view;
    return view instanceof MarkdownView ? view.file : null;
  }

  get activeEditor(): { editor: Editor; file: TFile | null } | null {
    const view = this.activeLeaf?.view;
    return view instanceof MarkdownView ? { editor: view.editor, file: view.file } : null;
  }

  onLayoutReady(callback: () => unknown): void {
    void callback();
  }

  async openLinkText(linktext: string, _sourcePath: string, _newLeaf?: boolean): Promise<void> {
    const file = this.app.vault.getFileByPath(linktext);
    if (file) await this.getLeaf().openFile(file);
  }

  requestSaveLayout(): void {}
}

// ===========================================================================
// App, Plugin
// ===========================================================================

export class App {
  vault: Vault;
  fileManager: FileManager;
  metadataCache: MetadataCache;
  workspace: Workspace;
  /** Вызовы `window.open`/`openUrl` из сервисов можно перехватывать через это поле. */
  openedUrls: string[] = [];

  constructor() {
    this.vault = new Vault();
    this.metadataCache = new MetadataCache(this.vault);
    this.fileManager = new FileManager(this);
    this.workspace = new Workspace(this);
  }
}

/** Создаёт новое in-memory приложение. */
export function createMockApp(options?: { vaultName?: string; resolved?: boolean }): App {
  const app = new App();
  if (options?.vaultName) app.vault.setName(options.vaultName);
  if (options?.resolved ?? true) app.metadataCache.resolve();
  return app;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion: string;
  description: string;
  author: string;
  isDesktopOnly?: boolean;
  dir?: string;
}

export interface Command {
  id: string;
  name: string;
  icon?: string;
  callback?: () => unknown;
  checkCallback?: (checking: boolean) => boolean | void;
  editorCallback?: (editor: Editor, ctx: unknown) => unknown;
  editorCheckCallback?: (checking: boolean, editor: Editor, ctx: unknown) => boolean | void;
}

export class Plugin extends Component {
  app: App;
  manifest: PluginManifest;
  /** Сохранённые данные (data.json). */
  data: unknown = null;
  readonly commands = new Map<string, Command>();
  readonly settingTabs: PluginSettingTab[] = [];
  readonly protocolHandlers = new Map<string, (params: Record<string, string>) => unknown>();
  readonly ribbonIcons: Array<{ icon: string; title: string; callback: (evt: MouseEvent) => unknown }> = [];
  readonly registeredViews: string[] = [];

  constructor(app: App, manifest?: PluginManifest) {
    super();
    this.app = app;
    this.manifest = manifest ?? {
      id: 'matrix-planner',
      name: 'Matrix planner',
      version: '0.0.0',
      minAppVersion: '1.8.7',
      description: '',
      author: '',
    };
  }

  async loadData(): Promise<unknown> {
    return this.data === null ? null : structuredClone(this.data);
  }

  async saveData(data: unknown): Promise<void> {
    this.data = structuredClone(data);
  }

  addCommand(command: Command): Command {
    const full = { ...command, id: `${this.manifest.id}:${command.id}` };
    this.commands.set(command.id, full);
    this.register(() => this.commands.delete(command.id));
    return full;
  }

  removeCommand(commandId: string): void {
    this.commands.delete(commandId);
  }

  addSettingTab(tab: PluginSettingTab): void {
    this.settingTabs.push(tab);
  }

  registerView(type: string, creator: ViewCreator): void {
    this.app.workspace.registerViewCreator(type, creator);
    this.registeredViews.push(type);
    this.register(() => this.app.workspace.viewCreators.delete(type));
  }

  registerObsidianProtocolHandler(action: string, handler: (params: Record<string, string>) => unknown): void {
    this.protocolHandlers.set(action, handler);
    this.register(() => this.protocolHandlers.delete(action));
  }

  addRibbonIcon(icon: string, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement {
    this.ribbonIcons.push({ icon, title, callback });
    return el();
  }

  addStatusBarItem(): HTMLElement {
    return el();
  }

  /** Выполнить команду по короткому id (для тестов). */
  runCommand(id: string): boolean {
    const command = this.commands.get(id);
    if (!command) return false;
    if (command.callback) {
      void command.callback();
      return true;
    }
    if (command.checkCallback) return command.checkCallback(false) !== false;
    return false;
  }
}

// ===========================================================================
// Модальные окна, настройки, уведомления, меню
// ===========================================================================

export class Modal {
  app: App;
  containerEl: HTMLElement = el();
  modalEl: HTMLElement;
  titleEl: HTMLElement;
  contentEl: HTMLElement;
  isOpen = false;

  constructor(app: App) {
    this.app = app;
    const container = this.containerEl as unknown as MockElement;
    const modal = container.createDiv('modal');
    this.modalEl = modal as unknown as HTMLElement;
    this.titleEl = modal.createDiv('modal-title') as unknown as HTMLElement;
    this.contentEl = modal.createDiv('modal-content') as unknown as HTMLElement;
  }

  open(): void {
    this.isOpen = true;
    void this.onOpen();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.onClose();
  }

  setTitle(title: string): this {
    (this.titleEl as unknown as MockElement).setText(title);
    return this;
  }

  setContent(content: string): this {
    (this.contentEl as unknown as MockElement).setText(content);
    return this;
  }

  onOpen(): void | Promise<void> {}

  onClose(): void {}
}

export class Notice {
  static messages: string[] = [];
  noticeEl: HTMLElement = el();
  message: string;

  constructor(message: string | DocumentFragment, _duration?: number) {
    this.message = typeof message === 'string' ? message : '[fragment]';
    Notice.messages.push(this.message);
  }

  setMessage(message: string): this {
    this.message = message;
    return this;
  }

  hide(): void {}
}

abstract class ValueComponent<T> {
  value: T;
  disabled = false;
  protected changeHandler: ((value: T) => unknown) | null = null;

  constructor(initial: T) {
    this.value = initial;
  }

  getValue(): T {
    return this.value;
  }

  setValue(value: T): this {
    this.value = value;
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }

  onChange(callback: (value: T) => unknown): this {
    this.changeHandler = callback;
    return this;
  }

  /** Имитирует ввод пользователя. */
  simulateChange(value: T): void {
    this.value = value;
    void this.changeHandler?.(value);
  }
}

export class TextComponent extends ValueComponent<string> {
  inputEl: HTMLInputElement = el('input') as unknown as HTMLInputElement;
  placeholder = '';

  constructor(_containerEl?: HTMLElement) {
    super('');
  }

  setPlaceholder(placeholder: string): this {
    this.placeholder = placeholder;
    return this;
  }
}

export class TextAreaComponent extends TextComponent {}

export class ToggleComponent extends ValueComponent<boolean> {
  toggleEl: HTMLElement = el();

  constructor(_containerEl?: HTMLElement) {
    super(false);
  }

  setTooltip(_tooltip: string): this {
    return this;
  }
}

export class DropdownComponent extends ValueComponent<string> {
  selectEl: HTMLSelectElement = el('select') as unknown as HTMLSelectElement;
  options: Record<string, string> = {};

  constructor(_containerEl?: HTMLElement) {
    super('');
  }

  addOption(value: string, display: string): this {
    this.options[value] = display;
    return this;
  }

  addOptions(options: Record<string, string>): this {
    Object.assign(this.options, options);
    return this;
  }
}

export class SliderComponent extends ValueComponent<number> {
  constructor(_containerEl?: HTMLElement) {
    super(0);
  }

  setLimits(_min: number, _max: number, _step: number | 'any'): this {
    return this;
  }

  setDynamicTooltip(): this {
    return this;
  }
}

export class ButtonComponent {
  buttonEl: HTMLButtonElement = el('button') as unknown as HTMLButtonElement;
  text = '';
  icon = '';
  disabled = false;
  cta = false;
  warning = false;
  private clickHandler: ((evt: MouseEvent) => unknown) | null = null;

  constructor(_containerEl?: HTMLElement) {}

  setButtonText(text: string): this {
    this.text = text;
    return this;
  }

  setIcon(icon: string): this {
    this.icon = icon;
    return this;
  }

  setTooltip(_tooltip: string): this {
    return this;
  }

  setCta(): this {
    this.cta = true;
    return this;
  }

  setWarning(): this {
    this.warning = true;
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }

  setClass(cls: string): this {
    (this.buttonEl as unknown as MockElement).addClass(cls);
    return this;
  }

  onClick(callback: (evt: MouseEvent) => unknown): this {
    this.clickHandler = callback;
    return this;
  }

  /** Имитирует нажатие. */
  click(): void {
    if (!this.disabled) void this.clickHandler?.({} as MouseEvent);
  }
}

export class ExtraButtonComponent extends ButtonComponent {}

export class Setting {
  settingEl: HTMLElement;
  infoEl: HTMLElement;
  nameEl: HTMLElement;
  descEl: HTMLElement;
  controlEl: HTMLElement;
  name = '';
  desc = '';
  heading = false;
  disabled = false;
  components: unknown[] = [];

  constructor(containerEl: HTMLElement) {
    const setting = (containerEl as unknown as MockElement).createDiv('setting-item');
    this.settingEl = setting as unknown as HTMLElement;
    const info = setting.createDiv('setting-item-info');
    this.infoEl = info as unknown as HTMLElement;
    this.nameEl = info.createDiv('setting-item-name') as unknown as HTMLElement;
    this.descEl = info.createDiv('setting-item-description') as unknown as HTMLElement;
    this.controlEl = setting.createDiv('setting-item-control') as unknown as HTMLElement;
  }

  setName(name: string | DocumentFragment): this {
    this.name = typeof name === 'string' ? name : '[fragment]';
    (this.nameEl as unknown as MockElement).setText(this.name);
    return this;
  }

  setDesc(desc: string | DocumentFragment): this {
    this.desc = typeof desc === 'string' ? desc : '[fragment]';
    (this.descEl as unknown as MockElement).setText(this.desc);
    return this;
  }

  setHeading(): this {
    this.heading = true;
    (this.settingEl as unknown as MockElement).addClass('setting-item-heading');
    return this;
  }

  setClass(cls: string): this {
    (this.settingEl as unknown as MockElement).addClass(cls);
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }

  setTooltip(_tooltip: string): this {
    return this;
  }

  private add<T>(component: T, cb: (component: T) => unknown): this {
    this.components.push(component);
    cb(component);
    return this;
  }

  addText(cb: (component: TextComponent) => unknown): this {
    return this.add(new TextComponent(), cb);
  }

  addTextArea(cb: (component: TextAreaComponent) => unknown): this {
    return this.add(new TextAreaComponent(), cb);
  }

  addToggle(cb: (component: ToggleComponent) => unknown): this {
    return this.add(new ToggleComponent(), cb);
  }

  addDropdown(cb: (component: DropdownComponent) => unknown): this {
    return this.add(new DropdownComponent(), cb);
  }

  addSlider(cb: (component: SliderComponent) => unknown): this {
    return this.add(new SliderComponent(), cb);
  }

  addButton(cb: (component: ButtonComponent) => unknown): this {
    return this.add(new ButtonComponent(), cb);
  }

  addExtraButton(cb: (component: ExtraButtonComponent) => unknown): this {
    return this.add(new ExtraButtonComponent(), cb);
  }

  then(cb: (setting: this) => unknown): this {
    cb(this);
    return this;
  }
}

export abstract class SettingTab {
  app: App;
  containerEl: HTMLElement = el();

  constructor(app: App) {
    this.app = app;
  }

  abstract display(): void;

  hide(): void {
    (this.containerEl as unknown as MockElement).empty();
  }
}

export abstract class PluginSettingTab extends SettingTab {
  plugin: Plugin;

  constructor(app: App, plugin: Plugin) {
    super(app);
    this.plugin = plugin;
  }
}

export class MenuItem {
  title = '';
  icon = '';
  section = '';
  checked = false;
  disabled = false;
  isWarning = false;
  private clickHandler: ((evt: MouseEvent | KeyboardEvent) => unknown) | null = null;

  setTitle(title: string | DocumentFragment): this {
    this.title = typeof title === 'string' ? title : '[fragment]';
    return this;
  }

  setIcon(icon: string | null): this {
    this.icon = icon ?? '';
    return this;
  }

  setChecked(checked: boolean | null): this {
    this.checked = checked ?? false;
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }

  setWarning(isWarning: boolean): this {
    this.isWarning = isWarning;
    return this;
  }

  setSection(section: string): this {
    this.section = section;
    return this;
  }

  onClick(callback: (evt: MouseEvent | KeyboardEvent) => unknown): this {
    this.clickHandler = callback;
    return this;
  }

  /** Имитирует выбор пункта. */
  click(): void {
    if (!this.disabled) void this.clickHandler?.({} as MouseEvent);
  }
}

export class Menu {
  static lastShown: Menu | null = null;
  items: Array<MenuItem | 'separator'> = [];
  private hideHandler: (() => unknown) | null = null;

  addItem(cb: (item: MenuItem) => unknown): this {
    const item = new MenuItem();
    cb(item);
    this.items.push(item);
    return this;
  }

  addSeparator(): this {
    this.items.push('separator');
    return this;
  }

  showAtMouseEvent(_evt: MouseEvent): this {
    Menu.lastShown = this;
    return this;
  }

  showAtPosition(_position: { x: number; y: number }): this {
    Menu.lastShown = this;
    return this;
  }

  hide(): this {
    void this.hideHandler?.();
    return this;
  }

  onHide(callback: () => unknown): void {
    this.hideHandler = callback;
  }

  /** Пункты меню без разделителей (для тестов). */
  get menuItems(): MenuItem[] {
    return this.items.filter((item): item is MenuItem => item !== 'separator');
  }
}

/** Заглушка `requestUrl` — плагин не делает сетевых запросов. */
export async function requestUrl(): Promise<never> {
  throw new Error('Network is not available in tests');
}

/**
 * Черновик редактора обоев (ТЗ §4.5). Чистый модуль: без `obsidian` и DOM.
 * Все функции возвращают новый черновик; исходные настройки не меняются,
 * пока пользователь не нажмёт «Готово» (`applyDraft`).
 */

import type {
  CachedCalendar,
  VaultPath,
  VisibleCalendarsSetting,
  WallpaperBackground,
  WallpaperCrop,
  WallpaperPalette,
  WallpaperProfile,
  WallpaperSettings,
  WallpaperTemplate,
  WeekStartSetting,
} from '../model/types';
import { KNOWN_PROFILES, parseProfileId } from './profiles';

/** Поля, которые меняет редактор (название быстрой команды — только в настройках). */
export type EditableWallpaperSettings = Omit<WallpaperSettings, 'shortcutName'>;

export interface WallpaperDraft {
  readonly original: Readonly<EditableWallpaperSettings>;
  readonly current: Readonly<EditableWallpaperSettings>;
}

export type BackgroundKind = WallpaperBackground['kind'];
export type TemplateCategory = 'tasks' | 'calendar';
export type TemplateFilter = 'all' | TemplateCategory;

export interface TemplateInfo {
  id: WallpaperTemplate;
  category: TemplateCategory;
  /** Значок Lucide. */
  icon: string;
}

/** Шаблоны версии 1 в порядке галереи. */
export const TEMPLATE_CATALOG: readonly TemplateInfo[] = [
  { id: 'matrix', category: 'tasks', icon: 'layout-grid' },
  { id: 'calendar', category: 'calendar', icon: 'calendar-days' },
];

export const TEMPLATE_FILTERS: readonly TemplateFilter[] = ['all', 'calendar', 'tasks'];

export const PALETTES: readonly WallpaperPalette[] = ['dark', 'light', 'translucent'];

export const BACKGROUND_KINDS: readonly BackgroundKind[] = ['image', 'solid', 'gradient'];

/** Однотонные фоны для быстрого выбора. */
export const SOLID_PRESETS: readonly string[] = ['#1C1C1E', '#2C3E50', '#3A4A5C', '#5B6B73', '#E5E5EA', '#F2E8DA'];

/** Градиенты для быстрого выбора. */
export const GRADIENT_PRESETS: readonly { from: string; to: string; angle: number }[] = [
  { from: '#0F2027', to: '#2C5364', angle: 180 },
  { from: '#1C1C1E', to: '#3A3A3C', angle: 180 },
  { from: '#41295A', to: '#2F0743', angle: 160 },
  { from: '#355C7D', to: '#C06C84', angle: 200 },
  { from: '#8E9EAB', to: '#EEF2F3', angle: 180 },
];

/** Пределы масштаба кадрирования. */
export const CROP_MIN_SCALE = 1;
export const CROP_MAX_SCALE = 4;

const DEFAULT_SOLID = '#1C1C1E';
const DEFAULT_CROP: WallpaperCrop = { centerX: 0.5, centerY: 0.5, scale: 1 };

// ---------------------------------------------------------------------------
// Создание, сравнение, применение
// ---------------------------------------------------------------------------

function cloneBackground(background: WallpaperBackground): WallpaperBackground {
  switch (background.kind) {
    case 'solid':
      return { kind: 'solid', color: background.color };
    case 'gradient':
      return { kind: 'gradient', from: background.from, to: background.to, angle: background.angle };
    case 'image':
      return { kind: 'image', path: background.path, crop: { ...background.crop } };
  }
}

function pickEditable(settings: Readonly<WallpaperSettings> | Readonly<EditableWallpaperSettings>): EditableWallpaperSettings {
  return {
    template: settings.template,
    palette: settings.palette,
    background: cloneBackground(settings.background),
    profile: settings.profile,
    tasksPerQuadrant: settings.tasksPerQuadrant,
    weekStart: settings.weekStart,
    calendarIds: settings.calendarIds === null ? null : [...settings.calendarIds],
  };
}

export function createDraft(settings: Readonly<WallpaperSettings>): WallpaperDraft {
  return { original: pickEditable(settings), current: pickEditable(settings) };
}

function withCurrent(draft: WallpaperDraft, patch: Partial<EditableWallpaperSettings>): WallpaperDraft {
  return { original: draft.original, current: { ...pickEditable(draft.current), ...patch } };
}

function sameBackground(a: WallpaperBackground, b: WallpaperBackground): boolean {
  if (a.kind === 'solid' && b.kind === 'solid') return a.color.toLowerCase() === b.color.toLowerCase();
  if (a.kind === 'gradient' && b.kind === 'gradient') {
    return a.from.toLowerCase() === b.from.toLowerCase() && a.to.toLowerCase() === b.to.toLowerCase() && a.angle === b.angle;
  }
  if (a.kind === 'image' && b.kind === 'image') {
    return (
      a.path === b.path &&
      a.crop.centerX === b.crop.centerX &&
      a.crop.centerY === b.crop.centerY &&
      a.crop.scale === b.crop.scale
    );
  }
  return false;
}

function sameIds(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

export type DraftField = keyof EditableWallpaperSettings;

/** Поля, отличающиеся от исходных настроек. */
export function changedFields(draft: WallpaperDraft): DraftField[] {
  const { original: o, current: c } = draft;
  const changed: DraftField[] = [];
  if (o.template !== c.template) changed.push('template');
  if (o.palette !== c.palette) changed.push('palette');
  if (!sameBackground(o.background, c.background)) changed.push('background');
  if (o.profile !== c.profile) changed.push('profile');
  if (o.tasksPerQuadrant !== c.tasksPerQuadrant) changed.push('tasksPerQuadrant');
  if (o.weekStart !== c.weekStart) changed.push('weekStart');
  if (!sameIds(o.calendarIds, c.calendarIds)) changed.push('calendarIds');
  return changed;
}

export function isDirty(draft: WallpaperDraft): boolean {
  return changedFields(draft).length > 0;
}

/**
 * Настройки обоев с изменениями черновика поверх `target` (актуальные настройки
 * на момент сохранения). Название быстрой команды и неизвестные поля сохраняются.
 */
export function applyDraft(target: Readonly<WallpaperSettings>, draft: WallpaperDraft): WallpaperSettings {
  return { ...target, ...pickEditable(draft.current), shortcutName: target.shortcutName };
}

/** Настройки для предпросмотра (`WallpaperService.renderPreview`). */
export function previewSettings(base: Readonly<WallpaperSettings>, draft: WallpaperDraft): WallpaperSettings {
  return applyDraft(base, draft);
}

// ---------------------------------------------------------------------------
// Шаблон и палитра
// ---------------------------------------------------------------------------

export function setTemplate(draft: WallpaperDraft, template: WallpaperTemplate): WallpaperDraft {
  return withCurrent(draft, { template });
}

export function setPalette(draft: WallpaperDraft, palette: WallpaperPalette): WallpaperDraft {
  return withCurrent(draft, { palette });
}

export function templateInfo(id: WallpaperTemplate): TemplateInfo {
  return TEMPLATE_CATALOG.find((item) => item.id === id) ?? TEMPLATE_CATALOG[0];
}

/** Шаблоны галереи по фильтру «Все / Календарь / Задачи». */
export function filterTemplates(filter: TemplateFilter): TemplateInfo[] {
  return TEMPLATE_CATALOG.filter((item) => filter === 'all' || item.category === filter);
}

/**
 * Показывают ли обои названия задач и событий на заблокированном экране (ТЗ §7).
 * Оба шаблона версии 1 показывают; вариант «Только счётчики» — версия 2.
 */
export function showsItemTitles(template: WallpaperTemplate): boolean {
  return template === 'matrix' || template === 'calendar';
}

// ---------------------------------------------------------------------------
// Фон и кадрирование
// ---------------------------------------------------------------------------

/**
 * Смена типа фона. Возврат к прежнему типу восстанавливает исходное значение,
 * иначе — значение по умолчанию. Для картинки без пути — `null` (сначала выбрать файл).
 */
export function setBackgroundKind(draft: WallpaperDraft, kind: BackgroundKind): WallpaperDraft | null {
  const current = draft.current.background;
  if (current.kind === kind) return draft;
  const original = draft.original.background;
  if (original.kind === kind) return withCurrent(draft, { background: cloneBackground(original) });
  switch (kind) {
    case 'solid':
      return withCurrent(draft, { background: { kind: 'solid', color: current.kind === 'gradient' ? current.from : DEFAULT_SOLID } });
    case 'gradient': {
      const preset = GRADIENT_PRESETS[0];
      const from = current.kind === 'solid' ? current.color : preset.from;
      return withCurrent(draft, { background: { kind: 'gradient', from, to: preset.to, angle: preset.angle } });
    }
    case 'image':
      return null;
  }
}

export function setSolidColor(draft: WallpaperDraft, color: string): WallpaperDraft {
  return withCurrent(draft, { background: { kind: 'solid', color: normalizeHex(color) ?? DEFAULT_SOLID } });
}

export function setGradient(draft: WallpaperDraft, patch: Partial<{ from: string; to: string; angle: number }>): WallpaperDraft {
  const current = draft.current.background;
  const base = current.kind === 'gradient' ? current : { kind: 'gradient' as const, ...GRADIENT_PRESETS[0] };
  return withCurrent(draft, {
    background: {
      kind: 'gradient',
      from: normalizeHex(patch.from ?? base.from) ?? base.from,
      to: normalizeHex(patch.to ?? base.to) ?? base.to,
      angle: normalizeAngle(patch.angle ?? base.angle),
    },
  });
}

/** Новая картинка: кадр по центру без увеличения. Та же картинка — кадр сохраняется. */
export function setImage(draft: WallpaperDraft, path: VaultPath): WallpaperDraft {
  const current = draft.current.background;
  const crop = current.kind === 'image' && current.path === path ? { ...current.crop } : { ...DEFAULT_CROP };
  return withCurrent(draft, { background: { kind: 'image', path, crop } });
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Округление долей, чтобы сдвиг туда-обратно не копил ошибку. */
function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function normalizeCrop(crop: WallpaperCrop): WallpaperCrop {
  return {
    centerX: round4(clamp(crop.centerX, 0, 1)),
    centerY: round4(clamp(crop.centerY, 0, 1)),
    scale: round4(clamp(crop.scale, CROP_MIN_SCALE, CROP_MAX_SCALE)),
  };
}

function updateCrop(draft: WallpaperDraft, mutate: (crop: WallpaperCrop) => WallpaperCrop): WallpaperDraft {
  const current = draft.current.background;
  if (current.kind !== 'image') return draft;
  return withCurrent(draft, { background: { kind: 'image', path: current.path, crop: normalizeCrop(mutate({ ...current.crop })) } });
}

/** Задать кадр целиком (ползунки). */
export function setCrop(draft: WallpaperDraft, patch: Partial<WallpaperCrop>): WallpaperDraft {
  return updateCrop(draft, (crop) => ({ ...crop, ...patch }));
}

/**
 * Сдвиг кадра перетаскиванием: `dx`, `dy` — доли видимой области (0–1).
 * Картинка тянется за пальцем, поэтому центр кадра смещается в обратную сторону;
 * при увеличении тот же жест сдвигает кадр меньше.
 */
export function panCrop(draft: WallpaperDraft, dx: number, dy: number): WallpaperDraft {
  return updateCrop(draft, (crop) => ({
    ...crop,
    centerX: crop.centerX - dx / crop.scale,
    centerY: crop.centerY - dy / crop.scale,
  }));
}

/** Масштаб кадра умножается на `factor`. */
export function zoomCrop(draft: WallpaperDraft, factor: number): WallpaperDraft {
  return updateCrop(draft, (crop) => ({ ...crop, scale: crop.scale * (Number.isFinite(factor) && factor > 0 ? factor : 1) }));
}

export function resetCrop(draft: WallpaperDraft): WallpaperDraft {
  return updateCrop(draft, () => ({ ...DEFAULT_CROP }));
}

/** `#rgb`/`#rrggbb` → `#RRGGBB`; иначе `null`. */
export function normalizeHex(value: string): string | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const hex = match[1].length === 3 ? Array.from(match[1]).map((c) => c + c).join('') : match[1];
  return `#${hex.toUpperCase()}`;
}

/** Угол градиента в диапазоне 0–359. */
export function normalizeAngle(angle: number): number {
  if (!Number.isFinite(angle)) return 180;
  return ((Math.round(angle) % 360) + 360) % 360;
}

// ---------------------------------------------------------------------------
// Параметры
// ---------------------------------------------------------------------------

export function setTasksPerQuadrant(draft: WallpaperDraft, count: number): WallpaperDraft {
  return withCurrent(draft, { tasksPerQuadrant: count <= 2 ? 2 : 3 });
}

export function setWeekStart(draft: WallpaperDraft, weekStart: WeekStartSetting): WallpaperDraft {
  return withCurrent(draft, { weekStart });
}

/** Ручной профиль устройства или `auto`. Неизвестный id не принимается. */
export function setProfile(draft: WallpaperDraft, profile: 'auto' | string): WallpaperDraft {
  if (profile !== 'auto' && !parseProfileId(profile)) return draft;
  return withCurrent(draft, { profile });
}

export interface ProfileOption {
  /** `auto` или id профиля. */
  id: string;
  /** Профиль (для `auto` — определённый автоматически или `null`). */
  profile: WallpaperProfile | null;
}

/**
 * Варианты выпадающего списка профилей: «Автоматически», известные iPhone
 * и сохранённый ручной профиль, если его нет в списке.
 */
export function profileOptions(current: 'auto' | string, autoProfile: WallpaperProfile | null): ProfileOption[] {
  const options: ProfileOption[] = [{ id: 'auto', profile: autoProfile }];
  for (const profile of KNOWN_PROFILES) options.push({ id: profile.id, profile });
  if (current !== 'auto' && !KNOWN_PROFILES.some((p) => p.id === current)) {
    options.push({ id: current, profile: parseProfileId(current) });
  }
  return options;
}

/**
 * Календари, которые сейчас попадают на обои. `calendarIds: null` — как в
 * «Показываемых календарях» (там же дни рождения по флагу `birthdays`).
 */
export function effectiveCalendarIds(
  calendarIds: readonly string[] | null,
  visible: Readonly<VisibleCalendarsSetting>,
  calendars: readonly CachedCalendar[],
): string[] {
  if (calendarIds !== null) return [...calendarIds];
  return calendars
    .filter((c) => visible.calendarIds.includes(c.calendarId) || (c.kind === 'birthdays' && visible.birthdays))
    .map((c) => c.calendarId);
}

/** Включить/выключить календарь: переводит черновик на явный список. */
export function setCalendarEnabled(
  draft: WallpaperDraft,
  calendarId: string,
  enabled: boolean,
  visible: Readonly<VisibleCalendarsSetting>,
  calendars: readonly CachedCalendar[],
): WallpaperDraft {
  const ids = effectiveCalendarIds(draft.current.calendarIds, visible, calendars).filter((id) => id !== calendarId);
  if (enabled) ids.push(calendarId);
  return withCurrent(draft, { calendarIds: ids });
}

/** Вернуть «как в настройках календаря» (`null`). */
export function useDefaultCalendars(draft: WallpaperDraft): WallpaperDraft {
  return withCurrent(draft, { calendarIds: null });
}

/** Перейти на явный список: сейчас включены те же календари, что и «как в настройках». */
export function useExplicitCalendars(
  draft: WallpaperDraft,
  visible: Readonly<VisibleCalendarsSetting>,
  calendars: readonly CachedCalendar[],
): WallpaperDraft {
  if (draft.current.calendarIds !== null) return draft;
  return withCurrent(draft, { calendarIds: effectiveCalendarIds(null, visible, calendars) });
}

import { describe, expect, it } from 'vitest';
import type { CachedCalendar, VisibleCalendarsSetting, WallpaperSettings } from '../../src/model/types';
import {
  CROP_MAX_SCALE,
  applyDraft,
  changedFields,
  createDraft,
  effectiveCalendarIds,
  filterTemplates,
  isDirty,
  normalizeAngle,
  normalizeHex,
  panCrop,
  profileOptions,
  resetCrop,
  setBackgroundKind,
  setCalendarEnabled,
  setCrop,
  setGradient,
  setImage,
  setPalette,
  setProfile,
  setSolidColor,
  setTasksPerQuadrant,
  setTemplate,
  setWeekStart,
  showsItemTitles,
  useDefaultCalendars,
  useExplicitCalendars,
  zoomCrop,
} from '../../src/wallpaper/wallpaper-draft';
import { KNOWN_PROFILES } from '../../src/wallpaper/profiles';

function settings(patch: Partial<WallpaperSettings> = {}): WallpaperSettings {
  return {
    template: 'matrix',
    palette: 'dark',
    background: { kind: 'solid', color: '#1C1C1E' },
    profile: 'auto',
    shortcutName: 'Обои Планировщика',
    tasksPerQuadrant: 3,
    weekStart: 'auto',
    calendarIds: null,
    ...patch,
  };
}

const CALENDARS: CachedCalendar[] = [
  { calendarId: 'work', title: 'Работа', color: '#3E8BF0', kind: 'caldav', allowsModifications: true },
  { calendarId: 'home', title: 'Дом', color: '#E5484D', kind: 'local', allowsModifications: true },
  { calendarId: 'bday', title: 'Дни рождения', color: '#8E8E93', kind: 'birthdays', allowsModifications: false },
];

const VISIBLE: VisibleCalendarsSetting = { planner: true, birthdays: true, calendarIds: ['work'] };

describe('черновик: создание и dirty', () => {
  it('новый черновик не изменён', () => {
    const draft = createDraft(settings());
    expect(isDirty(draft)).toBe(false);
    expect(changedFields(draft)).toEqual([]);
  });

  it('любое изменение делает черновик изменённым, возврат — снова чистым', () => {
    const draft = createDraft(settings());
    const changed = setPalette(draft, 'light');
    expect(isDirty(changed)).toBe(true);
    expect(changedFields(changed)).toEqual(['palette']);
    expect(isDirty(setPalette(changed, 'dark'))).toBe(false);
  });

  it('исходные настройки не мутируются', () => {
    const source = settings({ background: { kind: 'image', path: 'a.png', crop: { centerX: 0.5, centerY: 0.5, scale: 1 } } });
    const draft = createDraft(source);
    zoomCrop(panCrop(draft, 0.1, 0.1), 2);
    expect(source.background).toEqual({ kind: 'image', path: 'a.png', crop: { centerX: 0.5, centerY: 0.5, scale: 1 } });
    expect(draft.current.background).toEqual(source.background);
  });

  it('applyDraft сохраняет название быстрой команды и неизвестные поля целевых настроек', () => {
    const draft = setTemplate(createDraft(settings()), 'calendar');
    const target = { ...settings({ shortcutName: 'Новая команда' }), extra: 1 } as WallpaperSettings & { extra: number };
    const applied = applyDraft(target, draft) as WallpaperSettings & { extra?: number };
    expect(applied.template).toBe('calendar');
    expect(applied.shortcutName).toBe('Новая команда');
    expect(applied.extra).toBe(1);
  });
});

describe('шаблон и палитра', () => {
  it('смена шаблона и палитры', () => {
    let draft = createDraft(settings());
    draft = setTemplate(draft, 'calendar');
    draft = setPalette(draft, 'translucent');
    expect(draft.current.template).toBe('calendar');
    expect(draft.current.palette).toBe('translucent');
    expect(changedFields(draft)).toEqual(['template', 'palette']);
  });

  it('фильтр галереи: все, календарь, задачи', () => {
    expect(filterTemplates('all').map((i) => i.id)).toEqual(['matrix', 'calendar']);
    expect(filterTemplates('calendar').map((i) => i.id)).toEqual(['calendar']);
    expect(filterTemplates('tasks').map((i) => i.id)).toEqual(['matrix']);
  });

  it('предупреждение о видимости названий для обоих шаблонов версии 1', () => {
    expect(showsItemTitles('matrix')).toBe(true);
    expect(showsItemTitles('calendar')).toBe(true);
  });
});

describe('фон', () => {
  it('однотонный цвет нормализуется в #RRGGBB', () => {
    const draft = setSolidColor(createDraft(settings()), '#abc');
    expect(draft.current.background).toEqual({ kind: 'solid', color: '#AABBCC' });
    expect(normalizeHex('zzz')).toBeNull();
  });

  it('смена типа на градиент и обратно восстанавливает исходный цвет', () => {
    const draft = createDraft(settings({ background: { kind: 'solid', color: '#112233' } }));
    const gradient = setBackgroundKind(draft, 'gradient');
    expect(gradient?.current.background.kind).toBe('gradient');
    if (gradient?.current.background.kind === 'gradient') expect(gradient.current.background.from).toBe('#112233');
    const back = gradient ? setBackgroundKind(gradient, 'solid') : null;
    expect(back?.current.background).toEqual({ kind: 'solid', color: '#112233' });
    expect(back && isDirty(back)).toBe(false);
  });

  it('картинка без выбранного файла требует выбора (null)', () => {
    expect(setBackgroundKind(createDraft(settings()), 'image')).toBeNull();
  });

  it('градиент: частичное изменение и угол в 0–359', () => {
    let draft = setGradient(createDraft(settings()), { from: '#000000', to: '#ffffff', angle: 90 });
    draft = setGradient(draft, { angle: -90 });
    expect(draft.current.background).toEqual({ kind: 'gradient', from: '#000000', to: '#FFFFFF', angle: 270 });
    expect(normalizeAngle(720)).toBe(0);
  });

  it('новая картинка — кадр по центру; та же картинка сохраняет кадр', () => {
    let draft = setImage(createDraft(settings()), 'Фото/горы.jpg');
    expect(draft.current.background).toEqual({ kind: 'image', path: 'Фото/горы.jpg', crop: { centerX: 0.5, centerY: 0.5, scale: 1 } });
    draft = setCrop(draft, { scale: 2 });
    draft = setImage(draft, 'Фото/горы.jpg');
    if (draft.current.background.kind === 'image') expect(draft.current.background.crop.scale).toBe(2);
    draft = setImage(draft, 'Фото/море.jpg');
    if (draft.current.background.kind === 'image') expect(draft.current.background.crop.scale).toBe(1);
  });
});

describe('кадрирование', () => {
  const withImage = () => setImage(createDraft(settings()), 'bg.png');
  const crop = (draft: ReturnType<typeof withImage>) => {
    const bg = draft.current.background;
    if (bg.kind !== 'image') throw new Error('not image');
    return bg.crop;
  };

  it('сдвиг перетаскиванием: картинка за пальцем, центр кадра в обратную сторону', () => {
    const moved = panCrop(withImage(), 0.1, -0.2);
    expect(crop(moved)).toEqual({ centerX: 0.4, centerY: 0.7, scale: 1 });
  });

  it('при увеличении тот же жест сдвигает кадр меньше', () => {
    const zoomed = zoomCrop(withImage(), 2);
    expect(crop(panCrop(zoomed, 0.1, 0)).centerX).toBeCloseTo(0.45, 6);
  });

  it('центр ограничен 0–1, масштаб — 1…максимум', () => {
    let draft = panCrop(withImage(), 5, -5);
    expect(crop(draft)).toMatchObject({ centerX: 0, centerY: 1 });
    draft = zoomCrop(draft, 100);
    expect(crop(draft).scale).toBe(CROP_MAX_SCALE);
    draft = zoomCrop(draft, 0.0001);
    expect(crop(draft).scale).toBe(1);
  });

  it('сброс кадра и кадрирование без картинки не меняют черновик', () => {
    const draft = resetCrop(zoomCrop(withImage(), 3));
    expect(crop(draft)).toEqual({ centerX: 0.5, centerY: 0.5, scale: 1 });
    const solid = createDraft(settings());
    expect(panCrop(solid, 0.1, 0.1)).toBe(solid);
  });

  it('изменение кадра делает черновик изменённым', () => {
    const base = createDraft(settings({ background: { kind: 'image', path: 'bg.png', crop: { centerX: 0.5, centerY: 0.5, scale: 1 } } }));
    expect(changedFields(zoomCrop(base, 1.5))).toEqual(['background']);
  });
});

describe('параметры', () => {
  it('число задач в квадранте — только 2 или 3', () => {
    const draft = createDraft(settings());
    expect(setTasksPerQuadrant(draft, 2).current.tasksPerQuadrant).toBe(2);
    expect(setTasksPerQuadrant(draft, 1).current.tasksPerQuadrant).toBe(2);
    expect(setTasksPerQuadrant(draft, 7).current.tasksPerQuadrant).toBe(3);
  });

  it('начало недели', () => {
    expect(changedFields(setWeekStart(createDraft(settings()), 'sunday'))).toEqual(['weekStart']);
  });

  it('ручной профиль устройства и возврат к автоматическому', () => {
    let draft = setProfile(createDraft(settings()), 'iphone-1170x2532');
    expect(draft.current.profile).toBe('iphone-1170x2532');
    expect(applyDraft(settings(), draft).profile).toBe('iphone-1170x2532');
    draft = setProfile(draft, 'auto');
    expect(isDirty(draft)).toBe(false);
  });

  it('неизвестный профиль не принимается', () => {
    const draft = createDraft(settings());
    expect(setProfile(draft, 'garbage')).toBe(draft);
  });

  it('варианты профилей: авто, известные iPhone и сохранённый ручной', () => {
    const options = profileOptions('screen-1080x2400', null);
    expect(options[0]).toEqual({ id: 'auto', profile: null });
    expect(options).toHaveLength(KNOWN_PROFILES.length + 2);
    expect(options[options.length - 1].id).toBe('screen-1080x2400');
    expect(profileOptions('auto', KNOWN_PROFILES[0])).toHaveLength(KNOWN_PROFILES.length + 1);
  });

  it('календари: null — как в настройках календаря (с днями рождения)', () => {
    expect(effectiveCalendarIds(null, VISIBLE, CALENDARS)).toEqual(['work', 'bday']);
    expect(effectiveCalendarIds(null, { ...VISIBLE, birthdays: false }, CALENDARS)).toEqual(['work']);
  });

  it('переключение календаря переводит на явный список', () => {
    const draft = setCalendarEnabled(createDraft(settings()), 'home', true, VISIBLE, CALENDARS);
    expect(draft.current.calendarIds).toEqual(['work', 'bday', 'home']);
    const off = setCalendarEnabled(draft, 'work', false, VISIBLE, CALENDARS);
    expect(off.current.calendarIds).toEqual(['bday', 'home']);
    expect(useDefaultCalendars(off).current.calendarIds).toBeNull();
  });

  it('явный список без изменений набора и порядок не влияют на dirty', () => {
    const draft = createDraft(settings({ calendarIds: ['a', 'b'] }));
    const toggled = setCalendarEnabled(setCalendarEnabled(draft, 'a', false, VISIBLE, CALENDARS), 'a', true, VISIBLE, CALENDARS);
    expect(toggled.current.calendarIds).toEqual(['b', 'a']);
    expect(isDirty(toggled)).toBe(false);
  });

  it('useExplicitCalendars фиксирует текущий набор', () => {
    const draft = useExplicitCalendars(createDraft(settings()), VISIBLE, CALENDARS);
    expect(draft.current.calendarIds).toEqual(['work', 'bday']);
    expect(isDirty(draft)).toBe(true);
  });
});

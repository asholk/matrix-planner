# Контракты Matrix planner

Документ описывает общие типы (`src/model/types.ts`) и интерфейсы сервисов (`src/app/contracts.ts`), которые зафиксированы в задаче S1.T1. Параллельные задачи эти файлы **не меняют**. Если контракта не хватает, задача объявляет локальный тип в своём модуле и описывает нужное изменение в отчёте.

## Общие соглашения

| Тема | Правило |
| --- | --- |
| Импорты | `model/types.ts` и `app/contracts.ts` не импортируют `obsidian` и не используют DOM, кроме типов `HTMLElement`/`HTMLCanvasElement` в UI-контрактах. Чистые модули (`model/`, `calendar/*-layout`, `wallpaper/*-layout`, `protocol/links`) импортируют только их |
| Время | Текущее время — только `Clock.now()`. Зона устройства — `Clock.timeZone()`. Даты — строки `YYYY-MM-DD`, время — `HH:mm`, плавающая дата-время — `FloatingDateTime { date, time \| null }` |
| ID | ULID через `IdGenerator.next()`. Не зависит от имени файла |
| Ошибки | Пишущие операции возвращают `OpResult<T>` и не бросают исключений для ожидаемых сбоев. `changed: false` — идемпотентный пропуск. Коды — `PlannerErrorCode` |
| Подписки | Все `onChange` возвращают `Unsubscribe`. Владелец подписки обязан вызвать её в `unmount`/`onunload` |
| Пути | `VaultPath` — после `normalizePath()`, без ведущего `/`. Проверку «внутри корня» делает `NoteRepository` |
| Тексты | Только через `t()`/`tPlural()` из `src/i18n`. Строк в контрактах нет: ошибки и проблемы передают ключи i18n (`messageKey`) |

## Модель данных (`src/model/types.ts`)

### Скаляры и перечисления

- `QuadrantKey`: `do` (Важно и срочно), `plan` (Важно), `urgent` (Срочно), `someday` (Когда-нибудь). Порядок — `QUADRANT_KEYS`.
- `RepeatRule`: `none | daily | weekly | monthly | yearly`.
- `RemindOffset`: `none | at | 5m | 15m | 30m | 1h | 1d`.
- `Priority`: `normal | high`.
- `EventColor`: 8 ключей палитры — `blue, red, orange, yellow, green, teal, sky, purple` (порядок и набор как в форме события образца). CSS-цвета определяет UI.
- Константы: `SCHEMA_VERSION = 1`, `MIN_SUPPORTED_SCHEMA`, `MARKER_FILE_NAME`, `DEFAULT_ROOT_FOLDER = 'Планировщик'`, `PLANNER_LAYOUT` (имена папок по ТЗ §3.1, не локализуются), `SYSTEM_FILES`.

### Заметки Планировщика

Каждая сущность хранит две формы свойств:

- `props: TaskProperties | EventProperties | NoteProperties` — форма YAML (snake_case) после разбора. Невалидные значения заменены значениями по умолчанию, а проблема записана в `issues`.
- Нормализованные поля camelCase на самой сущности (`due: FloatingDateTime | null`, `repeatAnchor`, `allDay`, `calendarId` и т. д.) — их используют логика и UI.
- `extra` — неизвестные свойства. Запись идёт через `processFrontMatter`, поэтому они сохраняются автоматически; `extra` нужен для отображения и целостности.

| Тип | Ключевые нормализованные поля |
| --- | --- |
| `Task` | `quadrant`, `due`, `repeat`, `repeatAnchor` (якорь или дата `due`), `remind`, `priority`, `done` (для повторяющейся всегда `false`), `completed`, `completions`, `created`, `archived` |
| `PlannerEvent` | `start`, `end` (для `allDay` — исключительная дата), `allDay`, `tz`, `repeat`, `color`, `icon`, `calendarId` (`null` — «Планировщик»), `url`, `deletedInCalendar` |
| `QuickNote` | `date` |
| `InvalidPlannerNote` | `declaredType`, `frontmatter`, `issues` — заметка с `type`, но без обязательных свойств |

Формы и сервисы обмениваются черновиками: `TaskDraft`/`TaskPatch`, `EventDraft`/`EventPatch`, `NoteDraft`. В `EventDraft` конец события на весь день задаётся **включительно**, сервис переводит его в исключительный при записи.

`CompletionEntry` — строка фильтра «Выполнено»: обычная задача (`instanceDate: null`) или одно повторение.

### Матрица, маркер, схема

- `MatrixConfig.quadrants` — всегда 4 элемента в порядке `QUADRANT_KEYS`, `byKey` — доступ по ключу, `path: null` — файла нет, значения по умолчанию.
- `MarkerProperties`: `root`, `schema`, `vault_id`, `migrating`.
- `SchemaStatus`: `ok`, `needs-migration`, `migrating`, `newer` (только чтение), `invalid` (только чтение), `unknown` (до чтения).

### Целостность

`AttentionItem` — элемент «Требуют внимания»: `kind` (`duplicate-id`, `conflict-copy`, `invalid-properties`, `deleted-in-calendar`, `pending-deletion`, `schema`), все затронутые `paths`, ключ i18n описания. `IntegrityReport.reassignedIds` — новые ID, выданные копиям.

### Настройки (`PlannerSettings`)

| Группа | Поля |
| --- | --- |
| Общие | `rootFolder`, `archive` (`never` или `after-days` + `days`), `reminderTimeForDateOnly` (`09:00`) |
| Календарь | `weekStart` (`auto/monday/sunday`), `timeFormat` (`auto/24h/12h`), `showTasksInIosCalendar` (вкл.), `writeCompletedTasksToCalendar` (выкл.), `defaultEventCalendarId` (`null` — «Планировщик»), `visibleCalendars` (`planner`, `birthdays`, `calendarIds`) |
| Экран блокировки | `wallpaper`: `template`, `palette`, `background` (solid/gradient/image + crop), `profile` (`auto` или id), `shortcutName`, `tasksPerQuadrant`, `weekStart`, `calendarIds` |
| Интерфейс | `ui`: `lastTab`, `tasksLayout`, `tasksListGrouping`, `calendarMode`, `calendarSources` |

`version` — версия формата настроек. Значения по умолчанию и миграции настроек — `src/settings/defaults.ts` (S1.T5); `SettingsStore` сохраняет неизвестные поля data.json.

### Служебные JSON

Внешний формат файлов документирует S2.T1 в `docs/system-json.md`. Внутри плагина используются нормализованные типы:

- `CalendarCacheState`: `missing` / `corrupt` / `unsupported-version` / `ok` (+ `stale`). Отсутствие кэша, повреждение и новая версия различаются.
- `CalendarCacheData`: `range` (покрытие, включительно), `calendars: CachedCalendar[]` (`kind`, `allowsModifications`), `events: CachedCalendarEvent[]` — **каждое повторение отдельной записью**; время уже переведено в зону устройства, плюс `startMs`/`endMs` для событий со временем; `linkedItemId` — id заметки-события из `matrixplanner://item/<id>`.
- `CacheCoverage`: `no-cache` («Подключите компаньон…»), `out-of-range` («…за этот период не загружены»), `covered`.
- `TombstoneRecord { id, kind: 'event', deletedAt }`.
- `CompanionState` и `WallpaperStatusRecord` — статусы обоев по профилю: `savedAt`, `launchedAt`, `confirmedAt`, `failedAt` — разные события, не смешиваются.

### Элементы дня (календарь и обои)

`DayItem` — объединение `TaskDayItem | EventDayItem | ExternalDayItem | NoteDayItem` с общей частью: `key`, `date`, `title`, `allDay`, `startMinute`/`endMinute` (минуты от начала дня), признаки продолжения многодневного события, `color`, `icon`.

- `TaskDayItem.instanceDate` — дата повторения, `projected` — вычисленное будущее повторение, `completed`, `overdue`.
- `ExternalDayItem.readOnly` — открывать в режиме просмотра.
- `DayAgenda` — блоки дня по ТЗ §4.4: `allDay`, `timed`, `notes` и `coverage`.
- `DaySummary` — точки ленты недели (до 3 цветов), серая точка заметок, галочка выполненных.
- `DayItemsInput` → `DayItemsByDate` (`Map` дата → `DayAgenda`, дни без элементов присутствуют). Сборку выполняет чистая функция `DayItemsBuilder` (S2.T3). Обои используют тот же вход и исключают заметки.

### Ссылки

`PlannerLink` — разобранная ссылка `obsidian://planner`: `view`, `new-task` (`quadrant`, `date`), `open` (`id`), `wallpaper-done`, `wallpaper-failed`. В строке запроса действие передаётся параметром `do` (`…&do=new-task`): в `action` Obsidian кладёт имя обработчика (`planner`). Старый `action=` принимается для совместимости.

### Обои

- `WallpaperProfile`: `id` (`iphone-1179x2556` — имя папки), размеры, безопасные зоны `safeTop`/`safeBottom` в долях высоты (0,38 и 0,88).
- `WallpaperLayoutInput` → `WallpaperLayout { width, height, commands: DrawCommand[], overflow }`.
- `DrawCommand`: `rect`, `circle`, `line`, `text`, `icon` в пикселях холста. Раскладка не знает о Canvas: размеры текста получает от `TextMeasurer`, локализованные подписи — через `WallpaperStrings`.

## Сервисы (`src/app/contracts.ts`)

### Инфраструктура

| Интерфейс | Назначение |
| --- | --- |
| `Clock` | `now()`, `timeZone()` |
| `IdGenerator` | `next()` — ULID |
| `TextMeasurer` | `measure(text, font)` → `TextMetrics` |
| `PlatformInfo` | `isMobile`, `isPhone`, `isTablet`, `isIos`, `isAndroid`, `isDesktop` |
| `Notifier` | `show(message)` — обёртка над `Notice` |
| `FormatPreferencesProvider` | язык, вычисленное начало недели (`0`/`1`), 12/24 ч |

### Хранение (S1.T3)

- `WriteGuard` — запрет записи при `newer`/`invalid`/`migrating`. Все пишущие сервисы проверяют его и возвращают `read-only`.
- `MarkerService.ensure()` — идемпотентное создание маркера и папок, `getState()`, `onChange()`.
- `NoteRepository` — все операции с заметками по пути: `create` (коллизии ` (2)`), `updateFrontmatter` (`processFrontMatter`), `readBody`/`updateBody` (`vault.process`, активная заметка — Editor API), `rename`, `move`, `trash` (`fileManager.trashFile`), `ensureFolder`, `listFolder`, `readBinary`/`writeBinary` (`createBinary`/`modifyBinary`). `paths: PlannerPaths` — пути при текущем корне.
- `PlannerNoteParser` — разбор frontmatter (реализация S1.T2 в `model/properties.ts`), внедряется в индекс.
- `NoteIndex` — инкрементальный индекс: `getTasks/getEvents/getNotes/getInvalid/getMatrix`, `getById` (первая по пути), `getAllById` (дубликаты), `getByPath`, `onChange(IndexChange)`, `whenReady()`, `waitFor(path, predicate, timeout)` — ожидание события `changed` после записи, `rebuild()`.
- `SystemJsonStore` — `_system/*.json` только через `vault.adapter`: `read` (`missing`/`corrupt`/`ok`), `update` (перечитать → изменить свои ключи → записать; повреждённый файл не перезаписывается), `write`. Запись `calendar-cache.json` запрещена.
- `WriteQueue.run(key, job)` — последовательные записи по ключу.

### Настройки (S1.T5)

`SettingsStore`: `load()`, `get()`, `update(mutate)`, `onChange(next, previous)`. `SettingsSection` — расширяемая секция экрана настроек (`order`: 0 общие, 10 календарь, 20 экран блокировки, 30 компаньон, 40 данные); этап 2 добавляет секции без правки чужих файлов.

### Задачи (S1.T6)

`TaskService`: `create`, `update` (название меняет имя файла, id сохраняется), `complete(id, instanceDate?)` (повтор уже в `completions` → `changed: false`; несоответствие состояния → `stale`), `uncomplete`, `moveToQuadrant`, `reschedule`, `postponeToTomorrow`, `delete` (корзина), `getCompletions()`.

`ArchiveService`: `runAuto()`, `archive(id)`, `restore(id)`.

### События и заметки (S2.T2)

- `EventService`: `create`, `update` (вся серия), `delete` (сначала tombstone, затем корзина; повторный вызов завершает операцию), `getWritableCalendars()` — «Планировщик» и календари кэша с `allowsModifications`.
- `NoteService`: `create` (возвращает путь — форма открывает заметку в редакторе), `update`, `delete`.

### Календарь и компаньон (S2.T1, S2.T3)

- `CalendarCacheReader` — только чтение: `getState`, `refresh`, `coverage(date)`, `getCalendars`, `onChange`.
- `TombstoneWriter` — `add` (идемпотентно, объединение по id), `list`, `has`.
- `CompanionStore` — `read`, `getState`, `updateWallpaperStatus(profileId, patch)` (меняет только статус обоев, чужие поля сохраняются), `onChange`.
- `DayItemsBuilder` — чистая функция сборки; `DayItemsProvider` — обёртка над индексом, настройками и кэшем для UI и обоев. `getDays(range, DayItemsOptions)`: `includeCompleted`, `forWallpaper`, `calendarIds` (только для обоев: календари черновика вместо `settings.wallpaper.calendarIds`, `null` — как в календаре).

### Целостность (S1.T9)

`IntegrityService`: `check()`, `getLastReport()`, `keepVersion(item, path)`, `onChange`. Ни одно действие не удаляет «лишнюю» версию.

### Обои и протокол (S2.T4–S2.T8)

- `WallpaperLayoutFn(input, measurer)` — чистая раскладка.
- `WallpaperRenderer` — `render(request)` → PNG `ArrayBuffer`, `renderTo(canvas, request)` — предпросмотр (рисунок масштабируется под размер холста, поэтому предпросмотр рисуется в уменьшенный холст), `measurer`, необязательный `releaseResources()` после пакета.
- `WallpaperService` — `resolveProfile`, `renderAll()` (7 дат сегодня…+6 и `lock.png`, очистка своих файлов профиля; `WallpaperRenderResult` с частичными сбоями), `renderPreview`, `getCurrentImagePath`.
- `WallpaperStatusTracker` — состояние баннера `WallpaperBannerState` (`idle`, `dirty`, `rendering`, `saved`, `launched`, `confirmed`, `failed`), `getActionKind()` (`update` на iPhone/iPad, `save` на компьютере и Android), ревизия данных, `run()`, `onWallpaperCallback()`, тексты `describe()` (`BannerDescription`) и `getStatusText()`, `isFresh()` — PNG соответствуют текущей ревизии. Пакет без обновлённого `lock.png` (не удался рендер на сегодня) считается сбоем.
- `ShortcutLauncher.launch(name)` — только по жесту пользователя; защита от повтора.
- `ProtocolHandler.handle(params)` — откладывает обработку до `resolved`. `LinkBuilder` — `build(link)` и `shortcutRunUrl(name)`; все ссылки содержат `vault`.

### Интерфейс (S1.T4 и вкладки)

- `PlannerActions` — единая точка действий для вкладок, меню и команд: `openTaskForm`, `openEventForm`, `openNoteForm` (с подстановкой даты/квадранта), `openAddMenu(context)`, `openNote(path)`, `openItem(id)`, `showTab(tab, { date })`, `isAvailable(feature)` — что подключено на текущем этапе.
- `PlannerViewHost` — то, что вид даёт вкладкам: `actions`, `platform`, `switchTab`, `setAddContext`/`getAddContext` (контекст «+»), `register(cleanup)`.
- `TabController` — `mount(container)`, `unmount()`, необязательные `onShow`, `onHide`, `focus({ date })`. `TabFactory = (host) => TabController`.
- `BannerController`/`BannerFactory` — баннер над панелью вкладок.
- `PlannerViewOptions` — состав вида от сборки: фабрики вкладок (`Partial` — недоступная вкладка показывается как недоступная), баннер, действия, платформа, начальная вкладка.
- `SheetPresenter.open(SheetOptions)` → `SheetHandle` (`setSubmitEnabled`, `setBusy`, `close`) — нижний лист / модальная форма; на iPhone — во весь экран.
- `DatePickerFactory(container, DatePickerOptions)` → `DatePickerHandle`.

### Состав сервисов

`CoreServices` (этап 1) и `PlannerServices extends CoreServices` (этап 2) собираются в `compose-core.ts` и `compose-planner.ts`. Модули получают зависимости через конструктор, а не через плагин.

`composeApp(plugin)` = `composeCore(plugin, overrides, composePlanner)`: ядро строит сервисы и `PlannerActions`, затем вызывает расширение (`CoreContext` → `CoreExtension`) до регистрации вида, команд и вкладки настроек. Расширение подменяет формы события/заметки и `isAvailable`, возвращает вкладки «Календарь» и «Блокировка», баннер и дополнительные зависимости настроек; свои подписки (кэш календаря, компаньон, обработчик ссылок, провайдер элементов дня) регистрирует в `Plugin`. Сервис задач в ядре обёрнут `trackReminderEdits` — время последней правки задачи с напоминанием для баннера настроек «Напоминание будет запланировано…».

## Локализация (`src/i18n`)

- `registerDictionary(language, module, dict)` — модуль регистрирует свои словари `src/i18n/ru/<модуль>.ts` и `src/i18n/en/<модуль>.ts` при импорте. Ключ — `<модуль>.<путь>`, вложенные группы разворачиваются через точку. Повторная регистрация заменяет словарь модуля.
- `t(key, params)` — подстановка `{name}`. `tPlural(key, count)` — формы по `Intl.PluralRules` (`.one/.few/.many/.other`), `{count}` подставляется сам.
- Язык: `getLanguage()` Obsidian, `ru*` → ru, иначе en. Нет ключа → en → ru → сам ключ. `setLanguageOverride()` — для тестов.
- Словарь `common`: вкладки, квадранты, типы элементов, кнопки (`Готово`, `Отмена`…), ошибки по `PlannerErrorCode`.

## Сборка и тесты

- `npm run build` = `tsc --noEmit` (src + tests) → `esbuild.config.mjs production` (CJS, `main.js`, externals `obsidian`, `electron`, `@codemirror/*`, `@lezer/*`, встроенные модули Node) → `scripts/build-styles.mjs` (склейка `styles/*.css` по алфавиту в `styles.css`; без файлов — пустой). `main.js` и `styles.css` — артефакты, не хранятся в git.
- Стили: свой файл `styles/NN-<модуль>.css`, классы с префиксом `mp-`, только переменные темы.
- Тесты: vitest, окружение `node`, `obsidian` → `tests/__mocks__/obsidian.ts`.

### Мок `obsidian`

`createMockApp({ vaultName?, resolved? })` создаёт in-memory приложение. В src-код передавайте `app as unknown as App`.

| Возможность | Как использовать |
| --- | --- |
| Файлы | `app.vault.create/modify/process/createBinary/modifyBinary/read/rename`, `getFileByPath`, `getFolderByPath`; содержимое — `app.vault.contents` |
| Adapter | `app.vault.adapter.exists/read/write/mkdir/remove/list/stat/readBinary/writeBinary` |
| Свойства | `app.fileManager.processFrontMatter` (YAML через пакет `yaml`), `trashFile` → `app.vault.trashed` |
| Кэш метаданных | `getFileCache` отдаёт состояние на момент последнего `flush`; `autoFlush = false` + `flush()` — задержка `changed`; `resolve()` — холодный старт и событие `resolved`; `pendingCount()` |
| Сбой записи | `app.vault.failNextWrite(path)` |
| Workspace | `getLeaf`, `getLeavesOfType`, `revealLeaf`, `getActiveFile`, `activeEditor`, `getActiveViewOfType`; `MarkdownView` с упрощённым `Editor` |
| Plugin | `commands`, `runCommand(id)`, `protocolHandlers`, `registeredViews`, `data` (loadData/saveData), `load()`/`unload()`, `registeredCount` |
| UI | `MockElement` (createDiv/createEl/empty/addClass/setAttr/dispatch/findAllByClass), `Setting` с компонентами (`simulateChange`, `click`), `Menu.lastShown`, `Notice.messages` |
| Платформа и язык | `Platform` (изменяемый объект), `mockState.language` для `getLanguage()`, `resetMockState()` |

Мок не проверяется против `obsidian.d.ts`: `tsc` компилирует src против настоящих типов, а тесты, использующие мок-хелперы, импортируют их из `tests/__mocks__/obsidian` напрямую.

# Matrix planner

[Русский](README.md)

An Obsidian plugin for planning with the Eisenhower matrix: tasks in four quadrants, a calendar with events and quick notes, and lock screen wallpapers that show your week and matrix. All data is stored as plain Markdown notes in your vault, so you can open, edit and sync them like any other note.

The plugin works on Windows, macOS, iPhone, iPad and Android. Since version 0.2 it syncs tasks and events with iOS Calendar through iCloud by itself — no separate app is needed. A companion app for iPhone widgets is in development and is not part of this package.

## Features

- **Tasks.** A 2×2 matrix: “Important and urgent”, “Important”, “Urgent”, “Someday”. Due date and time, repeat (every day, week, month, year), reminder, high priority. Drag tasks between quadrants, postpone to tomorrow, review the **Completed** filter and return tasks to work, and move completed tasks to the archive automatically.
- **Calendar.** Week strip, day list (all day, timed, notes), timeline and month view. The **+** button adds a task, event or note straight to the selected day.
- **Events and quick notes.** An event is a note with a start, end, color, icon and repeat. A quick note is a note with a date that shows up on its calendar day.
- **iOS Calendar sync.** Through iCloud (CalDAV): events in both directions, tasks with a due date to the calendar with reminders, and read-only ICS subscriptions. Works on every platform.
- **Lock screen wallpapers.** “Matrix” and “Calendar” templates, a background (an image from the vault, a solid color or a gradient) and palettes. The plugin saves PNG files for the next 7 days and, on iPhone and iPad, runs a shortcut that sets the wallpaper. The **Get photo** button gives you today’s wallpaper as a photo.
- **Settings tab.** Plugin settings open right in the planner, without going to Obsidian settings.
- **`obsidian://planner` links** to open a tab, create a task or open an item.
- **Integrity check.** Duplicate IDs, conflict copies and broken properties are listed under **Needs attention**.
- Russian and English interface; week start and time format follow your region or can be set manually.

## Installation

The plugin is not published in the community plugin directory yet. Install it with BRAT or manually.

### With BRAT

Works well on iPhone and iPad: you don't need to copy files into the hidden `.obsidian` folder, and updates arrive automatically.

1. Install the **BRAT** plugin from the directory: **Settings → Community plugins → Browse**, search for "BRAT", then select **Install** and **Enable**.
2. Open **Settings → BRAT → Add beta plugin**.
3. Paste the repository URL `https://github.com/asholk/matrix-planner` and select **Add plugin**.
4. Enable **Matrix planner** in **Settings → Community plugins**.

### Manually

1. Download `main.js`, `manifest.json` and `styles.css` from the release (or build them yourself, see [Development](#development)).
2. Create the folder `<vault>/.obsidian/plugins/matrix-planner/` and put the three files in it.
3. Restart Obsidian or reload the plugin list: **Settings → Community plugins → Installed plugins**.
4. Turn on **Matrix planner**.
5. Open the planner with the ribbon icon (**Open planner**) or the **Open tasks** command.

On iPhone and iPad the `.obsidian` folder is hidden in Files. The easiest way is to copy the plugin on a computer and sync the vault, or use a file manager that shows hidden folders.

On first launch the plugin creates the marker note `matrix-planner.md` in the vault root and the `Планировщик/` folder.

## Data in your vault

```text
<vault>/
├── matrix-planner.md              # marker: root, schema, vault_id
└── Планировщик/
    ├── Задачи/                    # tasks, one note per task
    │   └── Архив/YYYY-MM/         # completed tasks (if archiving is on)
    ├── События/                   # events, one note per event
    │   └── Удалённые/             # events deleted in iOS Calendar
    ├── Заметки/                   # quick notes with a date
    ├── Матрица.md                 # quadrant titles, colors and icons
    ├── _system/                   # service JSON: calendar cache, deletion marks
    └── Обои/<device profile>/     # wallpaper PNG files
```

Folder names are fixed and stay in Russian in every language, so all devices find the same files. You can change the root folder in settings. The note name is the item title; items are linked by the `id` property (a ULID), so you can rename and move notes inside the root folder. The plugin keeps unknown properties and note text unchanged.

| Type | Main properties |
| --- | --- |
| Task (`type: task`) | `id`, `quadrant` (`do`, `plan`, `urgent`, `someday`), `due` (`2026-10-11` or `2026-10-11T09:00`), `repeat`, `repeat_anchor`, `remind`, `priority`, `done`, `completed`, `completions`, `created` |
| Event (`type: event`) | `id`, `start`, `end`, `all_day`, `tz`, `repeat`, `color`, `icon`, `calendar_id`, `url` |
| Quick note (`type: note`) | `id`, `date` |

Times in properties are “floating”: they're interpreted in the device time zone. See [docs/contracts.md](docs/contracts.md) for details and [docs/system-json.md](docs/system-json.md) for the service file format (both in Russian).

Sync:

- If you use Obsidian Sync, turn on **Other file types**, otherwise `_system/*.json` won't reach your other devices.
- Exclude the `Обои/` folder from sync: images are large and each device draws its own.
- The plugin doesn't use hidden folders (starting with a dot).

## iOS Calendar sync

The plugin connects to iCloud over CalDAV, the same way Calendar on a Mac or Windows does. Sync works on desktop, iPhone, iPad and Android; it’s enough to turn it on on one device, for example your main computer.

What is synced:

- **Events** — both ways: an event created in the planner appears in iPhone Calendar, and changes made in Calendar come back to the note. If an event was changed in both places, the note wins. A planner event deleted in Calendar is moved to the `События/Удалённые/` folder.
- **Tasks with a due date** — to the calendar to write to (“Planner” by default) with reminders, which iOS shows. You can also write completed tasks — see **Completed tasks in calendar**.
- **Visible calendars** — events from the selected iCloud calendars appear in the planner. They’re stored in `_system/calendar-cache.json`, so they’re also visible on devices where sync is off.
- **ICS subscriptions** — read-only calendars from a `webcal://` or `https://` link.

To connect:

1. Create an app-specific password: open [account.apple.com](https://account.apple.com), sign in, choose **Sign-In and Security → App-Specific Passwords** and create a password, for example “Planner”. Your regular Apple ID password won’t work.
2. In the planner, open the **Settings** tab (or **Settings → Matrix planner**) and find the **iOS Calendar** section.
3. Turn on **Sync**, enter your Apple ID and the app-specific password, then select **Test** next to **Test connection**.
4. Choose the **Calendar to write to** — the plugin can find or create a “Planner” calendar — and the calendars to show.

The password is stored only on this device (in Obsidian’s secret storage on Obsidian 1.11.4 and later, otherwise in the app’s local storage) and never gets into your vault or its sync. Your Apple ID is stored in the plugin settings. Instead of iCloud you can use another CalDAV server.

Sync runs after you change something in the planner, on an interval (15 minutes by default, see **Sync interval**), with the **Sync** button and with the **Sync calendar** command.

## Wallpapers and shortcuts

The **Lock screen** tab shows the current wallpaper and opens the editor. The button at the bottom of every tab:

- on iPhone and iPad — **Update lock screen**: the plugin redraws the wallpaper and runs the “Обои Планировщика” shortcut, which sets it on the lock screen;
- on desktop and Android — **Save wallpaper**: the plugin only saves PNG files to `Планировщик/Обои/<profile>/`.

**Get photo** gives you today’s wallpaper:

- on iPhone, iPad and Android the system share sheet opens — choose **Save image** to put the wallpaper in Photos; if the share sheet isn’t available, the plugin shows the image: touch and hold it → **Save to Photos**;
- on desktop (Windows, macOS) a preview opens with **Save as…**, **Copy**, **Show in folder** and **Open** — move the image to your phone, for example via cloud storage or AirDrop.

Files: `lock-YYYY-MM-DD.png` for each of the next 7 days and `lock.png` for today, so a nightly automation can change the wallpaper for a week without opening Obsidian. To build the shortcut and set up automations, see [docs/shortcuts.md](docs/shortcuts.md) (in Russian). You can set your own shortcut name in **Settings → Matrix planner → Lock screen → Shortcut name**.

Task titles are visible on the wallpaper, including on a locked screen.

## Commands

No hotkeys are assigned by default. You can set them in **Settings → Hotkeys**.

| Command | What it does |
| --- | --- |
| Open tasks | Opens the planner on the **Tasks** tab |
| Open calendar | Opens the **Calendar** tab |
| Open lock screen | Opens the **Lock screen** tab |
| Create task | Opens the task form |
| Create task in “…” quadrant | Task form with the quadrant preselected (one command per quadrant) |
| Create event | Opens the event form |
| Create note | Opens the quick note form |
| Complete task in active note | Marks the task open in the editor as completed |
| Postpone task in active note to tomorrow | Moves the due date of the open task to tomorrow |
| Update lock screen | Redraws the wallpaper and runs the shortcut (or saves PNG files) |
| Sync calendar | Starts sync with iOS Calendar |
| Check data integrity | Looks for problems and lists them under **Needs attention** |

Links (all include `vault=<vault name>`):

- `obsidian://planner?vault=…&view=tasks` (or `calendar`, `lockscreen`);
- `obsidian://planner?vault=…&do=new-task&quadrant=do&date=2026-10-21`;
- `obsidian://planner?vault=…&do=open&id=<ULID>`.

## Settings

Settings open on the planner’s **Settings** tab or in **Settings → Matrix planner** — the content is the same:

- no heading — root folder, moving completed tasks to the archive, reminder time for tasks without time;
- **Calendar** — week start, time format, calendar for new events, visible calendars;
- **iOS Calendar** — sync through iCloud or another CalDAV server, calendars to write to and to show, tasks in calendar, ICS subscriptions;
- **Lock screen** — template, device profile, shortcut name;
- **Companion** — information about the upcoming widgets app;
- **Data** — **Check integrity** and the **Needs attention** list.

## Platforms

| Feature | Windows, macOS | iPhone and iPad | Android |
| --- | --- | --- | --- |
| Tasks, calendar, forms, repeats | Yes | Yes | Yes |
| iOS Calendar sync (iCloud) | Yes | Yes | Yes |
| Task reminders | Shown by iPhone when sync and **Tasks in calendar** are on | Yes, through iOS Calendar | Shown by iPhone when sync and **Tasks in calendar** are on |
| Wallpapers | Save PNG, **Get photo** | Save and set with a shortcut, **Get photo** | Save PNG, **Get photo** |
| Widgets | No | No (companion app in development) | No |

On iPhone with Obsidian 1.11 and later, the planner’s bottom bar sits above Obsidian’s floating navigation bar.

If the vault marker was created by a newer plugin version, the planner is read-only: you can see your data, but changes are blocked until you update the plugin.

## Development

```sh
npm install
npm run build   # type check, build main.js and styles.css
npm run dev     # build and watch for changes
npm test        # vitest tests
npm run lint    # ESLint with eslint-plugin-obsidianmd
```

- Sources are in `src/`, styles in `styles/NN-*.css` (built into `styles.css`), tests in `tests/`, shared JSON fixtures for the plugin and the companion in `fixtures/`.
- The reference vault for acceptance is `tests/fixtures/reference-vault.ts`; the manual test protocol is [docs/acceptance.md](docs/acceptance.md) and the results are in [docs/verification-results.md](docs/verification-results.md).
- Module contracts: [docs/contracts.md](docs/contracts.md).

To try the plugin in your vault, copy `main.js`, `manifest.json` and `styles.css` after `npm run build` to `<vault>/.obsidian/plugins/matrix-planner/` and reload the plugin.

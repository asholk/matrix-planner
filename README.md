# Matrix planner

Плагин Obsidian: задачи по матрице Эйзенхауэра, календарь и обои экрана блокировки. Задачи, события и заметки хранятся как обычные заметки Markdown в хранилище.

> Проект в разработке. Полное описание установки и настройки появится к первому выпуску.

## Разработка

```sh
npm install
npm run build   # проверка типов, сборка main.js и styles.css
npm run dev     # сборка с отслеживанием изменений
npm run test    # тесты vitest
npm run lint    # ESLint с eslint-plugin-obsidianmd
```

- Исходники — `src/`, стили — `styles/NN-*.css` (собираются в `styles.css`).
- Контракты модулей — [docs/contracts.md](docs/contracts.md).

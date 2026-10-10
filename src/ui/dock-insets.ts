/**
 * Перекрытие нижней части вида элементами Obsidian: плавающая панель навигации
 * (Obsidian 1.11+ на телефоне), панель инструментов редактора и т. п. Нижний док вида
 * поднимается на это перекрытие. Расчёт — чистые функции; поиск элементов — `measureBottomOverlap`.
 */

export interface RectLike {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Известные нижние панели мобильного Obsidian. */
export const OBSIDIAN_BOTTOM_BAR_SELECTORS = [
  '.mobile-navbar',
  '.mobile-toolbar',
  '.mobile-tab-switcher-bar',
  '[class*="mobile-navbar"]',
].join(', ');

/** Нижние панели Obsidian в документе (по известным селекторам). */
export function findBottomBars(doc: Document | null | undefined): HTMLElement[] {
  const body = doc?.body;
  if (!body || typeof body.findAll !== 'function') return [];
  return body.findAll(OBSIDIAN_BOTTOM_BAR_SELECTORS);
}

/** Элементы, которые перекрывают вид временно (меню, окна) — их не учитываем. */
const TRANSIENT_SELECTORS = '.modal-container, .menu, .notice-container, .suggestion-container, .popover, .mp-sheet, .mp-task-drag-ghost, .prompt';

/** Доля высоты вида, выше которой элемент не считается нижней панелью. */
const MAX_BAR_SHARE = 0.4;

/**
 * Насколько препятствия заходят на нижнюю часть вида (px, целое, ≥ 0). Учитываются только
 * препятствия, пересекающие вид по горизонтали, ниже его середины и не выше `MAX_BAR_SHARE`.
 */
export function bottomOverlap(view: RectLike, obstacles: readonly RectLike[]): number {
  const height = view.bottom - view.top;
  if (height <= 0) return 0;
  let overlap = 0;
  for (const rect of obstacles) {
    const barHeight = rect.bottom - rect.top;
    if (barHeight <= 0 || barHeight > height * MAX_BAR_SHARE) continue;
    if (rect.right <= view.left || rect.left >= view.right) continue;
    if (rect.top >= view.bottom || rect.bottom <= view.top) continue;
    if (rect.top < view.top + height / 2) continue;
    overlap = Math.max(overlap, view.bottom - rect.top);
  }
  return Math.max(0, Math.ceil(overlap));
}

/** Точки проверки у нижнего края вида: три колонки, шаг по высоте. */
export function probePoints(view: RectLike, depth: number, step: number): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  const width = view.right - view.left;
  if (width <= 0 || view.bottom - view.top <= 0) return points;
  for (const share of [0.25, 0.5, 0.75]) {
    const x = view.left + width * share;
    for (let offset = 2; offset <= depth; offset += step) points.push({ x, y: view.bottom - offset });
  }
  return points;
}

function isVisible(el: Element): boolean {
  const view = el.ownerDocument.defaultView;
  const style = view?.getComputedStyle(el);
  if (!style) return true;
  return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') > 0.05;
}

/** Поднимается от `el` до верхнего предка, который ещё не содержит вид. */
function outermostBeside(el: Element, root: HTMLElement): Element {
  let current = el;
  while (current.parentElement && !current.parentElement.contains(root)) current = current.parentElement;
  return current;
}

/**
 * Перекрытие вида `root` элементами Obsidian: по известным селекторам и пробой точек
 * у нижнего края (`elementFromPoint`) — на случай нового класса панели.
 */
export function measureBottomOverlap(root: HTMLElement, options: { probe: boolean }): number {
  const doc = root.ownerDocument as Document | null | undefined;
  if (!doc) return 0;
  const rect = root.getBoundingClientRect();
  if (rect.height <= 0) return 0;
  const obstacles: RectLike[] = [];
  const seen = new Set<Element>();
  const consider = (el: Element): void => {
    if (seen.has(el) || root.contains(el) || el.contains(root)) return;
    seen.add(el);
    if (el.closest(TRANSIENT_SELECTORS) || !isVisible(el)) return;
    obstacles.push(el.getBoundingClientRect());
  };

  findBottomBars(doc).forEach(consider);

  // Проба точек — только на мобильных: на компьютере у края лежит строка состояния.
  if (options.probe && typeof doc.elementFromPoint === 'function') {
    const depth = Math.min(160, rect.height * MAX_BAR_SHARE);
    for (const point of probePoints(rect, depth, 12)) {
      const hit = doc.elementFromPoint(point.x, point.y);
      if (!hit || root.contains(hit) || hit.contains(root)) continue;
      consider(outermostBeside(hit, root));
    }
  }
  return bottomOverlap(rect, obstacles);
}

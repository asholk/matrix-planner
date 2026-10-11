/**
 * Лист формы (S1.T4): на мобильных — нижний лист (на iPhone по запросу во весь экран),
 * на компьютере — обычное модальное окно. Шапка как на кадре 04:
 * «Закрыть» слева, заголовок по центру, «Готово» справа.
 */

import { Modal, setIcon } from 'obsidian';
import type { App } from 'obsidian';
import type { PlatformInfo, SheetHandle, SheetOptions, SheetPresenter } from '../../app/contracts';
import { registerDictionary, t } from '../../i18n';
import { ruShell } from '../../i18n/ru/shell';
import { enShell } from '../../i18n/en/shell';
import { ruSheetGuard } from '../../i18n/ru/sheet-guard';
import { enSheetGuard } from '../../i18n/en/sheet-guard';
import type { HapticKind } from '../haptics';

registerDictionary('ru', 'shell', ruShell);
registerDictionary('en', 'shell', enShell);
registerDictionary('ru', 'sheetGuard', ruSheetGuard);
registerDictionary('en', 'sheetGuard', enSheetGuard);

/** Расстояние протягивания вниз, после которого лист закрывается. */
const DRAG_CLOSE_PX = 96;

let sheetCounter = 0;

/** Классы окна листа для платформы. */
export function sheetClasses(platform: PlatformInfo, fullScreenOnPhone: boolean): string[] {
  const classes = ['mp-sheet'];
  if (platform.isMobile) classes.push('mp-sheet-bottom');
  if (platform.isPhone && fullScreenOnPhone) classes.push('mp-sheet-full');
  return classes;
}

/**
 * Протягивание листа вниз за «ручку» (только мобильные).
 * Возвращает функцию отключения обработчиков.
 */
export function attachDragToClose(handleEl: HTMLElement, sheetEl: HTMLElement, onClose: () => void): () => void {
  let startY: number | null = null;
  let offset = 0;
  const setOffset = (value: number): void => {
    offset = Math.max(0, value);
    sheetEl.setCssProps({ '--mp-sheet-drag': `${offset}px` });
    sheetEl.toggleClass('is-dragging', startY !== null);
  };
  const down = (evt: PointerEvent): void => {
    if (evt.button !== 0) return;
    startY = evt.clientY;
    handleEl.setPointerCapture?.(evt.pointerId);
    setOffset(0);
  };
  const move = (evt: PointerEvent): void => {
    if (startY === null) return;
    setOffset(evt.clientY - startY);
  };
  const up = (): void => {
    if (startY === null) return;
    startY = null;
    const shouldClose = offset > DRAG_CLOSE_PX;
    setOffset(0);
    if (shouldClose) onClose();
  };
  handleEl.addEventListener('pointerdown', down);
  handleEl.addEventListener('pointermove', move);
  handleEl.addEventListener('pointerup', up);
  handleEl.addEventListener('pointercancel', up);
  return () => {
    handleEl.removeEventListener('pointerdown', down);
    handleEl.removeEventListener('pointermove', move);
    handleEl.removeEventListener('pointerup', up);
    handleEl.removeEventListener('pointercancel', up);
  };
}

// ---------------------------------------------------------------------------
// Защита черновика (доработка 006, §6)
// ---------------------------------------------------------------------------

export interface CloseGuardDeps {
  /** Форма изменена; нет функции — не изменена. */
  isDirty?(): boolean;
  /** «Сбросить изменения?»: `true` — сбросить, `false` — продолжить правку. */
  confirm(): Promise<boolean>;
  /** Закрыть лист без вопроса. */
  close(): void;
  haptic?(kind: HapticKind): void;
}

export interface CloseGuard {
  /** Закрытие пользователем (свайп, крестик, Esc, касание вне листа). `true` — лист закрыт. */
  request(): Promise<boolean>;
  /** Вопрос уже открыт (повторные попытки закрытия игнорируются). */
  isAsking(): boolean;
}

export function createCloseGuard(deps: CloseGuardDeps): CloseGuard {
  let asking = false;
  const dirty = (): boolean => {
    try {
      return deps.isDirty?.() ?? false;
    } catch (error) {
      console.error('[matrix-planner] sheet isDirty failed', error);
      return false;
    }
  };
  return {
    isAsking: () => asking,
    async request() {
      if (asking) return false;
      if (!dirty()) {
        deps.close();
        return true;
      }
      asking = true;
      deps.haptic?.('warning');
      let discard = false;
      try {
        discard = await deps.confirm();
      } catch (error) {
        console.error('[matrix-planner] discard confirm failed', error);
        discard = false;
      } finally {
        asking = false;
      }
      if (discard) deps.close();
      return discard;
    },
  };
}

/** Окно «Сбросить изменения?» (на мобильных — нижний лист с двумя кнопками). */
class DiscardConfirm extends Modal {
  private result = false;

  constructor(
    app: App,
    private readonly platform: PlatformInfo,
    private readonly done: (discard: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { modalEl, contentEl } = this;
    const titleId = `mp-discard-title-${++sheetCounter}`;
    this.containerEl.addClass('mp-sheet-container', 'mp-discard-container');
    modalEl.addClass('mp-discard');
    if (this.platform.isMobile) modalEl.addClass('mp-discard-bottom');
    modalEl.setAttr('role', 'alertdialog');
    modalEl.setAttr('aria-modal', 'true');
    modalEl.setAttr('aria-labelledby', titleId);
    contentEl.addClass('mp-discard-body');
    contentEl.createEl('h2', { cls: 'mp-discard-title', text: t('sheetGuard.title'), attr: { id: titleId } });
    contentEl.createEl('p', { cls: 'mp-discard-desc', text: t('sheetGuard.desc') });
    const actions = contentEl.createDiv({ cls: 'mp-discard-actions' });
    const discard = actions.createEl('button', { cls: 'mp-discard-button mod-warning', text: t('sheetGuard.discard'), attr: { type: 'button' } });
    const keep = actions.createEl('button', { cls: 'mp-discard-button mp-discard-keep', text: t('sheetGuard.keep'), attr: { type: 'button' } });
    discard.addEventListener('click', () => {
      this.result = true;
      this.close();
    });
    keep.addEventListener('click', () => this.close());
    // По умолчанию — безопасный вариант.
    window.setTimeout(() => keep.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
    this.done(this.result);
  }
}

/** Показать «Сбросить изменения?». */
export function confirmDiscard(app: App, platform: PlatformInfo): Promise<boolean> {
  return new Promise((resolve) => new DiscardConfirm(app, platform, resolve).open());
}

class FormSheet extends Modal {
  private submitEl: HTMLButtonElement | null = null;
  private submitEnabled = true;
  private busy = false;
  private closed = false;
  private detachDrag: (() => void) | null = null;
  private readonly guard: CloseGuard;
  /** Ручка для формы и вызывающего: `close()` — без вопроса, `requestClose()` — с вопросом. */
  readonly handle: SheetHandle;

  constructor(
    app: App,
    private readonly platform: PlatformInfo,
    private readonly options: SheetOptions,
    confirm: () => Promise<boolean>,
  ) {
    super(app);
    this.guard = createCloseGuard({
      isDirty: options.isDirty ? () => !this.closed && !this.busy && (options.isDirty?.() ?? false) : undefined,
      confirm,
      close: () => this.forceClose(),
      haptic: (kind) => options.haptic?.(kind),
    });
    this.handle = {
      setSubmitEnabled: (enabled) => this.setSubmitEnabled(enabled),
      setBusy: (busy) => this.setBusy(busy),
      close: () => this.forceClose(),
      submit: () => void this.submit(),
      requestClose: () => this.requestClose(),
    };
  }

  onOpen(): void {
    const { modalEl, contentEl, options } = this;
    const titleId = `mp-sheet-title-${++sheetCounter}`;
    this.containerEl.addClass('mp-sheet-container');
    for (const cls of sheetClasses(this.platform, options.fullScreenOnPhone)) modalEl.addClass(cls);
    if (options.cls) modalEl.addClass(options.cls);
    modalEl.setAttr('role', 'dialog');
    modalEl.setAttr('aria-modal', 'true');
    modalEl.setAttr('aria-labelledby', titleId);

    const header = createDiv({ cls: 'mp-sheet-header' });
    modalEl.insertBefore(header, contentEl);
    if (this.platform.isMobile) {
      const grabber = header.createDiv({ cls: 'mp-sheet-grabber', attr: { 'aria-hidden': 'true' } });
      this.detachDrag = attachDragToClose(grabber, modalEl, () => void this.requestClose());
    }
    const bar = header.createDiv({ cls: 'mp-sheet-bar' });
    const closeBtn = bar.createEl('button', {
      cls: 'mp-icon-button mp-sheet-close',
      attr: { type: 'button', 'aria-label': t('shell.sheet.close'), title: t('shell.sheet.close') },
    });
    setIcon(closeBtn, 'x');
    closeBtn.addEventListener('click', () => void this.requestClose());
    bar.createEl('h2', { cls: 'mp-sheet-title', text: options.title, attr: { id: titleId } });
    if (options.submitLabel !== null) {
      const submit = bar.createEl('button', {
        cls: 'mp-icon-button mp-sheet-submit mod-cta',
        attr: { type: 'button', 'aria-label': options.submitLabel, title: options.submitLabel },
      });
      setIcon(submit, 'check');
      submit.addEventListener('click', () => void this.submit());
      this.submitEl = submit;
    } else if (options.headerAction) {
      const action = options.headerAction;
      modalEl.addClass('mp-sheet-has-action');
      const button = bar.createEl('button', { cls: 'mp-sheet-action', attr: { type: 'button' } });
      setIcon(button.createSpan({ cls: 'mp-sheet-action-icon', attr: { 'aria-hidden': 'true' } }), action.icon);
      button.createSpan({ text: action.label });
      button.addEventListener('click', (evt) => action.onClick(evt));
    } else {
      bar.createDiv({ cls: 'mp-sheet-spacer' });
    }

    contentEl.addClass('mp-sheet-body');
    // Ctrl/Cmd+Enter — «Готово» с клавиатуры.
    this.scope.register(['Mod'], 'Enter', () => {
      void this.submit();
      return false;
    });
    this.syncSubmit();
    try {
      options.render(contentEl, this.handle);
    } catch (error) {
      console.error('[matrix-planner] sheet render failed', error);
      contentEl.createDiv({ cls: 'mp-sheet-error', text: t('common.errors.unknown') });
    }
  }

  onClose(): void {
    this.detachDrag?.();
    this.detachDrag = null;
    this.contentEl.empty();
    if (this.closed) return;
    this.closed = true;
    try {
      this.options.onClose?.();
    } catch (error) {
      console.error('[matrix-planner] sheet onClose failed', error);
    }
  }

  // --- SheetHandle ---

  setSubmitEnabled(enabled: boolean): void {
    this.submitEnabled = enabled;
    this.syncSubmit();
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.modalEl.toggleClass('is-busy', busy);
    this.modalEl.setAttr('aria-busy', busy ? 'true' : 'false');
    this.syncSubmit();
  }

  /**
   * Obsidian закрывает окно через `close()` (Esc, касание вне листа): изменённая форма
   * сначала спрашивает «Сбросить изменения?».
   */
  close(): void {
    if (this.closed) return;
    void this.requestClose();
  }

  requestClose(): Promise<boolean> {
    if (this.closed) return Promise.resolve(true);
    return this.guard.request();
  }

  /** Закрыть без вопроса (после сохранения, удаления). */
  forceClose(): void {
    if (this.closed) return;
    super.close();
  }

  private syncSubmit(): void {
    const submit = this.submitEl;
    if (!submit) return;
    const disabled = !this.submitEnabled || this.busy;
    submit.disabled = disabled;
    submit.setAttr('aria-disabled', disabled ? 'true' : 'false');
    const label = this.busy ? t('shell.sheet.busy') : (this.options.submitLabel ?? t('shell.sheet.submit'));
    submit.setAttr('aria-label', label);
    submit.setAttr('title', label);
  }

  /** «Готово»: повторное нажатие во время сохранения игнорируется. */
  private async submit(): Promise<void> {
    if (this.options.submitLabel === null || this.busy || !this.submitEnabled || this.closed) return;
    this.setBusy(true);
    let ok = false;
    try {
      ok = this.options.onSubmit ? await this.options.onSubmit() : true;
    } catch (error) {
      console.error('[matrix-planner] sheet submit failed', error);
      ok = false;
    } finally {
      if (!this.closed) this.setBusy(false);
    }
    if (ok && !this.closed) this.forceClose();
  }
}

/** Реализация `SheetPresenter` (`CoreServices.sheets`). */
export class FormSheetPresenter implements SheetPresenter {
  constructor(
    private readonly app: App,
    private readonly platform: PlatformInfo,
    /** «Сбросить изменения?» (в тестах — подмена). */
    private readonly confirm: () => Promise<boolean> = () => confirmDiscard(app, platform),
  ) {}

  open(options: SheetOptions): SheetHandle {
    const sheet = new FormSheet(this.app, this.platform, options, this.confirm);
    sheet.open();
    return sheet.handle;
  }
}

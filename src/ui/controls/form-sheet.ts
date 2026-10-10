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

registerDictionary('ru', 'shell', ruShell);
registerDictionary('en', 'shell', enShell);

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

class FormSheet extends Modal implements SheetHandle {
  private submitEl: HTMLButtonElement | null = null;
  private submitEnabled = true;
  private busy = false;
  private closed = false;
  private detachDrag: (() => void) | null = null;

  constructor(
    app: App,
    private readonly platform: PlatformInfo,
    private readonly options: SheetOptions,
  ) {
    super(app);
  }

  onOpen(): void {
    const { modalEl, contentEl, options } = this;
    const titleId = `mp-sheet-title-${++sheetCounter}`;
    this.containerEl.addClass('mp-sheet-container');
    for (const cls of sheetClasses(this.platform, options.fullScreenOnPhone)) modalEl.addClass(cls);
    modalEl.setAttr('role', 'dialog');
    modalEl.setAttr('aria-modal', 'true');
    modalEl.setAttr('aria-labelledby', titleId);

    const header = createDiv({ cls: 'mp-sheet-header' });
    modalEl.insertBefore(header, contentEl);
    if (this.platform.isMobile) {
      const grabber = header.createDiv({ cls: 'mp-sheet-grabber', attr: { 'aria-hidden': 'true' } });
      this.detachDrag = attachDragToClose(grabber, modalEl, () => this.close());
    }
    const bar = header.createDiv({ cls: 'mp-sheet-bar' });
    const closeBtn = bar.createEl('button', {
      cls: 'mp-icon-button mp-sheet-close',
      attr: { type: 'button', 'aria-label': t('shell.sheet.close'), title: t('shell.sheet.close') },
    });
    setIcon(closeBtn, 'x');
    closeBtn.addEventListener('click', () => this.close());
    bar.createEl('h2', { cls: 'mp-sheet-title', text: options.title, attr: { id: titleId } });
    if (options.submitLabel !== null) {
      const submit = bar.createEl('button', {
        cls: 'mp-icon-button mp-sheet-submit mod-cta',
        attr: { type: 'button', 'aria-label': options.submitLabel, title: options.submitLabel },
      });
      setIcon(submit, 'check');
      submit.addEventListener('click', () => void this.submit());
      this.submitEl = submit;
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
      options.render(contentEl, this);
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

  close(): void {
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
    if (ok && !this.closed) this.close();
  }
}

/** Реализация `SheetPresenter` (`CoreServices.sheets`). */
export class FormSheetPresenter implements SheetPresenter {
  constructor(
    private readonly app: App,
    private readonly platform: PlatformInfo,
  ) {}

  open(options: SheetOptions): SheetHandle {
    const sheet = new FormSheet(this.app, this.platform, options);
    sheet.open();
    return sheet;
  }
}

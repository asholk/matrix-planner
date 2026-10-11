import { describe, expect, it } from 'vitest';
import {
  addChecklistItem,
  checklistFromListItems,
  checklistProgress,
  formatChecklistProgress,
  isChecklistComplete,
  parseChecklist,
  removeChecklistItem,
  renameChecklistItem,
  setChecklistItemChecked,
  toggleChecklistItem,
} from '../../src/model/checklist';

const BODY = ['Описание задачи', '', '- [ ] Купить хлеб', '- [x] Позвонить маме', '* [X] Оплатить счёт', '  + [ ] Вложенный пункт', '1. [ ] Нумерованный', 'Обычный текст', '- обычный пункт списка'].join('\n');

describe('model/checklist: разбор', () => {
  it('находит пункты всех видов маркеров, отступы и [X]', () => {
    expect(parseChecklist(BODY)).toEqual([
      { text: 'Купить хлеб', checked: false, line: 2 },
      { text: 'Позвонить маме', checked: true, line: 3 },
      { text: 'Оплатить счёт', checked: true, line: 4 },
      { text: 'Вложенный пункт', checked: false, line: 5 },
      { text: 'Нумерованный', checked: false, line: 6 },
    ]);
  });

  it('пустое тело и тело без пунктов', () => {
    expect(parseChecklist('')).toEqual([]);
    expect(parseChecklist('Текст\n- пункт\n[ ] не список')).toEqual([]);
    expect(checklistProgress(parseChecklist('Текст'))).toBeNull();
  });

  it('пункт без текста и иные знаки выполнения', () => {
    expect(parseChecklist('- [ ]\n- [-] отменён')).toEqual([
      { text: '', checked: false, line: 0 },
      { text: 'отменён', checked: true, line: 1 },
    ]);
  });

  it('пункты в блоках кода не считаются', () => {
    const body = ['- [ ] до', '```md', '- [ ] в коде', '```', '~~~~', '- [x] тоже код', '```', '~~~~', '- [x] после'].join('\n');
    expect(parseChecklist(body).map((i) => i.text)).toEqual(['до', 'после']);
    // Незакрытый блок — до конца тела.
    expect(parseChecklist('- [ ] a\n```\n- [ ] b').map((i) => i.text)).toEqual(['a']);
  });

  it('CRLF: текст без \\r, номера строк те же', () => {
    const items = parseChecklist('Текст\r\n- [ ] один\r\n- [x] два\r\n');
    expect(items).toEqual([
      { text: 'один', checked: false, line: 1 },
      { text: 'два', checked: true, line: 2 },
    ]);
  });

  it('прогресс и подпись', () => {
    const progress = checklistProgress(parseChecklist(BODY));
    expect(progress).toEqual({ done: 2, total: 5 });
    expect(formatChecklistProgress(progress ?? { done: 0, total: 0 })).toBe('2/5');
    expect(isChecklistComplete({ done: 2, total: 5 })).toBe(false);
    expect(isChecklistComplete({ done: 3, total: 3 })).toBe(true);
  });

  it('прогресс из listItems кэша метаданных', () => {
    expect(checklistFromListItems(undefined)).toBeNull();
    expect(checklistFromListItems([{}, {}])).toBeNull();
    expect(checklistFromListItems([{ task: ' ' }, { task: 'x' }, {}, { task: '-' }, { task: ' ' }])).toEqual({ done: 2, total: 4 });
  });
});

describe('model/checklist: правка тела', () => {
  it('переключение меняет только знак в скобках', () => {
    const once = toggleChecklistItem(BODY, 2);
    expect(once.split('\n')[2]).toBe('- [x] Купить хлеб');
    expect(toggleChecklistItem(once, 2)).toBe(BODY);
    expect(toggleChecklistItem(BODY, 4).split('\n')[4]).toBe('* [ ] Оплатить счёт');
    expect(toggleChecklistItem(BODY, 5).split('\n')[5]).toBe('  + [x] Вложенный пункт');
    // Не пункт / вне диапазона — без изменений.
    expect(toggleChecklistItem(BODY, 0)).toBe(BODY);
    expect(toggleChecklistItem(BODY, 99)).toBe(BODY);
  });

  it('явная отметка не трогает уже отмеченный пункт', () => {
    expect(setChecklistItemChecked(BODY, 3, true)).toBe(BODY);
    expect(setChecklistItemChecked(BODY, 3, false).split('\n')[3]).toBe('- [ ] Позвонить маме');
  });

  it('пункт в блоке кода не переключается', () => {
    const body = '```\n- [ ] код\n```';
    expect(toggleChecklistItem(body, 1)).toBe(body);
  });

  it('CRLF сохраняется при переключении, правке и удалении', () => {
    const body = 'Текст\r\n- [ ] один\r\n- [x] два\r\n';
    expect(toggleChecklistItem(body, 1)).toBe('Текст\r\n- [x] один\r\n- [x] два\r\n');
    expect(renameChecklistItem(body, 2, 'три')).toBe('Текст\r\n- [ ] один\r\n- [x] три\r\n');
    expect(removeChecklistItem(body, 1)).toBe('Текст\r\n- [x] два\r\n');
    expect(addChecklistItem(body, 'новый')).toBe('Текст\r\n- [ ] один\r\n- [x] два\r\n- [ ] новый\r\n');
  });

  it('изменение текста сохраняет отступ, маркер и отметку', () => {
    expect(renameChecklistItem(BODY, 5, '  Новый текст  ').split('\n')[5]).toBe('  + [ ] Новый текст');
    expect(renameChecklistItem(BODY, 4, 'Счёт\nпереносом').split('\n')[4]).toBe('* [X] Счёт переносом');
    expect(renameChecklistItem(BODY, 4, '   ')).toBe(BODY);
    expect(renameChecklistItem(BODY, 0, 'x')).toBe(BODY);
  });

  it('удаление строки пункта', () => {
    const lines = BODY.split('\n');
    expect(removeChecklistItem(BODY, 3)).toBe([...lines.slice(0, 3), ...lines.slice(4)].join('\n'));
    // Последняя строка — убирается перевод строки перед ней.
    expect(removeChecklistItem('a\n- [ ] b', 1)).toBe('a');
    expect(removeChecklistItem('- [ ] b', 0)).toBe('');
    expect(removeChecklistItem(BODY, 1)).toBe(BODY);
  });

  it('добавление в конец существующего списка', () => {
    const body = 'Описание\n\n- [ ] один\n- [x] два\n\nПотом текст';
    expect(addChecklistItem(body, 'три')).toBe('Описание\n\n- [ ] один\n- [x] два\n- [ ] три\n\nПотом текст');
    // Маркер и отступ последнего пункта; вложенные строки остаются над новым пунктом.
    expect(addChecklistItem('  * [ ] a\n    подробности\nтекст', 'b')).toBe('  * [ ] a\n    подробности\n  * [ ] b\nтекст');
    // Нумерованный список продолжает нумерацию.
    expect(addChecklistItem('1. [ ] a\n2. [ ] b', 'c')).toBe('1. [ ] a\n2. [ ] b\n3. [ ] c');
  });

  it('без списка — в конец тела через пустую строку', () => {
    expect(addChecklistItem('', 'первый')).toBe('- [ ] первый');
    expect(addChecklistItem('  \n', 'первый')).toBe('- [ ] первый');
    expect(addChecklistItem('Описание', 'первый')).toBe('Описание\n\n- [ ] первый');
    expect(addChecklistItem('Описание\n\n\n', 'первый')).toBe('Описание\n\n- [ ] первый\n');
    expect(addChecklistItem('Описание\r\n', 'первый')).toBe('Описание\r\n\r\n- [ ] первый\r\n');
    // Пункты только в коде — новый список после кода.
    expect(addChecklistItem('```\n- [ ] код\n```', 'a')).toBe('```\n- [ ] код\n```\n\n- [ ] a');
    expect(addChecklistItem('Описание', '   ')).toBe('Описание');
  });
});

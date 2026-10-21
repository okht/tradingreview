import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMoneyInput, normalizeMoneyInput, normalizeMoneyEdit, moneyCaretPosition } from '../src/money-input.js';

test('money input groups thousands while retaining editable decimal precision', () => {
  assert.equal(formatMoneyInput('100000'), '100,000');
  assert.equal(formatMoneyInput('1234567.50'), '1,234,567.50');
  assert.equal(formatMoneyInput('1000.'), '1,000.');
  assert.equal(formatMoneyInput(''), '');
  assert.equal(formatMoneyInput('.5'), '0.5');
});

test('formatted input passes a plain amount to calculations without coercing invalid data', () => {
  assert.equal(normalizeMoneyInput('1,234,567.50'), '1234567.50');
  assert.equal(normalizeMoneyInput('0000012.30'), '12.30');
  for (const bad of ['abc', '1.2.3', '-10', '1e6']) assert.equal(normalizeMoneyInput(bad), null);
});

test('cursor follows the edited digits when separators are inserted', () => {
  assert.equal(moneyCaretPosition('1,000', 4), 5);
  assert.equal(moneyCaretPosition('12,345.00', 3), 4);
  assert.equal(moneyCaretPosition('12,345.00', 6), 7);
  assert.equal(moneyCaretPosition('', 0), 0);
});

function editResult(value, selectionStart) {
  const edit = normalizeMoneyEdit(value, selectionStart);
  if (!edit) return null;
  const formatted = formatMoneyInput(edit.value);
  return { value: edit.value, formatted, caret: moneyCaretPosition(formatted, edit.charactersBeforeCaret) };
}

test('deleting the decimal in 0.50 maps the cursor before the remaining digits', () => {
  // Backspace after the dot produces 0|50 before normalization removes zero.
  const edited = editResult('050', 1);
  assert.deepEqual(edited, { value: '50', formatted: '50', caret: 0 });
  const inserted = edited.formatted.slice(0, edited.caret) + '2' + edited.formatted.slice(edited.caret);
  assert.equal(editResult(inserted, edited.caret + 1).value, '250');
});

test('caret mapping handles edits that normalize to the same value and leading decimal insertion', () => {
  assert.deepEqual(editResult('00.50', 1), { value: '0.50', formatted: '0.50', caret: 0 });
  assert.deepEqual(editResult('.50', 0), { value: '0.50', formatted: '0.50', caret: 0 });
  assert.deepEqual(editResult('.', 1), { value: '0.', formatted: '0.', caret: 2 });
  assert.deepEqual(editResult('1,000', 2), { value: '1000', formatted: '1,000', caret: 1 });
});

test('middle editing keeps the caret with digits through regrouping, pasted zeros and whitespace', () => {
  assert.deepEqual(editResult('1234,567', 4), { value: '1234567', formatted: '1,234,567', caret: 5 });
  assert.deepEqual(editResult('10,000', 2), { value: '10000', formatted: '10,000', caret: 2 });
  assert.deepEqual(editResult('100,00', 4), { value: '10000', formatted: '10,000', caret: 4 });
  assert.deepEqual(editResult('  00012.30  ', 7), { value: '12.30', formatted: '12.30', caret: 2 });
  assert.deepEqual(editResult('', 0), { value: '', formatted: '', caret: 0 });
  assert.equal(editResult('1.2.3', 3), null);
});

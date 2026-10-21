import React, { useLayoutEffect, useReducer, useRef } from 'react';
import { formatMoneyInput, moneyCaretPosition, normalizeMoneyEdit } from './money-input.js';

export default function MoneyInput({ value = '', onChange, ...props }) {
  const input = useRef(null);
  const pendingCaret = useRef(null);
  const [selectionRevision, refreshSelection] = useReducer(revision => revision + 1, 0);
  const formatted = formatMoneyInput(value);
  useLayoutEffect(() => {
    if (pendingCaret.current === null || document.activeElement !== input.current) return;
    const position = moneyCaretPosition(formatted, pendingCaret.current);
    input.current.setSelectionRange(position, position);
    pendingCaret.current = null;
  }, [formatted, selectionRevision]);
  function change(event) {
    const edit = normalizeMoneyEdit(event.target.value, event.target.selectionStart);
    if (edit === null) return;
    pendingCaret.current = edit.charactersBeforeCaret;
    // Leading zeros and separators may normalize to the previous value. Force
    // a selection pass even if the parent's value setter then bails out.
    refreshSelection();
    onChange(edit.value);
  }
  function keyDown(event) {
    const field = event.currentTarget;
    const start = field.selectionStart;
    if (start !== field.selectionEnd) return;
    // Skip formatting separators so backspace/delete still removes a digit.
    if (event.key === 'Backspace' && field.value[start - 1] === ',') field.setSelectionRange(start - 1, start - 1);
    if (event.key === 'Delete' && field.value[start] === ',') field.setSelectionRange(start + 1, start + 1);
  }
  return <input {...props} ref={input} type="text" inputMode="decimal" value={formatted} onChange={change} onKeyDown={keyDown}/>;
}

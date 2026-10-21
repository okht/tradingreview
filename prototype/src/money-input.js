export function normalizeMoneyInput(value) {
  const raw = String(value ?? '').trim().replaceAll(',', '');
  if (!/^\d*(?:\.\d*)?$/.test(raw)) return null;
  return raw.replace(/^0+(?=\d)/, '').replace(/^\./, '0.');
}

export function normalizeMoneyEdit(value, selectionStart) {
  const source = String(value ?? '');
  const normalized = normalizeMoneyInput(source);
  if (normalized === null) return null;
  const trimmed = source.trim();
  const leadingSpace = source.length - source.trimStart().length;
  const cursor = Math.max(0, Math.min(trimmed.length, (selectionStart ?? source.length) - leadingSpace));
  const raw = trimmed.replaceAll(',', '');
  let charactersBeforeCaret = trimmed.slice(0, cursor).replaceAll(',', '').length;
  // Map the caret through the same full-value transformation. A prefix alone
  // cannot tell whether its zero survives when digits follow the caret.
  const removedZeros = raw.match(/^0+(?=\d)/)?.[0].length ?? 0;
  charactersBeforeCaret = Math.max(0, charactersBeforeCaret - removedZeros);
  if (raw.startsWith('.') && charactersBeforeCaret > 0) charactersBeforeCaret += 1;
  return { value: normalized, charactersBeforeCaret };
}

export function formatMoneyInput(value) {
  const raw = normalizeMoneyInput(value);
  if (raw === null) return String(value ?? '');
  const [whole, fraction] = raw.split('.');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction !== undefined ? `.${fraction}` : '');
}

export function moneyCaretPosition(formatted, characters) {
  if (characters <= 0) return 0;
  let count = 0;
  for (let index = 0; index < formatted.length; index += 1) {
    if (formatted[index] !== ',') count += 1;
    if (count === characters) return index + 1;
  }
  return formatted.length;
}

/** Split display-only citation runs without changing the stored model response. */
export function splitCitationRuns(text) {
  const parts = [];
  let cursor = 0;
  for (const match of text.matchAll(/\[\d+\](?:[ \t]*\[\d+\])+/g)) {
    if (match.index > cursor) parts.push({ text: text.slice(cursor, match.index) });
    parts.push({ text: match[0], numbers: [...match[0].matchAll(/\[(\d+)\]/g)].map(item => item[1]) });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  return parts;
}

export function citationReference(refs, number) {
  return refs.find(ref => /^\[(\d+)\]/.exec(ref.label || '')?.[1] === number);
}

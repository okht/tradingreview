/** Keep reversible editor drafts in storage, but omit inactive text from analysis. */
export function activeDecisionNotes(notes = {}) {
  if (!notes || typeof notes !== 'object' || Array.isArray(notes)) return notes;
  return Object.fromEntries(Object.entries(notes).map(([id, note]) => {
    if (!note || typeof note !== 'object' || Array.isArray(note)) return [id, note];
    return [id, {
      ...note,
      ...(note.unknown === true ? { reason: '' } : {}),
      ...(note.noPlan === true ? { plan: '' } : {}),
    }];
  }));
}

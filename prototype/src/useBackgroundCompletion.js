import { useMemo, useState } from 'react';
import { acceptedSuggestionPatch } from './background-preparation-state.js';
import { backgroundCompletion, completionForField } from './background-completion.js';

export default function useBackgroundCompletion({ conversation, trade, conversations, preparation, onPatch }) {
  const [dismissed, setDismissed] = useState({});
  const local = useMemo(() => backgroundCompletion(conversation, trade?.id, conversations), [conversation, trade?.id, conversations]);
  const model = preparation?.suggestions.find(item => item.tradeId === trade?.id);
  const note = conversation.contexts[trade?.id] || {};
  const candidate = field => completionForField(note, model, local, field, dismissed[`${trade?.id}:${field}`]);
  return {
    candidate,
    accept(field) {
      const suggestion = candidate(field);
      if (!suggestion) return false;
      if (suggestion.origin === 'model') return preparation.accept(trade.id, field);
      const patch = acceptedSuggestionPatch(conversation, suggestion, field);
      if (!patch) return false;
      // Changes to confirmed input also invalidate a running model preparation.
      preparation?.cancel();
      onPatch(patch);
      return true;
    },
    dismiss(field) {
      setDismissed(previous => ({ ...previous, [`${trade?.id}:${field}`]: true }));
      preparation?.dismiss(trade.id, field);
    },
  };
}

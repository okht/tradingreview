import { useEffect, useRef, useState } from 'react';
import { hasSessionConfig, runAgent } from './services/api.js';
import { createPreparationController, preparationScopeKey } from './background-preparation-state.js';

export default function useBackgroundPreparation({ conversation, model, readCurrent, commit }) {
  const [, refresh] = useState(0);
  const callbacks = useRef({ readCurrent, commit }); callbacks.current = { readCurrent, commit };
  const controller = useRef(null);
  if (!controller.current) controller.current = createPreparationController({ readCurrent: () => callbacks.current.readCurrent(), commit: (...args) => callbacks.current.commit(...args), run: runAgent, connected: hasSessionConfig, notify: () => refresh(value => value + 1) });
  const scope = preparationScopeKey(conversation, model);
  useEffect(() => { controller.current.activate(); return () => controller.current.dispose(); }, []);
  // Observe every committed render so a queued import starts after React commits it.
  useEffect(() => { controller.current.observe(); });
  return { ...controller.current.get(conversation.id), scope, connected: hasSessionConfig(model), queue: controller.current.queue, queueCurrent: () => controller.current.queue(conversation.id), retry: controller.current.start, cancel: controller.current.cancel, accept: controller.current.accept, dismiss: controller.current.dismiss };
}

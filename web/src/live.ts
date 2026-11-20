import { useEffect } from 'react';
import type { LiveEvent } from './api.ts';

type Handler = (event: LiveEvent) => void;
const handlers = new Set<Handler>();

export function emitLive(event: LiveEvent): void {
  for (const handler of handlers) {
    try {
      handler(event);
    } catch {
      /* a broken listener must not stop the others */
    }
  }
}

/** Subscribe to selected live event types (null = all). */
export function useLive(types: string[] | null, handler: Handler, deps: unknown[] = []): void {
  useEffect(() => {
    const listener: Handler = (event) => {
      if (types && !types.includes(event.type)) return;
      handler(event);
    };
    handlers.add(listener);
    return () => {
      handlers.delete(listener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

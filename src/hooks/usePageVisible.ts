import { useSyncExternalStore } from 'react';

function subscribe(fn: () => void) {
  document.addEventListener('visibilitychange', fn);
  return () => document.removeEventListener('visibilitychange', fn);
}

/** False while the tab / Home Screen app is in the background. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => document.visibilityState === 'visible',
    () => true,
  );
}

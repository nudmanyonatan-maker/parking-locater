// Tiny global toast queue (one visible at a time), rendered by <Toaster/>.

import { useSyncExternalStore } from 'react';

export type ToastTone = 'success' | 'error' | 'info';
export interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

let current: ToastItem | null = null;
let nextId = 1;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

export function toast(message: string, tone: ToastTone = 'success', durationMs = 2600): void {
  current = { id: nextId++, message, tone };
  clearTimeout(timer);
  timer = setTimeout(dismissToast, durationMs);
  emit();
}

export function dismissToast(): void {
  current = null;
  emit();
}

export function useToast(): ToastItem | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current,
    () => null,
  );
}

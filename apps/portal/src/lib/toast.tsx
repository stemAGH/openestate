import { useSyncExternalStore } from 'react';

interface ToastItem {
  id: number;
  message: string;
}

let toasts: ToastItem[] = [];
let nextId = 0;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

function show(message: string) {
  const id = nextId++;
  toasts = [...toasts, { id, message }];
  emit();
  setTimeout(() => dismiss(id), 6000);
}

export const toast = {
  clear: () => { toasts = []; emit(); },
  error: (message: string) => show(message),
};

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return toasts;
}

/** Mount once near the app root. Every failed mutation (see main.tsx's
 * MutationCache onError) renders here — no per-call-site wiring needed. */
export function ToastContainer() {
  const items = useSyncExternalStore(subscribe, getSnapshot);
  if (items.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          role="alert"
          className="flex items-start gap-2 rounded-md bg-red-600 px-4 py-3 text-sm text-white shadow-lg"
        >
          <span className="flex-1">{t.message}</span>
          <button
            type="button"
            onClick={() => dismiss(t.id)}
            className="text-white/80 hover:text-white"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

import type { ReactNode } from 'react';

/** What to show when a list or panel has nothing in it: the message, and optionally the next step. */
export function EmptyState({ message, action }: { message: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-8 text-center text-sm text-fg-2">
      <p>{message}</p>
      {action}
    </div>
  );
}

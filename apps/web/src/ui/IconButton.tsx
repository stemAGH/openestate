import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> {
  /** Required: an icon-only button has no other accessible name. */
  label: string;
  icon: ReactNode;
}

/** An icon-only button: always named, with a 40 px hit area. */
export function IconButton({ label, icon, className = '', type = 'button', ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={`inline-flex h-10 w-10 items-center justify-center rounded-md text-fg-2 hover:bg-surface-muted hover:text-fg ${className}`.trim()}
      {...rest}
    >
      {icon}
    </button>
  );
}

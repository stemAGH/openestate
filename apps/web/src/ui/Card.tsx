import type { HTMLAttributes } from 'react';

/** A bordered surface (e0 elevation). */
export function Card({ className = '', ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`card ${className}`.trim()} {...rest} />;
}

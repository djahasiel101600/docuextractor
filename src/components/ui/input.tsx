import * as React from 'react';
import {cn} from '../../lib/utils';

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({className, type, ...props}, ref) => (
  <input
    ref={ref}
    type={type}
    className={cn(
      'flex h-9 w-full rounded-md border border-neutral-300 bg-white px-3 py-1 text-xs text-neutral-900 shadow-sm outline-none transition-colors placeholder:text-neutral-400 focus-visible:ring-2 focus-visible:ring-neutral-500 disabled:cursor-not-allowed disabled:opacity-50',
      className
    )}
    {...props}
  />
));
Input.displayName = 'Input';

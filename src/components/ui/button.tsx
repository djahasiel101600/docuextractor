import * as React from 'react';
import {Slot} from '@radix-ui/react-slot';
import {cva, type VariantProps} from 'class-variance-authority';
import {cn} from '../../lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-neutral-900 text-white hover:bg-neutral-800',
        secondary: 'border border-neutral-200 bg-neutral-100 text-neutral-800 hover:bg-neutral-200',
        outline: 'border border-neutral-200 bg-white text-neutral-800 hover:bg-neutral-100',
        destructive: 'bg-rose-700 text-white hover:bg-rose-800',
      },
      size: {
        default: 'px-3.5 py-1.5',
        sm: 'px-2.5 py-1',
        icon: 'h-8 w-8',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({asChild = false, className, size, variant, ...props}, ref) => {
    const Component = asChild ? Slot : 'button';
    return (
      <Component
        ref={ref}
        className={cn(buttonVariants({className, size, variant}))}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';

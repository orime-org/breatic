import * as React from 'react';

/** shadcn/ui Progress (stub). */
const Progress = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { value?: number | null; indicatorClassName?: string }>(
  function Progress({ value: _value, indicatorClassName: _indicator, ...props }, ref) {
    return <div ref={ref} {...props} />;
  },
);

export { Progress };

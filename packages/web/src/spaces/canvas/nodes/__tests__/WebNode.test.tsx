import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { WebNode } from '../WebNode';

describe('WebNode', () => {
  it('renders placeholder when no url', () => {
    render(<WebNode data={{ kind: 'web', status: 'idle' }} />);
    expect(screen.getByTestId('node-placeholder')).toBeInTheDocument();
  });

  it('renders a sandboxed iframe with the url when present', () => {
    render(
      <WebNode
        data={{
          kind: 'web',
          url: 'https://example.com',
          status: 'idle',
        }}
      />,
    );
    const f = screen.getByTestId('web-node-iframe') as HTMLIFrameElement;
    expect(f.getAttribute('src')).toBe('https://example.com');
    expect(f.getAttribute('sandbox')).toContain('allow-scripts');
    expect(f.getAttribute('sandbox')).toContain('allow-same-origin');
  });

  it('error status surfaces the error message', () => {
    render(
      <WebNode
        data={{
          kind: 'web',
          status: 'error',
          errorMessage: 'X-Frame-Options blocked the page',
        }}
      />,
    );
    expect(screen.getByTestId('node-content-error')).toHaveTextContent(
      /X-Frame-Options/,
    );
  });
});

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { AudioNode } from '../AudioNode';

describe('AudioNode', () => {
  it('renders placeholder when no url', () => {
    render(<AudioNode data={{ kind: 'audio', status: 'idle' }} />);
    expect(screen.getByTestId('node-placeholder')).toBeInTheDocument();
  });

  it('renders audio element when url is present', () => {
    render(
      <AudioNode
        data={{ kind: 'audio', url: 'https://e.com/a.mp3', status: 'idle' }}
      />,
    );
    expect(
      screen.getByTestId('audio-node-audio').getAttribute('src'),
    ).toBe('https://e.com/a.mp3');
  });

  it('handling status shows skeleton', () => {
    render(<AudioNode data={{ kind: 'audio', status: 'handling' }} />);
    expect(screen.getByTestId('node-content-handling')).toBeInTheDocument();
  });
});

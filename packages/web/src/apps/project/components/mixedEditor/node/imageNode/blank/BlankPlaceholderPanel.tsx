import React from 'react';

/** Default width of the blank placeholder node */
export const blankPlaceholderDefaultWidth = 300;
/** Default height of the blank placeholder node (same as width, square by default) */
export const blankPlaceholderDefaultHeight = 300;

export type BlankPlaceholderPanelProps = {
  /** Whether the node is selected (stroke highlight) */
  selected?: boolean;
};

/**
 * Plain white placeholder preview: no grid, just a white background and border.
 *
 * @param props - {@link BlankPlaceholderPanelProps}
 * @returns React element
 */
export const BlankPlaceholderPanel: React.FC<BlankPlaceholderPanelProps> = ({ selected = false }) => {
  const borderColor = selected ? '#97A0FF' : '#D6D9E5';

  return <div className='h-full w-full overflow-hidden rounded-[2px] border bg-white' style={{ borderColor }} />;
};

import React, { useMemo } from 'react';
import { cn } from '@/utils/classnames';

/** Sprite id: `{dir}-{file-with-hyphens}` → `#icon-{dir}-{file_with_underscores}` */
export type IconName = string;

interface IconProps {
  name: IconName;
  width?: number | string;
  height?: number | string;
  color?: string;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Renders an SVG symbol from the sprite sheet.
 *
 * @param props - Display options (`name` = `dir-file-with-hyphens`)
 * @returns Inline SVG or null when `name` is empty
 * @example
 * ```tsx
 * <Icon name="project-check-icon" width={24} height={24} color="#000" />
 * ```
 */
export const Icon: React.FC<IconProps> = ({
  name,
  width,
  height,
  color,
  className,
  style,
}) => {
  const symbolId = useMemo(() => {
    if (!name) return '';
    const firstDashIndex = name.indexOf('-');
    if (firstDashIndex === -1) {
      console.warn(`Icon: expected "dir-filename" name, missing directory prefix: ${name}`);
      return `#icon-${name}`;
    }
    const dirName = name.substring(0, firstDashIndex);
    const fileName = name.substring(firstDashIndex + 1).replace(/-/g, '_');
    return `#icon-${dirName}-${fileName}`;
  }, [name]);

  const iconStyle = useMemo(() => {
    const styles: React.CSSProperties = {
      ...style,
    };

    if (width !== undefined) {
      styles.width = typeof width === 'number' ? `${width}px` : width;
    }
    if (height !== undefined) {
      styles.height = typeof height === 'number' ? `${height}px` : height;
    }

    if (color) {
      styles.color = color;
      styles.fill = color;
    }

    return styles;
  }, [width, height, color, style]);

  if (!symbolId) {
    console.warn(`Icon: could not resolve name=${name}`);
    return null;
  }

  return (
    <svg
      className={cn('inline-block', className)}
      style={iconStyle}
      aria-hidden='true'
    >
      <use href={symbolId} />
    </svg>
  );
};


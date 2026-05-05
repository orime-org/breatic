import { Icon } from '@/components/base/icon';
import { cn } from '@/utils/classnames';

export type TextEditorIconProps = {
  size?: number;
  className?: string;
};

/**
 * Text editor block chrome — sprites live under `src/assets/svg/textEditor/`.
 * `name` follows {@link Icon}: `textEditor-{filename-with-hyphens}` (file: `block_highlight.svg`).
 */
function TextEditorSpriteIcon({
  name,
  size = 16,
  className,
}: TextEditorIconProps & { name: string }) {
  return <Icon name={name} width={size} height={size} className={cn('shrink-0', className)} />;
}

export function BlockHighlightIcon(props: TextEditorIconProps) {
  return <TextEditorSpriteIcon {...props} name='textEditor-block-highlight' />;
}

export function BlockTaskListIcon(props: TextEditorIconProps) {
  return <TextEditorSpriteIcon {...props} name='textEditor-block-task-list' />;
}

export function BlockIndentAlignIcon(props: TextEditorIconProps) {
  return <TextEditorSpriteIcon {...props} name='textEditor-block-indent-align' />;
}

export function AiSpinnerIcon(props: TextEditorIconProps) {
  return <TextEditorSpriteIcon {...props} name='textEditor-ai-spinner' />;
}

export function AiErrorIcon(props: TextEditorIconProps) {
  return <TextEditorSpriteIcon {...props} name='textEditor-ai-error' />;
}

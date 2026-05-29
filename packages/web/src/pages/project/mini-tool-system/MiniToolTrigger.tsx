import { Button } from '@web/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { getMiniTool } from '@web/pages/project/mini-tool-system/catalog';

interface MiniToolTriggerProps {
  toolId: string;
  onTrigger: (toolId: string) => void;
  disabled?: boolean;
}

/**
 * Single-tool trigger button — used by deep links / keyboard shortcuts /
 * detail panels. The picker popover in the node toolbar uses its own
 * inline list; this component is for one-off "run this tool" affordances.
 */
export function MiniToolTrigger({
  toolId,
  onTrigger,
  disabled,
}: MiniToolTriggerProps) {
  const tool = getMiniTool(toolId);
  if (!tool) {
    return (
      <Button variant='ghost' size='sm' disabled data-testid='mini-tool-unknown'>
        Unknown
      </Button>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant='ghost'
          size='sm'
          disabled={disabled}
          onClick={() => onTrigger(toolId)}
          data-testid={`mini-tool-trigger-${tool.id}`}
        >
          {tool.label}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {tool.source} → {tool.output}
      </TooltipContent>
    </Tooltip>
  );
}

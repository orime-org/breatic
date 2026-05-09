/**
 * BottomToolbar — schema-driven parameter UI that floats at the
 * bottom-center of the canvas viewport when a mini-tool is active
 * (spec mockup `2026-04-27-visual-language/05-canvas-native-tailwind.html`).
 *
 * Reads the active tool from {@link MiniToolContext} and renders a
 * matching control per `ParamConfig.ui`. Apply / Cancel buttons
 * dispatch back through props so the host (the canvas surface) can
 * decide what "Apply" means — F4-framework wires Category B tools
 * to POST `/mini-tools/image`; F4-categoryA wires Category A tools
 * to in-browser canvas manipulation.
 *
 * Three controls (slider / select / toggle) are inlined into this
 * file — they're tiny and always rendered together; splitting them
 * into separate files only adds import noise.
 */
import { Switch as HSwitch } from '@headlessui/react';
import { useMiniTool } from './MiniToolContext';
import type { ParamConfig } from './types';

interface BottomToolbarProps {
  /**
   * Called when the user clicks Apply. Receives the active state
   * so the host has everything needed to dispatch (Category B
   * → POST; Category A → canvas op). Toolbar doesn't auto-clear
   * after Apply — host decides whether to keep the tool open
   * (e.g. for "apply with new params").
   */
  onApply: (state: { nodeId: string; toolId: string; values: Record<string, unknown> }) => void;
}

export function BottomToolbar({ onApply }: BottomToolbarProps) {
  const { active, setValue, clear } = useMiniTool();

  if (!active) return null;
  const { schema, values } = active;

  return (
    <div
      className='absolute bottom-6 left-1/2 -translate-x-1/2 bg-background-default-base border border-border-default-secondary rounded-lg shadow-md px-3.5 py-3 flex items-center gap-4 min-w-[480px] z-10 pointer-events-auto'
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className='text-xs text-text-default-tertiary uppercase tracking-wider font-semibold pr-3 border-r border-border-default-secondary whitespace-nowrap'>
        {schema.title}
      </div>

      {schema.params.length === 0 ? (
        <span className='text-xs text-text-default-tertiary'>No parameters</span>
      ) : (
        <div className='flex items-center gap-4 flex-1'>
          {schema.params.map((p) => (
            <ParamControl
              key={p.id}
              param={p}
              value={values[p.id] ?? p.default}
              onChange={(v) => setValue(p.id, v)}
            />
          ))}
        </div>
      )}

      <div className='flex gap-2 pl-3 border-l border-border-default-secondary'>
        <button
          type='button'
          onClick={clear}
          className='h-[30px] px-3 bg-transparent border border-border-default-secondary rounded-sm text-xs text-text-default-secondary hover:bg-background-default-secondary transition-colors'
        >
          Cancel
        </button>
        <button
          type='button'
          onClick={() =>
            onApply({ nodeId: active.nodeId, toolId: active.toolId, values: active.values })
          }
          className='h-[30px] px-3.5 bg-brand-500 text-white border-0 rounded-sm text-xs font-medium hover:bg-brand-600 transition-colors'
        >
          Apply
        </button>
      </div>
    </div>
  );
}

interface ParamControlProps {
  param: ParamConfig;
  value: unknown;
  onChange: (next: unknown) => void;
}

function ParamControl({ param, value, onChange }: ParamControlProps) {
  if (param.ui === 'slider') {
    return (
      <div className='flex items-center gap-2 min-w-[140px]'>
        <span className='text-[11px] text-text-default-secondary font-mono w-[44px] flex-shrink-0'>
          {param.label}
        </span>
        <input
          type='range'
          min={param.min}
          max={param.max}
          step={param.step ?? 1}
          value={Number(value ?? param.default)}
          onChange={(e) => onChange(Number(e.target.value))}
          className='flex-1 h-1 appearance-none bg-background-default-secondary rounded-full outline-none cursor-pointer'
        />
        <span className='text-[11px] text-text-default-tertiary font-mono w-[32px] text-right'>
          {String(value ?? param.default)}
        </span>
      </div>
    );
  }
  if (param.ui === 'select') {
    return (
      <div className='flex items-center gap-2 min-w-[120px]'>
        <span className='text-[11px] text-text-default-secondary font-mono'>
          {param.label}
        </span>
        <select
          value={String(value ?? param.default)}
          onChange={(e) => onChange(e.target.value)}
          className='h-7 px-2 bg-background-default-secondary border border-border-default-secondary rounded-sm text-xs text-text-default-primary cursor-pointer min-w-[60px] hover:bg-background-default-base-hover transition-colors'
        >
          {param.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </div>
    );
  }
  // toggle
  return (
    <div className='flex items-center gap-2 min-w-[110px]'>
      <span className='text-[11px] text-text-default-secondary font-mono'>{param.label}</span>
      <HSwitch
        checked={Boolean(value)}
        onChange={(checked: boolean) => onChange(checked)}
        className={
          'relative inline-flex w-7 h-4 rounded-full transition-colors flex-shrink-0 ' +
          (Boolean(value) ? 'bg-brand-500' : 'bg-background-default-secondary')
        }
      >
        <span
          className={
            'absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full shadow transition-transform ' +
            (Boolean(value) ? 'translate-x-3' : '')
          }
        />
      </HSwitch>
    </div>
  );
}

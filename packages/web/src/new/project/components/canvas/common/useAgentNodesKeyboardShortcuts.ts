import { useEffect, useRef } from 'react';
import { agentNodeShortcutCodeToType } from './localFlowNodeSpawn';

function isTextInputTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el.closest('[contenteditable="true"]')) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * While `active` is true, key Q/W/E/R (physical keys) select agent palette types `1001`–`1004`.
 * Ignores events when focus is in a form field; ignores modified chords with Ctrl/Meta/Alt.
 *
 * @param active - When false, the listener is not registered
 * @param onSelectType - Called with palette id (e.g. `1001`)
 */
export function useAgentNodesKeyboardShortcuts(active: boolean, onSelectType: (nodeType: string) => void): void {
  const onSelectRef = useRef(onSelectType);
  onSelectRef.current = onSelectType;

  useEffect(() => {
    if (!active) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.repeat) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTextInputTarget(e.target)) return;

      const paletteKind = agentNodeShortcutCodeToType[e.code];
      if (!paletteKind) return;

      e.preventDefault();
      e.stopPropagation();
      onSelectRef.current(paletteKind);
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [active]);
}

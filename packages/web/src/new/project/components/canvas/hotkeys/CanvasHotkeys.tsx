/**
 * Keyboard undo/redo for the local project canvas (no Yjs / Redux).
 * Skips when focus is in an input or contenteditable field.
 */
import { memo, useEffect, useRef, type FC } from 'react';

export interface CanvasHotkeysProps {
  /** When true, shortcuts are ignored. */
  disabled?: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}

const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!target || !(target instanceof HTMLElement)) return false;
  const el = target;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  return el.isContentEditable === true;
};

const CanvasHotkeys: FC<CanvasHotkeysProps> = ({
  disabled = false,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}) => {
  const disabledRef = useRef(disabled);
  const canUndoRef = useRef(canUndo);
  const canRedoRef = useRef(canRedo);
  disabledRef.current = disabled;
  canUndoRef.current = canUndo;
  canRedoRef.current = canRedo;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (disabledRef.current) return;
      if (isTypingTarget(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        if (!canUndoRef.current) return;
        e.preventDefault();
        onUndo();
        return;
      }
      if (key === 'z' && e.shiftKey) {
        if (!canRedoRef.current) return;
        e.preventDefault();
        onRedo();
        return;
      }
      if (key === 'y') {
        if (!canRedoRef.current) return;
        e.preventDefault();
        onRedo();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onUndo, onRedo]);

  return null;
};

export default memo(CanvasHotkeys);

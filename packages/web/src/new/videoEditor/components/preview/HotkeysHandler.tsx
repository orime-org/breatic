import { useEffect, useRef } from 'react';
import KeyController, { type KeyControllerEvent } from 'keycon';
import { useVideoEditorStore } from '@/app/hooks/useVideoEditorStore';
import type { TimelineClip } from '../../types';
import { nanoid } from 'nanoid';
import copy from 'copy-to-clipboard';

interface HotkeysHandlerProps {
  nodeId?: string;
  currentTime: number;
  onPlayPause: () => void;
  onTimeChange: (time: number) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

/* * * duplicateclip （supportmulti-select） */
function copyClipsToClipboard(clips: TimelineClip[]) {
  const jsonString = JSON.stringify(clips);
  // duplicate
  copy(jsonString);
}

/* * * clip（supportmulti-select） */
async function readClipsFromClipboard(): Promise<TimelineClip[] | null> {
  try {
    // comment
    const data = await navigator.clipboard.readText();
    if (!data) return null;
    const parsed = JSON.parse(data);
    // （ clip） （ ）
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return null;
  }
}

/* * * VideoEditor handle * support： * - : playback/ * - Ctrl+C: duplicateselected clip * - Ctrl+V: clip time * - Delete: deleteselected clip * - Ctrl+Z: * - Ctrl+Y / Ctrl+Shift+Z: * - left : 1 sec * - right : 1 sec */
const HotkeysHandler: React.FC<HotkeysHandlerProps> = ({
  nodeId,
  currentTime,
  onPlayPause,
  onTimeChange,
  undo,
  redo,
  canUndo,
  canRedo,
}) => {
  const { clips, selectedClipId, setSelectedClipId, setClips } = useVideoEditorStore();
  const clipboardClipsRef = useRef<TimelineClip[]>([]);

  // use ref
  const stateRef = useRef({
    clips,
    selectedClipId,
    currentTime,
    canUndo,
    canRedo,
    onPlayPause,
    onTimeChange,
    undo,
    redo,
    setSelectedClipId,
    setClips,
  });

  // update ref
  useEffect(() => {
    stateRef.current = {
      clips,
      selectedClipId,
      currentTime,
      canUndo,
      canRedo,
      onPlayPause,
      onTimeChange,
      undo,
      redo,
      setSelectedClipId,
      setClips,
    };
  }, [clips, selectedClipId, currentTime, canUndo, canRedo, onPlayPause, onTimeChange, undo, redo, setSelectedClipId, setClips]);

  // check input
  const isInputElement = (target: EventTarget | null): boolean => {
    if (!target) return false;
    const el = target as HTMLElement;
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true;
  };

  // （use keycon）
  useEffect(() => {
    // create KeyController ，avoid
    const keycon = new KeyController(window);

    // check input
    const checkInput = (e: KeyControllerEvent): boolean => {
      return isInputElement(e.inputEvent.target);
    };

    // ：playback/
    keycon.keydown('space', (e: KeyControllerEvent) => {
      if (checkInput(e)) return;
      e.inputEvent.preventDefault();
      const state = stateRef.current;
      const actualDuration = state.clips.length > 0 ? Math.max(...state.clips.map((c) => c.end)) : 0;
      if (state.currentTime >= actualDuration - 0.1) {
        state.onTimeChange(0);
        state.onPlayPause();
      } else {
        state.onPlayPause();
      }
    });

    // Ctrl+C / Cmd+C：duplicateselected clip （supportmulti-select）
    const copyHandler = (e: KeyControllerEvent) => {
      if (checkInput(e)) return;
      e.inputEvent.preventDefault();
      const state = stateRef.current;
      if (state.selectedClipId.length === 0) return;

      // getall duplicate clips
      const clipsToCopy = state.selectedClipId
        .map((id) => state.clips.find((c) => c.id === id))
        .filter(Boolean) as TimelineClip[];

      if (clipsToCopy.length === 0) return;

      // duplicate ， clip
      copyClipsToClipboard(clipsToCopy);
      // clipboardClipsRef.current = clipsToCopy;
    };
    keycon.keydown(['ctrl', 'c'], copyHandler);
    keycon.keydown(['meta', 'c'], copyHandler);

    // Ctrl+V / Cmd+V： clip time （supportmulti-select）
    const pasteHandler = async (e: KeyControllerEvent) => {
      if (checkInput(e)) return;
      e.inputEvent.preventDefault();
      const state = stateRef.current;

      // （ use ref， ）
      const clipboardClips = clipboardClipsRef.current.length > 0
        ? clipboardClipsRef.current
        : await readClipsFromClipboard();

      if (!clipboardClips || clipboardClips.length === 0) return;

      // calculate clip starttime（used forkeep ）
      const minStartTime = Math.min(...clipboardClips.map((clip) => clip.start));
      // calculatetimeoffset ： clip time
      const timeOffset = state.currentTime - minStartTime;

      // clip
      const pasteCount = clipboardClips.length;

      // create clip time ， track0, 1, 2, ...
      const timestamp = Date.now();
      const newClips: TimelineClip[] = clipboardClips.map((clip, index) => {
        return {
          ...clip,
          id: `clip-${timestamp}-${index}-${nanoid(5)}`,
          start: clip.start + timeOffset,
          end: clip.end + timeOffset,
          trackIndex: index, // clip track0, 1, 2, ...
        };
      });

      // clip track clip ，avoidoverlap
      const updatedExistingClips = state.clips.map((clip) => ({
        ...clip,
        trackIndex: clip.trackIndex + pasteCount,
      }));

      // clip（track0-N）， clip（trackN+）
      const finalClips = [...newClips, ...updatedExistingClips];
      state.setClips(finalClips);
      state.setSelectedClipId(newClips.map((c) => c.id));
    };
    keycon.keydown(['ctrl', 'v'], pasteHandler);
    keycon.keydown(['meta', 'v'], pasteHandler);

    // Delete：deleteselected clip（supportmulti-select）
    keycon.keydown('delete', (e: KeyControllerEvent) => {
      if (checkInput(e)) return;
      e.inputEvent.preventDefault();
      const state = stateRef.current;
      if (state.selectedClipId.length === 0) return;

      const deletedClips = state.clips.filter((c) => state.selectedClipId.includes(c.id));
      // batchdelete： all delete clips
      const remainingClips = state.clips.filter((c) => !state.selectedClipId.includes(c.id));
      state.setClips(remainingClips);

      // calculateremainingasset endtime
      const maxEndTime = remainingClips.length > 0
        ? Math.max(...remainingClips.map((c) => c.end))
        : 0;

      // delete playback exceed endtime， reset longest assetend
      if (state.currentTime > maxEndTime) {
        if (remainingClips.length > 0) {
          // reset longest assetend（ endtime）
          state.onTimeChange(maxEndTime);
        } else {
          // ifnoremainingasset，reset 0
          state.onTimeChange(0);
        }
      }

      // automaticallyselected “ ” remainingclip，keep
      if (remainingClips.length === 0) {
        state.setSelectedClipId([]);
      } else {
        const anchorTime =
          deletedClips.length > 0
            ? Math.min(...deletedClips.map((c) => c.start))
            : state.currentTime;
        const nextClip = [...remainingClips]
          .sort((a, b) => {
            const distA = Math.abs(a.start - anchorTime);
            const distB = Math.abs(b.start - anchorTime);
            if (distA !== distB) return distA - distB;
            if (a.trackIndex !== b.trackIndex) return a.trackIndex - b.trackIndex;
            return a.start - b.start;
          })[0];
        state.setSelectedClipId(nextClip ? [nextClip.id] : []);
      }
    });

    // Ctrl+Z / Cmd+Z：
    const undoHandler = (e: KeyControllerEvent) => {
      if (checkInput(e)) return;
      if (e.shiftKey) return; // Shift+Z ， handle
      e.inputEvent.preventDefault();
      const state = stateRef.current;
      if (state.canUndo) {
        state.undo();
      }
    };
    keycon.keydown(['ctrl', 'z'], undoHandler);
    keycon.keydown(['meta', 'z'], undoHandler);

    // Ctrl+Y / Cmd+Y：
    const redoHandler1 = (e: KeyControllerEvent) => {
      if (checkInput(e)) return;
      e.inputEvent.preventDefault();
      const state = stateRef.current;
      if (state.canRedo) {
        state.redo();
      }
    };
    keycon.keydown(['ctrl', 'y'], redoHandler1);
    keycon.keydown(['meta', 'y'], redoHandler1);

    // Ctrl+Shift+Z / Cmd+Shift+Z：
    const redoHandler2 = (e: KeyControllerEvent) => {
      if (checkInput(e)) return;
      e.inputEvent.preventDefault();
      const state = stateRef.current;
      if (state.canRedo) {
        state.redo();
      }
    };
    keycon.keydown(['ctrl', 'shift', 'z'], redoHandler2);
    keycon.keydown(['meta', 'shift', 'z'], redoHandler2);

    // left ： 1 sec
    keycon.keydown('left', (e: KeyControllerEvent) => {
      if (checkInput(e)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      e.inputEvent.preventDefault();
      const state = stateRef.current;
      const newTime = Math.max(0, state.currentTime - 1);
      state.onTimeChange(newTime);
    });

    // right ： 1 sec
    keycon.keydown('right', (e: KeyControllerEvent) => {
      if (checkInput(e)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      e.inputEvent.preventDefault();
      const state = stateRef.current;
      const actualDuration = state.clips.length > 0 ? Math.max(...state.clips.map((c) => c.end)) : 0;
      const newTime = Math.min(actualDuration, state.currentTime + 1);
      state.onTimeChange(newTime);
    });

    // comment
    return () => {
      keycon.destroy();
    };
  }, []); // comment

  return null;
};

export default HotkeysHandler;


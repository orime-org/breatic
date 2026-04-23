import { useEffect, useRef } from 'react';
import KeyController, { type KeyControllerEvent } from 'keycon';
import { useVideoEditorStore } from '@/hooks/useVideoEditorStore';
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

/**
 * 复制片段到剪贴板（支持多选）
 */
function copyClipsToClipboard(clips: TimelineClip[]) {
  const jsonString = JSON.stringify(clips);
  // 复制到系统剪贴板
  copy(jsonString);
}

/**
 * 从剪贴板读取片段（支持多选）
 */
async function readClipsFromClipboard(): Promise<TimelineClip[] | null> {
  try {
    // 从系统剪贴板读取
    const data = await navigator.clipboard.readText();
    if (!data) return null;
    const parsed = JSON.parse(data);
    // 兼容旧格式（单个 clip）和新格式（数组）
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return null;
  }
}

/**
 * VideoEditor 快捷键处理器
 * 支持：
 * - 空格键: 播放/暂停
 * - Ctrl+C: 复制选中的片段
 * - Ctrl+V: 粘贴片段到当前时间位置
 * - Delete: 删除选中的片段
 * - Ctrl+Z: 撤销
 * - Ctrl+Y / Ctrl+Shift+Z: 重做
 * - 左箭头: 后退 1 秒
 * - 右箭头: 前进 1 秒
 */
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

  // 使用 ref 存储最新的值
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

  // 更新 ref 的值
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

  // 检查是否在输入框中
  const isInputElement = (target: EventTarget | null): boolean => {
    if (!target) return false;
    const el = target as HTMLElement;
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true;
  };

  // 注册快捷键（使用 keycon）
  useEffect(() => {
    // 创建新的 KeyController 实例，避免影响全局实例
    const keycon = new KeyController(window);

    // 检查是否在输入框中
    const checkInput = (e: KeyControllerEvent): boolean => {
      return isInputElement(e.inputEvent.target);
    };

    // 空格键：播放/暂停
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

    // Ctrl+C / Cmd+C：复制选中的片段到剪贴板（支持多选）
    const copyHandler = (e: KeyControllerEvent) => {
      if (checkInput(e)) return;
      e.inputEvent.preventDefault();
      const state = stateRef.current;
      if (state.selectedClipId.length === 0) return;

      // 获取所有要复制的 clips
      const clipsToCopy = state.selectedClipId
        .map((id) => state.clips.find((c) => c.id === id))
        .filter(Boolean) as TimelineClip[];

      if (clipsToCopy.length === 0) return;

      // 只复制数据到剪贴板，不添加任何片段
      copyClipsToClipboard(clipsToCopy);
      // clipboardClipsRef.current = clipsToCopy;
    };
    keycon.keydown(['ctrl', 'c'], copyHandler);
    keycon.keydown(['meta', 'c'], copyHandler);

    // Ctrl+V / Cmd+V：从剪贴板粘贴片段到当前时间位置（支持多选）
    const pasteHandler = async (e: KeyControllerEvent) => {
      if (checkInput(e)) return;
      e.inputEvent.preventDefault();
      const state = stateRef.current;

      // 从剪贴板读取数据（优先使用 ref，否则从系统剪贴板读取）
      const clipboardClips = clipboardClipsRef.current.length > 0
        ? clipboardClipsRef.current
        : await readClipsFromClipboard();

      if (!clipboardClips || clipboardClips.length === 0) return;

      // 计算粘贴片段的最小开始时间（用于保持相对位置）
      const minStartTime = Math.min(...clipboardClips.map((clip) => clip.start));
      // 计算时间偏移量：将片段移动到当前时间位置
      const timeOffset = state.currentTime - minStartTime;

      // 粘贴片段的数量
      const pasteCount = clipboardClips.length;

      // 创建新片段并粘贴到当前时间位置，按顺序放到轨道0, 1, 2, ...
      const timestamp = Date.now();
      const newClips: TimelineClip[] = clipboardClips.map((clip, index) => {
        return {
          ...clip,
          id: `clip-${timestamp}-${index}-${nanoid(5)}`,
          start: clip.start + timeOffset,
          end: clip.end + timeOffset,
          trackIndex: index, // 粘贴的片段放到轨道0, 1, 2, ...
        };
      });

      // 将现有片段的轨道索引都增加粘贴片段的数量，避免重合
      const updatedExistingClips = state.clips.map((clip) => ({
        ...clip,
        trackIndex: clip.trackIndex + pasteCount,
      }));

      // 先添加新片段（轨道0-N），再添加现有片段（轨道N+）
      const finalClips = [...newClips, ...updatedExistingClips];
      state.setClips(finalClips);
      state.setSelectedClipId(newClips.map((c) => c.id));
    };
    keycon.keydown(['ctrl', 'v'], pasteHandler);
    keycon.keydown(['meta', 'v'], pasteHandler);

    // Delete：删除选中的片段（支持多选）
    keycon.keydown('delete', (e: KeyControllerEvent) => {
      if (checkInput(e)) return;
      e.inputEvent.preventDefault();
      const state = stateRef.current;
      if (state.selectedClipId.length === 0) return;

      const deletedClips = state.clips.filter((c) => state.selectedClipId.includes(c.id));
      // 批量删除：直接过滤掉所有要删除的 clips
      const remainingClips = state.clips.filter((c) => !state.selectedClipId.includes(c.id));
      state.setClips(remainingClips);

      // 计算剩余素材的最大结束时间
      const maxEndTime = remainingClips.length > 0
        ? Math.max(...remainingClips.map((c) => c.end))
        : 0;

      // 只有删除后播放头超出了最大结束时间，才重置到最长的素材结尾
      if (state.currentTime > maxEndTime) {
        if (remainingClips.length > 0) {
          // 重置到最长的素材结尾（最大结束时间）
          state.onTimeChange(maxEndTime);
        } else {
          // 如果没有剩余素材，重置到 0
          state.onTimeChange(0);
        }
      }

      // 自动选中一个“最近”的剩余片段，保持连续编辑体验
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

    // Ctrl+Z / Cmd+Z：撤销
    const undoHandler = (e: KeyControllerEvent) => {
      if (checkInput(e)) return;
      if (e.shiftKey) return; // Shift+Z 是重做，这里不处理
      e.inputEvent.preventDefault();
      const state = stateRef.current;
      if (state.canUndo) {
        state.undo();
      }
    };
    keycon.keydown(['ctrl', 'z'], undoHandler);
    keycon.keydown(['meta', 'z'], undoHandler);

    // Ctrl+Y / Cmd+Y：重做
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

    // Ctrl+Shift+Z / Cmd+Shift+Z：重做
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

    // 左箭头：后退 1 秒
    keycon.keydown('left', (e: KeyControllerEvent) => {
      if (checkInput(e)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      e.inputEvent.preventDefault();
      const state = stateRef.current;
      const newTime = Math.max(0, state.currentTime - 1);
      state.onTimeChange(newTime);
    });

    // 右箭头：前进 1 秒
    keycon.keydown('right', (e: KeyControllerEvent) => {
      if (checkInput(e)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      e.inputEvent.preventDefault();
      const state = stateRef.current;
      const actualDuration = state.clips.length > 0 ? Math.max(...state.clips.map((c) => c.end)) : 0;
      const newTime = Math.min(actualDuration, state.currentTime + 1);
      state.onTimeChange(newTime);
    });

    // 清理函数
    return () => {
      keycon.destroy();
    };
  }, []); // 只在挂载时注册一次

  return null;
};

export default HotkeysHandler;


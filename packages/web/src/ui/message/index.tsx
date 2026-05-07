import React, { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/utils/classnames';
import { Icon } from '@/ui/icon';

/** Toast API and portal container */

export type ToastType = 'success' | 'error' | 'warning';

interface ToastItem {
  key: string;
  content: React.ReactNode;
  type: ToastType;
  duration?: number;
  onClose?: () => void;
}

type ToastListener = (messages: ToastItem[]) => void;

class ToastManager {
  private messages: ToastItem[] = [];
  private listeners: Set<ToastListener> = new Set();

  subscribe(listener: ToastListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach((listener) => listener([...this.messages]));
  }

  add(item: ToastItem): void {
    this.messages.push(item);
    this.notify();
  }

  remove(key: string): void {
    const i = this.messages.findIndex((m) => m.key === key);
    if (i > -1) {
      this.messages.splice(i, 1);
      this.notify();
    }
  }

  getMessages(): ToastItem[] {
    return [...this.messages];
  }
}

const toastManager = new ToastManager();
const genKey = () => `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;

/** Imperative toast helpers */
export const message = {
  success: (content: React.ReactNode, duration = 3) =>
    toastManager.add({ key: genKey(), content, type: 'success', duration }),
  error: (content: React.ReactNode, duration = 3) =>
    toastManager.add({ key: genKey(), content, type: 'error', duration }),
  warning: (content: React.ReactNode, duration = 3) =>
    toastManager.add({ key: genKey(), content, type: 'warning', duration }),
};

const TOAST_ICON: Record<ToastType, string> = {
  success: 'base-success',
  error: 'base-error',
  warning: 'base-warning',
};

const TOAST_BG: Record<ToastType, string> = {
  success: 'bg-brand-base',
  error: 'bg-background-error-hover',
  warning: 'bg-background-warning-hover',
};

const ToastItemRow: React.FC<{ item: ToastItem }> = ({ item }) => {
  const [isVisible, setIsVisible] = useState(false);
  const [isExiting, setIsExiting] = useState(false);

  const handleClose = useCallback(() => {
    setIsExiting(true);
    setTimeout(() => {
      toastManager.remove(item.key);
      item.onClose?.();
    }, 200);
  }, [item]);

  useEffect(() => {
    requestAnimationFrame(() => setIsVisible(true));
    if (item.duration != null && item.duration > 0) {
      const t = setTimeout(handleClose, item.duration * 1000);
      return () => clearTimeout(t);
    }
  }, [item.duration, handleClose]);

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-full text-sm text-text-on-button-base shadow-lg shadow-black/15',
        TOAST_BG[item.type],
        isVisible && !isExiting
          ? 'opacity-100 translate-y-0'
          : 'opacity-0 -translate-y-2 pointer-events-none'
      )}
      style={{ padding: '6px 24px 6px 6px' }}
    >
      <Icon name={TOAST_ICON[item.type]} width={20} height={20} />
      <span className='flex-1'>{item.content}</span>
    </div>
  );
};

/** Mount once near app root */
export const MessageContainer: React.FC = () => {
  const [messages, setMessages] = useState<ToastItem[]>([]);

  useEffect(() => {
    const unsub = toastManager.subscribe(setMessages);
    setMessages(toastManager.getMessages());
    return unsub;
  }, []);

  if (messages.length === 0) return null;

  return createPortal(
    <div className='fixed top-4 left-1/2 -translate-x-1/2 z-[3000] flex flex-col gap-3 items-center pointer-events-none'>
      {messages.map((m) => (
        <div key={m.key} className='pointer-events-auto'>
          <ToastItemRow item={m} />
        </div>
      ))}
    </div>,
    document.body
  );
};

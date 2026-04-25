let pendingOrigin: string | symbol | null = null;

export const requestNextYjsWriteOrigin = (origin: string | symbol) => {
  pendingOrigin = origin;
};

export const consumeNextYjsWriteOrigin = (): string | symbol | null => {
  const origin = pendingOrigin;
  pendingOrigin = null;
  return origin;
};


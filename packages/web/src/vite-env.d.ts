/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LOGIN_MODE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

// Web Worker module typings
declare module '*.worker?worker' {
  const WorkerConstructor: {
    new (): Worker;
  };
  export default WorkerConstructor;
}

declare module '*.worker.ts' {
  const WorkerConstructor: {
    new (): Worker;
  };
  export default WorkerConstructor;
}
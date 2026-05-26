/// <reference types="vite/client" />

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

# @breatic/worker

The BullMQ task service. These rules apply when you change anything under `packages/worker/`.

Before changing any step of how a task runs in `handlers/dispatch.ts`, read the AIGC task execution order in [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md#%E4%B8%80%E4%B8%AA-aigc-%E4%BB%BB%E5%8A%A1%E7%9A%84%E6%89%A7%E8%A1%8C%E9%A1%BA%E5%BA%8F%E5%92%8C%E4%B8%8D%E5%BD%92%E8%B7%AF) and locate which step you are in: the same failure is safe before step 4 and costly after it.

### No throw after the vendor has returned

**Once the "vendor has returned" fact is written for a task, any later failure marks the task failed and returns; it never throws.** A throw makes BullMQ rerun the whole task, which calls the vendor again and pays for the same result twice. Before that fact is written, a thrown error is the retry path and a rerun resumes from the provider ticket stored on the task row (a task from before provider, from `task_upstream_steps`) without resubmitting.

Check: does this failure fall before or after the vendor-returned fact is written?

### Waiting on upstream throws StillRunning

**A handler that must wait for an upstream result throws `StillRunning` (`handlers/still-running.ts`); it never polls or sleeps.** The running-task gate throws the same class; `dispatch.ts`, `runTimelineExecution` (`handlers/timeline/web-animation-execution.ts`) for a web-animation execution (create, modify or export), the planned video tool run and analysis handlers (`handlers/mini-tool/run-execution-task.ts`, `run-analysis-task.ts`) and `handlers/video-presentation.ts` answer either by moving the job back to the delayed queue with `moveToDelayed`, which frees the slot and consumes no retry; a planned run or analysis stops waiting once its reporting window (`planReportingEnd`) has closed and ends expired.

### No local media processing

**Worker does not process media locally: container mini-tools hand the job to the ingest Worker, which runs ffmpeg in a container (`handlers/container/run-container-job.ts`; planned video tools, analyses and presentation preparation through `handlers/mini-tool/advance-plan-job.ts` and `handlers/video-presentation.ts`).** `runtime/` (spawn and temp dirs) exists only for the `voice-samples.ts` maintenance entry, which no deployment runs; `breatic/no-ffmpeg-bindings` blocks bindings but not `spawn`, so this rule is what keeps ffmpeg out of task code.

### Failed-job cleanup runs across processes

**Settling a task row nobody finished is driven by `QueueEvents.on('failed')` from core `createQueueEvents('tasks')` (`handlers/failed-job-cleanup.ts`), never by the in-process `worker.on('failed')`, and a job counts as terminally failed by `job.finishedOn`, never by `attemptsMade`.** A crashed worker cannot run its own callback, while every live instance receives the queue event; a stalled job's death sets `finishedOn` without incrementing `attemptsMade`. A planned video tool run ends itself: failed-job cleanup hands it to `recoverPlannedRun` (`handlers/mini-tool/recover-planned-run.ts`), and `handlers/planned-run-sweep.ts` ends a running run, or a pending run past `planned_run_sweep_grace_ms`, whose job has ended or is gone, because a crashed process may never emit the queue event.

### Model runs go through provider

**Every model run is a `@breatic/provider` ticket the worker stores on the task row and hands back on each pickup (`handlers/media-run.ts`); the worker sends our params by our names, and only each upstream's binding in `config/provider/media/` names its fields.** A second mapping in the worker would drift from the bindings, and a call the worker made itself would bypass provider's routing and cost readers.

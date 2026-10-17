# @breatic/worker

The BullMQ task service. These rules apply when you change anything under `packages/worker/`.

Before changing any step of how a task runs in `handlers/dispatch.ts`, read the AIGC task execution order in [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md#%E4%B8%80%E4%B8%AA-aigc-%E4%BB%BB%E5%8A%A1%E7%9A%84%E6%89%A7%E8%A1%8C%E9%A1%BA%E5%BA%8F%E5%92%8C%E4%B8%8D%E5%BD%92%E8%B7%AF) and locate which step you are in: the same failure is safe before step 4 and costly after it.

### No throw after the vendor has returned

**Once the "vendor has returned" fact is written for a task, any later failure marks the task failed and returns; it never throws.** A throw makes BullMQ rerun the whole task, which calls the vendor again and pays for the same result twice. Before that fact is written, a thrown error is the retry path and a rerun resumes from `task_upstream_steps` without resubmitting.

Check: does this failure fall before or after the vendor-returned fact is written?

### Waiting on upstream throws StillRunning

**A handler that must wait for an upstream result throws `StillRunning` (`providers/still-running.ts`); it never polls or sleeps.** The single catch in `dispatch.ts` moves the job back to the delayed queue with `moveToDelayed`, which frees the slot and consumes no retry.

### No local media processing

**Worker does not process media locally: container mini-tools hand the job to the ingest Worker, which runs ffmpeg in a container (`handlers/container/run-container-job.ts`).** `runtime/` (spawn and temp dirs) exists only for the `voice-samples.ts` maintenance entry, which no deployment runs; `breatic/no-ffmpeg-bindings` blocks bindings but not `spawn`, so this rule is what keeps ffmpeg out of task code.

### Failed-job cleanup runs across processes

**Settling a task row nobody finished is driven by `QueueEvents.on('failed')` from core `createQueueEvents('tasks')` (`handlers/failed-job-cleanup.ts`), never by the in-process `worker.on('failed')`, and a job counts as terminally failed by `job.finishedOn`, never by `attemptsMade`.** A crashed worker cannot run its own callback, while every live instance receives the queue event; a stalled job's death sets `finishedOn` without incrementing `attemptsMade`.

### Upstream field names are mapped in one place

**Our parameter names become an endpoint's field names only in `providers/upstream-body.ts`, from each param's `upstream` declaration in the model yaml.** A second mapping would drift from the yaml.

// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { once } from "node:events";
import { closeSync, existsSync, watchFile, unwatchFile, writeFileSync } from "node:fs";

const config = JSON.parse(process.argv[2]);
// A failed test must never leave an unbounded child behind.
const watchdog = setTimeout(() => process.exit(124), 8000);
const original = ' {"frames":2}\n';

/** Wait for the independent test gate, including a release preceding watch. */
async function gate(path) {
  if (existsSync(path)) return;
  await new Promise((resolve) => {
    /** Observe the actual gate file without a kernel filesystem watch. */
    const check = () => {
      if (!existsSync(path)) return;
      unwatchFile(path, check);
      resolve();
    };
    watchFile(path, { interval: 10 }, check);
    check();
  });
}

/** Write with actual pipe backpressure rather than dropping buffered data. */
async function write(stream, bytes) {
  if (!stream.write(bytes)) await once(stream, "drain");
}

/** Write a workload whose completion requires the owner to drain stderr. */
async function flood(tail) {
  for (let index = 0; index < 128; index += 1) await write(process.stderr, Buffer.alloc(65536, 88));
  await write(process.stderr, tail);
}

writeFileSync(config.ready, "ready");
if (config.role === "decoder") {
  if (config.flood) await flood("DECO-END");
  const bytes = Buffer.from(Array.from({ length: config.bytes ?? 24 }, (_, index) => index));
  if (config.holdAt !== undefined) {
    await write(process.stdout, bytes.subarray(0, config.holdAt));
    writeFileSync(config.written, String(config.holdAt));
    await gate(config.release);
    await write(process.stdout, bytes.subarray(config.holdAt));
  } else if (config.chunks) {
    let offset = 0;
    for (const size of config.chunks) {
      await write(process.stdout, bytes.subarray(offset, offset + size));
      offset += size;
    }
  } else {
    await write(process.stdout, bytes);
  }
  if (config.fail) await write(process.stderr, "DEC-FAIL");
  process.exitCode = config.fail ? 7 : 0;
} else {
  if (config.earlyOutput) {
    await write(process.stdout, original);
    writeFileSync(config.outputWritten, "written");
  }
  const parts = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    parts.push(chunk);
    length += chunk.length;
    if (length >= 12) writeFileSync(config.received, String(length));
    if (config.earlyExit) {
      if (config.fail) await write(process.stderr, "PRO-FAIL");
      clearTimeout(watchdog);
      process.exit(config.fail ? 9 : 0);
    }
    if (config.closeInput) {
      // Synchronously close the actual fd before publishing the marker. A
      // scheduled stream.destroy() can still accept the writer's next bytes.
      closeSync(0);
      writeFileSync(config.inputClosed, "closed");
      await gate(config.release);
    }
  }
  writeFileSync(config.input, Buffer.concat(parts));
  if (config.holdResult) {
    writeFileSync(config.waiting, "waiting");
    await gate(config.resultRelease);
  }
  if (config.flood) await flood("PROC-END");
  if (!config.earlyOutput) {
    if (config.splitOutput) {
      await write(process.stdout, "S".repeat(32));
      writeFileSync(config.outputWritten, "written");
      await gate(config.outputRelease);
      await write(process.stdout, "S");
    } else {
      await write(process.stdout, config.output ?? original);
    }
  }
  if (config.holdOutput) await gate(config.resultRelease);
  process.exitCode = config.fail ? 9 : 0;
}
clearTimeout(watchdog);

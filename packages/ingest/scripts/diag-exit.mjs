// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

// Temporary diagnosis for #1448: report how each process ends. Removed before
// the fix merges. `--trace-exit` beside it prints who calls process.exit.
const tag = () => `[diag-exit pid=${process.pid} title=${process.title} t=${process.uptime().toFixed(1)}s]`;
process.on("beforeExit", (code) => process.stderr.write(`${tag()} beforeExit code=${code} exitCode=${process.exitCode}\n`));
process.on("exit", (code) => process.stderr.write(`${tag()} exit code=${code}\n`));
process.on("uncaughtExceptionMonitor", (err, origin) => process.stderr.write(`${tag()} ${origin}: ${err?.stack ?? err}\n`));

// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/** One thing a check found wrong. */
export interface Finding {
  /** Repo-relative path of the offending file. */
  readonly file: string;
  /** 1-based line, when the finding is about a particular line. */
  readonly line?: number;
  /** What is wrong, phrased so the reader knows what to do about it. */
  readonly message: string;
}

/** What a check is handed when it runs. */
export interface CheckContext {
  /** Absolute path of the repository root. */
  readonly repoRoot: string;
  /**
   * Every file the repository is about to consist of, matching the predicate.
   *
   * That is the tracked set plus anything written but not committed yet, and
   * minus anything ignored — build output, dependencies, local scratch. It is
   * deliberately not just the tracked set: a file that exists in the working
   * tree is part of what the next commit contains, and judging only what is
   * committed means a new file reads as clean right up until it lands.
   * Either way there is no per-check exclude list to maintain, and none to
   * drift.
   * @param select Which of the tracked files this check is about.
   * @param label What the selection is, named in the error if it is empty.
   * @returns The matching paths.
   * @throws {Error} If nothing matches. A filter that selects no files is a
   *   broken filter, and reporting "clean" is how these checks have died
   *   before.
   */
  files(select: (path: string) => boolean, label: string): string[];
  /**
   * Every file under a directory git does not track, matching the predicate.
   *
   * For build output, which is the one thing a check may need to read that
   * is deliberately absent from the repository. Separate from `files` so
   * that reaching outside the tracked set is a visible decision rather
   * than something a predicate can do by accident.
   * @param directory Repo-relative directory to walk.
   * @param select Which of the files found this check is about.
   * @param label What the selection is, named in the error if it is empty.
   * @returns The matching repo-relative paths.
   * @throws {Error} If the directory is missing, or nothing matches. A
   *   check whose subject is build output must say "build first", never
   *   report clean because there was nothing to look at.
   */
  walk(
    directory: string,
    select: (path: string) => boolean,
    label: string,
  ): string[];

  /**
   * Every file a text scan can actually read, having opened them to find out.
   *
   * For the checks that go through a file character by character. An
   * extension list alone is not enough to decide this: a binary whose kind
   * nobody listed is read as text and answers with one finding per control
   * byte — measured at 2400 findings for 20 KB of random data, which buries
   * whatever the check was looking for. The extension list stays as the fast
   * path; this opens what survives it and judges the bytes.
   * @param select Which of those files this check is about.
   * @param label What the selection is, named in the error if it is empty.
   * @returns The readable paths.
   * @throws {Error} If nothing is readable, for the same reason `files` does.
   */
  textFiles(select: (path: string) => boolean, label: string): string[];

  /**
   * Reads a tracked file.
   * @param file Repo-relative path.
   * @returns Its contents as UTF-8 text.
   * @throws {Error} If the file cannot be read.
   */
  read(file: string): string;
  /**
   * Whether a path exists, for checks that assert something is in place.
   * @param path Repo-relative path.
   * @returns True when it exists.
   */
  exists(path: string): boolean;
}

/** A repository-wide invariant that is not about one source file's AST. */
export interface Check {
  /** Stable id, used in output and to name the check in CI logs. */
  readonly name: string;
  /** One line on what it enforces, printed when it fails. */
  readonly description: string;
  /**
   * Looks for violations.
   *
   * May be async: some checks delegate to a tool with a promise-based API,
   * and forcing them through a sync shim would only move the await.
   * @param context Access to the repository's files.
   * @returns Everything wrong, empty when clean.
   * @throws {Error} When the check cannot run at all — an unreadable target
   *   or an empty candidate set is a failure, never a pass.
   */
  run(context: CheckContext): Finding[] | Promise<Finding[]>;
}

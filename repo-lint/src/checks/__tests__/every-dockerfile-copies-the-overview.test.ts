// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { describe, expect, it } from "vitest";
import { everyDockerfileCopiesTheOverview } from "#repo-lint/checks/every-dockerfile-copies-the-overview";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

/** What a Dockerfile that carries the overview looks like, in one line. */
const CARRIES = "COPY THIRD-PARTY.md /usr/share/doc/breatic/THIRD-PARTY.md\n";

describe("every-dockerfile-copies-the-overview", () => {
  it("says nothing when every Dockerfile copies the overview in", () => {
    const findings = everyDockerfileCopiesTheOverview.run(
      fakeContext({
        "Dockerfile": `FROM node:22\n${CARRIES}`,
        "Dockerfile.web": `FROM nginx\n${CARRIES}`,
        "packages/ingest/Dockerfile": `FROM alpine\n${CARRIES}`,
      }),
    );

    expect(findings).toHaveLength(0);
  });

  it("reports the Dockerfile that leaves the overview behind", () => {
    const findings = everyDockerfileCopiesTheOverview.run(
      fakeContext({
        "Dockerfile": `FROM node:22\n${CARRIES}`,
        "Dockerfile.web": "FROM nginx\nCOPY dist /usr/share/nginx/html\n",
      }),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("Dockerfile.web");
  });

  it("names the file the image has to carry, so the fix needs no guessing", () => {
    const findings = everyDockerfileCopiesTheOverview.run(
      fakeContext({
        "Dockerfile": "FROM node:22\n",
      }),
    );

    expect(findings[0]?.message).toContain("THIRD-PARTY.md");
  });

  // A COPY carrying flags is the same instruction. `--chown` and `--chmod` are
  // the ones this repository would reach for; the pattern takes any of them.
  it("accepts a COPY that carries flags", () => {
    const findings = everyDockerfileCopiesTheOverview.run(
      fakeContext({
        "Dockerfile": "FROM node:22\nCOPY --chown=node:node THIRD-PARTY.md /app/THIRD-PARTY.md\n",
      }),
    );

    expect(findings).toHaveLength(0);
  });

  // Lifting it out of an earlier stage still puts it in the image that ships.
  it("accepts a COPY from a build stage", () => {
    const findings = everyDockerfileCopiesTheOverview.run(
      fakeContext({
        "Dockerfile": "FROM node:22 AS build\nFROM node:22\nCOPY --from=build /src/THIRD-PARTY.md /app/THIRD-PARTY.md\n",
      }),
    );

    expect(findings).toHaveLength(0);
  });

  // The word appears in prose in all three of this repository's Dockerfiles,
  // so a check that reads a mention as the instruction reports every one of
  // them as already done. What keeps them apart is the line-start anchor: a
  // Dockerfile comment is a whole line, and `#` is not `COPY`.
  it("does not take a mention in a comment for the instruction", () => {
    const findings = everyDockerfileCopiesTheOverview.run(
      fakeContext({
        "Dockerfile": "FROM node:22\n# COPY THIRD-PARTY.md — the pin THIRD-PARTY.md names\n",
      }),
    );

    expect(findings).toHaveLength(1);
  });

  // `THIRD-PARTY.md.bak` and friends are not the file the notice asks for.
  it("does not take a longer filename that starts the same way", () => {
    const findings = everyDockerfileCopiesTheOverview.run(
      fakeContext({
        "Dockerfile": "FROM node:22\nCOPY THIRD-PARTY.md.bak /app/\n",
      }),
    );

    expect(findings).toHaveLength(1);
  });

  // The whole point is that a Dockerfile added later is covered without anyone
  // remembering to add it to a list.
  it("covers a Dockerfile nobody has told it about", () => {
    const findings = everyDockerfileCopiesTheOverview.run(
      fakeContext({
        "Dockerfile": `FROM node:22\n${CARRIES}`,
        "packages/somewhere-new/Dockerfile": "FROM alpine\n",
      }),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("packages/somewhere-new/Dockerfile");
  });
});

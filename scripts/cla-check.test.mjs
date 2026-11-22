// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  ALLOWLIST,
  acceptanceRecord,
  checkRunOutput,
  currentVersion,
  isAcceptance,
  isMaintainerRecheck,
  judgePullRequest,
  peopleOf,
  signRequestComment,
  collectCompare,
} from './cla-check.mjs';

const versions = JSON.parse(readFileSync(new URL('../docs/legal/cla/versions.json', import.meta.url), 'utf8'));
const V2 = currentVersion(versions);

// The SHA-256 of the fixed v2 text. Changing the text means publishing a new
// version, so this constant is meant to be edited only together with one.
const PINNED_V2_SHA256 = 'dee9944afe77ca3d68a154f73d5c0cbc79a145ad379fd89c4ceef4c5a7208fde';

const MAINTAINER = { id: ALLOWLIST[0].id, login: ALLOWLIST[0].login, email: null };
const ALICE = { id: 1001, login: 'alice', email: null };
const BOB = { id: 1002, login: 'bob', email: null };

/**
 * Builds a pull request as the check sees it.
 * @param {object} overrides Fields to change.
 * @returns {object} The pull request.
 */
function pr(overrides = {}) {
  return { number: 7, url: 'https://github.com/o/r/pull/7', createdAt: '2026-12-10T00:00:00Z', headSha: 'h1', opener: ALICE, ...overrides };
}

/**
 * Builds a v2 acceptance record.
 * @param {object} person The signer.
 * @param {object} overrides Fields to change.
 * @returns {object} The record.
 */
function signed(person, overrides = {}) {
  return { id: person.id, login: person.login, version: V2.id, sha256: V2.sha256, pullRequest: 7, acceptedAt: '2026-12-10T01:00:00Z', ...overrides };
}

/**
 * Judges a PR with empty records unless given.
 * @param {object} input Pull request, people and records.
 * @returns {object} The verdict.
 */
function judge({ pull = pr(), people = [ALICE], signatures = [], reviewRequired = [], reviews = [] } = {}) {
  return judgePullRequest({ pull, people, signatures, reviewRequired, reviews, version: V2 });
}

test('the fixed v2 text matches the version map, the pinned hash and the root CLA.md', () => {
  const fixed = readFileSync(new URL('../docs/legal/cla/v2/CLA.md', import.meta.url));
  const sha = createHash('sha256').update(fixed).digest('hex');
  assert.equal(sha, V2.sha256);
  assert.equal(sha, PINNED_V2_SHA256);
  assert.deepEqual(readFileSync(new URL('../CLA.md', import.meta.url)), fixed);
  assert.equal(versions.current, 'Breatic-CLA-2.0');
});

test('case 1: an account that never accepted v2 fails, and the request links the fixed text and the sentence', () => {
  const verdict = judge();
  assert.equal(verdict.ok, false);
  const comment = signRequestComment(verdict, V2, 'o/r');
  assert.match(comment, new RegExp(V2.commit));
  assert.ok(comment.includes(V2.phrase));
});

test('case 2: only the exact v2 sentence is an acceptance; the old sentence and extra words are not', () => {
  assert.equal(isAcceptance(`  ${V2.phrase.toUpperCase()} \n`, V2), true);
  assert.equal(isAcceptance('I have read the CLA Document and I hereby sign the CLA', V2), false);
  assert.equal(isAcceptance(`${V2.phrase} Thanks!`, V2), false);
});

test('case 3: accepting in the pull request records version, comment, time, head and own commits, then passes', () => {
  const record = acceptanceRecord({
    signer: ALICE,
    comment: { id: 55, url: 'https://github.com/o/r/pull/7#issuecomment-55', body: V2.phrase, createdAt: '2026-12-10T01:00:00Z' },
    pull: pr(),
    commits: [{ sha: 'c1', author: ALICE }, { sha: 'c2', author: BOB }],
    version: V2,
    repository: 'o/r',
  });
  assert.equal(record.version, V2.id);
  assert.equal(record.sha256, V2.sha256);
  assert.equal(record.headSha, 'h1');
  assert.deepEqual(record.commits, ['c1']);
  assert.equal(record.commentBody, V2.phrase);
  assert.equal(record.pullRequest, 7);
  assert.equal(judge({ signatures: [record] }).ok, true);
});

test('case 4 and 4b: an earlier acceptance covers later pull requests, and accepting again elsewhere keeps the first one covered', () => {
  const inA = signed(ALICE, { pullRequest: 3, acceptedAt: '2026-12-01T00:00:00Z' });
  const inB = signed(ALICE, { pullRequest: 9, acceptedAt: '2026-12-20T00:00:00Z' });
  assert.equal(judge({ signatures: [inA] }).ok, true);
  assert.equal(judge({ pull: pr({ number: 3, createdAt: '2026-11-30T00:00:00Z' }), signatures: [inA, inB] }).ok, true);
});

test('case 5: an employee with a personal acceptance passes, and the output says corporate rights were not verified', () => {
  const verdict = judge({ signatures: [signed(ALICE)] });
  assert.equal(verdict.ok, true);
  assert.match(checkRunOutput(verdict, V2).summary, /corporate rights were not verified/i);
  const listed = judge({ signatures: [signed(ALICE)], reviewRequired: [{ id: ALICE.id, reason: 'corporate' }] });
  assert.equal(listed.ok, false);
});

test('case 6: an acceptance in an older pull request covers that pull request only, not one opened before it elsewhere', () => {
  const inOld = signed(ALICE, { pullRequest: 4, acceptedAt: '2026-12-15T00:00:00Z' });
  assert.equal(judge({ pull: pr({ number: 4, createdAt: '2026-11-16T00:00:00Z' }), signatures: [inOld] }).ok, true);
  assert.equal(judge({ pull: pr({ number: 5, createdAt: '2026-11-20T00:00:00Z' }), signatures: [inOld] }).ok, false);
});

test('case 7 and 7b: a stop-coverage notice needs a maintainer review for the current head, and a new push needs another', () => {
  const required = [{ id: ALICE.id, reason: 'notice' }];
  assert.equal(judge({ signatures: [signed(ALICE)], reviewRequired: required }).ok, false);
  const review = { pullRequest: 7, headSha: 'h1', identity: { id: ALICE.id } };
  assert.equal(judge({ signatures: [signed(ALICE)], reviewRequired: required, reviews: [review] }).ok, true);
  assert.equal(judge({ pull: pr({ headSha: 'h2' }), signatures: [signed(ALICE)], reviewRequired: required, reviews: [review] }).ok, false);
});

test('case 8 and 9: a corporate account fails until a maintainer records a review for this head', () => {
  const required = [{ id: ALICE.id, reason: 'corporate' }];
  assert.equal(judge({ signatures: [signed(ALICE)], reviewRequired: required }).ok, false);
  const review = { pullRequest: 7, headSha: 'h1', identity: { id: ALICE.id } };
  assert.equal(judge({ signatures: [signed(ALICE)], reviewRequired: required, reviews: [review] }).ok, true);
});

test('case 10: v1 signatures are never read as v2 acceptances', () => {
  const v1 = { id: ALICE.id, login: 'alice', version: 'Breatic-CLA-1.0', sha256: versions.versions[0].sha256, pullRequest: 7, acceptedAt: '2026-12-10T01:00:00Z' };
  assert.equal(judge({ signatures: [v1] }).ok, false);
});

test('case 11: a record whose text hash differs from the current version is not an acceptance', () => {
  assert.equal(judge({ signatures: [signed(ALICE, { sha256: '0'.repeat(64) })] }).ok, false);
});

test('case 14: an outsider cannot pass by authoring commits as an allowlisted account', () => {
  const verdict = judge({ pull: pr({ opener: BOB }), people: [BOB, MAINTAINER], signatures: [signed(BOB)] });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.people.find((p) => p.identity.id === MAINTAINER.id).ok, false);
});

test('case 15: a maintainer commit inside an external pull request passes once a maintainer records a review for this head', () => {
  const people = [ALICE, MAINTAINER];
  const review = { pullRequest: 7, headSha: 'h1', identity: { id: MAINTAINER.id } };
  assert.equal(judge({ people, signatures: [signed(ALICE)] }).ok, false);
  assert.equal(judge({ people, signatures: [signed(ALICE)], reviews: [review] }).ok, true);
});

test('a pull request opened by an allowlisted account passes for allowlisted authors', () => {
  assert.equal(judge({ pull: pr({ opener: MAINTAINER }), people: [MAINTAINER] }).ok, true);
});

test('case 16: an author with no account fails until a maintainer records a review by email', () => {
  const ghost = { id: null, login: null, email: 'openclaw@M3.local' };
  const people = [MAINTAINER, ghost];
  const pull = pr({ opener: MAINTAINER });
  assert.equal(judge({ pull, people }).ok, false);
  const review = { pullRequest: 7, headSha: 'h1', identity: { email: 'openclaw@M3.local' } };
  assert.equal(judge({ pull, people, reviews: [review] }).ok, true);
});

test('case 17: the commit list is collected across pages and a short list is an error', () => {
  const page = (n) => Array.from({ length: n }, (_, i) => ({ sha: `s${i}`, author: { id: 1, login: 'a' }, commit: { author: { email: 'a@x' }, message: 'm' } }));
  assert.equal(collectCompare([{ total_commits: 254, commits: page(100) }, { total_commits: 254, commits: page(100) }, { total_commits: 254, commits: page(54) }]).length, 254);
  assert.throws(() => collectCompare([{ total_commits: 254, commits: page(100) }]), /incomplete/i);
});

test('people are the opener, each commit author and each Co-authored-by trailer', () => {
  const commits = [
    { sha: 'c1', author: { id: 1002, login: 'bob' }, commit: { author: { email: 'bob@x' }, message: 'm\n\nCo-authored-by: Carol <7+carol@users.noreply.github.com>\nCo-authored-by: Dan <dan@example.com>' } },
    { sha: 'c2', author: null, commit: { author: { email: 'ghost@x' }, message: 'm' } },
  ];
  const people = peopleOf({ opener: ALICE, commits });
  assert.deepEqual(people.map((p) => p.id ?? p.email), [1001, 1002, 7, 'dan@example.com', 'ghost@x']);
});

test('case 19: after a notice, a maintainer-set restart time lets later pull requests pass on a later acceptance', () => {
  const required = [{ id: ALICE.id, reason: 'notice', coverageRestartAt: '2026-12-05T00:00:00Z' }];
  const again = signed(ALICE, { pullRequest: 6, acceptedAt: '2026-12-06T00:00:00Z' });
  assert.equal(judge({ signatures: [again], reviewRequired: required }).ok, true);
  assert.equal(judge({ pull: pr({ createdAt: '2026-12-04T00:00:00Z' }), signatures: [again], reviewRequired: required }).ok, false);
});

test('only a maintainer comment of "recheck" re-judges', () => {
  assert.equal(isMaintainerRecheck({ body: ' recheck ', author_association: 'MEMBER' }), true);
  assert.equal(isMaintainerRecheck({ body: 'recheck', author_association: 'CONTRIBUTOR' }), false);
  assert.equal(isMaintainerRecheck({ body: 'please recheck', author_association: 'OWNER' }), false);
});

test('the check output names each person and why they passed or not', () => {
  const verdict = judge({ people: [ALICE, BOB], signatures: [signed(ALICE)] });
  const { summary, conclusion } = checkRunOutput(verdict, V2);
  assert.equal(conclusion, 'failure');
  assert.match(summary, /alice/);
  assert.match(summary, /bob/);
});

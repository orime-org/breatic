// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0
/**
 * The CLA check on pull requests: who must have accepted the current CLA, who
 * has, and what a maintainer still has to review.
 *
 * Run by `.github/workflows/cla.yml` on `pull_request_target` and on PR
 * comments, from the base branch: it reads the PR through the GitHub API and
 * never checks out or runs the PR's code. Records live on the unprotected
 * `cla-signatures` branch:
 * - `signatures/v2/cla.json`, acceptances this script appends;
 * - `signatures/v2/review-required.json`, accounts a maintainer must review
 *   (corporate contributors, stop-coverage notices), written by maintainers
 *   and never deleted;
 * - `signatures/v2/reviews.json`, a maintainer's clearance of one identity for
 *   one PR head, written by maintainers.
 * Anything this script cannot decide fails and waits for such a clearance.
 *
 * Shapes maintainers write (numbers are numbers, times are ISO 8601 instants):
 *   review-required.json  {"accounts": [{"id": 1001, "login": "alice", "reason": "corporate" | "notice",
 *                          "recordedAt": "...", "coverageRestartAt": "..." (optional)}]}
 *   reviews.json          {"reviews": [{"pullRequest": 7, "headSha": "<full 40-character sha>",
 *                          "identity": {"id": 1001} | {"email": "a@example.com"}, "reason": "...",
 *                          "reviewer": "...", "reviewedAt": "..."}]}
 * The check output prints the reviews.json entry for each person still waiting.
 *
 * The required check `CLA signed` (GitHub Actions, app 15368) is written here
 * through the Checks API, updated in place when one already exists on the head.
 */
import { readFileSync } from 'node:fs';

/** Accounts of Orime, Inc. that open and author PRs without a CLA. */
export const ALLOWLIST = [
  { login: 'ubiquition', id: 44453739 },
  { login: 'recombyn', id: 51704449 },
];

/** The app the required check is bound to on main: GitHub Actions. */
const ACTIONS_APP_ID = 15368;
const CHECK_NAME = 'CLA signed';
const RECORDS_BRANCH = 'cla-signatures';
const COMMENT_MARKER = '<!-- breatic-cla-check -->';
const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/**
 * The version contributors accept now.
 * @param {{current: string, versions: object[]}} versions The version map.
 * @returns {object} The current version's entry.
 * @throws {Error} When the map names a version it does not list.
 */
export function currentVersion(versions) {
  const found = versions.versions.find((v) => v.id === versions.current);
  if (!found) throw new Error(`versions.json names ${versions.current} as current but does not list it`);
  return found;
}

/**
 * Whether a comment is an acceptance of this version: its whole text, trimmed
 * and case-folded, is the version's sentence.
 * @param {string} body The comment.
 * @param {{phrase: string}} version The version.
 * @returns {boolean} True for an acceptance.
 */
export function isAcceptance(body, version) {
  return body.trim().toLowerCase() === version.phrase.trim().toLowerCase();
}

/**
 * Whether a comment asks for the check to run again and comes from someone
 * with write access to the repository.
 * @param {{body: string, author_association: string}} comment The comment.
 * @returns {boolean} True for a maintainer's `recheck`.
 */
export function isMaintainerRecheck(comment) {
  return comment.body.trim().toLowerCase() === 'recheck' && MAINTAINER_ASSOCIATIONS.has(comment.author_association);
}

/**
 * Reads the account id GitHub encodes in a noreply address.
 * @param {string} email The address.
 * @returns {number | null} The id, or null for any other address.
 */
function noreplyId(email) {
  const match = /^(\d+)\+[^@]+@users\.noreply\.github\.com$/i.exec(email);
  return match ? Number(match[1]) : null;
}

/**
 * Everyone whose acceptance a PR needs: its opener, each commit author and
 * each `Co-authored-by` trailer, once each. An author GitHub cannot match to
 * an account is kept by email, with no id.
 * @param {{opener: object, commits: object[]}} input The opener and the compare API's commits.
 * @returns {object[]} Identities `{id, login, email}`.
 */
export function peopleOf({ opener, commits }) {
  const people = [];
  const seen = new Set();
  const add = (person) => {
    const key = person.id !== null ? `id:${person.id}` : `email:${person.email?.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    people.push(person);
  };
  add({ id: opener.id, login: opener.login, email: null });
  for (const commit of commits) {
    if (commit.author) add({ id: commit.author.id, login: commit.author.login, email: null });
    else add({ id: null, login: null, email: commit.commit.author.email });
    for (const [, name, email] of commit.commit.message.matchAll(/^Co-authored-by:\s*(.*?)\s*<([^>]+)>\s*$/gim)) {
      const id = noreplyId(email);
      add(id !== null ? { id, login: name, email: null } : { id: null, login: null, email });
    }
  }
  return people;
}

/**
 * Flattens the pages of `GET /repos/{o}/{r}/compare/{base}...{head}`.
 * @param {{total_commits: number, commits: object[]}[]} pages The responses, in order.
 * @returns {object[]} Every commit.
 * @throws {Error} When the pages do not add up to the reported total.
 */
export function collectCompare(pages) {
  const commits = pages.flatMap((page) => page.commits);
  const total = pages[0]?.total_commits ?? 0;
  if (commits.length !== total) throw new Error(`commit list incomplete: ${commits.length} of ${total}`);
  return commits;
}

/**
 * Whether two identities are the same person: same account id, or, for an
 * author with no account, the same email.
 * @param {object} cleared The identity a review names.
 * @param {object} person The identity being judged.
 * @returns {boolean} True when they match.
 */
function sameIdentity(cleared, person) {
  if (person.id !== null) return Number(cleared.id) === person.id;
  return typeof cleared.email === 'string' && cleared.email.toLowerCase() === person.email?.toLowerCase();
}

/**
 * Judges one person for one PR, in the design's order.
 * @param {object} input The person, the PR and the records.
 * @returns {{ok: boolean, reason: string}} The verdict and why.
 */
function judgePerson({ person, pull, openerAllowlisted, signatures, reviewRequired, reviews, version }) {
  if (reviews.some((r) => Number(r.pullRequest) === pull.number && r.headSha === pull.headSha && sameIdentity(r.identity ?? {}, person))) {
    return { ok: true, reason: 'cleared by a maintainer review for this head' };
  }
  const allowlisted = person.id !== null && ALLOWLIST.some((a) => a.id === person.id);
  if (allowlisted && openerAllowlisted) return { ok: true, reason: 'Orime, Inc. account' };
  if (person.id === null) return { ok: false, reason: 'no GitHub account matches this author; a maintainer has to review' };
  if (allowlisted) return { ok: false, reason: 'an Orime, Inc. account inside an external pull request; a maintainer has to review' };

  const valid = signatures.filter((s) => s.id === person.id && s.version === version.id && s.sha256 === version.sha256);
  if (valid.length === 0) return { ok: false, reason: `has not accepted ${version.id}` };
  const at = Date.parse;
  const applies = (s) => s.pullRequest === pull.number || at(s.acceptedAt) < at(pull.createdAt);
  const required = reviewRequired.find((r) => Number(r.id) === person.id);
  if (required) {
    // An unreadable restart time parses to NaN, and every comparison with NaN is false.
    const restart = at(required.coverageRestartAt);
    if (at(pull.createdAt) > restart && valid.some((s) => at(s.acceptedAt) > restart && applies(s))) {
      return { ok: true, reason: `accepted ${version.id} after coverage restarted` };
    }
    return { ok: false, reason: `a maintainer has to review (${required.reason})` };
  }
  if (!valid.some(applies)) return { ok: false, reason: `accepted ${version.id} after this pull request was opened; accept it in this pull request` };
  return { ok: true, reason: `accepted ${version.id}` };
}

/**
 * Judges a PR: every person passes, or it fails.
 * @param {object} input The PR, its people, the records and the version.
 * @returns {{ok: boolean, people: {identity: object, ok: boolean, reason: string}[]}} The verdict.
 */
export function judgePullRequest({ pull, people, signatures, reviewRequired, reviews, version }) {
  const openerAllowlisted = ALLOWLIST.some((a) => a.id === pull.opener.id);
  const judged = people.map((identity) => ({
    identity,
    ...judgePerson({ person: identity, pull, openerAllowlisted, signatures, reviewRequired, reviews, version }),
  }));
  return { ok: judged.every((p) => p.ok), people: judged };
}

/**
 * The record of one acceptance.
 * @param {object} input The signer, the comment, the PR, its commits and the version.
 * @returns {object} The record appended to the version's signature file.
 */
export function acceptanceRecord({ signer, comment, pull, commits, version, repository }) {
  return {
    id: signer.id,
    login: signer.login,
    version: version.id,
    sha256: version.sha256,
    document: `https://github.com/${repository}/blob/${version.commit}/${version.path}`,
    pullRequest: pull.number,
    pullRequestUrl: pull.url,
    commentId: comment.id,
    commentUrl: comment.url,
    commentBody: comment.body,
    acceptedAt: comment.createdAt,
    headSha: pull.headSha,
    commits: commits.filter((c) => c.author?.id === signer.id).map((c) => c.sha),
  };
}

/**
 * A person's name for the check output.
 * @param {object} identity The identity.
 * @returns {string} `@login`, or the email for an author with no account.
 */
function nameOf(identity) {
  return identity.login ? `@${identity.login}` : identity.email;
}

/**
 * The `CLA signed` check run's conclusion and text.
 * @param {{ok: boolean, people: object[]}} verdict The verdict.
 * @param {object} version The version.
 * @returns {{conclusion: string, title: string, summary: string}} The check run fields.
 */
export function checkRunOutput(verdict, version, pull) {
  const entry = (identity) => JSON.stringify({ pullRequest: pull?.number, headSha: pull?.headSha, identity: identity.id !== null ? { id: identity.id } : { email: identity.email } });
  const lines = verdict.people.map((p) => `- ${p.ok ? 'passed' : 'not yet'}: ${nameOf(p.identity)} — ${p.reason}` + (p.ok || !pull ? '' : `\n  a maintainer's reviews.json entry after checking: \`${entry(p.identity)}\``));
  return {
    conclusion: verdict.ok ? 'success' : 'failure',
    title: verdict.ok ? `Everyone has accepted ${version.id}` : `Waiting on ${version.id} acceptance or a maintainer review`,
    summary: [
      ...lines,
      '',
      'A green check means an acceptance record exists for each person. Corporate rights were not verified by this check; before merging, a maintainer reviews them as CONTRIBUTING.md describes.',
    ].join('\n'),
  };
}

/**
 * The comment asking people to accept, kept as one comment updated in place.
 * @param {{ok: boolean, people: object[]}} verdict The verdict.
 * @param {object} version The version.
 * @param {string} repository `owner/name`.
 * @returns {string} The comment body.
 */
export function signRequestComment(verdict, version, repository) {
  const link = `https://github.com/${repository}/blob/${version.commit}/${version.path}`;
  if (verdict.ok) return `${COMMENT_MARKER}\nEveryone on this pull request has accepted the [Breatic Contributor License Agreement version 2.0](${link}).`;
  const waiting = verdict.people.filter((p) => !p.ok).map((p) => `- ${nameOf(p.identity)}: ${p.reason}`);
  return [
    COMMENT_MARKER,
    `Before this pull request can be merged, each person below has to accept the [Breatic Contributor License Agreement version 2.0](${link}) (SHA-256 \`${version.sha256}\`).`,
    '',
    'Read it before accepting. You keep the copyright in your contributions. You grant Orime, Inc. the right to use, sublicense and commercially license them, and Orime, Inc. does not commit to offering them under an OSI-approved license.',
    '',
    'To accept, post a comment on this pull request containing exactly:',
    '',
    `> ${version.phrase}`,
    '',
    'If your employer has rights in your contributions, contact@breatic.ai handles the corporate agreement privately; do not post company documents here.',
    '',
    ...waiting,
  ].join('\n');
}

/**
 * Calls the GitHub REST API.
 * @param {string} token The workflow token.
 * @param {string} path The API path.
 * @param {{method?: string, body?: object}} options Method and JSON body.
 * @returns {Promise<{status: number, json: any}>} The status and parsed body.
 * @throws {Error} On a status other than 2xx, 404 or 409.
 */
async function api(token, path, { method = 'GET', body, accept = 'application/vnd.github+json' } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept, 'x-github-api-version': '2022-11-28' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = response.status === 204 ? null : await response.json();
  if (!response.ok && response.status !== 404 && response.status !== 409) {
    throw new Error(`${method} ${path} failed with ${response.status}: ${JSON.stringify(json)}`);
  }
  return { status: response.status, json };
}

/**
 * Reads a JSON record file from the records branch.
 * @param {string} token The workflow token.
 * @param {string} repository `owner/name`.
 * @param {string} path The file path.
 * @param {object} empty What a missing file stands for.
 * @returns {Promise<{data: object, sha: string | null}>} Contents and blob sha.
 */
async function readRecords(token, repository, path, empty) {
  const { status, json } = await api(token, `/repos/${repository}/contents/${path}?ref=${RECORDS_BRANCH}`, { accept: 'application/vnd.github.object' });
  if (status === 404) return { data: empty, sha: null };
  // Above 1 MB the contents API leaves `content` empty; the blob API serves up to 100 MB.
  const content = json.encoding === 'none' ? (await api(token, `/repos/${repository}/git/blobs/${json.sha}`)).json.content : json.content;
  return { data: JSON.parse(Buffer.from(content, 'base64').toString('utf8')), sha: json.sha };
}

/**
 * Appends an acceptance to the signature file, retrying when another run
 * wrote first.
 * @param {string} token The workflow token.
 * @param {string} repository `owner/name`.
 * @param {object} version The version.
 * @param {object} record The record.
 * @returns {Promise<object>} The signature file as written.
 * @throws {Error} When five attempts all lose the race.
 */
async function appendSignature(token, repository, version, record) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { data, sha } = await readRecords(token, repository, version.signatures, { signatures: [] });
    data.signatures.push(record);
    const content = Buffer.from(`${JSON.stringify(data, null, 2)}\n`).toString('base64');
    const { status } = await api(token, `/repos/${repository}/contents/${version.signatures}`, {
      method: 'PUT',
      body: { message: `Record ${record.login}'s acceptance of ${version.id} in #${record.pullRequest}`, content, branch: RECORDS_BRANCH, ...(sha && { sha }) },
    });
    if (status !== 409) return data;
  }
  throw new Error('could not record the acceptance after 5 attempts');
}

/**
 * Lists the PR's commits across every page of the compare API.
 * @param {string} token The workflow token.
 * @param {string} repository `owner/name`.
 * @param {{baseSha: string, headSha: string}} pull The PR.
 * @returns {Promise<object[]>} Every commit.
 */
async function prCommits(token, repository, pull) {
  const pages = [];
  for (let page = 1; ; page += 1) {
    const { json } = await api(token, `/repos/${repository}/compare/${pull.baseSha}...${pull.headSha}?per_page=100&page=${page}`);
    pages.push(json);
    if (json.commits.length < 100) break;
  }
  return collectCompare(pages);
}

/**
 * Writes `CLA signed` on the head, updating the run already there.
 * @param {string} token The workflow token.
 * @param {string} repository `owner/name`.
 * @param {string} headSha The PR head.
 * @param {object} output The conclusion and text.
 * @returns {Promise<void>} Resolves once written.
 */
async function writeCheck(token, repository, headSha, output) {
  const { json } = await api(token, `/repos/${repository}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}`);
  const body = { status: 'completed', conclusion: output.conclusion, output: { title: output.title, summary: output.summary } };
  for (const request of checkRunRequests(json.check_runs, headSha)) {
    await api(token, `/repos/${repository}${request.path}`, { method: request.method, body: { ...request.body, ...body } });
  }
}

/**
 * Which `CLA signed` runs to write on a head: every GitHub Actions run of that
 * name, updated in place, or one new run when there is none.
 * @param {{id: number, app?: {id: number}}[]} existingRuns The head's runs named `CLA signed`.
 * @param {string} headSha The PR head.
 * @returns {{method: string, path: string, body: object}[]} The requests.
 */
export function checkRunRequests(existingRuns, headSha) {
  const mine = existingRuns.filter((run) => run.app?.id === ACTIONS_APP_ID);
  if (mine.length === 0) return [{ method: 'POST', path: '/check-runs', body: { name: CHECK_NAME, head_sha: headSha } }];
  return mine.map((run) => ({ method: 'PATCH', path: `/check-runs/${run.id}`, body: {} }));
}

/**
 * Creates or updates the one request comment on the PR.
 * @param {string} token The workflow token.
 * @param {string} repository `owner/name`.
 * @param {number} number The PR number.
 * @param {string} body The comment.
 * @param {boolean} ok Whether everyone passed.
 * @returns {Promise<void>} Resolves once written.
 */
async function writeComment(token, repository, number, body, ok) {
  let existing;
  for (let page = 1; !existing; page += 1) {
    const { json } = await api(token, `/repos/${repository}/issues/${number}/comments?per_page=100&page=${page}`);
    existing = json.find((c) => c.user?.login === 'github-actions[bot]' && c.body?.startsWith(COMMENT_MARKER));
    if (json.length < 100) break;
  }
  if (existing) await api(token, `/repos/${repository}/issues/comments/${existing.id}`, { method: 'PATCH', body: { body } });
  else if (!ok) await api(token, `/repos/${repository}/issues/${number}/comments`, { method: 'POST', body: { body } });
}

/**
 * Runs the check for the event that started the workflow.
 * @param {NodeJS.ProcessEnv} env The workflow environment.
 * @returns {Promise<void>} Resolves when the check is written.
 * @throws {Error} When the GitHub API fails or the commit list is incomplete.
 */
export async function main(env) {
  const token = env.GITHUB_TOKEN;
  const repository = env.GITHUB_REPOSITORY;
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const version = currentVersion(JSON.parse(readFileSync(new URL('../docs/legal/cla/versions.json', import.meta.url), 'utf8')));

  let number;
  let comment = null;
  if (env.GITHUB_EVENT_NAME === 'pull_request_target') {
    number = event.pull_request.number;
  } else {
    if (!event.issue?.pull_request) return;
    const accepting = isAcceptance(event.comment.body, version);
    if (!accepting && !isMaintainerRecheck(event.comment)) return;
    number = event.issue.number;
    if (accepting) comment = event.comment;
  }

  const { json: raw } = await api(token, `/repos/${repository}/pulls/${number}`);
  const pull = {
    number,
    url: raw.html_url,
    createdAt: raw.created_at,
    headSha: raw.head.sha,
    baseSha: raw.base.sha,
    opener: { id: raw.user.id, login: raw.user.login },
  };
  const commits = await prCommits(token, repository, pull);

  let signatureData = null;
  if (comment) {
    const signer = { id: comment.user.id, login: comment.user.login };
    const record = acceptanceRecord({
      signer,
      comment: { id: comment.id, url: comment.html_url, body: comment.body, createdAt: comment.created_at },
      pull,
      commits,
      version,
      repository,
    });
    signatureData = await appendSignature(token, repository, version, record);
  }

  const [signatures, reviewRequired, reviews] = await Promise.all([
    signatureData ? { data: signatureData } : readRecords(token, repository, version.signatures, { signatures: [] }),
    readRecords(token, repository, 'signatures/v2/review-required.json', { accounts: [] }),
    readRecords(token, repository, 'signatures/v2/reviews.json', { reviews: [] }),
  ]);
  const verdict = judgePullRequest({
    pull,
    people: peopleOf({ opener: pull.opener, commits }),
    signatures: signatures.data.signatures,
    reviewRequired: reviewRequired.data.accounts,
    reviews: reviews.data.reviews,
    version,
  });
  await writeCheck(token, repository, pull.headSha, checkRunOutput(verdict, version, pull));
  await writeComment(token, repository, number, signRequestComment(verdict, version, repository), verdict.ok);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main(process.env);
}

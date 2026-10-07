// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** web, migrate, server, collab and worker. */
const PRODUCT_IMAGE_COUNT = 5;
const releasePattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.(0|[1-9]\d*))?$/;

/** Version of a release tag (`v0.2.0` -> `0.2.0`); throws for anything else. */
function parseReleaseTag(tag) {
  if (!tag.startsWith('v') || !releasePattern.test(tag.slice(1))) throw new Error('Invalid release tag');
  return tag.slice(1);
}

/** Validate the release identity shared by every artifact. */
export function buildInfo(version = '0.0.0-dev', revision = 'unknown') {
  if (version !== '0.0.0-dev' && !releasePattern.test(version)) {
    throw new Error('Expected X.Y.Z or X.Y.Z-rc.N (no leading v)');
  }
  if (!/^[a-f0-9]{40}$/.test(revision) && !(version === '0.0.0-dev' && revision === 'unknown')) {
    throw new Error('A release requires the full source commit SHA');
  }
  return { releaseVersion: version, revision };
}

/** Create the portable manifest only from registry-confirmed image digests. */
export function releaseManifest(tag, revision, repository, backend, web, ingestMedia) {
  const info = buildInfo(parseReleaseTag(tag), revision);
  if (!/^[a-z0-9-]+\/breatic$/.test(repository)) throw new Error('Invalid product repository');
  for (const [name, ref] of [['breatic', backend], ['breatic-web', web], ['breatic-ingest-media', ingestMedia]]) {
    const prefix = `ghcr.io/${repository.split('/')[0]}/${name}@sha256:`;
    if (typeof ref !== 'string' || !ref.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(ref.slice(prefix.length))) {
      throw new Error(`Invalid immutable ${name} image`);
    }
  }
  return { schemaVersion: 1, tag, ...info, repository, platform: 'linux/amd64', images: { backend, web, ingestMedia } };
}

/** Tags of every product image the compose file runs, in file order. */
export function composeImageTags(text) {
  return [...text.matchAll(/^\s*image:\s*["']?ghcr\.io\/orime-org\/breatic(?:-web)?:([^\s"'#]+)["']?\s*(?:#.*)?$/gm)].map((match) => match[1]);
}

/** A stable release must ship a compose file that runs exactly its own images. */
export function checkComposeTag(tag, text) {
  if (parseReleaseTag(tag).includes('-rc.')) return;
  const tags = composeImageTags(text);
  if (tags.length !== PRODUCT_IMAGE_COUNT) {
    throw new Error(`docker-compose.yml: found ${tags.length} product image lines, expected ${PRODUCT_IMAGE_COUNT}`);
  }
  if (tags.some((found) => found !== tag)) {
    throw new Error(`docker-compose.yml must run ${tag} for every product image; found ${tags.join(', ')}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'build-info' && args.length === 3) {
    writeFileSync(args[2], JSON.stringify(buildInfo(args[0], args[1]), null, 2) + '\n');
  } else if (command === 'manifest' && args.length === 7) {
    writeFileSync(args[6], JSON.stringify(releaseManifest(...args.slice(0, 6)), null, 2) + '\n');
  } else if (command === 'compose-tag' && args.length === 2) {
    checkComposeTag(args[0], readFileSync(args[1], 'utf8'));
  } else if (command === 'ci' && args.length === 2) {
    const [ref, revision] = args;
    const release = ref.startsWith('refs/tags/');
    const tag = release ? ref.slice('refs/tags/'.length) : 'ci';
    const info = buildInfo(release ? parseReleaseTag(tag) : '0.0.0-dev', revision);
    console.log(`version=${info.releaseVersion}\nimage_tag=${tag}`);
  } else {
    throw new Error('Usage: release.mjs ci REF SHA | compose-tag TAG COMPOSE_FILE | build-info VERSION SHA OUTPUT | manifest TAG SHA REPOSITORY BACKEND_DIGEST WEB_DIGEST MEDIA_DIGEST OUTPUT');
  }
}

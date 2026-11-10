// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

for (const failure of ['', 'wrong-index', 'missing-digest', 'media-digest', 'web-reader-digest', 'missing-web-reader-digest', 'malformed-web-reader-digest']) {
  test(`publication validates the exact tested digests: ${failure || 'success'}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'publish-images-'));
    try {
      mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'digests')); mkdirSync(join(dir, 'scripts'));
      for (const file of ['release.mjs', 'publish-images.sh']) cpSync(new URL(file, import.meta.url), join(dir, 'scripts', file));
      for (const [i, name] of ['backend-amd64', 'backend-arm64', 'web-amd64', 'web-arm64', 'ingestMedia-amd64', 'ingestWebReader-amd64'].entries()) {
        if (failure === 'missing-digest' && name === 'web-arm64') continue;
        if (failure === 'missing-web-reader-digest' && name === 'ingestWebReader-amd64') continue;
        const malformed = failure === 'malformed-web-reader-digest' && name === 'ingestWebReader-amd64';
        writeFileSync(join(dir, 'digests', name), malformed ? `sha256:${'6'.repeat(63)}` : `sha256:${String(i + 1).repeat(64)}`);
      }
      const executable = `#!${process.execPath}\n` + `
import fs from 'node:fs';
const args=process.argv.slice(2);
fs.appendFileSync('calls', JSON.stringify([process.argv[1].split('/').at(-1).replace('.mjs',''), ...args])+'\\n');
if(args[0]==='buildx' && args[2]==='inspect') {
  const media=args[3].includes('ingest-media'), reader=args[3].includes('ingest-web-reader'), web=!reader && args[3].includes('-web');
  if(args.includes('--raw')) {
    const start=web?3:1;
    console.log(JSON.stringify({manifests:['amd64','arm64'].map((architecture,i)=>({platform:{os:'linux',architecture},digest:'sha256:'+String(start+i+(process.env.FAILURE==='wrong-index'?1:0)).repeat(64)}))}));
  } else console.log('sha256:'+(media?(process.env.FAILURE==='media-digest'?'9':'5'):reader?(process.env.FAILURE==='web-reader-digest'?'8':'6'):web?'7':'6').repeat(64));
}
`;
      // .mjs wrappers keep behavior independent of the invoking Node's module defaults.
      for (const name of ['docker', 'gh']) {
        writeFileSync(join(dir, 'bin', name+'.mjs'), executable);
        writeFileSync(join(dir, 'bin', name), `#!/bin/sh\nexec '${process.execPath}' '${join(dir,'bin',name+'.mjs')}' "$@"\n`, { mode: 0o755 });
      }
      const result = spawnSync('bash', ['scripts/publish-images.sh'], { cwd: dir, encoding: 'utf8', env: {
        ...process.env, PATH: join(dir,'bin')+':'+process.env.PATH, FAILURE:failure,
        TAG:'v0.2.0', REVISION:'a'.repeat(40), REPOSITORY:'orime-org/breatic',
      }});
      if (failure) {
        assert.notEqual(result.status,0);
        const calls = existsSync(join(dir,'calls'))?readFileSync(join(dir,'calls'),'utf8'):'';
        assert.ok(!calls.includes('["gh"'), 'failed validation must leave the release draft');
      } else {
        assert.equal(result.status,0,result.stderr);
        const manifest=JSON.parse(readFileSync(join(dir,'release.json'),'utf8'));
        assert.equal(manifest.schemaVersion,2);
        assert.equal(manifest.images.backend,'ghcr.io/orime-org/breatic@sha256:'+'6'.repeat(64));
        const reader='ghcr.io/orime-org/breatic-ingest-web-reader';
        assert.equal(manifest.images.ingestWebReader,reader+'@sha256:'+'6'.repeat(64));
        assert.deepEqual(manifest.imagePlatforms.ingestWebReader,['linux/amd64']);
        const calls=readFileSync(join(dir,'calls'),'utf8').trim().split('\n').map(JSON.parse);
        // Single-platform like the media image: tagged without wrapping it in an index.
        assert.deepEqual(calls.filter(call=>call[3]==='create'&&call.at(-1).startsWith(reader)),
          [['docker','buildx','imagetools','create','--prefer-index=false','--tag',reader+':v0.2.0',reader+'@sha256:'+'6'.repeat(64)]]);
        assert.deepEqual(calls.slice(-2),[['gh','release','upload','v0.2.0','release.json'],['gh','release','edit','v0.2.0','--draft=false','--latest=false']]);
      }
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
}

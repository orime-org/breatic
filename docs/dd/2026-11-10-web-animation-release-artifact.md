# Web-animation release artifact verification

Date: 2026-11-10. Scope: the existing web-animation container's native release artifact, not its application behavior or production settings.

## Factual verification

| Hypothesis | Evidence and result |
|---|---|
| The merged animation feature already has a runnable container definition. | `packages/ingest/web-animation.Dockerfile` bundles the runner, Chromium, the pinned HyperFrames runtime, six font families and the existing harness profile. Verified in source. |
| A completed product Release includes that image. | Disproved at the selected pre-release source: the native CI matrix, manifest builder and publisher include media and page reading but omit animation. Packaging cannot obtain an immutable animation digest from that Release. |
| The existing native publication path can include it without a deployment rebuild. | The AMD64 matrix already builds and tests single-platform media and page-reader images before publishing their exact digests. The animation image uses the same contract and adds `images.ingestWebAnimation` and its AMD64 platform entry to schema 2. |
| A release can complete with missing or substituted animation content. | Regression tests first reproduced the omission. After the fix, missing, malformed, foreign-repository and registry-mismatched animation references fail before release upload/completion. Backend/web still require their exact two tested native descriptors. |
| An offline image test can run without model credentials or charges. | The runner boots from image-internal settings and rejects malformed JSON at `POST /run` before starting a job. The smoke test uses that request, harness help, a fixed local composition, the shipped runtime and font; Docker disables networking. No valid generation request or model call is submitted. Actual native image execution remains a CI gate, not a claim established by the script contract tests. |

## Implementation and validation boundary

The existing native AMD64 image pipeline builds `breatic-ingest-web-animation`, embeds `/app/build-info.json` and verifies its release identity and OCI labels. Publication waits for all seven native image checks, keeps the three Ingest manifests single-platform, checks registry digests and completes the Release only after manifest generation succeeds. No deployment image rebuild or new production setting is introduced.

The independent audit session supplied the release contract and failure boundaries; the implementation session encoded and ran the failing tests before changing the manifest/publisher, then obtained 21 passing release/publication tests. Shell and JavaScript syntax, five stable Compose tags and workflow matrix/gate checks are also verified locally. Full native image execution, complete product CI and formal tag publication remain required after review. Historical release manifests are not modified or republished.

See [versioned releases](../../self-host/RELEASE.md) for artifact identities, supported architectures and interrupted-publication behavior.

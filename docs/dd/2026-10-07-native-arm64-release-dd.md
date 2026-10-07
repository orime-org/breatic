# Native multi-platform release builds

Date: 2026-10-07. Scope: backend and self-host web release images; application behavior is unchanged.

## Evidence and decision

The previous workflow (base `234ca2731`) builds only `linux/amd64`, and its release manifest declares one global platform. Adding ARM64 requires both publishing an image index and updating deployment readers. Published versions through v0.0.3 remain unchanged.

| Approach | Runtime evidence | Build cost / dependencies | Decision |
|---|---|---|---|
| Native AMD64 and ARM64 runners | Executes binaries on their actual CPU | Five parallel jobs; requires ARM runner availability | Selected |
| QEMU on AMD64 | Exercises emulation rather than native ARM | Extra emulator setup and slower compilation | No automatic fallback |
| Cross compilation alone | Does not run target binaries | Must configure every native Node/apt dependency | Insufficient for this task |

[GitHub runner documentation](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) documents `ubuntu-24.04-arm`. [Docker’s matrix example](https://docs.docker.com/build/ci/github-actions/multi-platform/) documents publishing per-platform digests and merging them with imagetools. [Cloudflare Containers](https://developers.cloudflare.com/containers/get-started/) requires `linux/amd64`; the Ingest media container is intentionally excluded from ARM64. Container base images and ffmpeg must resolve for each target; native CI builds are the acceptance test, not an assumption based on package names.

The user authorized implementation of ARM64 packaging. Native runners are the implementation choice; no new cloud provider, paid service or production deployment is introduced.

## Publication and compatibility

PR and branch jobs build locally without uploading images. Tag jobs upload untagged content, pull that exact digest, and run native checks. After all five jobs succeed, a serialized publisher reserves a draft Release, combines exactly the tested AMD64/ARM64 descriptors for backend/web, tags the original media manifest, and uploads schema 2 `release.json`. Only then is the Release completed. Failed publication leaves a draft; reruns cannot replace it. Registry retention must preserve child manifests as well as published indexes.

Schema 2 removes global `platform` and adds `imagePlatforms`: backend/web support both CPUs, media only AMD64. Deployment tools retain schema 1 support. New readers must land before selecting a new release. Production nginx must likewise use a compatible multi-platform digest. Independent native builds may produce different Sentry Debug IDs, so extract mappings from both exact images.

## Validation boundary

Release tests reject missing, duplicate, incorrect or foreign-OS index descriptors and mismatched digests. Publication tests reject partial manifests and prevent completion on registry errors. Native image smoke checks validate metadata and labels; backend checks Node CPU, real ffmpeg output and installed source maps, web checks served version JSON, media performs its existing video/cover checks. CI runs full product lint, type checking and integration suites before image jobs.

Passing PR CI proves native image builds and smoke checks. It does not prove a formal tag publication or deployment with production databases. After merge, a new version must be prepared and tagged, then its GHCR index and native pulls verified. Do not reuse or overwrite v0.0.3.

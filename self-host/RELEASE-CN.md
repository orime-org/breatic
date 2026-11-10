# 版本发布

一个版本对应已经合并进 `main` 的一个选定提交，可以包含多个 PR。用 `v0.2.0` 这样的 Git 标签确定发布版本；发布不等于上线。

## 操作流程

1. 合并一个 PR，把 `docker-compose.yml` 里五个产品镜像的标签改成新版本（例如 `v0.2.0`）。要先发候选版本的，这个 PR 排在第一个 `-rc` 标签之前。
2. 合并计划中的 PR，确认检查通过，核对选定提交及数据库迁移。
3. 获取 main，选择完整提交号，创建并推送新标签：

   ```bash
   git fetch origin main
   git tag -a v0.2.0 <完整提交SHA> -m 'Release 0.2.0'
   git push origin refs/tags/v0.2.0
   ```

   示例不代表已有该版本。支持 `v主版本.次版本.补丁版本` 和 `v主版本.次版本.补丁版本-rc.N`，数字不带多余前导零；所选提交必须属于 main 历史。正式标签所在提交的 `docker-compose.yml` 必须对五个产品镜像写同一个版本号，否则 CI 在占用版本号之前停止；候选版本标签不做这项检查。
4. Tag CI runs all checks and builds backend and self-host web on native AMD64 and ARM64 runners. Ingest media, the Ingest page reader and the web-animation runner remain `linux/amd64` because Cloudflare Containers requires it. Each native image is checked for architecture, embedded version and OCI labels; backend checks include ffmpeg encoding and source maps, web checks an HTTP response from nginx, media checks licences and actual video/cover processing, and the page reader checks its licence notice and reads local HTML and PDF samples with networking off. The animation runner checks its unprivileged runtime, licence notices, harness profile, all six font families, a malformed local request and a fixed Chromium composition using the shipped runtime and font, with networking off and no model call.
5. Tag builds push untagged content digests to GHCR and pull those exact images for native smoke tests. After all seven builds pass, CI reserves a draft GitHub Release, combines the tested backend/web digests into multi-platform indexes under the version tags, tags the tested media, page reader and animation manifests, attaches `release.json`, then publishes the Release. No manual Docker upload is needed. PRs and branch pushes build images for checks without publishing; `main`, `latest` and minor-version aliases are no longer updated.
6. 下载已完成的 Release 清单，用其中固定的镜像摘要测试。正式上线使用测试过的同一摘要；前后端部署顺序要结合接口兼容和数据库迁移安排。标签构建成功不代表云配置已经验证。

The images are `ghcr.io/orime-org/breatic:v0.2.0`, `ghcr.io/orime-org/breatic-web:v0.2.0`, `ghcr.io/orime-org/breatic-ingest-media:v0.2.0`, `ghcr.io/orime-org/breatic-ingest-web-reader:v0.2.0` and `ghcr.io/orime-org/breatic-ingest-web-animation:v0.2.0`. Deploy by the `@sha256:…` references in the manifest for production. Record and retain manifests, image digests and deployed frontend assets; registry cleanup must exclude deployed and rollback versions.

## 版本实际保存的位置

| 位置 | 内容 |
|---|---|
| Git 标签 `v0.2.0` | 人指定的发布版本及其源码提交 |
| 后端 `/app/build-info.json` | 构建写入的 `releaseVersion`、完整 `revision`，Server、Worker、Collab、迁移共用 |
| 前端 `/app-version.json` | `releaseVersion`、完整 `revision`、更新检测用的 `version` |
| Ingest media, page reader and web animation `/app/build-info.json` | The same product `releaseVersion` and full `revision` |
| 镜像 OCI 标签 | `org.opencontainers.image.version` 和 `.revision` |
| `docker-compose.yml` | 五个产品镜像的标签，等于这份源码对应的正式版本 |
| GitHub Release `release.json` | Schema version, tag, release version, revision, repository, per-image `imagePlatforms` and immutable `images.backend`, `images.web`, `images.ingestMedia`, `images.ingestWebReader` and `images.ingestWebAnimation` references |

为兼容现有更新提示，前端 JSON 的 `version` 继续使用完整提交号，可读版本单独放在 `releaseVersion`。nginx 对版本文件返回 `Cache-Control: no-store`。

版本写在构建产物里，不由生产 `.env` 修改。每次发布不改 package.json；工作区 package.json 版本不是部署版本。普通开发构建标为 `0.0.0-dev`，提交未知时为 `unknown`。

无需连接数据库即可检查镜像版本：

```bash
docker run --rm --entrypoint cat <带摘要的后端镜像> /app/build-info.json
```

Build arguments are `RELEASE_VERSION` and `VCS_REF` for the backend, Ingest media, the Ingest page reader and web animation; `VITE_RELEASE_VERSION` and `VITE_APP_VERSION` for the web. CI supplies them from the tag and commit. Frontend URL and Google configuration remain separate public build settings.

## 发布中断与重跑

草稿在发布版本标签前占用版本号；此前 GHCR 可能已保存无标签的单架构内容。已有草稿或正式 Release 时重跑会停止，不会覆盖同名版本。占用后中断，保留失败草稿排查，使用新的版本标签重新发布；部分上传的镜像不能部署。不要移动、删除重建标签来重试。占用前的检查失败可以重跑；`docker-compose.yml` 版本不一致除外，同一标签每次重跑都会同样失败。换新的正式版本号重发前，先合并把 `docker-compose.yml` 改成该版本的 PR；候选版本换新 rc 号不改 `docker-compose.yml`。

在 GitHub 设置保护 `v*` 标签不被更新、删除，并按仓库能力启用不可变 Release；创建权限仅给可信发布人员。管理员还需保留在用的镜像摘要和附件。

For local Docker use, obtain the source of a release as described in [LOCAL.md](LOCAL.md); from `v0.0.2` on, its `docker-compose.yml` runs that release's images. The Ingest media, page reader and animation images are published with the product tag; the Worker JavaScript is not inside them. Official production packaging compiles the Worker from the same commit and downloads `images.ingestMedia`, `images.ingestWebReader` and `images.ingestWebAnimation` by digest, exporting those exact images into the Ingest bundle. Manual deployment imports them and pushes them to Cloudflare’s registry, then deploys the Worker. No image rebuild happens during packaging or deployment.

New product manifests use schema version 2. `imagePlatforms.backend` and `.web` are `["linux/amd64", "linux/arm64"]`; `.ingestMedia`, `.ingestWebReader` and `.ingestWebAnimation` are `["linux/amd64"]`. The global `platform` field is removed. Backend/web references pin the complete multi-platform index, allowing Docker to select the native image without architecture-specific tags. Deployment readers must support schema 2 before selecting these releases. Schema 1 releases, including v0.0.3, remain AMD64-only and are not republished. Old releases remain valid for backend/web deployment; new official Ingest packaging requires a completed release containing all three Ingest image fields required by the selected Worker source. Do not edit old release assets or silently rebuild missing media images. GHCR download access is needed on the packaging machine; the bundle recipient only needs access to the target Cloudflare account.

原生 CI 使用 `ubuntu-24.04` / `ubuntu-24.04-arm`，不依赖 QEMU。生产部署另选的 nginx 摘要也必须是支持目标架构的索引。后端 Sentry 映射从两个原生镜像分别提取上传，避免独立构建的 Debug ID 差异影响错误定位。选型依据与验收边界见 [原生多架构发布决策](../docs/dd/2026-10-07-native-arm64-release-dd.md)。

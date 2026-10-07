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
4. 标签触发全部检查。后端和自托管 Web 分别在原生 AMD64、ARM64 runner 构建与测试；Ingest 媒体遵循 Cloudflare Containers 要求，仅构建 AMD64。各镜像核对架构、内嵌版本与 OCI 标签；后端实际编码视频并核对源码映射，Web 启动 nginx 验证 HTTP，媒体验证许可证、视频解析和封面生成。
5. 标签构建先将无版本标签的内容摘要上传 GHCR，拉取同一摘要完成原生测试。五个构建全部通过后，CI 创建草稿占用版本号，将后端/Web 已测试摘要组合为双架构索引并发布版本标签，给媒体原摘要打版本标签，附上 `release.json`，最后完成 GitHub Release。不需要手动上传镜像。PR 和分支提交只构建检查，不再更新 `main`、`latest` 或次版本镜像别名。
6. 下载已完成的 Release 清单，用其中固定的镜像摘要测试。正式上线使用测试过的同一摘要；前后端部署顺序要结合接口兼容和数据库迁移安排。标签构建成功不代表云配置已经验证。

示例镜像为 `ghcr.io/orime-org/breatic:v0.2.0`、`ghcr.io/orime-org/breatic-web:v0.2.0` 和 `ghcr.io/orime-org/breatic-ingest-media:v0.2.0`。生产使用清单中的 `@sha256:…`。保留发布清单、镜像摘要和前端历史资产；清理仓库时排除在用及回退版本。

## 版本实际保存的位置

| 位置 | 内容 |
|---|---|
| Git 标签 `v0.2.0` | 人指定的发布版本及其源码提交 |
| 后端 `/app/build-info.json` | 构建写入的 `releaseVersion`、完整 `revision`，Server、Worker、Collab、迁移共用 |
| 前端 `/app-version.json` | `releaseVersion`、完整 `revision`、更新检测用的 `version` |
| Ingest 媒体 `/app/build-info.json` | 同一产品版本 `releaseVersion` 与完整 `revision` |
| 镜像 OCI 标签 | `org.opencontainers.image.version` 和 `.revision` |
| `docker-compose.yml` | 五个产品镜像的标签，等于这份源码对应的正式版本 |
| GitHub Release 附件 `release.json` | 清单格式版本、发布标签、版本、提交、仓库、逐镜像架构 `imagePlatforms` 及三个不可变镜像引用 `images.backend`、`images.web`、`images.ingestMedia` |

为兼容现有更新提示，前端 JSON 的 `version` 继续使用完整提交号，可读版本单独放在 `releaseVersion`。nginx 对版本文件返回 `Cache-Control: no-store`。

版本写在构建产物里，不由生产 `.env` 修改。每次发布不改 package.json；工作区 package.json 版本不是部署版本。普通开发构建标为 `0.0.0-dev`，提交未知时为 `unknown`。

无需连接数据库即可检查镜像版本：

```bash
docker run --rm --entrypoint cat <带摘要的后端镜像> /app/build-info.json
```

构建参数：后端和 Ingest 媒体 `RELEASE_VERSION`、`VCS_REF`；前端 `VITE_RELEASE_VERSION`、`VITE_APP_VERSION`。CI 从标签及提交注入。前端地址和 Google Client ID 仍是独立的公开打包配置。

## 发布中断与重跑

草稿在发布版本标签前占用版本号；此前 GHCR 可能已保存无标签的单架构内容。已有草稿或正式 Release 时重跑会停止，不会覆盖同名版本。占用后中断，保留失败草稿排查，使用新的版本标签重新发布；部分上传的镜像不能部署。不要移动、删除重建标签来重试。占用前的检查失败可以重跑；`docker-compose.yml` 版本不一致除外，同一标签每次重跑都会同样失败。换新的正式版本号重发前，先合并把 `docker-compose.yml` 改成该版本的 PR；候选版本换新 rc 号不改 `docker-compose.yml`。

在 GitHub 设置保护 `v*` 标签不被更新、删除，并按仓库能力启用不可变 Release；创建权限仅给可信发布人员。管理员还需保留在用的镜像摘要和附件。

本地 Docker 按 [LOCAL-CN.md](LOCAL-CN.md) 取某个发布版本的源码，从 `v0.0.2` 起，其中的 `docker-compose.yml` 运行的就是该版本的镜像。Ingest 媒体镜像随产品标签发布，但不包含 Worker JavaScript。官方部署仓从同一提交编译 Worker，并按 `images.ingestMedia` 摘要下载媒体镜像，原样导出到 Ingest 包。手动上线时导入镜像、上传 Cloudflare 镜像仓库，再发布 Worker；打包与上线均不重建媒体镜像。

新产品清单使用 schemaVersion 2，以 `imagePlatforms.backend/web` 声明 AMD64 和 ARM64，以 `imagePlatforms.ingestMedia` 声明仅 AMD64，不再提供全局 `platform`。后端/Web 摘要固定整个多平台索引，Docker 自动选择本机架构，无需添加架构标签后缀。部署工具必须先支持新格式。历史 schemaVersion 1（包括 v0.0.3）仍为 AMD64，不修改旧版本。历史 Release 仍可用于后端/前端；新工具生成 Ingest 包必须选包含此字段的已完成产品 Release，不修改旧附件，也不回退到本地构建。打包机需要 GHCR 拉取权限；拿到完整包的部署者只需目标 Cloudflare 账号权限。

原生 CI 使用 `ubuntu-24.04` / `ubuntu-24.04-arm`，不依赖 QEMU。生产部署另选的 nginx 摘要也必须是支持目标架构的索引。后端 Sentry 映射从两个原生镜像分别提取上传，避免独立构建的 Debug ID 差异影响错误定位。选型依据与验收边界见 [原生多架构发布决策](../docs/dd/2026-10-07-native-arm64-release-dd.md)。

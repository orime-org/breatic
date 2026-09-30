# 版本发布

一个版本对应已经合并进 `main` 的一个选定提交，可以包含多个 PR。用 `v0.2.0` 这样的 Git 标签确定发布版本；发布不等于上线。

## 操作流程

1. 合并计划中的 PR，确认检查通过，核对选定提交及数据库迁移。
2. 获取 main，选择完整提交号，创建并推送新标签：

   ```bash
   git fetch origin main
   git tag -a v0.2.0 <完整提交SHA> -m 'Release 0.2.0'
   git push origin refs/tags/v0.2.0
   ```

   示例不代表已有该版本。支持 `v主版本.次版本.补丁版本` 和 `v主版本.次版本.补丁版本-rc.N`，数字不带多余前导零；所选提交必须属于 main 历史。
3. 标签触发全部检查和 `linux/amd64` 镜像构建。验证镜像内的版本文件及媒体镜像许可文件之后，才开始发布。
4. CI 创建草稿占用版本号，自动上传后端与前端镜像到 GHCR，附上 `release.json`，最后完成 GitHub Release。不需要手动上传镜像。PR 和分支提交只构建检查，不再更新 `main`、`latest` 或次版本镜像别名。
5. 下载已完成的 Release 清单，用其中固定的镜像摘要测试。正式上线使用测试过的同一摘要；前后端部署顺序要结合接口兼容和数据库迁移安排。标签构建成功不代表云配置已经验证。

示例镜像为 `ghcr.io/orime-org/breatic:v0.2.0` 和 `ghcr.io/orime-org/breatic-web:v0.2.0`。生产使用清单中的 `@sha256:…`。保留发布清单、镜像摘要和前端历史资产；清理仓库时排除在用及回退版本。

## 版本实际保存的位置

| 位置 | 内容 |
|---|---|
| Git 标签 `v0.2.0` | 人指定的发布版本及其源码提交 |
| 后端 `/app/build-info.json` | 构建写入的 `releaseVersion`、完整 `revision`，Server、Worker、Collab、迁移共用 |
| 前端 `/app-version.json` | `releaseVersion`、完整 `revision`、更新检测用的 `version` |
| 镜像 OCI 标签 | `org.opencontainers.image.version` 和 `.revision` |
| GitHub Release 附件 `release.json` | 清单格式版本、发布标签、版本、提交、仓库、架构及两个不可变镜像引用 |

为兼容现有更新提示，前端 JSON 的 `version` 继续使用完整提交号，可读版本单独放在 `releaseVersion`。nginx 对版本文件返回 `Cache-Control: no-store`。

版本写在构建产物里，不由生产 `.env` 修改。每次发布不需要再改 package.json、提交一次版本 PR；工作区 package.json 版本不是部署版本。普通开发构建标为 `0.0.0-dev`，提交未知时为 `unknown`。

无需连接数据库即可检查镜像版本：

```bash
docker run --rm --entrypoint cat <带摘要的后端镜像> /app/build-info.json
```

构建参数：后端 `RELEASE_VERSION`、`VCS_REF`；前端 `VITE_RELEASE_VERSION`、`VITE_APP_VERSION`。CI 从标签及提交注入。前端地址和 Google Client ID 仍是独立的公开打包配置。

## 发布中断与重跑

草稿在首次推送前占用版本号。已有草稿或正式 Release 时重跑会停止，不会覆盖同名版本。占用后中断，保留失败草稿排查，使用新的版本标签重新发布；部分上传的镜像不能部署。不要移动、删除重建标签来重试。占用前的检查失败可以重跑。

在 GitHub 设置保护 `v*` 标签不被更新、删除，并按仓库能力启用不可变 Release；创建权限仅给可信发布人员。管理员还需保留在用的镜像摘要和附件。

本地 Docker 按 [LOCAL-CN.md](LOCAL-CN.md) 将 `BREATIC_TAG` 填为实际已发布的完整标签，不再默认选择浮动版本。旧仓库标签不会被本次修改删除。Ingest 构建检查不等于发布 Worker，仍需从匹配源码单独部署。

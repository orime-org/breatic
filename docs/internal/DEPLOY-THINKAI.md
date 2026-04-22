# `<域名>` 部署运维手册

> **作用范围**：breatic 在 `<域名>` 域名的线上测试环境（staging）。
> **代码来源**：`test_thinkai_cc` 分支。本文档也只存在于此分支，main 分支无此文件。
> **目标读者**：维护 `<域名>` 的工程师。

---

## 目录

- [架构总览](#架构总览)
- [服务器基本信息](#服务器基本信息)
- [自动部署流程](#自动部署流程)
- [一次性初始化（灾难恢复用）](#一次性初始化灾难恢复用)
- [常见运维操作](#常见运维操作)
- [故障排查](#故障排查)
- [历史踩坑记录](#历史踩坑记录)

---

## 架构总览

```
┌──────────────────────────────────────────────────────────────┐
│                      开发者本地                              │
│                                                              │
│   git push origin test_thinkai_cc                            │
└────────────────────┬─────────────────────────────────────────┘
                     ▼
┌──────────────────────────────────────────────────────────────┐
│                    GitHub (orime-org/breatic_ai)             │
│                                                              │
│   test_thinkai_cc 分支收到 push                              │
└────────────────────┬─────────────────────────────────────────┘
                     ▼
┌──────────────────────────────────────────────────────────────┐
│                 GitHub Actions CI                            │
│                                                              │
│   1. Lint + Typecheck + Test                                 │
│   2. Docker Build (buildx + gha cache)                       │
│   3. Push to GHCR:                                           │
│      - ghcr.io/orime-org/breatic:test_thinkai_cc             │
│      - ghcr.io/orime-org/breatic-web:test_thinkai_cc         │
└────────────────────┬─────────────────────────────────────────┘
                     ▼
┌──────────────────────────────────────────────────────────────┐
│           阿里云香港 ECS（<服务器IP>）                       │
│                                                              │
│   Cron（deploy 用户，每 5 分钟一次）                         │
│     └─> /opt/breatic/auto-deploy.sh                          │
│            ├─ 检查 git HEAD                                  │
│            ├─ docker compose pull（对比 digest）             │
│            └─ 任一变化 → /opt/breatic/deploy.sh              │
│                 ├─ git fetch + reset --hard                  │
│                 ├─ docker compose pull                       │
│                 ├─ docker compose up -d                      │
│                 ├─ docker image prune -f                     │
│                 └─ curl /api/health（自检）                  │
└──────────────────────────────────────────────────────────────┘
                     ▼
                 <域名> 更新完成
```

**端到端延迟**：push 后约 5-15 分钟（CI 构建约 2-10 分钟 + cron 轮询最大 5 分钟）。

---

## 服务器基本信息

| 项 | 值 |
|---|---|
| 云厂商 | 阿里云香港 ECS |
| 公网 IP | `<服务器IP>` |
| 操作系统 | Ubuntu 22.04 LTS |
| 配置 | 2 核 4 GB（Swap 4 GB） |
| 项目根目录 | `/opt/breatic` |
| 部署用户 | `deploy`（属 `docker` 组） |
| 运维用户 | `root`（密钥登录） |

### DNS & 证书

| 项 | 配置 |
|---|---|
| DNS 服务商 | Cloudflare |
| 代理模式 | **DNS only（灰色云）**—— Hocuspocus WebSocket 不能走 Cloudflare 代理 |
| 规范域名 | `www.<域名>`（apex `<域名>` 经 nginx 301 跳转） |
| SSL 证书 | 用户自备，放在 `/opt/breatic/docker/certs/cert.pem` + `cert.key` |
| 证书覆盖 | 必须同时覆盖 `<域名>` 和 `www.<域名>`（或通配符 `*.<域名>`） |

### 网络开放端口

| 端口 | 用途 | 来源 |
|---|---|---|
| 22 | SSH | `0.0.0.0/0`（密钥认证，禁密码） |
| 80 | HTTP（会 301 到 HTTPS） | `0.0.0.0/0` |
| 443 | HTTPS | `0.0.0.0/0` |

---

## 自动部署流程

### 触发

- **自动**：cron 每 5 分钟调用 `auto-deploy.sh`，检测到 git 或 GHCR 镜像有变化时触发
- **手动**：SSH 到服务器以 deploy 身份执行 `/opt/breatic/deploy.sh`

### `auto-deploy.sh`（静默探测层）

位置：`/opt/breatic/auto-deploy.sh`
属主：`deploy:deploy`
权限：`0755`

职责：
- `git fetch` + 比较 HEAD
- `docker compose pull` + 根据输出判断镜像是否有更新
- 两者都无变化则**静默退出**（不写日志）
- 任何一方变化则调用 `deploy.sh`，输出追加到 `/opt/breatic/logs/auto-deploy.log`

### `deploy.sh`（无条件部署层）

位置：`/opt/breatic/deploy.sh`
属主：`deploy:deploy`
权限：`0755`

职责（按顺序）：
1. `git fetch origin test_thinkai_cc && git reset --hard`
2. `docker compose pull`（拉最新镜像）
3. `docker compose up -d`（只重建 image 变化的服务）
4. `docker image prune -f`（清理 dangling layers）
5. `sleep 10 && curl /api/health`（自检，失败 exit 1）

**不带自检检查的话，ffmpeg 启动慢会误判"成功"**——所以健康检查必须保留。

### Cron 调度

用户：`deploy`
内容：

```
*/5 * * * * /opt/breatic/auto-deploy.sh
```

查看：`sudo -u deploy crontab -l`
编辑：`sudo -u deploy crontab -e`

### 日志位置

| 日志 | 作用 |
|---|---|
| `/opt/breatic/logs/auto-deploy.log` | 自动部署历史（只在有变化时写） |
| `/opt/breatic/logs/api/api.*.log` | API 服务日志（pino-roll 按天） |
| `/opt/breatic/logs/collab/collab.*.log` | Collab 服务日志 |
| `/opt/breatic/logs/worker/worker.*.log` | Worker 服务日志 |
| `/opt/breatic/logs/nginx/` | Nginx 访问 / 错误日志 |
| `/var/log/syslog` | cron 调用记录（grep auto-deploy 查看） |

---

## 一次性初始化（灾难恢复用）

当服务器需要**从零重建**（系统重装、换机器）时，按此流程。

### 1. 操作系统

阿里云控制台 → 实例 → 更换操作系统 → **Ubuntu 22.04 LTS**。

### 2. 安全组（入方向规则）

TCP/22、TCP/80、TCP/443 对 `0.0.0.0/0` 放行。

### 3. 安装 Docker

```bash
curl -fsSL https://get.docker.com | sh
```

### 4. Swap（可选但推荐）

```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 5. 创建 deploy 用户

```bash
sudo useradd -m -s /bin/bash deploy
sudo usermod -aG docker deploy
sudo mkdir -p /home/deploy/.ssh
sudo chmod 700 /home/deploy/.ssh
sudo chown deploy:deploy /home/deploy/.ssh
```

### 6. SSH 密钥配置

把本地 `~/.ssh/thinkai_deploy.pub` 的公钥追加到 `/home/deploy/.ssh/authorized_keys`：

```bash
sudo tee -a /home/deploy/.ssh/authorized_keys <<'KEY'
ssh-ed25519 AAAA... github-actions-thinkai-cc
KEY
sudo chmod 600 /home/deploy/.ssh/authorized_keys
sudo chown deploy:deploy /home/deploy/.ssh/authorized_keys
```

### 7. 克隆项目

```bash
sudo mkdir -p /opt/breatic
sudo chown deploy:deploy /opt/breatic
sudo -u deploy git clone -b test_thinkai_cc https://github.com/orime-org/breatic_ai.git /opt/breatic
sudo -u deploy git config --global --add safe.directory /opt/breatic
```

### 8. 配置 `.env`

```bash
sudo -u deploy cp /opt/breatic/.env.docker /opt/breatic/.env
sudo -u deploy nano /opt/breatic/.env
```

**必填项**：
- `ENV=staging`
- `SESSION_SECRET_KEY=<随机 16+ 字符>`
- `BREATIC_TAG=test_thinkai_cc`（让 compose 拉 test 分支镜像，不是 main 的 `:latest`）
- `ALLOWED_ORIGINS=http://localhost:8000,https://www.<域名>,https://<域名>`
- 至少一个 LLM key（推荐 `OPENROUTER_API_KEY`）
- AIGC / Stripe / OAuth 按需

保存后：
```bash
sudo chown deploy:deploy /opt/breatic/.env
sudo chmod 600 /opt/breatic/.env
```

### 9. 放 SSL 证书

```bash
sudo cp /path/to/<域名>-fullchain.pem /opt/breatic/docker/certs/cert.pem
sudo cp /path/to/<域名>.key /opt/breatic/docker/certs/cert.key
sudo chown -R deploy:deploy /opt/breatic/docker/certs
sudo chmod 644 /opt/breatic/docker/certs/cert.pem
sudo chmod 600 /opt/breatic/docker/certs/cert.key
```

### 10. 部署脚本

参考 [运维操作 → 重建 deploy.sh/auto-deploy.sh](#重建部署脚本)。

### 11. 配 cron

```bash
sudo -u deploy crontab -e
# 选 1 (nano)
# 加一行：*/5 * * * * /opt/breatic/auto-deploy.sh
```

### 12. 首次部署

```bash
sudo -u deploy /opt/breatic/deploy.sh
```

### 13. DNS 更新

如果 IP 变了，去 Cloudflare DNS 更新 A 记录。**确保灰色云**（DNS only，不走代理）。

---

## 常见运维操作

### 手动强制重新部署

```bash
sudo -u deploy /opt/breatic/deploy.sh
```

### 查看当前容器状态

```bash
sudo -u deploy bash -c 'cd /opt/breatic && docker compose ps'
```

### 查看某服务实时日志

```bash
sudo -u deploy bash -c 'cd /opt/breatic && docker compose logs -f api'
# 或 collab / worker / web / postgres / redis
```

### 修改 `.env` 并让改动生效

```bash
# 编辑
sudo -u deploy nano /opt/breatic/.env

# 只重启受影响的服务（而非全部）
# 大多数 .env 改动只影响 API / Worker / Collab，web/postgres/redis 不受影响
sudo -u deploy bash -c 'cd /opt/breatic && docker compose restart api worker collab'
```

### 改 `VITE_*` 前端变量（现已不需要）

> ⚠️ **现在前端用相对 URL，不再有 `VITE_API_URL`/`VITE_WS_URL`/`VITE_BASE_URL`**。
> 前端永远通过 `window.location` 推算 API 地址，所以**同一个镜像可以跑在任何域名上**。以前改 VITE 变量必须重建镜像的坑不再存在。

### 暂停自动部署（冻结版本）

```bash
# 删除 cron 条目
sudo -u deploy crontab -e
# 在 */5 * * * * ... 那行前加 # 注释掉，保存退出

# 恢复时去掉 # 即可
```

### 切换到某个历史版本

`.env` 里把 `BREATIC_TAG` 改成具体版本号（如 `BREATIC_TAG=1.2.3`）或特定 commit 对应的镜像 tag，然后：

```bash
sudo -u deploy bash -c 'cd /opt/breatic && docker compose pull && docker compose up -d --force-recreate'
```

### 手动回滚到"昨天的部署"

Docker 没有内置"回滚"。两种做法：

**方法 A：通过 git revert**
```bash
# 本地
git revert <问题commit>
git push origin test_thinkai_cc
# 等 CI 出新镜像 + cron 自动部署
```

**方法 B：指定 tag**
`BREATIC_TAG=<历史 commit 的短 sha>`（需要 CI 为每个 commit 也打 tag，看 CI 配置是否支持）

### 备份数据库

```bash
sudo -u deploy bash -c 'cd /opt/breatic && docker compose exec -T postgres pg_dump -U breatic breatic' > /tmp/breatic-$(date +%F).sql
```

### 清理磁盘

```bash
# 看谁占空间
sudo du -sh /opt/breatic/logs /opt/breatic/uploads 2>/dev/null

# 清 Docker 悬挂镜像 / 缓存 / 旧容器
sudo docker system prune -f

# 清 pino 老日志（>30 天）
sudo find /opt/breatic/logs -name '*.log.*' -mtime +30 -delete
```

### 重建部署脚本

如果 deploy.sh / auto-deploy.sh 丢了或出错，参考 [docs/internal/DEPLOY-THINKAI.md](./DEPLOY-THINKAI.md)（本文件）自己，或直接从 git 历史里找：

```bash
git log -- '*deploy*.sh' 2>/dev/null
```

### 更新 SSL 证书

```bash
sudo cp /path/to/new-cert.pem /opt/breatic/docker/certs/cert.pem
sudo cp /path/to/new-cert.key /opt/breatic/docker/certs/cert.key

# nginx 容器的 entrypoint 启动时读证书，需要重启才能加载新证书
sudo -u deploy bash -c 'cd /opt/breatic && docker compose restart web'
```

---

## 故障排查

### 线上访问 `<域名>` 502 / 500

```bash
# 1. 看容器状态
sudo -u deploy bash -c 'cd /opt/breatic && docker compose ps'
# api/collab/worker 必须是 Up；migrate 应是 Exited (0)

# 2. 看 API 日志
sudo -u deploy bash -c 'cd /opt/breatic && docker compose logs --tail=100 api'

# 3. 健康检查
curl http://localhost:3000/api/health
# 应返回 {"status":"ok",...}
```

### 自动部署没触发（push 后久等无反应）

```bash
# 1. CI 是否完成 + 镜像推上了 GHCR？
# 浏览器看 https://github.com/orime-org/breatic_ai/actions

# 2. 服务器 cron 是否在跑？
sudo grep auto-deploy /var/log/syslog | tail -5
# 应该有每 5 分钟一次的 CRON 调用记录

# 3. auto-deploy 的日志（只在有变化时才有内容）
tail /opt/breatic/logs/auto-deploy.log

# 4. 手动跑 auto-deploy 看输出
sudo -u deploy /opt/breatic/auto-deploy.sh
echo "Exit: $?"
```

### deploy.sh 里 `docker compose pull` 报 `permission denied`

`.env` 文件权限或属主问题。修复：
```bash
sudo chown deploy:deploy /opt/breatic/.env
sudo chmod 600 /opt/breatic/.env
```

### `git fetch` 报 `detected dubious ownership`

```bash
sudo -u deploy git config --global --add safe.directory /opt/breatic
```

### 容器全部 Created 但不 Running

多半是 migrate 失败卡住。
```bash
sudo -u deploy bash -c 'cd /opt/breatic && docker compose logs migrate'
```

看具体错（如 `yjs_documents already exists` 类的历史 bug）。如果确认是环境损坏，可以：
```bash
# ⚠️ 会清空数据库数据，确认能接受再跑
sudo -u deploy bash -c 'cd /opt/breatic && docker compose down -v && docker compose up -d'
```

### 内存不足 OOM

```bash
# 看 OOM killer 记录
sudo dmesg -T | grep -i oom | tail -10

# 看 swap 是否开
free -h
# Swap 应 > 0
```

### Cron 跑不起来 / 每次都报错

1. 检查 shebang 是否**顶格**（第一行必须是 `#!/bin/bash` 前无任何空格）
   ```bash
   head -1 /opt/breatic/auto-deploy.sh | cat -An
   # 应显示：#!/bin/bash$
   ```
2. 检查文件属主和权限
   ```bash
   ls -la /opt/breatic/*.sh
   # 应是：-rwxr-xr-x 1 deploy deploy ...
   ```

---

## 历史踩坑记录

> 这些问题当时都花了时间定位，记下来避免重复踩。

### 1. GitHub Actions SSH 到阿里云 HK 超时

**现象**：appleboy/ssh-action 报 `dial tcp ***:***: i/o timeout`，但本机 SSH 正常。

**根因**：GitHub Actions runner 在 Azure 网络，**Azure 与阿里云 HK 之间的 BGP 路由被过滤**，port 22 发出去的 SYN 被丢弃。

**解决**：弃用 GitHub Actions SSH 方案，改为**服务器端 cron 轮询**（本文档架构）。

### 2. Docker 在 2C2G 上 OOM

**现象**：`docker compose up --build` 在 2 核 2G 的阿里云实例上构建镜像被 OOM killer 杀。

**根因**：`pnpm install` 峰值 1.5-2 GB + `turbo build` 叠加 1 GB，2 GB 总内存根本不够。

**解决**：升级到 2C4G + 启用 4GB swap。后来切换到镜像仓库模式（构建在 CI，服务器只拉镜像），问题彻底消失。

### 3. Cloudflare Proxy 导致 Hocuspocus WebSocket 频繁断连

**现象**：画布协作功能时 WebSocket 每 100 秒断开重连。

**根因**：Cloudflare 橙色云代理的 WebSocket 免费版**硬超时 100 秒**。

**解决**：Cloudflare DNS 改为**灰色云（DNS only）**，WebSocket 直连服务器 nginx。

### 4. Electerm 粘贴脚本给 shebang 加缩进

**现象**：cron 跑 auto-deploy.sh 每次都报 `Illegal option -o pipefail`。

**根因**：Electerm 粘贴 heredoc 时自动给每行前加了 2 个空格，导致 `#!/bin/bash` 前有空格，内核不识别 shebang，fallback 到 `/bin/sh`（Ubuntu 上是 dash），dash 不支持 `pipefail`。

**解决**：用 `sed -i '1s/^[[:space:]]*//' file` 去掉行首空格；或用 `python3` heredoc 写文件（不经 shell 解析）。

### 5. `.env` 属主是 root，deploy 读不了

**现象**：`docker compose pull` 报 `open /opt/breatic/.env: permission denied`。

**根因**：`.env` 是 root 用 `cp .env.docker .env` 创建的，属主 root / 权限 600，deploy 读不到。

**解决**：`sudo chown deploy:deploy /opt/breatic/.env`。**所有 `/opt/breatic` 下的文件都应属 `deploy`**。

### 6. 前端资源路径 `/breatic/` 404

**现象**：console 一堆 `Failed to load module script` 错误，资源路径是 `/breatic/assets/*.js` 但 nginx 返回 HTML。

**根因**：Vite 构建时 `base` 被设成 `/breatic/`，但 nginx 只从根目录 `/` 提供静态文件。

**解决**：已在主仓库修正（PR #110），Vite `base=/` 一律从根起步。

### 7. 迁移失败 `yjs_documents already exists`

**现象**：API 启动时报 `relation "yjs_documents" already exists` 无限重启。

**根因**：旧版 API/Worker 启动时都会跑迁移，两个并发跑时有竞争。

**解决**：主仓库 PR #107 把迁移抽成**独立 migrate 容器**（`service_completed_successfully`），严格串行。PR #108 又修了 migrate 的 `node_modules` 解析路径（从 `packages/server` 的 workdir 跑）。

### 8. `VITE_API_URL=https://<域名>/api` 导致 `/api/api/v1/*` 404

**现象**：前端请求路径重复了 `/api`，变成 `https://<域名>/api/api/v1/*`。

**根因**：前端代码内部就有 `/api/v1/` 前缀，`VITE_API_URL` 不该再带 `/api`。

**解决**：PR #111 修正了 `.env.docker` 模板。**前端现已迁移到相对 URL**（PR #120），从根本消除此类 VITE 变量拼接问题。

---

## 相关链接

- [DEPLOY.md](../DEPLOY.md) — 通用部署文档（面向所有自托管用户）
- [FRONTEND.md](../FRONTEND.md) — 前端架构
- [YJS.md](../YJS.md) — 画布协作技术规范
- [CLAUDE.md](../../CLAUDE.md) — 项目快速索引

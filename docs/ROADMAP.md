# Roadmap

## Alpha — Core Flow（让整个链路跑通）

**目标**：一个用户能打开画布 → 和 Agent 对话 → 生成 AIGC 内容 → 看到结果。

### API + Worker

- [x] 前后端 API 对接：shared Zod schemas，8 个前端 API 文件，类型共享
- [x] API key 配置 + Agent 聊天验证：OpenRouter + WaveSpeed 实测通过
- [x] AIGC 图片生成全链路：canvas/tasks → Worker → WaveSpeed → 下载 → 本地存储
- [x] Storage 统一重构：Transport 返回 raw bytes，Worker 统一 persist（buffer 上传 + CDN 下载）
- [x] 模型目录精简：~102 → 50 个模型，只保留顶尖模型
- [x] AIGC 调用耗时记录：tasks 表 duration_ms 列，performance.now() 计时
- [x] 阿里云 OSS 存储：AIGC 结果上传 OSS，CDN 前缀 resource.visiony.cc
- [x] WaveSpeed 参数修复：null 值过滤 + MiniMax lyrics fallback
- [x] Image + Audio 模态验证：nano-banana-pro (54s) + minimax-music-2.5 (119s) 全链路通过
- [x] 全模态 AIGC 验证：Video/TTS/3D 全部通过，含 OSS 存储 + durationMs
- [x] 视频封面提取：ffmpeg 抽首帧上传为 cover_url
- [x] Drizzle migration：last_consolidated_turn、tokens_used、model、provider 已就位
- [ ] 集成测试：testcontainers 真实 PG + Redis，覆盖核心链路

### Collab

- [x] Yjs 文档结构规范：canvas Map-of-Maps schema、状态机、事件流、锁语义已落地；CanvasNodeFields + AttachRef 共享类型在 @breatic/shared
- [x] Canvas 节点同步：Redis Streams + 节点锁，API/Worker/Collab 三方事件驱动写入 canvas.nodesMap
- [x] Canvas Yjs-first 同步架构：前端写操作直接写 Yjs nodesMap/edgesMap，observe 回调同步 Redux（只读缓存），删除旧的 Redux↔Yjs 双向桥
- [x] Canvas 嵌套 data Y.Map：节点结构镜像 ReactFlow `{ id, type, position, data }`，增量 observe 只重建变更节点
- [ ] Awareness 集成：光标位置、在线用户列表、正在编辑的节点高亮

### Frontend

- [x] 前端组件迁移：27 组件从 useProjectStore 迁移到 useCanvasData/Actions/UI
- [x] 安全加固：XSS 清洗（DOMPurify）、Auth 限速、FK restrict、锁 CAS 验证、presign 安全、prompt 提取
- [x] 测试覆盖恢复：17 文件 65 测试（从 5 文件 21 测试）
- [ ] 前后端联调：SSE 流式聊天跑通，AIGC 任务状态同步
- [ ] 模型参数动态表单：根据 `GET /api/v1/models` 返回的 params 动态渲染 UI（模态模板 + tier 过滤）
- [ ] 认证页面：登录 / 注册 / Google OAuth 对接后端 auth 路由
- [ ] Agent 聊天界面：SSE 流式输出 + plan 确认交互

### DevOps

- [x] Docker build 验证通过（CI + 本地）
- [x] 日志系统：pino-roll daily rotation，per-service 子目录（api/worker/collab/nginx），双时间戳（ISO + epoch）
- [x] Logger 改为 initLogger(serviceName) 模式，Worker 显式调用 initLogger("worker")
- [x] Nginx 日志轮转：logrotate，30 天保留，日志写到 logs/nginx/
- [x] Pre-commit hook：拦截 .env 和密钥文件
- [x] Docker 镜像优化：pnpm deploy --filter，1.12GB → 357MB（-68%）
- [x] DB auto-migrate：API + Worker 启动时自动运行 Drizzle migration
- [x] Nginx 反向代理：前端容器 73MB，统一入口 port 80，SSE + WebSocket proxy
- [x] Nginx SSL auto-detect：entrypoint.sh 检测证书，自动选择 HTTP/HTTPS
- [x] VITE_* build-arg：Docker build 时从 .env 传入前端环境变量
- [x] Redis 拆分为 3 个逻辑 DB（REDIS_URL/REDIS_QUEUE_URL/REDIS_STREAM_URL）
- [x] Package exports → dist/，turbo dev dependsOn ^build，消除 import.meta.dirname 脆弱性
- [x] .env.dev + .env.docker 双模板，替代 .env.example
- [x] 登录页完整修复：response parsing、用户信息显示、Google OAuth 头像同步、401 循环修复
- [ ] CD pipeline：GitHub Actions → Docker build → 自动部署

---

## Beta — User Ready（用户可以日常使用）

**目标**：创作者能注册、充值、创作完整的多模态项目。

### 产品功能

- [ ] 积分购买页面：Stripe Checkout 跳转 + 余额显示 + 购买历史
- [ ] 项目管理：创建/删除/重命名项目、项目列表、缩略图
- [ ] 节点交互（canvas-native，PR-C 起）：
  - text 富文本：✅ TipTap 富文本编辑器（左侧全屏面板，绑定 `data.prompt` Y.XmlFragment）
  - canvas-native mini-tools：image.crop / image.adjust / image.remove-bg / video tools / audio tools 逐条接入（前端 `new/` 分支开发中）
  - 节点悬浮菜单（selected 节点上方）+ 底部工具栏：PR-C 范畴
  - text mini-tools UI：10 个 text mini-tool 的 slash-menu 接入待确认
- [ ] i18n 前端接入：统一 i18n 方案（前后端共享或独立），语言切换 UI

### 画布协作

- [x] 节点编辑器文档（Phase 1）：per-node Yjs 文档 `project-{id}/node/{nodeId}` 支持文本/混合编辑器 —— PR #138 + #140。已在 Phase 2 替换为 canvas-native 模型（见下方 Phase 2）
- [x] **Phase 2: canvas-native 架构前向修复（PR #13 后端 + PR #14 前端）**：单项目 Yjs 文档（`project-{id}`），取消 per-node 编辑器子文档；NodeStateUpdateEvent 统一事件形态（替代 handling/completed/failed 三事件）；节点状态机 idle/handling（Yjs）+ localPending（本地）；后端不再持有 per-node Redis 锁；操作产生新兄弟节点；1:N 支持（targetNodeIds）
- [ ] 文档权限控制：onAuthenticate 中按 project 成员关系校验，支持 readOnly
- [ ] 多实例负载均衡验证：Redis extension 跨实例同步测试

### AI 能力

- [ ] Canvas Skill：各模态智能模式 Skill（scope: canvas，单次执行，直接生成）
- [ ] 模型推荐引擎：Agent 根据用户意图自动选择最佳模型，不需要用户手动选

### 安全

- [ ] Skill 安全分级：内置 Skill 可用 run_script，第三方禁止；未来按需开放 isolated-vm / Docker 沙箱 / Webhook
- [x] 上传改为 presigned URL：`GET /assets/presign` → 直传 S3/OSS/本地，前端不持有 credentials

---

## GA — Public Launch（公开发布 + 开源社区）

**目标**：稳定运行、全球可用、社区可贡献。

### 平台

- [ ] MCP Server 层：暴露 breatic_chat / breatic_create_task / breatic_list_skills 给外部 AI 调用
- [ ] Skill 市场基础：Skill 提交 / 审核 / 安装流程
- [ ] 文档 GC 策略：定期清理孤立 Yjs 文档（项目已删除但 yjs_documents 还在）

### 运营

- [ ] 前端部署到 CDN（Vercel / Cloudflare Pages）
- [ ] CD Pipeline：GitHub Actions → Docker build → 自动部署
- [ ] 监控：Sentry 错误追踪 + 基础性能指标
- [ ] CONTRIBUTING.md：贡献指南、Code of Conduct、PR 模板

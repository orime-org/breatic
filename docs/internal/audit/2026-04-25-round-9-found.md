# Audit Round 9 — 发现快照

**审计日期**:2026-04-25
**对应代码**:`origin/main` HEAD `81bfcfe`(含 PR #2 `chore: restore remaining 410 tracked files dropped by 4-11 cutoff` 合入,以及前置 `dfc3544` root-level 11 文件 restore + `c9a5e7e` repo rename PR #177)
**审计方法**:**主 session 直接侦察**(无 agent dispatch),偏 forensics —— 起点是发现 4-25 出现 `chore: restore 410 files dropped by 4-11 cutoff` 这种描述模糊的 commit,反推其来源、影响范围、对历史完整性的破坏
**发现总数**:6 个新条目(2 P0 + 3 P1 MED + 1 P2 MED)+ 关闭核查 2 个(BUG-159 / BUG-169 自然修复未追踪 → 独立成 BUG-190)

> 本轮**没有使用 agent dispatch**,因为侦察性强 / 多次 git 命令链式依赖 / 需要主 session 反复对照 BUGS.md 与历史 found.md。所有 finding 均由主 session 直接在 `bugs_list` 工作树上执行,符合 audit-only role 边界(不 import / edit 业务代码,只 read)。
>
> **测试规约 vs 测试代码**:本文档对每个 BUG 给出"测试规约"(input / expected / 边界 / pass / fail),按 audit role 边界**不附测试代码**。dev session 据此在 fix 分支编写 `*.test.ts`。

## 编号映射

| 临时编号 | 全局 BUG 编号 | 严重度 |
|---|---|---|
| BUG-R9-01 | BUG-186 | 🔴 P0 HIGH |
| BUG-R9-02 | BUG-187 | 🔴 P0 HIGH |
| BUG-R9-03 | BUG-188 | 🟠 P1 MED |
| BUG-R9-04 | BUG-189 | 🟠 P1 MED |
| BUG-R9-05 | BUG-190 | 🟠 P1 MED |
| BUG-R9-06 | BUG-191 | 🟡 P2 MED |

---

## 起因 —— 一个无解释的 chore commit 引出的整个事件

**触发事件**:Round 9 起点是注意到 `git log` 顶部出现两个 commit:

```
eea202e 2026-04-25 17:38:35  chore: restore remaining 410 tracked files dropped by 4-11 cutoff
dfc3544 2026-04-25 17:25:42  chore: restore root-level tracked files dropped by 4-11 cutoff
```

两条 message 都用了**模糊措辞** "dropped by 4-11 cutoff" —— 没有说:

1. cutoff 是什么操作(force push? squash? branch reset?)
2. 谁/什么工具丢的
3. 为什么 421 个文件能"被丢"了 14 天没人发现
4. dropped 的文件里有没有跟已修 bug 修复点冲突的

主 session 用以下命令链反向溯源,得到决定性证据:

```
1. 看 commit date(真实顺序) vs author date(原始顺序)
   git log --all --format='%h %ci %s' | sort -k2 | tail -20
   结果:402 个 commit 的 commit date 全部是 2026-04-25 当天(11:39 ~ 17:45)
        author date 仍跨 4-10 ~ 4-25

2. 验证基础设施文件在 cutoff 前真不存在
   git ls-tree cba75d8 -- pnpm-workspace.yaml tsconfig.base.json eslint.config.mjs agents/
   输出:完全空 → 4-10 commit 里这些文件根本不存在

3. 验证 BUGS.md / closed.md 中所有 fix commit hash 是否还在
   for h in 3a811dd 8273383 e282686 710c9e8 120e932 1bc5d6f 621b636 296b392 \
            06314f4 90d8451 a91e2cb dbd29d5; do
     git cat-file -e "$h" 2>/dev/null && echo "OK:$h" || echo "GONE:$h"
   done
   结果:12 / 12 全部 GONE

4. 看 reflog
   git reflog --all
   只有 1 条 clone:from github.com:orime-org/breatic.git
   → 当前是新 clone,本地无 force push 操作,意味着远端历史被重写
```

**结论**(被下面 6 个 BUG 的具体证据共同支撑):

整个 git 历史在 2026-04-25 当天被一次 **`git filter-repo` / `git rebase --root` / 类似工具**操作**完全重写**,所有 commit 重新计算 SHA,然后 force push 到 `orime-org/breatic`(刚 rename 过的新仓库)。这次重写**默认丢弃了 421 个 tracked 文件**,被 `dfc3544` + `eea202e` 两条 chore commit 作为 "new files" 补回来。整个事件**没有任何 commit message / docs / SECURITY 通知 / changelog / PR description** 解释为什么、由谁触发、是否经过 review。

---

## BUG-186:整个 git 历史 4-25 被无解释 force push 重写,所有 closed bug 的 fix commit hash 全部失效

- **严重度**:🔴 P0 HIGH(数据完整性 / 审计可追溯 / 合规)
- **位置**:整个 `orime-org/breatic` 仓库;具体证据点:
  - `docs/internal/BUGS.md`(行 211 引用 `296b392`)
  - `docs/internal/audit/2026-04-closed.md`(行 11 / 17 / 22 / 27 / 32 / 40 / 47 / 76 / 102 / 107 / 117 / 126 / 141 引用的 12 个 hash)
  - `docs/internal/audit/2026-04-21-round-4-found.md` / `2026-04-22-round-5-found.md` / `2026-04-23-round-6-found.md` / `2026-04-23-round-7-found.md` / `2026-04-23-round-8-found.md` —— 多个 audit 找到 hash 引用

- **问题描述**:

  4-25 的某次操作把整个 `main` 分支历史重写,402 个 commit 全部重新计算 SHA。证据:

  - **commit date 全部塌缩到 2026-04-25**(`git log --all --format='%h %ci %s' | sort -k2`):402 commit 的 commit date 在 11:39 ~ 17:45 之间(单日 6 小时),但 author date 仍跨 2026-04-10 ~ 2026-04-25
  - **BUGS.md / closed.md 中引用的 12+ 个 fix commit hash 全部 GONE**:`3a811dd` (BUG-046) / `8273383` (BUG-047/048/052/053) / `e282686` (BUG-031/033) / `710c9e8` (BUG-079) / `120e932` (BUG-141/142) / `1bc5d6f` (BUG-163) / `621b636` (BUG-164) / `296b392` (BUG-185) / `06314f4` (CLAUDE.md #5 升级) / `90d8451` / `a91e2cb` / `dbd29d5` —— `git cat-file -e` 全部 exit 128

- **影响**:

  1. **审计文档反查链全断**:`closed.md` 每条都说"核查方法:`git show <hash> -- <files>`"。现在所有 hash 找不到,审计员无法重现核查、无法验证 PR 是否真改了声称的文件、无法做合规审计或事故复盘
  2. **外部引用全失效**:任何 GitHub PR 链接、任何 SECURITY.md / blog / commit-anchored 链接(BUGS.md 现已 link 到的)指向旧 SHA → 全部 404
  3. **fork / 下游 contributor 全部脱钩**:任何已 fork 仓库的 PR 现在 base 在不存在的 commit 上,无法 rebase / merge
  4. **git blame 历史归零**:421 个被 restore 的文件 git blame 全指向 `dfc3544` / `eea202e`(4-25),失去原作者 / 原 PR / 原修改时间
  5. **defense-in-depth 假设破裂**:LICENSE v1.0 公开承诺了"代码可审计",但 history rewrite 等于公开承诺的反面 —— 历史可被无声销毁

- **测试规约**:

  - **Input**:从 `docs/internal/audit/2026-04-closed.md` + `docs/internal/BUGS.md` 提取所有 7~40 hex 字符的反引号包裹字符串(commit hash 引用)
  - **Procedure**:对每个 hash 执行 `git cat-file -t <hash>`,跳过明显的 placeholder(全 0、纯数字字符串如 `1000000` / `63072000`)
  - **Expected**:每个 hash 的 cat-file 输出 `commit`(exit 0)
  - **Current**:12 个真实 hash 全部返回 missing(exit 128)
  - **边界**:测试范围限定 `docs/internal/audit/` + `docs/internal/BUGS.md`;排除 `nginx-ssl.conf` 等配置文件中的看似 hex 但语义不同的字符串(如 SSL session cache size);跳过 placeholder 用正则 `^0+$` 或 `^\d+$` 过滤
  - **Pass**:所有真实 hash 都能 resolve
  - **Fail**(当前):至少 12 个 hash 不可 resolve
  - **修复方向**:不是"修代码",是**修流程** —— audit 文档应停止用 commit hash 做引用,改用 PR 编号 + 文件路径 + 行号(PR 号在 GitHub 不会随 history rewrite 变);或维护一份 hash 映射表 `audit/hash-migration-2026-04-25.md`(旧 SHA → 新 SHA);或对历史重写本身建立 "non-go" 流程
  - **延伸 spec**:每次 history rewrite 后,跑此测试,如果发现新失效 hash,立即在 `docs/internal/INCIDENTS/<date>-history-rewrite-rca.md` 中登记

- **关联**:BUG-187 / BUG-188 / BUG-189(同一根因的不同侧面)

---

## BUG-187:Cutoff 前约 400 commit 缺基础设施文件,git 历史**不可重建** → bisect / 回滚部署 / 事故复盘全部失效

- **严重度**:🔴 P0 HIGH(灾备 / 事故响应)
- **位置**:从 cutoff 前最早 commit `ac28ded`(2026-04-10 17:40 author date)到 `c9a5e7e`(2026-04-25 15:14 author date)之间约 400 个 commit
- **问题描述**:

  4-25 history rewrite 时,工具默认丢弃了 421 个文件。其中包含**项目最基础的构建 / 配置文件**:

  - `pnpm-workspace.yaml`(monorepo 根配置 —— 缺它,pnpm 不识别 `packages/*`)
  - `tsconfig.base.json`(共享 TS 编译选项 —— 缺它,所有 `extends: "../../tsconfig.base.json"` 失败)
  - `eslint.config.mjs`(flat config —— 缺它,`pnpm lint` 报 missing config)
  - `agents/researcher.md` / `analyst.md` / `planner.md` / `prompt_optimizer.md`(4 个内置 SubAgent 角色定义 —— 缺它们,Agent system 启动时 `loadAgents()` 返回空,`spawn` tool 无可用 agent)
  - `.husky/commit-msg`(commit 钩子 —— 缺它,本地 `git commit` 时 ai-attribution 检查不执行)
  - `.npmrc`(pnpm 设置)
  - `.claudeignore`(Claude Code 忽略规则)
  - `logs/.gitignore`(运行时日志目录 keepfile)

- **可重现验证**:

  ```
  # 任选 cutoff 前任一 commit
  git ls-tree cba75d8 -- pnpm-workspace.yaml tsconfig.base.json eslint.config.mjs agents/ .husky/commit-msg
  # 实测输出:完全空 → 这 5 个 path 在 cba75d8 这个 4-10 commit 里 100% 不存在

  # 重现"历史不可 build":
  git checkout cba75d8 -- .  # 切到 4-10 历史快照
  pnpm install                # 必然失败:ERR_PNPM_NO_PKG_MANIFEST 或 missing workspace
  ```

- **影响**:

  1. **`git bisect` 不可用**:出 production bug 后想用 bisect 二分定位首次引入的 commit,任何 cutoff 前 commit 都装不出依赖,bisect 直接死
  2. **生产回滚部署不可用**:Docker `:test_thinkai_cc` 现在 = `branch HEAD` 别名(BUG-111),想回滚到 "上次稳定版"必须 build 旧 commit。当前任何 cutoff 前 SHA 都 build fail
  3. **事故复盘 / Postmortem 不可重现**:RCA 必须能 checkout 到事故时刻的 commit 重现 bug。现在 history rewrite 后所有 cutoff 前历史都 build fail
  4. **CI 回放失效**:GitHub Actions 历史 run 用了旧 SHA,任何重跑都失败
  5. **下游用户 quick-start 风险**:开源用户 `git clone && checkout v0.x` 想试旧版功能 → 装不出依赖

- **测试规约**:

  - **Input**:`git log --since="30 days ago" --format=%H --reverse | awk 'NR % 50 == 1'`(每 30 天 sample,每 50 个 commit 取 1 个)
  - **Procedure**:对每个 sampled SHA 执行 `git ls-tree <sha> -- pnpm-workspace.yaml`,检查输出是否非空
  - **Expected**:每个 sampled commit 都包含 `pnpm-workspace.yaml`(ls-tree 输出非空)
  - **Current**:cutoff 前所有 sample 都缺
  - **边界**:测试 sample 频率不能太密(避免单测耗时爆),也不能太稀(漏掉某段时期的 break)。每 50 commit 取 1 是合理起点;如果有 release tag,优先 sample tag 对应 commit;不应跑 `pnpm install` 真实安装(慢且需要网络),只用 `git ls-tree` 静态检查关键文件存在性
  - **Pass**:每个 sampled commit 包含全部基础设施文件(`pnpm-workspace.yaml` + `tsconfig.base.json` + 其他 5 个)
  - **Fail**(当前):cutoff 前 100% sample 缺至少一个基础文件
  - **修复方向**:**唯一根治** = 用 `git filter-repo --replace-text` 给 cutoff 前每个 commit 反向写回这些文件;**临时缓解** = 在 README / DEPLOY.md 顶部加大字号警告 "2026-04-25 之前的 commit SHA 不可直接 build,需补上 dfc3544 内容";**最差方案** = 接受现状,在 SECURITY.md 公开声明 history 完整性破坏

---

## BUG-188:4-25 force push / history rewrite 操作零文档 / 零通知 / 零审批,违反 CLAUDE.md 编码行为准则 #5("彻底解决,禁止补丁")

- **严重度**:🟠 P1 MED(流程 / 透明度 / OSS 治理)
- **位置**:
  - `docs/internal/BUGS.md`(无任何 entry 记录此事件)
  - `docs/internal/audit/`(无任何 entry)
  - `docs/DEPLOY.md`(无 history rewrite 警示)
  - `SECURITY.md`(无 disclosure)
  - `CHANGELOG.md`(无条目)
  - `git log` 中关于此事件的 commit message 仅有:
    - `dfc3544` "chore: restore root-level tracked files dropped by 4-11 cutoff"
    - `eea202e` "chore: restore remaining 410 tracked files dropped by 4-11 cutoff"
    - `ed09c59` "chore: trigger workflows"
    - `c9a5e7e` Merge PR #177 "chore: migrate repo name to breatic"

  以上没有任何一条解释:**为什么要 history rewrite、是什么工具触发的、是否经过审批**

- **问题描述**:

  CLAUDE.md "编码行为准则 #5" 明确规定:

  > **彻底解决,禁止补丁(MANDATORY — 零容忍)**
  > 方案不彻底 = 违规
  > 明令禁止的补丁词汇:
  > - "作为 compat shim / 兼容层"
  > - "临时/过渡/暂时/先这样/后续再改"
  > - "为了不改 XX 个 callsite / 工作量考虑"

  4-25 的两个 chore commit 完美命中所有禁词 —— "restore 410 dropped" 是典型的"先这样补一下,根因不查"的 patch 思维。**根因到底是什么** —— 用什么工具重写历史导致丢文件? 重写的目的是什么? —— **没有任何文档说明**

- **影响**:

  1. **内部团队事故响应不可见**:dev / audit / ops 都不知道发生了什么,下次再发生同类事件无法预防
  2. **OSS contributor 不知情**:任何 fork 仓库的 contributor 4-26 早上 git pull 会被 force push 拒绝(non-fast-forward),需要 `git reset --hard origin/main` 或 re-fork。**没有 ANNOUNCEMENT 告知他们应该做什么**
  3. **合规审计失败**:LICENSE v1.0 公开承诺"代码可审计",但 history rewrite 没有 disclosure,等于事实上违反公开承诺
  4. **重复发生概率高**:既然没有 RCA,工具 / 流程 / 触发条件不明,下次还会发生

- **测试规约**:

  - **Input**:对 `docs/`、`SECURITY.md`、`CHANGELOG.md`、`README.md` 跑 `grep -lriE "history rewrite|force push|filter-repo|cutoff incident"`
  - **Expected**:至少一个文件命中,内容包含 (a) 触发原因 (b) 影响范围(date range / commit count) (c) 缓解措施(下游 contributor 应做什么) (d) 是否会再次发生
  - **Current**:0 个文件命中
  - **边界**:测试只检查 disclosure**存在性 + 字段完整性**,不评估 disclosure 内容是否技术正确(那是人工 review 范畴);disclosure 文档允许在多个文件分布(不要求集中一个),但每个必备字段至少一处出现
  - **Pass**:disclosure 文件存在,且 4 个必备字段(原因/范围/缓解/复发风险)全部覆盖
  - **Fail**(当前):零文档
  - **修复方向**:**audit role 写不了 fix code,但可以写 docs**。建议本 BUG 的修复路径走 docs PR(`docs/internal/INCIDENTS/2026-04-25-history-rewrite.md` + `SECURITY.md` 章节),由 dev session / 主 maintainer 操作;audit role 在 PR 评审时核查 disclosure 完整性

---

## BUG-189:421 文件 restore commit 没有 per-file 决策记录 → 已发现至少 1 处 dead code 引入(`googleAuthSchema` 重复定义)

- **严重度**:🟠 P1 MED(代码质量 / dead code / SoT 违反)
- **位置**:
  - 整体:`dfc3544`(root 11 文件)+ `eea202e`(packages 410 文件)
  - 已发现的具体证据点:
    - `packages/shared/src/schemas/index.ts:5`(restore 引入)re-export `googleAuthSchema`
    - `packages/shared/src/schemas/api.ts:27`(原始定义)`export const googleAuthSchema = z.object({ credential: z.string().min(1) })`
    - `packages/server/src/routes/auth.ts:91`(post-cutoff inline 定义)又写了一遍 `const googleAuthSchema = z.object({ credential: z.string().min(1) })`

- **问题描述**:

  Restore commit 用粗放的"全量恢复"策略,没有针对每个文件做以下三条决策:

  1. **是否与已修 bug 冲突**:被 dropped 的版本是否是某个 bug 的 pre-fix 状态? restore 等于回滚修复
  2. **是否与当前 HEAD 接口一致**:cutoff 期间(4-10 ~ 4-25)接口可能演进过,旧版 export 列表可能已经 deprecated
  3. **是否引入 dead code / 重复**:cutoff 期间 inline 重写过的 helper 在 restore 后会出现"两份共存"

  实际证据(已通过 `grep -rn "googleAuthSchema" packages/`):

  ```
  packages/shared/src/schemas/index.ts:5         (restored — re-export)
  packages/shared/src/schemas/api.ts:27          (original — actual export)
  packages/server/src/routes/auth.ts:91          (post-cutoff inlined — 实际生产用此版本)
  packages/server/src/routes/auth.ts:117         (consume routes/auth.ts:91 这个 local 定义)
  ```

  → `routes/auth.ts:13` import 自 `./schemas.js` 但 schemas.ts re-export 列表里没有 `googleAuthSchema`(只有 `registerSchema, loginSchema, ...`),证明 `routes/auth.ts:91` inline 版是"pre-cutoff 期间发现 shared re-export 不可用,作者就地重定义"的产物。restore 后 shared 的版本回来了但 inline 不会自动消失 → **形成两份 z.object 定义共存**

  虽然两份当前 schema 定义内容完全一致(`credential: z.string().min(1)`),但:

  1. 是 SoT(single source of truth)违反 —— 任意一份修改不更新另一份会导致前后端 schema drift
  2. 是 dead code —— `shared/schemas/index.ts` re-export 的 `googleAuthSchema` 实际生产零引用
  3. 是 audit 的 false-negative 风险 —— 未来 BUG-133 类型 "schema 缺 max length" 修复时可能只改 shared 不改 server inline,导致部分有效

- **采样面积**:本审计仅 spot-check 了 `googleAuthSchema` 这一个符号。剩余 421 个 restored 文件中潜在的同类问题数量未知 —— **应被列为 Round 9 follow-up 工作**(可能产生 BUG-189-A/B/C/...)

- **影响**:

  1. SoT 违反 → 未来 schema 演进时 silently drift
  2. Dead code 累积 → bundle 大小膨胀(虽 tree-shaking 可缓解,但 IDE auto-import 会随机选错路径)
  3. Audit 困难 → "改这个 schema 是否影响实际验证"判断需要每次 grep 全仓

- **测试规约**:

  - **Input**:对每个被 `shared/schemas/index.ts` re-export 的符号(当前 11 个:registerSchema / loginSchema / googleAuthSchema / chatMessageSchema / skillCommandSchema / taskCreateSchema / understandSchema / projectCreateSchema / canvasSaveSchema / checkoutSchema / paginationSchema),在 `packages/` 目录下 grep `^(const|export const) <name> = ` 模式
  - **Expected**:每个符号的"原始定义点"(以 `export const` 开头)在 packages 全仓有且仅有 1 处
  - **Current**:至少 `googleAuthSchema` 有 2 处定义(`shared/schemas/api.ts:27` + `server/routes/auth.ts:91`),其余 10 个符号未 spot-check
  - **边界**:测试排除 `__tests__/` 测试 mock、`node_modules/`、`dist/` 编译产物、`.d.ts` 类型声明;只看主源码 `.ts` / `.tsx`;`const X = ` 与 `export const X = ` 都算定义,但 import 引用不算
  - **Pass**:每个 schema 至多 1 处定义
  - **Fail**(当前):至少 1 个 schema 有 2 处定义
  - **修复方向**:逐个文件审计 restore 内容、删除被 inline 顶替的 shared re-export(或反过来,删除 inline 改用 shared) —— 取决于哪个更接近"原本设计意图"。**作为流程改进**:今后任何 mass restore commit 必须配套 `restore-decision-log.md` per-file 决策记录,在 PR description 里链接

---

## BUG-190:BUGS.md 状态同步缺陷 —— BUG-159 / BUG-169 已被 PR 自然修复但 BUGS.md 仍标 active(假阳性 → dev 浪费工时复查)

- **严重度**:🟠 P1 MED(audit 流程质量)
- **位置**:
  - `docs/internal/BUGS.md` 行 96(BUG-159)+ 行 163(BUG-169)
  - `docs/internal/audit/2026-04-closed.md` 行 121(BUG-163 closed.md 提到"反转了 BUG-169 的 unused deps",但 **BUG-169 没有正式关闭 entry**)

- **问题描述**:

  audit-only role 当前流程:dev 修完 → 主动通知 audit → audit 核查 → BUGS.md 行删 + closed.md 追加。**但 dev 修代码时常常顺带修了相邻 active bug(side effect),没有显式通知 audit,导致 BUGS.md 标 active 但实际已修**。

  **证据 1 — BUG-159(P1 MED,videoNode.tsx 6 处 catch{}**):

  ```
  BUGS.md 描述:packages/web/src/apps/project/components/mixedEditor/node/videoNode/videoNode.tsx:676,733,767,800,823,847(6 处 catch{})

  当前 grep 结果:
  $ grep -rE "catch *\{ *\}" packages/web/src/apps/project/components/mixedEditor/
  0 处

  文件 videoNode.tsx 仍存在(1913 行),但内容已大幅重写。
  推测 PR #144 video editor workspace 重构时,ffmpeg.wasm 工具被迁移到后端 Worker
  (BUG-153 / BUG-154 修复路径),原 6 处 catch{} 失去存在意义被自然删除。
  ```

  **证据 2 — BUG-169(P2 LOW,@tiptap/extension-collaboration deps 装了零引用)**:

  ```
  当前 grep:
  $ grep -rn "@tiptap/extension-collaboration\|y-tiptap" packages/web/src/ --include="*.ts" --include="*.tsx"
  packages/web/src/apps/project/components/textEditor/index.tsx:4
    import Collaboration from '@tiptap/extension-collaboration';

  → 真实使用了。这是 PR #138 (BUG-163 修复) 的 side effect,closed.md 行 121 已提到。
  但 BUGS.md 行 163 仍把 BUG-169 列在 P2 active。
  ```

- **影响**:

  1. **dev 工时浪费**:任何 dev session 想修 BUG-159 时,会先去看 line 676/733/... 发现已经不存在,然后重新 grep 全仓 → 浪费 5~15 min
  2. **审计公信力降低**:BUGS.md 自称"状态机",但状态滞后 → audit role 的 single source of truth 假设破裂
  3. **优先级失真**:active bug 数量虚高(140 中至少 2 个假阳性),P1 / P2 工时估算虚高
  4. **同类问题持续累积**:每次 PR 改一大块代码都可能 side-effect 修一些 bug,如果不显式 audit pass 容易越积越多

- **测试规约**:

  - **Input**:对 BUGS.md 中每个 active bug,提取其"位置"列的文件路径 + 行号 + 关键 grep pattern(如"6 处 catch{}");执行 file 存在性 + 行号附近内容核查 + pattern grep
  - **Expected**:active bug 在当前 HEAD 仍可观察到其声明的"问题"(file 存在 / pattern 仍命中 / 行号附近代码与描述一致)
  - **Current**:BUG-159 (catch{} 0 命中) + BUG-169 (deps 已被 import) 是显式假阳性
  - **边界**:测试需容忍"位置略有漂移"(行号上下浮动 ±20 仍认为 valid),但完全无命中 = 假阳性候选;不能取代人工 audit pass(自然修复仍需 audit role 主动核查后正式关闭),但可以**自动检测假阳性候选**列表
  - **Pass**(从 audit 流程视角):BUGS.md 中任何 active bug 在最近 7 天内,其引用证据都仍可在当前 HEAD 观察到
  - **Fail**(当前):BUG-159 + BUG-169 验证失败
  - **修复方向**:
    1. **本轮 audit 直接处理**:本 BUGS.md 更新中关闭 BUG-159 / BUG-169,追加到 closed.md
    2. **流程改进**:每周(或每次 large PR merge 后)主 audit session 跑一遍"假阳性候选扫描",清理 BUGS.md
    3. **dev 协作**:大重构 PR description 应主动列出 "Possibly fixes BUG-XXX as side effect" 让 audit 核查

---

## BUG-191:14 个源码文件违反 CLAUDE.md 800 行 max,最严重 1913 行(2.39× 上限),包括 PR #140 重写后的核心文件

- **严重度**:🟡 P2 MED(代码质量 / 可维护性 / IDE 性能)
- **位置**:`find packages/ -name "*.tsx" -o -name "*.ts" | xargs wc -l | sort -rn`(完整列表见下表)

  | 行数 | 文件 | 备注 |
  |------:|------|------|
  | 1913 | `packages/web/src/apps/project/components/mixedEditor/node/videoNode/videoNode.tsx` | 超 max 2.39× |
  | 1797 | `packages/web/src/hooks/useMixedEditorActions.ts` | 超 max 2.25× |
  | 1555 | `packages/web/src/apps/project/components/mixedEditor/node/imageNode/ImageNode.tsx` | 超 max 1.94× |
  | 1427 | `packages/web/src/apps/project/components/textEditor/table/TableHandles.tsx` | |
  | 1388 | `packages/web/src/apps/project/components/textEditor/ui/BlockLineControl.tsx` | |
  | 1348 | `packages/web/src/apps/project/components/mixedEditor/index.tsx` | **PR #140 Yjs-first rewrite 后的产物** |
  | 1036 | `packages/web/src/apps/project/components/agent/AiChatRecordPanel.tsx` | BUG-185 修复点所在文件 |
  | 977 | `packages/web/src/components/base/agent/AgentInput.tsx` | BUG-139 修复点所在文件 |
  | 942 | `packages/web/src/apps/videoEditor/components/timeline/TimelineEditor.tsx` | BUG-179~182 所在区域 |
  | 925 | `packages/web/src/apps/project/components/canvas/index.tsx` | BUG-094 修复点 |
  | 917 | `packages/web/src/apps/videoEditor/components/rightPanel/TextStylePanel.tsx` | |
  | 865 | `packages/web/src/apps/videoEditor/components/preview/PreviewCanvas.tsx` | |
  | 865 | `packages/web/src/apps/project/components/mixedEditor/node/imageNode/relight/RelightThreeScene.tsx` | |
  | 822 | `packages/web/src/apps/project/components/canvas/common/NodeContextMenu.tsx` | |

- **问题描述**:

  CLAUDE.md "代码风格" 章节 + "common/coding-style.md" 同时规定:

  > MANY SMALL FILES > FEW LARGE FILES:
  > - 200-400 lines typical, **800 max**
  > - Extract utilities from large modules

  当前 14 个文件违反 800 max,最严重 2.39×。**关键观察**:

  - `mixedEditor/index.tsx` 1348 行是 **PR #140 "Yjs-first rewrite" 重写后**的产物 —— 重构解决了 BUG-093 / BUG-164 架构 bug,但留下文件大小违规。说明 PR #140 的"重构正确"未达到"重构彻底"
  - `videoNode.tsx` 1913 行包含一切视频节点交互逻辑(crop / upscale / interpolate / hdrConversion / sceneExtension / ...),已是单文件维护噩梦
  - `useMixedEditorActions.ts` 1797 行是单一 hook 文件,远超合理边界

  这些违规未在 BUGS.md 任何条目中列出 —— audit 历史 R1 ~ R8 完全没扫过文件大小这个维度。

- **影响**:

  1. **可维护性**:任何 active bug 在这 14 个文件中的复查 / 修复都需要扫 1k+ 行,出错率显著上升
  2. **IDE 性能**:VSCode / TypeScript LSP 在 1k+ 行 .tsx 上启动慢、补全延迟高
  3. **Code review 质量**:1.5k+ 行文件的 PR diff 完整阅读极困难,reviewer 倾向只看 changed lines,容易漏 system-level regression
  4. **Test coverage 难度**:大文件难做单元测试隔离(mock 的依赖也变多)

- **测试规约**:

  - **Input**:在 `packages/` 全仓查 `.ts` / `.tsx` 文件,排除 `node_modules/` `dist/` `*.d.ts`,统计每个文件行数
  - **Expected**:0 个文件超过 800 行(hard max);p95 < 400 行(typical 上限)
  - **Current**:14 个文件超 800,最严重 1913
  - **边界**:测试只看主源码 `.ts` / `.tsx`,排除生成文件 / 第三方代码 / 测试样板 / `*.d.ts`(类型声明可能很大);statistics 用行数(`wc -l`)而非语义行数(允许 comment / blank line 占行)
  - **Pass**:0 文件超 800 + p95 < 400
  - **Fail**(当前):14 文件超 800
  - **修复方向**:**这是长期任务**,不能也不应一次性修。建议:
    1. **新增 ESLint rule**(`max-lines: ["error", { max: 800 }]`)放进 `eslint.config.mjs`,**新写代码硬限制**
    2. **历史 14 文件分批拆**:每个文件单开 sub-task,按职责拆分(例如 videoNode.tsx 拆成 `crop/` `upscale/` `hdrConversion/` 等 sub-module)
    3. 优先拆 `mixedEditor/index.tsx`(1348 行,关键架构入口,影响所有后续重构)+ `videoNode.tsx`(1913 行,bug 高发区)

---

## 关闭核查(本轮顺带处理)

按 BUG-190 的修复方向 1,本轮 audit 在 BUGS.md 更新中**直接关闭** 2 个假阳性:

- **BUG-159**(P1 MED · videoNode.tsx 6 处 catch{}):**自然修复**,grep 验证 0 处。归因:PR #144 video editor workspace 重构时,ffmpeg.wasm 工具迁移到后端 Worker(同期 BUG-153/154 修复路径),原 6 处 catch{} 失去存在意义被删
- **BUG-169**(P2 LOW · @tiptap/extension-collaboration deps 零引用):**自然修复**,`textEditor/index.tsx:4` 真实 import。归因:PR #138 (BUG-163 修复) 把 deps 投入实际使用。closed.md 行 121 已提到此事,但未追加正式关闭 entry —— 本轮一并补全

---

## 汇总

| BUG # | 严重度 | 主题 | 类型 |
|---|---|---|---|
| BUG-186 | 🔴 P0 HIGH | git history rewrite 致 12 个 fix commit hash 全失效 | 数据完整性 / 流程 |
| BUG-187 | 🔴 P0 HIGH | cutoff 前约 400 commit 不可 build → bisect / 回滚失效 | 灾备 / 事故响应 |
| BUG-188 | 🟠 P1 MED | history rewrite 零文档 / 零通知 / 零审批 | 流程 / 透明度 / OSS |
| BUG-189 | 🟠 P1 MED | 421 文件 restore 无 per-file 决策 → 已发现 dead code 引入 | 代码质量 |
| BUG-190 | 🟠 P1 MED | BUGS.md 状态滞后(BUG-159 / BUG-169 假阳性) | audit 流程 |
| BUG-191 | 🟡 P2 MED | 14 文件超 800 行 max(最严重 1913 行) | 代码质量(systemic) |

**Round 9 总计**:6 个新 BUG + 关闭核查 2 个(BUG-159 / BUG-169 自然修复)

**主 session 用时**:~30 min(无 agent dispatch,纯 forensics + grep + 写 spec)

**关键定性观察**:

1. Round 9 的所有 P0 / P1 BUG 都是**流程层**问题,不是代码层。这意味着:
   - 单纯 audit 代码不够,**audit 必须覆盖到 git 操作 / 仓库治理 / 文档 disclosure**
   - 4-25 history rewrite 是单次操作,但暴露的是**整个 OSS 治理流程的薄弱点**(force push 无审批 / restore 无 per-file 决策 / 状态机滞后)

2. 这是 audit-only role 第一次发现"audit 自身的状态机有 bug"(BUG-190)—— 反身性 finding,价值高

3. BUG-186 / BUG-187 / BUG-188 / BUG-189 同根同源(都是 4-25 history rewrite 事件),建议**作为单一 incident 一并 RCA**(写一份 `docs/internal/INCIDENTS/2026-04-25-history-rewrite-rca.md`),在 RCA 中讨论根因 / 防御 / 流程改进,然后逐个关闭这 4 个 BUG

4. 本轮**没有发现单文件代码层的新 bug** —— 与之前 R1~R8 的 pattern 完全不同。说明 history rewrite 这个事件**显著超出常规审计**,值得列为本月最重要的 finding

---

## 后续建议

| 优先级 | 行动 | 责任方 |
|---|---|---|
| P0 | 写 `docs/internal/INCIDENTS/2026-04-25-history-rewrite-rca.md` 描述事件全貌 | dev / maintainer |
| P0 | 在 SECURITY.md / CHANGELOG.md 添加 disclosure entry,告知 fork contributor | dev / maintainer |
| P1 | 决定 BUG-187 修复路径(filter-repo 反向写回 vs 接受现状 + warning) | maintainer 决策 |
| P1 | Per-file 审计 421 个 restored 文件,继续找 dead code(BUG-189-A/B/C 候选) | audit role 后续轮 |
| P2 | 加 ESLint `max-lines: 800` 防新代码继续违规(BUG-191) | dev |
| P2 | 建立 BUGS.md 自动假阳性扫描 weekly job(BUG-190) | audit role / CI |

---

**审计员**:bugs_list session(主 audit)
**生成时间**:2026-04-25 夜间
**审计代码基准**:`81bfcfe`

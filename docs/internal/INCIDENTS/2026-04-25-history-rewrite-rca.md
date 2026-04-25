# Incident RCA · 2026-04-25 Git History Rewrite

| 字段 | 值 |
|---|---|
| **Incident ID** | INC-2026-04-25-001 |
| **标题** | `orime-org/breatic` `main` 分支 git 历史在 2026-04-25 被重写,402 commit 的 SHA 全部重新计算,421 个 tracked 文件被丢失后 restore |
| **发现日期** | 2026-04-25 夜间 |
| **报告人(forensics)** | `bugs_list` audit session(主 audit) |
| **决策人(根因 + 处置)** | **`[待 maintainer 填写]`** |
| **严重度** | 🔴 Critical(数据完整性 / 灾备 / 合规 / OSS 治理 4 个维度同时受影响) |
| **状态** | **🚧 调查中(forensics 完成 / 根因待填 / 处置待决)** |
| **关联 BUG** | [BUG-186](../BUGS.md)(P0)· [BUG-187](../BUGS.md)(P0)· [BUG-188](../BUGS.md)(P1)· [BUG-189](../BUGS.md)(P1)· 详见 [Round 9 found.md](../audit/2026-04-25-round-9-found.md) |

---

> **本 RCA 的 audit / maintainer 分工说明**:
>
> - 第 1~4 节(Executive Summary / 时间线 / 影响范围 / Forensics 证据)由 `bugs_list` audit session 基于本地 git 状态反推得出,**事实层面已确认**
> - 第 5 节(根因)的"触发原因 / 工具 / 操作人 / 触发情境"**audit 不知道**,只能列 hypothesis 候选,**真值待 maintainer 填写**
> - 第 6 节(处置决策)audit 列出每个 BUG 的可选方案 + 复杂度 + 回归面权衡,**最终选哪个由 maintainer 拍板**(CLAUDE.md 编码行为准则 #5 "方案不唯一时不许自己拍板")
> - 第 7 节(防御措施)audit 给建议,maintainer 拍板执行
>
> RCA **完整**(可以 close 关联 BUG)的标准:第 5 / 6 节 maintainer 填完 + 第 7 节防御措施至少一条 in-flight。

---

## 1. Executive Summary(2 分钟读完版)

2026-04-25 当天,`orime-org/breatic`(刚从 `breatic_ai` rename 过来的新仓库名)的 `main` 分支被一次 `git filter-repo` / `git rebase --root` / 类似工具的操作**重写整个历史**,触发以下连锁结果:

1. **402 个 commit 全部重新计算 SHA**(commit date 全部塌缩到 2026-04-25 当天,11:39 ~ 17:45 之间)
2. **421 个 tracked 文件在重写过程中被默认丢弃**,其中包含项目最基础的构建配置(`pnpm-workspace.yaml` / `tsconfig.base.json` / `eslint.config.mjs` / `.husky/commit-msg` / `agents/*.md` 等),由 17:25(`dfc3544`)和 17:38(`eea202e`)两条 chore commit 作为 "new files" 重新加回
3. **`docs/internal/BUGS.md` 与 `audit/2026-04-closed.md` 引用的 12+ 个修复 commit hash 全部失效**(`git cat-file -e` 返回 missing),审计反查链断裂
4. **整个 cutoff 前历史(约 4-10 ~ 4-25 17:25 之间 ~400 commit)不可重建** —— `git checkout` 任意 cutoff 前 commit 后 `pnpm install` 因缺 `pnpm-workspace.yaml` 必失败,`git bisect` / 历史回滚 / 事故复盘三条灾备路径同时失效
5. **整个事件零 commit message 解释 / 零 docs disclosure / 零 SECURITY 通知 / 零 CHANGELOG entry**,违反 CLAUDE.md 编码行为准则 #5("彻底解决,禁止补丁")+ LICENSE v1.0 公开承诺的"代码可审计"

**4 个 BUG(BUG-186 / 187 / 188 / 189)同根同源,都是本事件的不同症状面**,逐个修会相互打架(详见第 6 节),应由本 RCA 统一处置。

---

## 2. 事件时间线(audit 已确认部分)

> 时间均为 commit date(`%ci`)。author date 仍跨 4-10 ~ 4-25,**不反映真实顺序**。

| 时间 | Commit | 操作 | 说明 |
|---|---|---|---|
| ~ 11:39 ~ 14:33 | (一系列 t3-phase6 PR + merge) | t3-phase6 重构 PR (#175 / #176)合入 main | 这些 commit 的 author date 也在 4-25,可能是真实当天工作 |
| 14:53 | `7fb8af1` | `chore: rename repo references from breatic_ai to breatic` | trademark / repo rename 系列开始 |
| 15:04 | `f389ad4` | `chore: trim AI Authorship Policy section, drop tool-specific exposure` | |
| 15:07 | `6abd8d2` | `chore: lead with "AI assistance is fine" in commit author policy` | |
| 15:14 | `c9a5e7e` | Merge PR #177 `chore: migrate repo name to breatic` | repo rename 主 PR 合入 |
| **17:15** | **`ed09c59`** | **`chore: trigger workflows`** | ⚠️ 异常 commit。"trigger workflows" 通常是 force push 后用来重启 CI 的空 commit。**本 RCA 怀疑此 commit 是 history rewrite 的标志点**,但需 maintainer 确认 |
| 17:25 | `dfc3544` | `chore: restore root-level tracked files dropped by 4-11 cutoff` | 11 个 root 文件作为 "new" 加入(包括 `pnpm-workspace.yaml`)。从这一刻开始历史可 build |
| 17:38 | `eea202e` | `chore: restore remaining 410 tracked files dropped by 4-11 cutoff` | 410 个 packages / config / skills 文件作为 "new" 加入 |
| 17:45 | `81bfcfe` | Merge PR #2 `chore/restore-pre-cutoff-tracked-files` | restore 主 PR 合入,事件"善后"完成 |

**audit 推断的事件顺序**(标 ⚠️ 即推测):

1. 14:53 ~ 15:14 期间 maintainer 在主导 trademark 引发的 repo rename
2. 15:14 之后 maintainer ⚠️ **可能** 跑了 `git filter-repo --invert-paths` 或 `git rebase --root` 类型操作来"清理"旧 repo 名引用 / trademark 相关历史
3. 该工具操作**无声丢弃了 421 个 tracked 文件**(可能因为 `--paths-from-file` 误用 / `--invert-paths` 边界条件 / `--mailmap` 副作用 / 或工具默认行为本身就会丢某类文件)
4. 17:15 `ed09c59 chore: trigger workflows` 推送后 CI 失败(因为缺 `pnpm-workspace.yaml`),maintainer 才发现文件丢失
5. 17:25 + 17:38 用 2 个 chore commit 紧急把文件加回 main

**⚠️ 以上 5 步全部是 audit 推测,具体是哪个步骤、用了哪个工具、是否走了 review、是否有 dry-run —— 需 maintainer 在第 5 节填写真值**。

---

## 3. 影响范围

### 3.1 数据完整性影响(已确认)

- **402 个 commit 的 SHA 全部失效**,任何 cutoff 前的旧 SHA `git cat-file -e <sha>` 返回 missing
- 已抽样确认失效的 12 个 fix commit hash(全部出现在 `docs/internal/audit/2026-04-closed.md`):

  | 旧 hash | 关联 BUG | 来源章节 |
  |---|---|---|
  | `3a811dd` | BUG-046 | 2026-04-21 Round 4 |
  | `8273383` | BUG-047 / 048 / 052 / 053 | 2026-04-21 Round 4 |
  | `e282686` | BUG-031 / 033 | 2026-04-22 PR #126 |
  | `710c9e8` | BUG-079 | 2026-04-22 PR #128 |
  | `120e932` | BUG-141 / 142 | 2026-04-23 PR #137 |
  | `1bc5d6f` | BUG-163 | 2026-04-23 PR #138 |
  | `621b636` | BUG-164 | 2026-04-23 PR #140 |
  | `296b392` | BUG-185 | 2026-04-23 PR #153 |
  | `06314f4` | CLAUDE.md #5 升级 commit | 2026-04-23 PR #140 备注 |
  | `90d8451` | BUG-170 引用 | 2026-04-23 Round 6 |
  | `a91e2cb` | BUG-169 引用 | 2026-04-23 Round 6 |
  | `dbd29d5` | BUG-185 audit 发现 commit | 2026-04-23 Round 8 |

- **421 个文件的 git blame 历史归零**:全部指向 `dfc3544` 或 `eea202e`(4-25),原作者 / 原修改时间 / 原 PR 关联**全部丢失**

### 3.2 灾备 / 事故响应影响(已确认)

- **`git bisect` 失效**:`git ls-tree cba75d8 -- pnpm-workspace.yaml` 输出空 → cutoff 前任意 commit `git checkout` 后 `pnpm install` 因缺 workspace 配置失败,bisect 自动 build 链路死
- **生产回滚部署失效**:Docker `:test_thinkai_cc` tag = `branch HEAD` 别名(BUG-111 已记),回滚到"上次稳定版"必须 build 旧 commit。当前任何 cutoff 前 SHA 都 build fail
- **Postmortem 不可重现**:任何 RCA 需要 `git checkout <故障时刻 commit>` 重现 → 全部失败
- **CI 历史重跑失效**:GitHub Actions 历史 run 用了旧 SHA,任何重跑都失败

### 3.3 OSS 治理影响(已确认 + 推测)

- **fork contributor 全脱钩(已确认)**:任何已 fork 仓库 4-26 早上 `git pull origin main` 会被拒绝(non-fast-forward),需要 `git reset --hard` 或 re-fork
- **外部 commit-anchored 链接全失效(已确认)**:GitHub PR description 链接到具体 SHA / blog post / SECURITY.md 引用过的 SHA → 全部 404
- ⚠️ **release tag 是否受影响 (待 maintainer 确认)**:如果有发布过 release tag(如 `v0.1.0` 等),tag 指向的 commit hash 现在是否还有效?
- ⚠️ **release notes / Docker image tag 是否引用旧 SHA (待 maintainer 确认)**:如有,需要同步 disclosure

### 3.4 已发现的代码层副作用(已确认)

由 BUG-189 spot-check 发现:`packages/shared/src/schemas/index.ts:5`(restore 引入)与 `packages/server/src/routes/auth.ts:91`(post-cutoff inline 重定义)出现 `googleAuthSchema` **两份独立定义**。这是 restore 操作没做 per-file 决策的产物。**剩余 421 个文件中潜在的同类 dead code 数量未知**,需要后续审计轮次(Round 10+)逐个 grep 排查。

---

## 4. Forensics 证据(audit 已收集,可重现)

以下命令在当前 `bugs_list` 工作树执行均可重现:

```bash
# 证据 1:402 commit 的 commit date 全部塌缩到 4-25
git log --all --format='%h %ci %s' | sort -k2 | tail -20
# 输出最早 a69a381 11:39:04 → 最晚 81bfcfe 17:45:55

# 证据 2:cutoff 前 commit 缺基础设施
git ls-tree cba75d8 -- pnpm-workspace.yaml tsconfig.base.json eslint.config.mjs agents/ .husky/commit-msg
# 输出:完全空

# 证据 3:12 个 closed bug fix hash 全部 missing
for h in 3a811dd 8273383 e282686 710c9e8 120e932 1bc5d6f 621b636 296b392 \
         06314f4 90d8451 a91e2cb dbd29d5; do
  git cat-file -e "$h" 2>/dev/null && echo "OK:$h" || echo "GONE:$h"
done
# 输出:12 / 12 全部 GONE

# 证据 4:reflog 显示当前是新 clone,本地无 force push 操作
git reflog --all
# 输出:仅 1 条 "clone: from github.com:orime-org/breatic.git"
# → 意味着 force push 发生在远端

# 证据 5:421 文件 restore 列表
git diff --name-only eea202e^..eea202e > /tmp/410.txt
git diff --name-only dfc3544^..dfc3544 > /tmp/11.txt
cat /tmp/410.txt /tmp/11.txt | sort -u | wc -l
# 输出:421

# 证据 6:具体 dead code 例
grep -rn "googleAuthSchema" packages/ --include="*.ts"
# 输出:packages/shared/src/schemas/index.ts:5(restored)
#       packages/shared/src/schemas/api.ts:27(original)
#       packages/server/src/routes/auth.ts:91(post-cutoff inlined)
```

---

## 5. 根因分析

### 5.1 已知事实

- 4-25 当天主导事件的人**有能力 force push 到 main**(本仓库的 admin / maintainer)
- 工具操作**默认丢弃了 421 个文件**,但 17:25 之前 maintainer 没注意到
- 17:15 `ed09c59 chore: trigger workflows` 这个 commit 的命名暗示 CI 失败 / 重启需求

### 5.2 待 maintainer 填写的关键问题

> ⚠️ **以下字段 audit 不知道,无法推测填值。请 maintainer 直接填空。每个字段都影响第 6 节处置决策的方向。**

**5.2.1 触发原因(为什么要 history rewrite?)**

- [ ] **A. trademark 隐藏旧仓库名 / 旧 commit message**(主动决策,目的明确)
- [ ] **B. 清理 leaked 信息 / secrets / PII**(被动响应,合规驱动)
- [ ] **C. 工具误用导致意外 rewrite**(意外事件,无主动意图)
- [ ] **D. 其他原因:** ___________________________

**5.2.2 触发工具**

- [ ] `git filter-repo`(具体参数: ___________________________)
- [ ] `git filter-branch`(具体参数: ___________________________)
- [ ] `git rebase --root`(具体目标: ___________________________)
- [ ] `bfg-repo-cleaner`(具体清理目标: ___________________________)
- [ ] 其他: ___________________________

**5.2.3 触发情境**

- [ ] PR #177(`chore: migrate repo name to breatic`)合入流程的一部分
- [ ] PR #177 合入后单独操作(为何?)
- [ ] 完全独立操作(与 rename PR 无关)
- [ ] 其他: ___________________________

**5.2.4 操作人 + 是否经过审批**

- 操作人: ___________________________
- 是否有第二人 review / approve? □ 是 □ 否
- 是否有 dry-run? □ 是 □ 否
- 操作前是否备份 origin/main 到独立 branch? □ 是 □ 否(如有,backup branch 名: ____________)

**5.2.5 文件丢失为何没立即发现?**

- [ ] 工具未给出 dropped files 报告
- [ ] 给了报告但被忽略
- [ ] 本地 dev environment 因为缓存还能 build,只在 CI 触发后才发现
- [ ] 其他: ___________________________

### 5.3 audit 的 hypothesis(可能完全错,仅供 maintainer 否决用)

> 这些是 audit 看到证据后的合理推测。**如果与真实情况不符,请 maintainer 在 5.2 直接填真值,无需在此回应**。

**Hypothesis A**(audit 倾向):trademark 主动重写 + filter-repo `--invert-paths` 误用

- 为什么 trademark:repo rename 4-25 同日,且 PR #177 message 提到 trademark
- 为什么 filter-repo:符合 "重写所有 commit + 默认丢弃 untracked" 的工具行为
- 为什么 invert-paths 误用:`--invert-paths --paths-from-file=...` 反向 keep 模式下,paths 文件如果只列了"想保留的源码文件",就会丢弃所有不在列表里的 root-level 配置 / agents 目录 / skills 目录 —— 与 421 文件的实际分布完全吻合

**Hypothesis B**(audit 次倾向):合规驱动清理 + 配套问题

- 如果存在过 secret / leaked credential / PII,则需要立即清理 history
- 但若如此,SECURITY.md 应该有 disclosure;当前为空与此假设矛盾

**Hypothesis C**(audit 弱倾向):意外触发

- 例如 git rebase --root 期间因 conflict 处理不当导致部分文件 deleted
- 但 421 文件这种"几乎全部 root + 整个 packages 目录的非 src 部分"的丢失模式,意外触发的概率较低

---

## 6. 处置决策(audit 列选项 + 权衡;maintainer 拍板)

> ⚠️ **以下选项之间存在依赖**(标 →),修复顺序错会让前序工作失效。详见每节末尾的"方案间冲突"。

### 6.1 BUG-186(commit hash 失效)处置选项

| 选项 | 复杂度 | 回归面 | 优点 | 缺点 |
|---|---|---|---|---|
| **A. 全面替换 docs 中所有 hash 引用为 PR 号 / 文件路径 + 行号** | 中(2~3h) | 仅 docs | 永久解决;PR 号在 GitHub 不会随 history rewrite 变 | 无法精确指向某行修改;需要扫描全部 audit docs |
| **B. 维护 hash 映射表 `audit/hash-migration-2026-04-25.md`(旧 SHA → 新 SHA)** | 低(30m) | 仅 docs | 保留精确引用;实施快 | 只是临时桥接;下次 rewrite 又得加一份;增加维护负担 |
| **C. A + B 混合**(关键文档用 PR 号,历史 audit doc 用映射表) | 中(2h) | 仅 docs | 兼顾彻底性与历史可追溯 | 多份依据,审计员需记多个引用风格 |
| **D. 接受现状不修(把 GONE 状态写入 SECURITY.md disclosure)** | 极低(15m) | 仅 docs | 最快 | audit 反查永久断裂;违反 LICENSE v1.0"代码可审计"承诺 |

**audit 推荐**:**C 混合**。理由:audit docs 大量引用 hash 已经做过,直接替换工作量大;映射表低成本兜底;新写 docs 强制走 PR 号引用。但**最终选项请 maintainer 决定**。

**方案间冲突**:**如果 6.2 选了 A(filter-repo 反向写回),则本节所有方案都白做** —— 反向写回会让 SHA 再次全部重新计算,所有映射 / 替换需重做。**6.1 必须等 6.2 决策后才动手**。

### 6.2 BUG-187(cutoff 前 commit 不可 build)处置选项

| 选项 | 复杂度 | 回归面 | 优点 | 缺点 |
|---|---|---|---|---|
| **A. `git filter-repo --replace-text` 反向给每个 cutoff 前 commit 写回 421 文件** | 高(4~8h + 验证) | **再次重写整个 history,所有 SHA 又变一遍** | 历史可重建 / git bisect 恢复 / 灾备能力恢复 | 第二次 history rewrite,fork contributor 再次 broken;**本 BUG-186 / 188 / 189 全部需要二次处置**;LICENSE 公开"代码可审计"承诺再受冲击 |
| **B. 接受现状 + 在 README / DEPLOY.md / SECURITY.md 顶部加大字号警告 "2026-04-25 之前的 commit SHA 不可直接 build,请补 dfc3544 内容后再 build"** | 低(1h) | 仅 docs | 不再触发新 rewrite;诚实 disclosure | 灾备能力永久下降;事故复盘需要手工补文件再 checkout |
| **C. A + B 混合**(反向写回最近 30 天 commit + 更老的接受现状) | 高(3~5h) | 30 天 commit 重写 | 折中;最常用的灾备路径恢复 | 仍会触发部分 rewrite;30 天界定主观 |
| **D. 维护一份 "infra-snapshot 补丁包"(`docs/INCIDENTS/infra-snapshot-2026-04-25.tar`),需要 build 旧 commit 时手工解压到 worktree** | 低(30m) | 零(纯 docs + tar) | 不再触发任何 rewrite;真需要灾备时仍可手工恢复 | UX 差;灾备时多一步;新人不知道存在 |

**audit 推荐**:**取决于 5.2.1 触发原因的真值**:

- 如果 5.2.1 = A(trademark 主动隐藏)→ **选 D 或 B**(再次 rewrite 等于推翻 maintainer 主动决策,不合理)
- 如果 5.2.1 = B(合规清理)→ **选 D**(已 rewrite 不可逆,只能 docs disclosure + 补丁包)
- 如果 5.2.1 = C(工具误用意外)→ **选 A**(反向写回是 undo 误操作的正确路径,但要做好"事件 announcement"二次发布)

**方案间冲突**:**A 会让 6.1 / 6.4 全部需要二次处置**。如果选 A,RCA 必须先 hold,等 A 完成后整个 RCA 重写。

### 6.3 BUG-188(零文档 / 零通知)处置选项

| 选项 | 复杂度 | 回归面 | 优点 | 缺点 |
|---|---|---|---|---|
| **A. 完整 disclosure(本 RCA 公开 + SECURITY.md 章节 + CHANGELOG entry + GitHub Release notes 公告)** | 中(2h) | 仅 docs | 完整透明;符合 LICENSE v1.0 承诺 | 公开承认仓库治理疏漏,可能影响 OSS 信誉 |
| **B. 内部 disclosure 完整 + 外部仅 README 加 "history rewritten on 2026-04-25" 一句** | 低(1h) | 仅 docs | 折中,降低对外曝光 | 外部 contributor 仍可能困惑;事实上仍违反 LICENSE 承诺 |
| **C. 只本 RCA(不公开),不外部 disclosure** | 极低(0,RCA 已写) | 无 | 最快 | 完全违反 OSS 治理标准;LICENSE 公开承诺事实上违反 |

**audit 推荐**:**A 完整 disclosure**。理由:LICENSE v1.0 已公开承诺"代码可审计",失败 disclosure 比承认事件本身更损害 OSS 信誉。但 disclosure 文案需要 maintainer 起草(audit 不能替 maintainer 决定 PR 措辞)。

**方案间冲突**:无,与 6.1 / 6.2 / 6.4 独立。**可立即并行执行**。

### 6.4 BUG-189(421 文件 restore 无 per-file 决策 / dead code)处置选项

| 选项 | 复杂度 | 回归面 | 优点 | 缺点 |
|---|---|---|---|---|
| **A. 全量 per-file 审计 421 个 restored 文件,逐个决策(保留 / 删 / 替换 inline 版)** | 高(估 8~16h,后续审计轮次) | 中(可能改动多个 import / re-export) | 彻底清理 dead code | 工作量大;需要多个 audit 轮次配合 dev session |
| **B. 仅修已发现的 1 处(`googleAuthSchema`)+ 把"全量审计"列为 P2 长期任务** | 低(15m + 长期) | 极小(单文件 import) | 立刻消除最显眼问题 | 剩余 420 文件中的潜在 dead code 仍在 |
| **C. 写一份 audit playbook "如何检测 restore-induced dead code"(grep recipes / 命名规则 / SoT 判定标准),后续 audit 轮次按 playbook 扫** | 中(1.5h) | 仅 docs + 提升后续审计效率 | 流程化,可重复 | 短期内仍有 dead code 残留 |
| **D. B + C 混合** | 中(2h + 长期) | 同 B | 立刻清显眼 + 流程化扫剩余 | 仍需多轮持续 |

**audit 推荐**:**D 混合**。立刻处理 `googleAuthSchema`(BUG-189 主条目),同时建立 playbook 用于 Round 10+ 持续清理。

**方案间冲突**:**如果 6.2 选了 A(反向写回)**,则 421 文件不再是"restored"而是"原本就在历史里",dead code 检测的边界变化,**本节工作需要重做**。

### 6.5 处置顺序与依赖图

```
6.3 BUG-188 disclosure(独立,可立即做)
    ↓
6.2 BUG-187 决策(必须先于 6.1 / 6.4)
    │
    ├─[选 A 反向写回]──→ 6.1 / 6.4 必须等待重写完成后重新规划
    │                    + 二次 announcement
    │
    └─[选 B/C/D 不再 rewrite]──→ 6.1 BUG-186 处置(选 A/B/C/D)
                                  ↓
                                  6.4 BUG-189 处置(选 A/B/C/D)
```

**audit 强烈建议**:**maintainer 先填 5.2 真值 + 选 6.2 方案,然后再决定 6.1 / 6.4**。这两步如果倒过来,大概率返工。

---

## 7. 防御措施(audit 建议;maintainer 拍板)

| # | 措施 | 复杂度 | 优先级 |
|---|---|---|---|
| **D-1** | GitHub branch protection rule:`main` 禁止 force push(包括 admin)<br>设置:Settings → Branches → main → ☑ "Allow force pushes" 关闭 + ☑ "Do not allow bypassing the above settings" 开启 | 极低(5m) | **P0(立即)** |
| **D-2** | CI 加"commit hash 完整性检查"job:在每次 main push 前,验证 `docs/internal/audit/*.md` 中所有引用 hash 都存在(BUG-186 测试规约) | 中(2h) | P1(本周) |
| **D-3** | CI 加"基础设施文件存在性检查"job:在每次 PR 检查 `pnpm-workspace.yaml` / `tsconfig.base.json` / `agents/*.md` 等关键文件存在(BUG-187 测试规约的简化版) | 低(1h) | P1(本周) |
| **D-4** | 仓库治理文档 `docs/internal/GOVERNANCE.md`:明确"history rewrite / force push 必须走 PR + RCA + dual-approval"流程 | 中(2h) | P1(本周) |
| **D-5** | 任何 mass mutation operation(filter-repo / branch reset / tag move 等)前**强制 dry-run + diff 验证 + offsite backup branch** | 流程,人工执行 | P0(立即) |
| **D-6** | 建立 audit role 的 weekly "假阳性扫描" job(BUG-190 测试规约):自动检测 BUGS.md 中已自然修复但未关闭的条目 | 中(2h) | P2(本月) |
| **D-7** | 任何 mass restore commit(>10 文件)必须配套 `restore-decision-log.md` per-file 决策记录,在 PR description 链接(BUG-189 测试规约前置) | 流程,人工执行 | P1(本周) |

---

## 8. RCA 完成 checklist(maintainer 完成后才能 close 关联 BUG)

- [ ] 第 5.2 节(根因)5 个待填字段全部填值(A/B/C/D 选项 + 具体说明)
- [ ] 第 6.1 / 6.2 / 6.3 / 6.4 节方案各选 1 个,记录在表格"已选方案"列
- [ ] 第 7 节防御措施至少 3 条进入 in-flight 状态(有 issue / PR / 配置变更链接)
- [ ] BUG-186 / 187 / 188 / 189 在 BUGS.md 中**链接到本 RCA**(line entry 末尾加 `(by INC-2026-04-25-001)`)
- [ ] **关联 BUG 关闭归档**:在 `docs/internal/audit/2026-04-closed.md` 追加 4 条 entry,关闭原因 = "Closed by RCA INC-2026-04-25-001;详见处置决策第 X 节"
- [ ] 本 RCA 状态从"🚧 调查中"改为"✅ 已 close"

---

## 9. 附录

- [Round 9 found.md(完整 audit forensics)](../audit/2026-04-25-round-9-found.md)
- [BUG-186 / 187 / 188 / 189 / 190 / 191(BUGS.md)](../BUGS.md)
- [closed.md 中 hash 失效的 12 条 entry](../audit/2026-04-closed.md)

---

**审计员(forensics + 选项列举)**:`bugs_list` audit session
**生成时间**:2026-04-25 夜间
**根因 + 处置决策人**:**`[待 maintainer 填写]`**
**Audit 边界声明**:本 RCA 的第 1~4 节 + 6 节选项列举 + 7 节建议由 audit role 完成,不超出"审计 / 文档"边界(零代码改动)。第 5.2 节根因字段、第 6 节方案选择、第 7 节防御措施执行**必须由 maintainer 接力**,audit role 不替决策。

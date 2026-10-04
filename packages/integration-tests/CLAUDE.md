# @integration-tests — 包边界(MANDATORY)

> 项目级边界见根 [CLAUDE.md](../../CLAUDE.md#关键规范);测试归档规则见 [docs/TEST-MANDATE.md](../../docs/TEST-MANDATE.md#11-一条用例归哪一档mandatory)。

## 角色
**不构建、不部署的测试包。** 两样东西住这里:

- **跨服务的集成测试**(`src/__tests__/`):一次运行里驱动 server / worker / collab 中两个以上的代码。只测一个包的集成测试住那个包自己。判定题:**这条测试读到了别的服务的源码吗?读到 → 住这里。**
- **起容器的集成套件共用的启动**(`src/test-utils/`):`containers.ts` 是 vitest 的 globalSetup,起 PG + Redis、建并迁移业务库和 yjs 库、经 `provide()` 交出六个地址;`env.ts` 是 setupFile,把地址和固定 env 写进每个测试文件的 `process.env`,文件结束时关掉 core 的连接;`provided-context.d.ts` 是 `inject()` 的类型。server、collab 和本包的 `vitest.integration.config.ts` 都引用这三样,**容器启动只有这一份**。

## 可 import 谁
- ✅ `@breatic/core` / `@breatic/domain` / `@breatic/shared`(声明为依赖)
- ✅ server / worker / collab 的**源码**,经 vitest 别名和 tsconfig paths 按路径读(`@server` / `@worker` / `@collab`)
- ❌ **不声明 server / worker / collab 为依赖** —— server 和 collab 依赖本包拿容器启动,反向声明会成环。所以 turbo 看不到这层依赖,`turbo.json` 把三个服务的 `src/**` 列进本包 `typecheck` / `lint` 的 `inputs`,改了服务源码缓存才会失效
- 本包内部用 `@integration-tests/*` 前缀

## 依赖要点
- **`testcontainers` 和 `@testcontainers/postgresql` 每个起容器的包都要声明**(server / collab / 本包,版本在 catalog):vite 解析共用的 `containers.ts` 里的裸模块时,以正在跑的那个包的 root 为基准
- 测试里 `vi.mock` 的外部包(`ai`)也要声明,mock 才能对上被测源码加载的那一份

## 怎么跑
`pnpm turbo run test:integration --filter=@breatic/integration-tests`(要 Docker)。CI 的 `integration-tests` 任务跑全部包的 `test:integration`,本包自动在内。

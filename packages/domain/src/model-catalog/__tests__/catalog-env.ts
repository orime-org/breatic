// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 给目录测试注入一个想要的 provider key 环境。
 *
 * 存在的理由：#1951 之后目录一律按 provider 可用性过滤，没有例外。CI 跑单测
 * 时一个 provider key 都不设（`.github/workflows/ci.yml` 只给数据库和 Redis），
 * 于是目录在那里是空的 —— 而好几个测试要从真实目录里捞一个模型来验，捞不到
 * 就走「没什么可验的」分支提前退出。那些断言从此在 CI 上不执行，而测试照绿。
 *
 * 所以依赖「目录里有东西」的测试得自己把这个前提说出来，不能指望跑它的那台
 * 机器恰好配了 key。
 */

import { initCore } from "@breatic/core";

import {
  getFullModelConfig,
  getModelCatalog,
  resetModelCatalog,
  MODALITIES,
} from "../model-catalog.js";

/**
 * 目录里每个 provider 声明的那个环境变量名。
 *
 * 从配置读而不是写死一份清单：加一个 provider 就多一个变量名，写死的那份会在
 * 没人注意的时候漏掉它，而漏掉的后果正是这个模块要防的（那个 provider 的模型
 * 被过滤掉，依赖它的测试悄悄改走逃生分支）。
 * @returns 全部 provider 的 `api_key_env` 变量名，去重。
 */
export function allProviderKeyNames(): string[] {
  const names = new Set<string>();
  for (const modality of MODALITIES) {
    for (const config of Object.values(getFullModelConfig(modality).providers)) {
      if (config.api_key_env) names.add(config.api_key_env);
    }
  }
  return [...names];
}

/**
 * 只让这些 provider 配着 key，其余全部清空，然后清掉目录缓存。
 *
 * 传空数组就是「一个 key 都没配」。其余环境变量原样保留，因为 core 的 schema
 * 还要校验数据库和 Redis 那些。
 * @param configured - 要保留成非空的 key 名。
 */
export function useEnvWithKeys(configured: readonly string[]): void {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of allProviderKeyNames()) {
    env[name] = configured.includes(name) ? "test-key" : "";
  }
  initCore(env);
  resetModelCatalog();
}

/**
 * 让每个 provider 都配着 key —— 即「目录里所有模型都可用」。
 *
 * 要从真实目录里捞模型来验的测试用它开场，这样跑在哪台机器上都一样，不受那台
 * 机器配了哪些 key 影响。
 *
 * **它自己验一次**：配上全部 key 之后目录仍然是空的，就当场抛错。不验的话这个
 * 函数只是把前提说出口，而说出口挡不住它失效 —— 调用方那些「捞不到模型就提前
 * 退出」的分支照样静默走掉，断言一句不执行而测试全绿，正是它要关掉的那个洞。
 * @throws {Error} 配齐 key 后目录仍为空（yaml 读取或 key 名解析出了问题）。
 */
export function useFullCatalog(): void {
  const keys = allProviderKeyNames();
  useEnvWithKeys(keys);
  if (getModelCatalog().total === 0) {
    throw new Error(
      `useFullCatalog: 配齐 ${keys.length} 个 provider key 之后目录仍然是空的，` +
        `依赖它的断言会静默不执行。设过的变量：${keys.join(", ")}`,
    );
  }
}

/** 把 core 的配置和目录缓存还回进程自己的环境。 */
export function restoreProcessEnv(): void {
  initCore(process.env);
  resetModelCatalog();
}

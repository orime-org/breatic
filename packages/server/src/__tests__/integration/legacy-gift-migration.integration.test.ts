// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** Historical manual gifts migrate only with explicit immutable provenance (inner#1871). */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, mkdtemp, cp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrateDatabase } from "@breatic/core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import fc from "fast-check";

const migration = new URL("../../../../core/src/db/migrations/0110_credit_grants.sql", import.meta.url);
let sql: ReturnType<typeof postgres>;
let statements: string[];
beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false, connection: { application_name: "legacy-gift-migration-test" } });
  statements = (await readFile(migration, "utf8")).split("--> statement-breakpoint");
});
afterAll(async () => { await sql?.end({ timeout: 3 }); });
class Rollback extends Error {}
type Tx = postgres.TransactionSql;
type Confirmation = { schemaVersion: 1; kind: "user_confirmed_historical_manual_gift"; sourceId: string; lotId: string; targetUserId: string; personalStudioId: string; originalCredits: string; sourceCreatedAt: string; lotCreatedAt: string; receiptSha256: string; confirmedAt: string };

/** Each replay owns a transaction; all test DDL and funding fixtures roll back. */
async function replay(body: (tx: Tx, c: Confirmation) => Promise<void>): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`DROP TABLE credit_gifts,credit_compensations,credit_grant_operations`;
    // Earlier integration files leave synthetic funding fixtures. Isolate this
    // replay transaction; its final rollback restores every other file's rows.
    await tx`TRUNCATE credit_sources CASCADE`;
    const c = await seed(tx);
    await body(tx, c);
    throw new Rollback();
  }).catch((err: unknown) => { if (!(err instanceof Rollback)) throw err; });
}
/** An already-spent, independently identified gift, with a live hold and balanced ledger. */
async function seed(tx: Tx): Promise<Confirmation> {
  const userId = randomUUID(), studioId = randomUUID(), sourceId = randomUUID(), lotId = randomUUID();
  const when = "2026-09-01T00:00:00.000Z";
  await tx`INSERT INTO users(id,email) VALUES (${userId},${`${userId}@example.test`})`;
  await tx`INSERT INTO studios(id,created_by_user_id,slug,name,type) VALUES (${studioId},${userId},${studioId.slice(0,30)},'Fixture','personal')`;
  await tx`INSERT INTO studio_members(studio_id,user_id,role) VALUES (${studioId},${userId},'admin')`;
  await tx`INSERT INTO credit_sources(id,kind,created_at) VALUES (${sourceId},'gift',${when})`;
  await tx`INSERT INTO credit_lots(id,source_id,source_kind,user_id,designated_studio_id,purchased_credits,remaining_credits,lifecycle,created_at)
    VALUES (${lotId},${sourceId},'gift',${userId},${studioId},'13.250000','7.125000','active',${when})`;
  await tx`INSERT INTO credit_ledger(payer_user_id,lot_id,studio_id,entry_type,amount) VALUES
    (${userId},${lotId},${studioId},'topup','13.250000'),(${userId},${lotId},${studioId},'spend','-6.125000')`;
  await tx`INSERT INTO credit_holds(studio_id,actor_user_id,reference_id,amount,expires_at) VALUES (${studioId},${userId},${randomUUID()},'0.250000',now()+interval '1 hour')`;
  return { schemaVersion: 1, kind: "user_confirmed_historical_manual_gift", sourceId, lotId, targetUserId: userId, personalStudioId: studioId,
    originalCredits: "13.250000", sourceCreatedAt: when, lotCreatedAt: when, receiptSha256: "a".repeat(64), confirmedAt: "2026-11-01T00:00:00.000Z" };
}
/** Snapshot every funding column, including holds, before replay. */
async function funding(tx: Tx | ReturnType<typeof postgres>): Promise<unknown> {
  const [row] = await tx`SELECT jsonb_build_object(
    'sources',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM credit_sources t),
    'lots',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM credit_lots t),
    'ledger',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM credit_ledger t),
    'holds',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM credit_holds t),
    'debts',(SELECT jsonb_agg(to_jsonb(t) ORDER BY studio_id) FROM studio_credit_debts t)) AS snapshot`;
  return row!.snapshot;
}
/** The explicit confirmation stays transaction-local when the SQL is replayed. */
async function apply(tx: Tx, confirmation?: unknown): Promise<void> {
  if (confirmation !== undefined) await tx`SELECT set_config('breatic.legacy_gift_confirmation',${JSON.stringify(confirmation)},true)`;
  for (const statement of statements) await tx.unsafe(statement);
}

describe("confirmed historical manual gift migration", () => {
  it("preserves every source, lot, ledger, hold and debt column and records no invented historical operator", async () => {
    await replay(async (tx, c) => {
      const before = await funding(tx);
      await apply(tx, c);
      const [gift] = await tx`SELECT id,origin,target_user_id,personal_studio_id,credits::text,created_at,reason,operation_key,requested_by,legacy_confirmation FROM credit_gifts WHERE id=${c.sourceId}`;
      expect(gift).toMatchObject({ id: c.sourceId, origin: "operator", target_user_id: c.targetUserId, personal_studio_id: c.personalStudioId,
        credits: c.originalCredits, reason: null, operation_key: null, requested_by: null, legacy_confirmation: c });
      expect(gift!.created_at).toEqual(new Date(c.sourceCreatedAt));
      expect(await tx`SELECT count(*)::int AS n FROM credit_grant_operations`).toEqual([{ n: 0 }]);
      expect(await funding(tx)).toEqual(before);
    });
  });
  it("refuses a historical manual gift without explicit confirmation", async () => {
    await expect(replay(async (tx) => { await apply(tx); })).rejects.toThrow();
  });
  it.each(["sourceId","lotId","targetUserId","personalStudioId"] as const)("refuses confirmation for the wrong %s", async (key) => {
    await expect(replay(async (tx,c) => { await apply(tx,{...c,[key]:randomUUID()}); })).rejects.toThrow();
  });
  it.each([{ originalCredits: "13.240000" },{ sourceCreatedAt: "2026-09-02T00:00:00.000Z" },{ lotCreatedAt: "2026-09-02T00:00:00.000Z" },
    { originalCredits: 13.25 },{ receiptSha256: "" },{ confirmedAt: "not-a-date" },{ kind: "registration" },{ schemaVersion: 2 }])("refuses mismatched or malformed confirmation %j", async (change) => {
    await expect(replay(async (tx,c) => { await apply(tx,{...c,...change}); })).rejects.toThrow();
  });
  it("refuses a second unconfirmed historical gift", async () => {
    await expect(replay(async (tx,c) => { await seed(tx); await apply(tx,c); })).rejects.toThrow();
  });
  it("refuses a confirmation whose source is another account identity", async () => {
    await expect(replay(async (tx,c) => { await tx`INSERT INTO users(id,email) VALUES (${c.sourceId},${`${c.sourceId}@example.test`})`; await apply(tx,c); })).rejects.toThrow();
  });
  it.each(["nonpersonal","notadmin","missinglot","ledger","amount"] as const)("refuses invalid underlying state: %s", async (state) => {
    await expect(replay(async (tx,c) => {
      if(state==="nonpersonal") await tx`UPDATE studios SET type='team' WHERE id=${c.personalStudioId}`;
      if(state==="notadmin") await tx`UPDATE studio_members SET role='creator' WHERE studio_id=${c.personalStudioId}`;
      if(state==="missinglot") await tx`DELETE FROM credit_ledger WHERE lot_id=${c.lotId}`;
      if(state==="missinglot") await tx`DELETE FROM credit_lots WHERE id=${c.lotId}`;
      if(state==="ledger") await tx`UPDATE credit_lots SET remaining_credits=6 WHERE id=${c.lotId}`;
      if(state==="amount") await tx`UPDATE credit_lots SET purchased_credits=0 WHERE id=${c.lotId}`;
      await apply(tx,c);
    })).rejects.toThrow();
  });
  it.each([null,[],{}, { schemaVersion: 1 }, { sourceId: null }])("refuses malformed confirmation objects %j", async (confirmation) => {
    await expect(replay(async (tx) => { await apply(tx,confirmation); })).rejects.toThrow();
  });
  it("does not let a JSON null or missing confirmation key weaken native operator audit", async () => {
    await replay(async (tx,c) => {
      await apply(tx,c);
      for(const bad of [null,{}, { ...c, receiptSha256: null },{ ...c, originalCredits: 13.25 },{ ...c, sourceId: randomUUID() }]) {
        await expect(tx.savepoint(async (sp) => { await sp`UPDATE credit_gifts SET legacy_confirmation=${sp.json(bad)} WHERE id=${c.sourceId}`; })).rejects.toThrow();
      }
      await expect(tx.savepoint(async (sp) => { await sp`UPDATE credit_gifts SET legacy_confirmation=NULL WHERE id=${c.sourceId}`; })).rejects.toThrow();
      await expect(tx.savepoint(async (sp) => { await sp`UPDATE credit_gifts SET origin='registration' WHERE id=${c.sourceId}`; })).rejects.toThrow();
    });
  });
  it("binds every persisted legacy confirmation to its own immutable identity", async () => {
    await replay(async (tx,c) => {
      await apply(tx,c);
      await fc.assert(fc.asyncProperty(fc.uuid(),async other => {
        if(other===c.sourceId)return;
        await expect(tx.savepoint(async sp => { await sp`UPDATE credit_gifts SET legacy_confirmation=${sp.json({...c,sourceId:other})} WHERE id=${c.sourceId}`; })).rejects.toThrow();
      }),{numRuns:12});
    });
  });
});


const migrationDir = fileURLToPath(new URL("../../../../core/src/db/migrations/", import.meta.url));
let nativeFolders: { root: string; before: string; old: string; expectedMigrationCount: number } | undefined;
/** Native migration fixtures contain the exact original journal entries, without invented watermarks. */
async function folders(): Promise<{ root: string; before: string; old: string; expectedMigrationCount: number }> {
  if (nativeFolders) return nativeFolders;
  const cache = resolve(migrationDir,"../../../../../node_modules/.cache");
  await mkdir(cache,{recursive:true});
  const root = await mkdtemp(resolve(cache,"legacy-gift-"));
  const before = resolve(root,"before"), old = resolve(root,"old");
  await cp(migrationDir,before,{recursive:true});
  await cp(migrationDir,old,{recursive:true});
  const journal = JSON.parse(await readFile(resolve(migrationDir,"meta/_journal.json"),"utf8")) as { entries: { idx: number }[] };
  await writeFile(resolve(before,"meta/_journal.json"),JSON.stringify({...journal,entries:journal.entries.filter(e=>e.idx<=107)}));
  await writeFile(resolve(old,"meta/_journal.json"),JSON.stringify({...journal,entries:journal.entries.filter(e=>e.idx<=110)}));
  await cp(new URL("./fixtures/0110-credit-grants-original.sql",import.meta.url),resolve(old,"0110_credit_grants.sql"));
  nativeFolders={root,before,old,expectedMigrationCount:journal.entries.length};return nativeFolders;
}
afterAll(async()=>{if(nativeFolders)await rm(nativeFolders.root,{recursive:true,force:true});});
/** A private synthetic database per native-migrator case. */
async function nativeFixture(body: (db: ReturnType<typeof postgres>, url: string, c: Confirmation) => Promise<void>): Promise<void> {
  const name = `legacy_gift_${randomUUID().replaceAll("-","")}`;
  await sql.unsafe(`CREATE DATABASE "${name}"`);
  const url = new URL(inject("DATABASE_URL"));url.pathname="/"+name;
  const db = postgres(url.toString(),{max:1,prepare:false,connection:{application_name:"legacy-native-fixture"}});
  try {
    await migrateDatabase(url.toString(),{migrationsFolder:(await folders()).before});
    const c = await db.begin(tx=>seed(tx));
    await body(db,url.toString(),c);
  } finally {
    await db.end({timeout:3});
    await sql.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
  }
}

describe("native historical gift migrator",()=>{
  it("runs the whole pending journal on a dedicated connection, preserves funding, and repeats without confirmation",async()=>{
    await nativeFixture(async(db,url,c)=>{
      const before=await funding(db);
      await db`SELECT set_config('breatic.legacy_gift_confirmation','application-pool-sentinel',false)`;
      await migrateDatabase(url,{legacyGiftConfirmation:c});
      const [w]=await db`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
      expect(w!.n).toBe((await folders()).expectedMigrationCount);
      expect(await funding(db)).toEqual(before);
      expect(await db`SELECT origin,legacy_confirmation FROM credit_gifts WHERE id=${c.sourceId}`).toEqual([{origin:"operator",legacy_confirmation:c}]);
      expect(await db`SELECT current_setting('breatic.legacy_gift_confirmation') AS value`).toEqual([{value:"application-pool-sentinel"}]);
      const history=await db`SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id`;
      await migrateDatabase(url);
      expect(await db`SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id`).toEqual(history);
      expect(await funding(db)).toEqual(before);
    });
  });
  it("rolls back all pending original migrations when confirmation is absent",async()=>{
    await nativeFixture(async(db,url)=>{
      const before=await funding(db);
      await expect(migrateDatabase(url)).rejects.toThrow();
      expect(await db`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`).toEqual([{n:108}]);
      expect(await db`SELECT to_regclass('public.credit_gifts') IS NULL AS absent`).toEqual([{absent:true}]);
      expect(await funding(db)).toEqual(before);
    });
  });
  it("rejects malformed input before migrating or printing its private values",async()=>{
    await nativeFixture(async(db,url,c)=>{
      for(const input of [null,[],{...c,receiptSha256:"not-a-sha"},{...c,originalCredits:13.25},{...c,extra:"private-sentinel"}]){
        await expect(migrateDatabase(url,{legacyGiftConfirmation:input})).rejects.toThrow("Invalid historical manual gift confirmation");
      }
      expect(await db`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`).toEqual([{n:108}]);
    });
  });
  it("upgrades an already-applied original 0110 without rewriting old rows or migration hashes",async()=>{
    await nativeFixture(async(db,url,c)=>{
      await db`INSERT INTO credit_sources(id,kind,created_at) VALUES (${c.targetUserId},'gift',${c.sourceCreatedAt})`;
      await db`UPDATE credit_lots SET source_id=${c.targetUserId} WHERE id=${c.lotId}`;
      await db`DELETE FROM credit_sources WHERE id=${c.sourceId}`;
      await migrateDatabase(url,{migrationsFolder:(await folders()).old});
      const before=await funding(db);
      const history=await db`SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id`;
      const [gift]=await db`SELECT * FROM credit_gifts WHERE id=${c.targetUserId}`;
      await migrateDatabase(url);
      expect(await db`SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id LIMIT 111`).toEqual(history);
      expect(await db`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`).toEqual([{n:(await folders()).expectedMigrationCount}]);
      expect(await db`SELECT * FROM credit_gifts WHERE id=${c.targetUserId}`).toEqual([{...gift,legacy_confirmation:null}]);
      expect(await funding(db)).toEqual(before);
    });
  });
  it("fails closed and rolls back if the dedicated migration connection is terminated",async()=>{
    await nativeFixture(async(db,url,c)=>{
      const before=await funding(db);
      const gate=postgres(url,{max:1,prepare:false});
      let unlock: (()=>void)|undefined, locked: (()=>void)|undefined;
      const hold=new Promise<void>(resolve=>{unlock=resolve;});
      const acquired=new Promise<void>(resolve=>{locked=resolve;});
      const blocking=gate.begin(async tx=>{await tx`LOCK TABLE credit_sources IN ACCESS EXCLUSIVE MODE`;locked!();await hold;});
      await acquired;
      // Killing a database connection can terminate the driver process itself.
      // Exercise that real one-off migration boundary in a child, just as deployment does.
      const child=spawn(process.execPath,["--input-type=module","-e",
        "const{migrateDatabase}=await import(process.argv[1]);try{await migrateDatabase(process.argv[2],{legacyGiftConfirmation:JSON.parse(process.argv[3])});}catch{process.exitCode=1;}",
        new URL("../../../../core/dist/index.js",import.meta.url).href,url,JSON.stringify(c)],{stdio:"ignore"});
      const outcome=new Promise<boolean>((resolve,reject)=>{child.once("error",reject);child.once("exit",code=>resolve(code!==0));});
      try{
        let pid:number|undefined;
        for(let n=0;n<200;n++){
          const [row]=await db<{pid:number}[]>`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name='confirmed-gift-migrate' AND wait_event_type='Lock' LIMIT 1`;
          if(row){pid=row.pid;break;}
          await new Promise(resolve=>setTimeout(resolve,10));
        }
        expect(pid).toBeTypeOf("number");
        await db`SELECT pg_terminate_backend(${pid!})`;
        expect(await outcome).toBe(true);
      }finally{unlock!();await blocking;await gate.end({timeout:3});}
      expect(await db`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`).toEqual([{n:108}]);
      expect(await db`SELECT to_regclass('public.credit_gifts') IS NULL AS absent`).toEqual([{absent:true}]);
      expect(await funding(db)).toEqual(before);
    });
  });
});

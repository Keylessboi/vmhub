/**
 * Schema-equivalence test — guards the cross-lane contract.
 *
 * Both vmhub-lite and vmhub-reaper open the SAME leases.sqlite file. This test
 * proves (a) both lanes resolve the identical DDL (no dual-file drift) and
 * (b) a file written through lite's DB layer is readable by the reaper's layer
 * and vice versa. If either assertion breaks, leases written by one lane
 * silently orphan in the other.
 */
import { describe, expect, test } from "vitest";
import { SCHEMA_SQL } from "./schema.ts";
import { SCHEMA_SQL as REAPER_SCHEMA } from "../reaper/reaper.db.ts";
import { loadDbDriver as loadLiteDriver } from "../lite/db.ts";
import { loadDbDriver as loadReaperDriver } from "../reaper/reaper.db.ts";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DbConnection } from "../lite/db.ts";

describe("schema cross-lane equivalence", () => {
  test("lite and reaper resolve the identical DDL", () => {
    expect(REAPER_SCHEMA).toBe(SCHEMA_SQL);
  });

  test("the vms table is keyed by (nodeId, vmid), never vmid alone", () => {
    expect(SCHEMA_SQL).toContain("UNIQUE(nodeId, vmid)");
    expect(SCHEMA_SQL).not.toContain("vmid         INTEGER NOT NULL UNIQUE");
    expect(SCHEMA_SQL).toContain("idx_vms_proxmoxTag");
  });

  test("a file written by lite is readable by the reaper layer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vmhub-schema-"));
    const dbPath = join(dir, "leases.sqlite");

    const liteCtor = await loadLiteDriver();
    const liteConn: DbConnection = new liteCtor(dbPath);
    liteConn.exec(SCHEMA_SQL);
    liteConn
      .prepare(
        `INSERT INTO vms (uuid, vmid, nodeId, templateId, adapter, capabilities, proxmoxTag, namePrefix, status, createdAt)
         VALUES ('u1', 1000, 'dl360p', 'hyprland-2404', 'hyprland', '[]', 'vmhub-hl-u1', 'hl', 'ready', 1000)`,
      )
      .run();
    liteConn.close();

    const reaperCtor = await loadReaperDriver();
    const reaperConn: DbConnection = new reaperCtor(dbPath);
    const row = reaperConn
      .prepare("SELECT nodeId FROM vms WHERE uuid = 'u1'")
      .get() as { nodeId: string };
    reaperConn.close();

    expect(row.nodeId).toBe("dl360p");
  });

  test("a file written by the reaper layer is readable by lite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vmhub-schema-"));
    const dbPath = join(dir, "leases.sqlite");

    const reaperCtor = await loadReaperDriver();
    const reaperConn: DbConnection = new reaperCtor(dbPath);
    reaperConn.exec(SCHEMA_SQL);
    reaperConn
      .prepare(
        `INSERT INTO vms (uuid, vmid, nodeId, templateId, adapter, capabilities, proxmoxTag, namePrefix, status, createdAt)
         VALUES ('u2', 1001, 'vostro', 'macos-sequoia-1.0.0', 'macos', '[]', 'vmhub-mac-u2', 'mac', 'ready', 1000)`,
      )
      .run();
    reaperConn.close();

    const liteCtor = await loadLiteDriver();
    const liteConn: DbConnection = new liteCtor(dbPath);
    const row = liteConn
      .prepare("SELECT nodeId FROM vms WHERE uuid = 'u2'")
      .get() as { nodeId: string };
    liteConn.close();

    expect(row.nodeId).toBe("vostro");
  });
});

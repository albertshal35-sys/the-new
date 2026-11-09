import { DatabaseSync } from "node:sqlite";
import type { Param, Sql } from "../src/sql";

/** node:sqlite implementation of the Durable Object Sql interface (tests / local runs). */
export class NodeSql implements Sql {
  db: DatabaseSync;
  private depth = 0;
  constructor(path = ":memory:") { this.db = new DatabaseSync(path); }
  all<T>(q: string, ...p: Param[]): T[] { return this.db.prepare(q).all(...(p as any[])) as T[]; }
  one<T>(q: string, ...p: Param[]): T | null { return (this.all<T>(q, ...p)[0] ?? null) as T | null; }
  run(q: string, ...p: Param[]): void { this.db.prepare(q).run(...(p as any[])); }
  tx<T>(fn: () => T): T {
    const sp = `sp${this.depth++}`;
    this.db.exec(`SAVEPOINT ${sp}`);
    try { const r = fn(); this.db.exec(`RELEASE ${sp}`); return r; }
    catch (e) { this.db.exec(`ROLLBACK TO ${sp}`); this.db.exec(`RELEASE ${sp}`); throw e; }
    finally { this.depth--; }
  }
}

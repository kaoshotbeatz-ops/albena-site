// Minimal D1 look-alike over node:sqlite so tests run without workerd. Merge: use @cloudflare/vitest-plugin instead.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

class Stmt {
  constructor(private db: DatabaseSync, private sql: string, private args: unknown[] = []) {}
  bind(...a: unknown[]) { return new Stmt(this.db, this.sql, a); }
  async first() { return (this.db.prepare(this.sql).get(...(this.args as any[])) as any) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...(this.args as any[])) as any[] }; }
  async run() {
    const r = this.db.prepare(this.sql).run(...(this.args as any[]));
    return { meta: { changes: Number(r.changes) } };
  }
}
export function newD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../migrations/0300_hubs_init.sql", import.meta.url), "utf8"));
  return {
    raw: db,
    prepare: (sql: string) => new Stmt(db, sql),
    batch: async (s: Stmt[]) => Promise.all(s.map((x) => x.run())),
  };
}

/** Minimal synchronous SQL interface implemented by Durable Object storage (and node:sqlite in tests). */
export type Row = Record<string, any>;
export type Param = string | number | null | ArrayBuffer;

export interface Sql {
  all<T = Row>(q: string, ...p: Param[]): T[];
  one<T = Row>(q: string, ...p: Param[]): T | null;
  run(q: string, ...p: Param[]): void;
  tx<T>(fn: () => T): T;
}

export class DurableSql implements Sql {
  constructor(private storage: DurableObjectStorage) {}
  all<T>(q: string, ...p: Param[]): T[] {
    return this.storage.sql.exec(q, ...p).toArray() as T[];
  }
  one<T>(q: string, ...p: Param[]): T | null {
    return (this.all<T>(q, ...p)[0] ?? null) as T | null;
  }
  run(q: string, ...p: Param[]): void {
    this.storage.sql.exec(q, ...p);
  }
  tx<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
}

/** JSON helpers for TEXT columns. */
export const j = (v: unknown): string => JSON.stringify(v ?? null);
export function pj<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined || v === "") return fallback;
  try {
    return JSON.parse(String(v)) as T;
  } catch {
    return fallback;
  }
}
export const b = (v: unknown): number | null => (v === null || v === undefined ? null : v ? 1 : 0);
export const nowIso = (): string => new Date().toISOString();

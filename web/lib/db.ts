import { Pool, types } from "pg";

// Return numeric/bigint as JS numbers (values here are well within safe range) and dates as strings.
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
types.setTypeParser(1082, (v) => v);

const g = globalThis as unknown as { __icecapPool?: Pool };
export const pool: Pool =
  g.__icecapPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL ?? "postgresql://icecap:icecap@localhost:5432/icecap",
    max: Number(process.env.PG_POOL_MAX ?? 10),
    statement_timeout: 15000,
  });
if (process.env.NODE_ENV !== "production") g.__icecapPool = pool;

export async function q<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(sql, params);
  return res.rows as T[];
}
export async function one<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await q<T>(sql, params);
  return rows[0] ?? null;
}

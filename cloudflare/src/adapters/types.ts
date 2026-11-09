import type { Http } from "../http";
import type { Filing, RawRecord } from "../logic";

export interface SourceMeta {
  key: string;
  name: string;
  recordClass: string;
  officialUrl: string;
  apiUrl: string;
  description: string;
  limitations: string;
  cadence: string;
  minIntervalS: number;
  maxIntervalS: number;
  lookbackDays: number;
  reconcileEveryH: number;
  isEnrichmentOnly: boolean;
  backfillOrder: number;
}
export interface Upstream { version: string | null; updatedAt: string | null }
export interface PageCtx { mode: string; windowStart: string; windowEnd: string; cursor: any; upstream: Upstream | null }
export interface Page { records: RawRecord[]; nextCursor: any | null; fullSnapshot?: boolean }

/** A source adapter fetches one page at a time so long jobs resume across 5-minute runs. */
export interface Adapter {
  meta: SourceMeta;
  checkUpstream?(http: Http): Promise<Upstream | null>;
  fetchPage(http: Http, ctx: PageCtx): Promise<Page>;
  normalize(raw: RawRecord): Filing | null;
}

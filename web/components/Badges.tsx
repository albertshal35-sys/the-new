import { ELIGIBILITY, FITS, STAGES } from "@/lib/filters";

const tone: Record<string, string> = {
  qualified: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  needs_review: "bg-amber-50 text-amber-800 ring-amber-200",
  rejected: "bg-slate-100 text-slate-600 ring-slate-200",
  likely: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  uncertain: "bg-amber-50 text-amber-800 ring-amber-200",
  outside_scope: "bg-rose-50 text-rose-700 ring-rose-200",
  high: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  medium: "bg-sky-50 text-sky-700 ring-sky-200",
  low: "bg-slate-100 text-slate-600 ring-slate-200",
};

export function Pill({ children, t }: { children: React.ReactNode; t?: string }) {
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap ${tone[t ?? ""] ?? "bg-slate-50 text-slate-700 ring-slate-200"}`}>
      {children}
    </span>
  );
}
export const Elig = ({ v }: { v: string }) => <Pill t={v}>{ELIGIBILITY[v] ?? v}</Pill>;
export const Fit = ({ v }: { v: string }) => <Pill t={v}>Fit: {FITS[v] ?? v}</Pill>;
export const Conf = ({ v }: { v: string }) => <Pill t={v}>{v} confidence</Pill>;
export const Stage = ({ v }: { v: string | null }) => <Pill>{v ? STAGES[v] ?? v : "Stage unknown"}</Pill>;

export function Score({ v }: { v: number | null }) {
  if (v === null || v === undefined) return <span className="text-slate-400">—</span>;
  const c = v >= 70 ? "bg-emerald-600" : v >= 45 ? "bg-ice-500" : "bg-slate-400";
  return (
    <span className="inline-flex items-center gap-1.5" title="Research priority score (not a financing need)">
      <span className="w-10 h-1.5 bg-slate-200 rounded overflow-hidden"><span className={`block h-full ${c}`} style={{ width: `${v}%` }} /></span>
      <span className="tabular-nums text-xs">{v}</span>
    </span>
  );
}

"use client";
import { useState } from "react";
import { PIPELINE } from "@/lib/filters";

export default function LeadActions({ id, status, notes, isRead }: { id: number; status: string; notes: string | null; isRead: boolean }) {
  const [s, setS] = useState(status);
  const [n, setN] = useState(notes ?? "");
  const [msg, setMsg] = useState("");
  const patch = async (body: object) => {
    const r = await fetch(`/api/projects/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    setMsg(r.ok ? "Saved" : "Error");
    setTimeout(() => setMsg(""), 1500);
  };
  return (
    <div className="space-y-2">
      <label className="flex flex-col gap-1"><span className="label">Pipeline status</span>
        <select className="input" value={s} onChange={(e) => { setS(e.target.value); patch({ pipeline_status: e.target.value }); }}>
          {PIPELINE.map((p) => <option key={p}>{p}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1"><span className="label">Internal notes</span>
        <textarea className="input h-24" value={n} onChange={(e) => setN(e.target.value)} />
      </label>
      <div className="flex gap-2 items-center">
        <button className="btn" onClick={() => patch({ notes: n })}>Save notes</button>
        <button className="btn-ghost" onClick={() => patch({ is_read: !isRead })}>{isRead ? "Mark unread" : "Mark read"}</button>
        <span className="text-xs text-emerald-700">{msg}</span>
      </div>
    </div>
  );
}

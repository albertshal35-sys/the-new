"use client";
import { useEffect, useState } from "react";

type Saved = { id: number; name: string; query: { qs: string; path: string } };

export default function SavedSearches({ qs, path }: { qs: string; path: string }) {
  const [items, setItems] = useState<Saved[]>([]);
  const [name, setName] = useState("");
  const load = () => fetch("/api/saved-searches").then((r) => r.json()).then(setItems).catch(() => {});
  useEffect(() => { load(); }, []);
  const save = async () => {
    if (!name.trim()) return;
    await fetch("/api/saved-searches", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, query: { qs, path } }) });
    setName("");
    load();
  };
  const del = async (id: number) => { await fetch(`/api/saved-searches?id=${id}`, { method: "DELETE" }); load(); };
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="label">Saved searches:</span>
      {items.map((s) => (
        <span key={s.id} className="inline-flex items-center gap-1 bg-white border border-slate-300 rounded px-2 py-0.5">
          <a className="link" href={`${s.query.path}?${s.query.qs}`}>{s.name}</a>
          <button onClick={() => del(s.id)} className="text-slate-400 hover:text-rose-600" aria-label="delete">×</button>
        </span>
      ))}
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name this search" className="input w-40" />
      <button onClick={save} className="btn-ghost">Save current</button>
    </div>
  );
}

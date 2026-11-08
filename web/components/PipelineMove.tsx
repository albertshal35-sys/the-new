"use client";
import { useRouter } from "next/navigation";
import { PIPELINE } from "@/lib/filters";
export default function PipelineMove({ id, status }: { id: number; status: string }) {
  const router = useRouter();
  return (
    <select className="input text-xs w-full mt-1" defaultValue={status} onChange={async (e) => {
      await fetch(`/api/projects/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ pipeline_status: e.target.value }) });
      router.refresh();
    }}>
      {PIPELINE.map((p) => <option key={p}>{p}</option>)}
    </select>
  );
}

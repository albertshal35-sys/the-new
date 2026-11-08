import { ELIGIBILITY, FITS, PIPELINE, PROJECT_TYPES, SORTS, STAGES, UNIT_BUCKETS, type Filters } from "@/lib/filters";

function Sel({ name, value, options, all = "Any" }: { name: string; value?: string; options: Record<string, string> | string[]; all?: string }) {
  const entries = Array.isArray(options) ? options.map((o) => [o, o]) : Object.entries(options);
  return (
    <select name={name} defaultValue={value ?? ""} className="input">
      <option value="">{all}</option>
      {entries.map(([k, v]) => (
        <option key={k} value={k}>{v}</option>
      ))}
    </select>
  );
}

export default function FilterBar({ f, neighborhoods, action, showSort = true }: { f: Filters; neighborhoods: string[]; action: string; showSort?: boolean }) {
  return (
    <form action={action} method="get" className="card p-3 grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2 items-end text-sm">
      <label className="flex flex-col gap-1"><span className="label">Eligibility</span>
        <select name="eligibility" defaultValue={f.eligibility ?? "all"} className="input">
          <option value="all">All</option>
          {Object.entries(ELIGIBILITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1"><span className="label">Units</span>
        <Sel name="units" value={f.units} options={{ ...Object.fromEntries(Object.keys(UNIT_BUCKETS).map((k) => [k, `${k} units`])), unknown: "Unknown" }} />
      </label>
      <label className="flex flex-col gap-1"><span className="label">Project type</span><Sel name="type" value={f.type} options={PROJECT_TYPES} /></label>
      <label className="flex flex-col gap-1"><span className="label">Stage</span><Sel name="stage" value={f.stage} options={STAGES} /></label>
      <label className="flex flex-col gap-1"><span className="label">Financing fit</span><Sel name="fit" value={f.fit} options={FITS} /></label>
      <label className="flex flex-col gap-1"><span className="label">Neighborhood</span><Sel name="neighborhood" value={f.neighborhood} options={neighborhoods} /></label>
      <label className="flex flex-col gap-1"><span className="label">Developer / owner</span><input name="developer" defaultValue={f.developer} className="input" placeholder="name contains" /></label>
      <label className="flex flex-col gap-1"><span className="label">Applicant / agent</span><input name="applicant" defaultValue={f.applicant} className="input" placeholder="name contains" /></label>
      <label className="flex flex-col gap-1"><span className="label">Filing date from</span><input type="date" name="filed_from" defaultValue={f.filed_from} className="input" /></label>
      <label className="flex flex-col gap-1"><span className="label">Filing date to</span><input type="date" name="filed_to" defaultValue={f.filed_to} className="input" /></label>
      <label className="flex flex-col gap-1"><span className="label">First seen from</span><input type="date" name="seen_from" defaultValue={f.seen_from} className="input" /></label>
      <label className="flex flex-col gap-1"><span className="label">First seen to</span><input type="date" name="seen_to" defaultValue={f.seen_to} className="input" /></label>
      <label className="flex flex-col gap-1"><span className="label">Pipeline</span><Sel name="pipeline" value={f.pipeline} options={PIPELINE} /></label>
      <label className="flex flex-col gap-1"><span className="label">Search</span><input name="q" defaultValue={f.q} className="input" placeholder="address, name, parcel" /></label>
      {showSort && (
        <label className="flex flex-col gap-1"><span className="label">Sort</span>
          <select name="sort" defaultValue={f.sort ?? "first_seen"} className="input">
            {Object.entries(SORTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>
      )}
      <div className="flex flex-col gap-1 text-xs">
        <label className="flex items-center gap-1"><input type="checkbox" name="unread" value="1" defaultChecked={f.unread === "1"} /> Only new / unread</label>
        <label className="flex items-center gap-1"><input type="checkbox" name="contact" value="1" defaultChecked={f.contact === "1"} /> Only with contact info</label>
      </div>
      <div className="flex gap-2 col-span-2 md:col-span-1">
        <button className="btn" type="submit">Apply</button>
        <a className="btn-ghost" href={action}>Reset</a>
      </div>
    </form>
  );
}

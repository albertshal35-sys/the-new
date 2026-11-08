"use client";
import "leaflet/dist/leaflet.css";
import { CircleMarker, MapContainer, Popup, TileLayer } from "react-leaflet";

export type MapPoint = { id: number; lat: number; lon: number; address: string; units: number | null; stage: string | null; eligibility: string; score: number | null; fit: string };
const color: Record<string, string> = { qualified: "#059669", needs_review: "#d97706", rejected: "#94a3b8" };

export default function MapView({ points }: { points: MapPoint[] }) {
  return (
    <MapContainer center={[42.325, -71.075]} zoom={12} style={{ height: "70vh", width: "100%" }} scrollWheelZoom>
      <TileLayer attribution='&copy; OpenStreetMap contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
      {points.map((p) => (
        <CircleMarker key={p.id} center={[p.lat, p.lon]} radius={p.units ? Math.min(4 + Math.sqrt(p.units) * 1.2, 18) : 5}
          pathOptions={{ color: color[p.eligibility] ?? "#2b7aa8", fillOpacity: 0.6, weight: 1 }}>
          <Popup>
            <div className="text-sm">
              <a href={`/leads/${p.id}`} className="font-semibold">{p.address}</a>
              <div>{p.units ?? "unknown"} units · {p.stage ?? "stage unknown"}</div>
              <div>{p.eligibility} · fit {p.fit} · score {p.score ?? "—"}</div>
            </div>
          </Popup>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}

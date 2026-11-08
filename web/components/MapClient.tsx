"use client";
import dynamic from "next/dynamic";
import type { MapPoint } from "./MapView";
const MapView = dynamic(() => import("./MapView"), { ssr: false, loading: () => <div className="h-[70vh] grid place-items-center text-slate-500">Loading map…</div> });
export default function MapClient({ points }: { points: MapPoint[] }) {
  return <MapView points={points} />;
}

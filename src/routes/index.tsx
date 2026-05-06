import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState } from "react";

const TrackEditor = lazy(() => import("@/components/TrackEditor"));

export const Route = createFileRoute("/")({
  component: Index,
  head: () => ({
    meta: [
      { title: "Track Editor — Build & Drive 3D Circuits" },
      { name: "description", content: "Design 3D racing circuits with a spline-based editor and drive them with realistic physics." },
    ],
  }),
});

function Index() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) {
    return <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">Loading…</div>;
  }
  return (
    <Suspense fallback={<div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">Loading…</div>}>
      <TrackEditor />
    </Suspense>
  );
}

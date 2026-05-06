import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

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
  return (
    <Suspense fallback={<div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">Loading…</div>}>
      <TrackEditor />
    </Suspense>
  );
}

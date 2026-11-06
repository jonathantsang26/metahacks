import { lazy, Suspense, useEffect, useState } from "react";
import { useSearchParams } from "react-router";

// deck.gl, onnxruntime-web and the ported stores touch window at import, so the whole screen
// loads in the browser only; the server renders the loading frame.
const IncidentScreen = lazy(() => import("@/sentinel/app/AppShell"));

const FIRES = ["eaton", "palisades"] as const;
type FireId = (typeof FIRES)[number];

export function meta() {
  return [
    { title: "Incident · Sentinel Ember" },
    {
      name: "description",
      content:
        "Replay of a wildfire with the next hour's drone coverage plan and crew briefing.",
    },
  ];
}

function Loading({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-se-muted">
      {text}
    </div>
  );
}

export default function IncidentRoute() {
  const [params] = useSearchParams();
  const raw = params.get("fire");
  const fire: FireId = FIRES.includes(raw as FireId) ? (raw as FireId) : "eaton";
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <div className="sentinel-root h-full min-h-[480px]">
      {mounted ? (
        <Suspense fallback={<Loading text="Loading the incident map…" />}>
          {/* One mount per fire: every file reloads cleanly, as the Meta build's page load did. */}
          <IncidentScreen key={fire} fire={fire} />
        </Suspense>
      ) : (
        <Loading text="Loading the incident map…" />
      )}
    </div>
  );
}

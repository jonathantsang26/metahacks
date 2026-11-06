/**
 * Client-side shapes for the plan actions (docs/CONTRACTS.md, plan-domain), plus tolerant
 * normalizers so the UI degrades instead of crashing when a field is missing or renamed.
 */

export type Fire = 'eaton' | 'palisades';
export type By = 'agent' | 'person';
export type LonLat = [number, number];

export type Plan = {
  id: string;
  fire: string;
  t: string;
  status: 'draft' | 'approved';
  updatedBy: By | null;
  updatedAt: string | null;
};

export type Assignment = {
  droneId: string;
  lon: number;
  lat: number;
  radiusM: number;
  reason: string;
  locked: boolean;
  grounded: boolean;
  groundedReason: string | null;
  /** Gust at flight height at the watch point, m/s (from the score). */
  gustMs: number | null;
  updatedBy: By | null;
  updatedAt: string | null;
};

/** HRRR wind cell for the hour: drones inside a cell with flyable false are grounded. */
export type WindCell = {bbox: [number, number, number, number]; gustMs: number | null; flyable: boolean};

/** One piece of the forecast front, flagged covered when it lies inside a drone footprint. */
export type FrontSegment = {path: LonLat[]; covered: boolean};

export type Score = {
  frontKm: number | null;
  coveredKm: number | null;
  /** 0–100. */
  frontCoveragePct: number | null;
  groundedCount: number | null;
  homesNearFront: number | null;
  homesWatched: number | null;
  label: string | null;
  /** Forecast method behind the front ("muse" | "physics"), from score.forecast. */
  forecastMethod: string | null;
  perDrone: {droneId: string; coveredKm: number | null; grounded: boolean; groundedReason: string | null; gustMs: number | null; homesWatched: number | null}[];
  windCells: WindCell[];
  segments: FrontSegment[] | null;
};

export type BriefingCite = {action: string; args: Record<string, unknown>; label: string; lon: number | null; lat: number | null};
/** What a cited action returned, labelled for the UI (save-briefing fills it). */
export type BriefingEvidence = {layer: string; label: string; t: string | null; lon: number | null; lat: number | null};
export type BriefingParagraph = {text: string; cites: BriefingCite[]; evidence: BriefingEvidence[]; verified: boolean | null; editedBy: By | null};
export type Briefing = {
  id: string;
  paragraphs: BriefingParagraph[];
  dropped: {text: string | null; reason: string | null}[];
  droppedCount: number;
  verified: boolean | null;
  updatedBy: By | null;
  updatedAt: string | null;
};

export type PlanBundle = {plan: Plan | null; assignments: Assignment[]; score: Score | null; briefing: Briefing | null};

export type ForecastFront = {paths: LonLat[][]; forecastFor: string | null; method: string | null; status: string | null; source: string | null};

export type Hindsight = {
  /** 0–100: share of the real next-hour burned area inside the drone footprints. */
  pct: number | null;
  baselinePct: number | null;
  baselineLabel: string | null;
  /** Long description of the baseline (how its drones were placed). */
  baselineMethod: string | null;
  burnedHa: number | null;
  label: string | null;
  source: string | null;
};

/* ---------- normalizers ---------- */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const pick = (o: Obj, ...keys: string[]): unknown => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};
const by = (v: unknown): By | null => (v === 'agent' || v === 'person' ? v : v === 'user' || v === 'ui' ? 'person' : null);

/** Fractions (≤1) become percentages; percentages pass through. */
function pctOf(v: unknown): number | null {
  const n = num(v);
  if (n === null) return null;
  return n <= 1 ? n * 100 : n;
}

export function normalizePlan(v: unknown): Plan | null {
  if (!isObj(v)) return null;
  const id = str(pick(v, 'id', 'planId'));
  if (!id) return null;
  const status = str(pick(v, 'status'));
  return {
    id,
    fire: str(v.fire) ?? 'eaton',
    t: str(pick(v, 't', 'hour', 'planT')) ?? '',
    status: status === 'approved' || v.approved === true || !!v.approvedAt || !!v.approved_at ? 'approved' : 'draft',
    updatedBy: by(pick(v, 'updatedBy', 'updated_by')),
    updatedAt: str(pick(v, 'updatedAt', 'updated_at'))
  };
}

export function normalizeAssignment(v: unknown): Assignment | null {
  if (!isObj(v)) return null;
  const droneId = str(pick(v, 'droneId', 'drone_id', 'id'));
  const lon = num(v.lon);
  const lat = num(v.lat);
  if (!droneId || lon === null || lat === null) return null;
  return {
    droneId,
    lon,
    lat,
    radiusM: num(pick(v, 'radiusM', 'radius_m', 'radius')) ?? 400,
    reason: str(v.reason) ?? '',
    locked: v.locked === true,
    grounded: v.grounded === true,
    groundedReason: str(pick(v, 'groundedReason', 'grounded_reason')),
    gustMs: num(pick(v, 'gustMs', 'gust_ms', 'gust')),
    updatedBy: by(pick(v, 'updatedBy', 'updated_by')),
    updatedAt: str(pick(v, 'updatedAt', 'updated_at'))
  };
}

function toLonLat(p: unknown): LonLat | null {
  if (!Array.isArray(p) || p.length < 2) return null;
  const a = num(p[0]);
  const b = num(p[1]);
  return a === null || b === null ? null : [a, b];
}

/** LineString coords, MultiLineString coords, or a GeoJSON geometry/feature → list of paths. */
export function pathsOf(v: unknown): LonLat[][] {
  if (!v) return [];
  if (isObj(v)) {
    if (v.type === 'Feature') return pathsOf(v.geometry);
    if (v.type === 'FeatureCollection' && Array.isArray(v.features)) return v.features.flatMap(pathsOf);
    if (v.type === 'LineString' || v.type === 'MultiLineString') return pathsOf(v.coordinates);
    if ('coordinates' in v) return pathsOf(v.coordinates);
    return [];
  }
  if (!Array.isArray(v) || !v.length) return [];
  if (toLonLat(v[0])) {
    const path = v.map(toLonLat).filter((p): p is LonLat => !!p);
    return path.length >= 2 ? [path] : [];
  }
  return v.flatMap(pathsOf);
}

function normalizeSegments(v: Obj): FrontSegment[] | null {
  const raw = pick(v, 'segments', 'frontSegments', 'front_segments');
  if (Array.isArray(raw)) {
    const out: FrontSegment[] = [];
    for (const s of raw) {
      if (!isObj(s)) continue;
      const covered = s.covered === true || s.status === 'covered';
      for (const path of pathsOf(pick(s, 'path', 'coords', 'coordinates', 'geometry'))) out.push({path, covered});
    }
    return out.length ? out : null;
  }
  const covered = pick(v, 'coveredFront', 'covered_front', 'coveredPaths');
  const uncovered = pick(v, 'uncoveredFront', 'uncovered_front', 'uncoveredPaths');
  if (covered || uncovered) {
    return [...pathsOf(covered).map(path => ({path, covered: true})), ...pathsOf(uncovered).map(path => ({path, covered: false}))];
  }
  return null;
}

export function normalizeScore(v: unknown): Score | null {
  if (!isObj(v)) return null;
  const s = isObj(v.score) ? v.score : v;
  const frontKm = num(pick(s, 'frontKm', 'front_km'));
  const coveredKm = num(pick(s, 'coveredKm', 'covered_km'));
  // frontCoveragePct is 0–100 (server/plan/score.ts).
  let pct = num(pick(s, 'frontCoveragePct', 'front_coverage_pct', 'coveragePct'));
  if (frontKm && coveredKm !== null) pct = (coveredKm / frontKm) * 100;
  const perDrone = Array.isArray(s.perDrone ?? s.per_drone)
    ? ((s.perDrone ?? s.per_drone) as unknown[]).filter(isObj).map(d => ({
        droneId: str(pick(d, 'droneId', 'drone_id', 'id')) ?? '?',
        coveredKm: num(pick(d, 'coveredKm', 'covered_km', 'frontKmInView')),
        grounded: d.grounded === true,
        groundedReason: str(pick(d, 'groundedReason', 'grounded_reason')) ?? (d.grounded === true && num(d.gustMs) !== null ? `gusts ${num(d.gustMs)!.toFixed(1)} m/s at ${num(s.flightAglM) ?? 120} m, over the ${num(s.gustLimitMs) ?? 12} m/s limit` : null),
        gustMs: num(pick(d, 'gustMs', 'gust_ms', 'gust')),
        homesWatched: num(pick(d, 'homesWatched', 'homes_watched', 'homesInView', 'homes'))
      }))
    : [];
  return {
    frontKm,
    coveredKm,
    frontCoveragePct: pct,
    groundedCount: num(pick(s, 'groundedCount', 'grounded_count')) ?? (perDrone.length ? perDrone.filter(d => d.grounded).length : null),
    homesNearFront: num(pick(s, 'homesNearFront', 'homes_near_front')),
    homesWatched: num(pick(s, 'homesWatched', 'homes_watched')),
    label: str(s.label),
    forecastMethod: isObj(s.forecast) ? str(s.forecast.method) : null,
    windCells: normalizeWindCells(s.windCells),
    perDrone,
    segments: normalizeSegments(s)
  };
}

function normalizeCite(v: unknown): BriefingCite | null {
  if (!isObj(v)) return null;
  const action = str(pick(v, 'action', 'layer', 'tool')) ?? 'source';
  const args = isObj(v.args) ? v.args : {};
  const lon = num(v.lon) ?? num(args.lon);
  const lat = num(v.lat) ?? num(args.lat);
  const argText = Object.entries(args)
    .filter(([k]) => k !== 'fire')
    .map(([k, a]) => `${k} ${typeof a === 'number' ? +a.toFixed(4) : String(a)}`)
    .join(', ');
  return {action, args, label: str(v.label) ?? (argText ? `${action} (${argText})` : action), lon, lat};
}

export function normalizeBriefing(v: unknown): Briefing | null {
  if (!isObj(v)) return null;
  const id = str(pick(v, 'id', 'briefingId'));
  const paras = Array.isArray(v.paragraphs) ? v.paragraphs : [];
  if (!id && !paras.length) return null;
  const rawDropped = pick(v, 'dropped', 'droppedParagraphs', 'dropped_paragraphs');
  let dropped: Briefing['dropped'] = [];
  let droppedCount = 0;
  if (Array.isArray(rawDropped)) {
    dropped = rawDropped.map(d =>
      isObj(d)
        ? {text: str(d.text), reason: [str(pick(d, 'reason', 'why')), ...(Array.isArray(d.detail) ? d.detail.map(str).filter(Boolean) : [])].filter(Boolean).join(': ') || null}
        : {text: str(d), reason: null}
    );
    droppedCount = dropped.length;
  } else if (typeof rawDropped === 'number') {
    droppedCount = rawDropped;
  } else if (isObj(rawDropped)) {
    droppedCount = Object.values(rawDropped).reduce<number>((a, b) => a + (num(b) ?? 0), 0);
  }
  return {
    id: id ?? '',
    paragraphs: paras.filter(isObj).map(p => ({
      text: str(p.text) ?? '',
      cites: Array.isArray(p.cites) ? p.cites.map(normalizeCite).filter((c): c is BriefingCite => !!c) : [],
      evidence: Array.isArray(p.evidence)
        ? p.evidence.filter(isObj).map(e => ({layer: str(pick(e, 'layer', 'action')) ?? 'source', label: str(e.label) ?? '', t: str(e.t), lon: num(e.lon), lat: num(e.lat)}))
        : [],
      verified: typeof p.verified === 'boolean' ? p.verified : null,
      editedBy: by(pick(p, 'editedBy', 'edited_by')) ?? (p.edited === true ? 'person' : null)
    })),
    dropped,
    droppedCount,
    verified: typeof v.verified === 'boolean' ? v.verified : paras.length && paras.every(p => isObj(p) && p.verified === true) ? true : null,
    updatedBy: by(pick(v, 'updatedBy', 'updated_by')),
    updatedAt: str(pick(v, 'updatedAt', 'updated_at'))
  };
}

export function normalizeBundle(v: unknown): PlanBundle {
  if (!isObj(v)) return {plan: null, assignments: [], score: null, briefing: null};
  const plan = normalizePlan(v.plan);
  const rawAssignments = pick(v, 'assignments', 'drones') ?? (isObj(v.plan) ? pick(v.plan, 'assignments', 'drones') : undefined);
  const assignments = Array.isArray(rawAssignments)
    ? rawAssignments.map(normalizeAssignment).filter((a): a is Assignment => !!a).sort((a, b) => a.droneId.localeCompare(b.droneId, 'en', {numeric: true}))
    : [];
  const score = plan ? normalizeScore(v.score) : null;
  // Grounding is decided by the score (gust at flight height), so copy it onto each drone.
  const merged = assignments.map(a => {
    const d = score?.perDrone.find(p => p.droneId === a.droneId);
    return d ? {...a, grounded: a.grounded || d.grounded, groundedReason: a.groundedReason ?? d.groundedReason, gustMs: a.gustMs ?? d.gustMs} : a;
  });
  return {plan, assignments: plan ? merged : [], score, briefing: plan ? normalizeBriefing(v.briefing) : null};
}

export function normalizeFront(v: unknown): ForecastFront | null {
  if (!isObj(v)) return null;
  const body = isObj(v.result) ? v.result : v;
  const paths = pathsOf(pick(body, 'front', 'frontLine', 'line'));
  return {paths, forecastFor: str(pick(body, 'forecastFor', 'forecast_for')), method: str(body.method), status: str(body.status), source: str(body.source)};
}

export function normalizeHindsight(v: unknown): Hindsight | null {
  if (!isObj(v)) return null;
  const h = isObj(v.result) ? v.result : v;
  const base = isObj(h.baseline) ? h.baseline : null;
  const plan = isObj(h.plan) ? h.plan : null;
  // insidePct is already 0–100 (hindsight.ts), so it skips the fraction guess.
  return {
    pct: plan && num(plan.insidePct) !== null ? num(plan.insidePct) : pctOf(pick(h, 'sharePct', 'share_pct', 'pct', 'share', 'planPct', 'coveredPct')),
    baselinePct: base ? (num(base.insidePct) ?? pctOf(pick(base, 'sharePct', 'pct', 'share'))) : pctOf(pick(h, 'baselinePct', 'baseline_pct')),
    baselineLabel: (base ? str(pick(base, 'label', 'name')) : null) ?? str(pick(h, 'baselineLabel', 'baseline_label')) ?? (base ? 'evenly spaced drones' : null),
    baselineMethod: base ? str(base.method) : null,
    burnedHa: num(h.burnedHa),
    label: str(h.label),
    source: str(h.source)
  };
}

/** windCells from the score, or the cells of a `flyable-cells` read ({cells} or a bare array). */
export function normalizeWindCells(v: unknown): WindCell[] {
  const list = Array.isArray(v) ? v : isObj(v) ? (pick(v, 'cells', 'windCells') as unknown) : null;
  if (!Array.isArray(list)) return [];
  const out: WindCell[] = [];
  for (const c of list) {
    if (!isObj(c) || !Array.isArray(c.bbox) || c.bbox.length !== 4) continue;
    const b = c.bbox.map(num);
    if (b.some(x => x === null)) continue;
    out.push({bbox: b as [number, number, number, number], gustMs: num(pick(c, 'gustMs', 'gust_ms', 'gust')), flyable: c.flyable !== false});
  }
  return out;
}

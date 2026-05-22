// Procedural racetrack generation inspired by:
// "Generating Race Tracks With Repulsive Curves" (Henrich et al., 2024)
// https://github.com/LasseHenrich/racetrack-generation
//
// A pragmatic 2D port: a closed polyline is evolved by gradient descent on
// a tangent-point repulsion energy, with periodic arc-length resampling and
// projection onto a target perimeter length + a minimum self-distance.

export type Pt = { x: number; z: number };

export interface GenerateOptions {
  n: number;                // number of control points (8..40)
  seed: number;             // RNG seed
  iterations: number;       // optimization steps
  lengthTarget: number;     // desired perimeter length
  repulsion: number;        // strength multiplier (0.5..3)
  minDist: number;          // min distance between non-adjacent vertices
  bbox: number;             // half-size of the playfield
  alpha?: number;           // tangent-point exponent (default 3)
  beta?: number;            // tangent-point exponent (default 6)
}

export interface GenerateCallbacks {
  onStep?: (iter: number, total: number, pts: Pt[]) => void;
  onDone?: (pts: Pt[]) => void;
}

// Tiny seeded RNG (mulberry32)
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedPolygon(n: number, radius: number, jitter: number, rand: () => number): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = radius * (1 + (rand() - 0.5) * jitter);
    pts.push({ x: Math.cos(a) * r, z: Math.sin(a) * r });
  }
  return pts;
}

function perimeter(pts: Pt[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return s;
}

// Tangent-point energy: sum over non-adjacent vertex pairs of
//   |cross(T_i, p_i - p_j)|^alpha / |p_i - p_j|^beta
function energy(pts: Pt[], alpha: number, beta: number): number {
  const N = pts.length;
  let E = 0;
  for (let i = 0; i < N; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % N];
    let tx = b.x - a.x, tz = b.z - a.z;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    for (let j = 0; j < N; j++) {
      if (j === i || j === (i + 1) % N || (j + 1) % N === i) continue;
      const p = pts[j];
      const dx = a.x - p.x, dz = a.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d < 1e-4) continue;
      const cross = Math.abs(tx * dz - tz * dx);
      E += Math.pow(cross, alpha) / Math.pow(d, beta);
    }
  }
  return E;
}

// Numerical gradient (finite differences) — O(N) energy evals per vertex.
// Fine for N <= 40.
function gradient(pts: Pt[], alpha: number, beta: number, h = 1e-2): Pt[] {
  const g: Pt[] = pts.map(() => ({ x: 0, z: 0 }));
  for (let i = 0; i < pts.length; i++) {
    const ox = pts[i].x, oz = pts[i].z;
    pts[i].x = ox + h; const e1x = energy(pts, alpha, beta);
    pts[i].x = ox - h; const e2x = energy(pts, alpha, beta);
    pts[i].x = ox;
    pts[i].z = oz + h; const e1z = energy(pts, alpha, beta);
    pts[i].z = oz - h; const e2z = energy(pts, alpha, beta);
    pts[i].z = oz;
    g[i].x = (e1x - e2x) / (2 * h);
    g[i].z = (e1z - e2z) / (2 * h);
  }
  return g;
}

function scaleToLength(pts: Pt[], target: number) {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cz = pts.reduce((s, p) => s + p.z, 0) / pts.length;
  const L = perimeter(pts);
  if (L < 1e-3) return;
  const k = target / L;
  for (const p of pts) {
    p.x = cx + (p.x - cx) * k;
    p.z = cz + (p.z - cz) * k;
  }
}

function clampBbox(pts: Pt[], half: number) {
  for (const p of pts) {
    if (p.x > half) p.x = half;
    if (p.x < -half) p.x = -half;
    if (p.z > half) p.z = half;
    if (p.z < -half) p.z = -half;
  }
}

// Push apart non-adjacent vertices that came too close.
function enforceMinDist(pts: Pt[], minD: number) {
  const N = pts.length;
  for (let i = 0; i < N; i++) {
    for (let j = i + 2; j < N; j++) {
      if (i === 0 && j === N - 1) continue;
      const a = pts[i], b = pts[j];
      const dx = b.x - a.x, dz = b.z - a.z;
      const d = Math.hypot(dx, dz);
      if (d > 1e-4 && d < minD) {
        const push = (minD - d) * 0.5;
        const nx = dx / d, nz = dz / d;
        a.x -= nx * push; a.z -= nz * push;
        b.x += nx * push; b.z += nz * push;
      }
    }
  }
}

// Resample the closed polyline to N equally-spaced points by arc length.
function resample(pts: Pt[], n: number): Pt[] {
  const L = perimeter(pts);
  const step = L / n;
  const out: Pt[] = [];
  let i = 0, acc = 0;
  let cur = { ...pts[0] };
  out.push({ ...cur });
  while (out.length < n) {
    const next = pts[(i + 1) % pts.length];
    const dx = next.x - cur.x, dz = next.z - cur.z;
    const seg = Math.hypot(dx, dz);
    if (acc + seg >= step) {
      const t = (step - acc) / seg;
      cur = { x: cur.x + dx * t, z: cur.z + dz * t };
      out.push({ ...cur });
      acc = 0;
    } else {
      acc += seg;
      cur = { ...next };
      i = (i + 1) % pts.length;
      if (i === 0 && out.length < n) {
        // safety: shouldn't usually happen
        break;
      }
    }
  }
  while (out.length < n) out.push({ ...pts[pts.length - 1] });
  return out;
}

export function runGeneration(opts: GenerateOptions, cb: GenerateCallbacks = {}) {
  const alpha = opts.alpha ?? 3;
  const beta = opts.beta ?? 6;
  const rand = rng(opts.seed);
  const seedRadius = opts.lengthTarget / (2 * Math.PI);
  let pts = seedPolygon(opts.n, seedRadius, 0.55, rand);

  let cancelled = false;
  let iter = 0;
  const chunk = 4; // iterations per frame

  // Adaptive step: tangent-point grads can be huge; cap by max move.
  const maxMove = Math.max(0.4, opts.minDist * 0.25);

  function stepOnce() {
    const g = gradient(pts, alpha, beta);
    // Find max grad magnitude to normalize
    let gmax = 0;
    for (const v of g) {
      const m = Math.hypot(v.x, v.z);
      if (m > gmax) gmax = m;
    }
    const lr = gmax > 0 ? (maxMove * opts.repulsion) / gmax : 0;
    for (let i = 0; i < pts.length; i++) {
      pts[i].x -= g[i].x * lr;
      pts[i].z -= g[i].z * lr;
    }
    enforceMinDist(pts, opts.minDist);
    scaleToLength(pts, opts.lengthTarget);
    clampBbox(pts, opts.bbox);

    if (iter > 0 && iter % 15 === 0) {
      pts = resample(pts, opts.n);
    }
  }

  function loop() {
    if (cancelled) return;
    const end = Math.min(iter + chunk, opts.iterations);
    for (; iter < end; iter++) stepOnce();
    cb.onStep?.(iter, opts.iterations, pts);
    if (iter < opts.iterations) {
      (window.requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 0)))(loop);
    } else {
      // Final cleanup
      pts = resample(pts, opts.n);
      enforceMinDist(pts, opts.minDist);
      scaleToLength(pts, opts.lengthTarget);
      cb.onDone?.(pts);
    }
  }

  loop();
  return () => { cancelled = true; };
}

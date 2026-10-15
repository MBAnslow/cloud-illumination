import type { EllipsoidParams } from "../state";

/**
 * Bolts crawl the faces of the lightning cuboid. A chord through the
 * interior stays far from the LEDs, which sit out near the boundary.
 */

type Vec3 = [number, number, number];

const FACE = [
  { axis: 0, sign: 1, u: 1, v: 2 },
  { axis: 0, sign: -1, u: 1, v: 2 },
  { axis: 1, sign: 1, u: 0, v: 2 },
  { axis: 1, sign: -1, u: 0, v: 2 },
  { axis: 2, sign: 1, u: 0, v: 1 },
  { axis: 2, sign: -1, u: 0, v: 1 },
] as const;

interface Surf {
  face: number;
  u: number;
  v: number;
}

export interface SurfacePolyline {
  points: Vec3[];
  /** Face each vertex sits on. Edge vertices use the face of the incoming leg. */
  faces: number[];
}

function rand(): number {
  return Math.random();
}

function halfOf(box: EllipsoidParams): [number, number, number] {
  return [
    Math.max(1e-4, box.rx),
    Math.max(1e-4, box.ry),
    Math.max(1e-4, box.rz),
  ];
}

function onFace(
  face: number,
  u: number,
  v: number,
  half: [number, number, number],
): Vec3 {
  const f = FACE[face];
  const p: Vec3 = [0, 0, 0];
  p[f.axis] = f.sign * half[f.axis];
  p[f.u] = u;
  p[f.v] = v;
  return p;
}

function faceCoords(face: number, p: Vec3): { u: number; v: number } {
  const f = FACE[face];
  return { u: p[f.u], v: p[f.v] };
}

function opposite(face: number): number {
  return face ^ 1;
}

function adjacent(a: number, b: number): boolean {
  return FACE[a].axis !== FACE[b].axis;
}

function pickFace(half: [number, number, number]): number {
  const area = [
    half[1] * half[2],
    half[1] * half[2],
    half[0] * half[2],
    half[0] * half[2],
    half[0] * half[1],
    half[0] * half[1],
  ];
  let sum = 0;
  for (const a of area) sum += a;
  let r = rand() * sum;
  for (let i = 0; i < area.length; i++) {
    r -= area[i];
    if (r <= 0) return i;
  }
  return area.length - 1;
}

function sampleOnFace(
  face: number,
  half: [number, number, number],
  span: number,
): Surf {
  const f = FACE[face];
  const s = Math.max(0.05, Math.min(1, span));
  return {
    face,
    u: (rand() * 2 - 1) * half[f.u] * s,
    v: (rand() * 2 - 1) * half[f.v] * s,
  };
}

/** Place `b`, which lies on face B, into face A's in-plane coordinates. */
function unfoldOnto(
  faceA: number,
  faceB: number,
  uB: number,
  vB: number,
  half: [number, number, number],
): { u: number; v: number } {
  const pb = onFace(faceB, uB, vB, half);
  const A = FACE[faceA];
  const B = FACE[faceB];
  const onU = A.u === B.axis;
  const edgeCoord = B.sign * half[B.axis];
  const dist = Math.abs(A.sign * half[A.axis] - pb[A.axis]);
  const outward = edgeCoord >= 0 ? 1 : -1;
  const alongEdge = pb[onU ? A.v : A.u];
  const crossed = edgeCoord + outward * dist;
  return onU ? { u: crossed, v: alongEdge } : { u: alongEdge, v: crossed };
}

function attachment(
  faceA: number,
  faceB: number,
  half: [number, number, number],
): { onU: boolean; edge: number; outward: number } {
  const A = FACE[faceA];
  const B = FACE[faceB];
  const onU = A.u === B.axis;
  const edge = B.sign * half[B.axis];
  return { onU, edge, outward: edge >= 0 ? 1 : -1 };
}

function unfoldedToMid(
  startFace: number,
  midFace: number,
  u: number,
  v: number,
  half: [number, number, number],
): Vec3 {
  const att = attachment(startFace, midFace, half);
  const s = att.onU ? u : v;
  const transverse = att.onU ? v : u;
  const d = (s - att.edge) * att.outward;
  const S = FACE[startFace];
  const M = FACE[midFace];
  const p: Vec3 = [0, 0, 0];
  p[M.axis] = M.sign * half[M.axis];
  // Leaving the start face, this coordinate runs from that face's plane
  // toward the opposite side of the box. It does not follow `outward`,
  // which only says which edge of the start face we crossed.
  p[S.axis] = S.sign * (half[S.axis] - d);
  p[3 - S.axis - M.axis] = transverse;
  return p;
}

interface Leg {
  face: number;
  from: Vec3;
  to: Vec3;
}

function edgeBetween(
  a: Surf,
  b: Surf,
  half: [number, number, number],
): Vec3 {
  const end = unfoldOnto(a.face, b.face, b.u, b.v, half);
  const att = attachment(a.face, b.face, half);
  const aC = att.onU ? a.u : a.v;
  const bC = att.onU ? end.u : end.v;
  const denom = bC - aC;
  const t = Math.abs(denom) < 1e-8 ? 0 : (att.edge - aC) / denom;
  const clamped = Math.max(0, Math.min(1, t));
  const u = a.u + (end.u - a.u) * clamped;
  const v = a.v + (end.v - a.v) * clamped;
  return onFace(a.face, att.onU ? att.edge : u, att.onU ? v : att.edge, half);
}

function legsFor(
  a: Surf,
  b: Surf,
  half: [number, number, number],
): Leg[] {
  const start = onFace(a.face, a.u, a.v, half);
  const end = onFace(b.face, b.u, b.v, half);
  if (a.face === b.face) return [{ face: a.face, from: start, to: end }];
  if (adjacent(a.face, b.face)) {
    const edge = edgeBetween(a, b, half);
    return [
      { face: a.face, from: start, to: edge },
      { face: b.face, from: edge, to: end },
    ];
  }
  const mids = [0, 1, 2, 3, 4, 5].filter(
    (face) => face !== a.face && face !== opposite(a.face) && adjacent(a.face, face),
  );
  const mid = mids[Math.floor(rand() * mids.length)] ?? 0;
  const endOnMid = unfoldOnto(mid, b.face, b.u, b.v, half);
  const folded = unfoldOnto(a.face, mid, endOnMid.u, endOnMid.v, half);
  const att = attachment(a.face, mid, half);
  const aC = att.onU ? a.u : a.v;
  const bC = att.onU ? folded.u : folded.v;
  const width = half[FACE[a.face].axis] * 2;
  const edge2 = att.edge + att.outward * width;
  const tAt = (edge: number) => {
    const denom = bC - aC;
    if (Math.abs(denom) < 1e-8) return 0;
    return Math.max(0, Math.min(1, (edge - aC) / denom));
  };
  const at = (t: number) => ({
    u: a.u + (folded.u - a.u) * t,
    v: a.v + (folded.v - a.v) * t,
  });
  const t1 = tAt(att.edge);
  const t2 = tAt(edge2);
  const p1 = at(t1);
  const p2 = at(t2);
  const edgeNear = onFace(
    a.face,
    att.onU ? att.edge : p1.u,
    att.onU ? p1.v : att.edge,
    half,
  );
  const edgeFar = unfoldedToMid(a.face, mid, p2.u, p2.v, half);
  return [
    { face: a.face, from: start, to: edgeNear },
    { face: mid, from: edgeNear, to: edgeFar },
    { face: b.face, from: edgeFar, to: end },
  ];
}

function legLength(leg: Leg): number {
  const dx = leg.to[0] - leg.from[0];
  const dy = leg.to[1] - leg.from[1];
  const dz = leg.to[2] - leg.from[2];
  return Math.hypot(dx, dy, dz);
}

function clampFace(
  face: number,
  u: number,
  v: number,
  half: [number, number, number],
): { u: number; v: number } {
  const f = FACE[face];
  const hu = half[f.u];
  const hv = half[f.v];
  return {
    u: Math.max(-hu, Math.min(hu, u)),
    v: Math.max(-hv, Math.min(hv, v)),
  };
}

function traceLegs(
  legs: Leg[],
  segments: number,
  jitter: number,
  half: [number, number, number],
): SurfacePolyline {
  const lengths = legs.map(legLength);
  const total = lengths.reduce((sum, len) => sum + len, 0) || 1;
  const usable = legs
    .map((leg, i) => ({ leg, len: lengths[i] }))
    .filter((entry) => entry.len > 1e-6);
  const route = usable.length > 0 ? usable : legs.map((leg, i) => ({ leg, len: lengths[i] }));
  const counts = route.map((entry) =>
    Math.max(1, Math.round(Math.max(2, segments) * (entry.len / total))),
  );
  let sum = counts.reduce((s, n) => s + n, 0);
  while (sum > Math.max(2, segments) && counts.some((n) => n > 1)) {
    let idx = 0;
    for (let i = 1; i < counts.length; i++) if (counts[i] > counts[idx]) idx = i;
    if (counts[idx] <= 1) break;
    counts[idx] -= 1;
    sum -= 1;
  }
  const points: Vec3[] = [];
  const faces: number[] = [];
  const lateral = Math.max(0, jitter) * total;
  for (let li = 0; li < route.length; li++) {
    const { leg } = route[li];
    const n = counts[li];
    const from = faceCoords(leg.face, leg.from);
    const to = faceCoords(leg.face, leg.to);
    const du = to.u - from.u;
    const dv = to.v - from.v;
    const plen = Math.hypot(du, dv) || 1;
    const pu = -dv / plen;
    const pv = du / plen;
    const freq = 1 + Math.floor(rand() * 3);
    const phase = rand() * Math.PI * 2;
    const waveAmp = (rand() * 2 - 1) * lateral * 0.55;
    const startI = li === 0 ? 0 : 1;
    for (let i = startI; i <= n; i++) {
      const t = n === 0 ? 0 : i / n;
      const anchor = Math.sin(t * Math.PI);
      const noise = (rand() * 2 - 1) * lateral * 0.3 * anchor;
      const wave = Math.sin(t * Math.PI * freq + phase) * waveAmp * anchor;
      const off = noise + wave;
      const clamped = clampFace(
        leg.face,
        from.u + du * t + pu * off,
        from.v + dv * t + pv * off,
        half,
      );
      points.push(onFace(leg.face, clamped.u, clamped.v, half));
      faces.push(leg.face);
    }
  }
  if (points.length < 2) {
    const only = route[0].leg;
    return { points: [only.from, only.to], faces: [only.face, only.face] };
  }
  return { points, faces };
}

function pathLength(points: Vec3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(
      points[i][0] - points[i - 1][0],
      points[i][1] - points[i - 1][1],
      points[i][2] - points[i - 1][2],
    );
  }
  return total;
}

export function sampleSurfacePolyline(
  box: EllipsoidParams,
  segments: number,
  jitter: number,
  spanScale: number,
  minSpanScale: number,
  ground: boolean,
): SurfacePolyline {
  const half = halfOf(box);
  const mean = (half[0] + half[1] + half[2]) / 3;
  const minLen = Math.max(0, minSpanScale) * mean;
  let built = traceLegs(
    legsFor(
      ground ? sampleOnFace(2, half, spanScale) : sampleOnFace(pickFace(half), half, spanScale),
      ground ? sampleOnFace(3, half, spanScale) : sampleOnFace(pickFace(half), half, spanScale),
      half,
    ),
    segments,
    jitter,
    half,
  );
  for (let tries = 0; tries < 12 && pathLength(built.points) < minLen; tries++) {
    const a = ground
      ? sampleOnFace(2, half, spanScale)
      : sampleOnFace(pickFace(half), half, spanScale);
    const b = ground
      ? sampleOnFace(3, half, spanScale)
      : sampleOnFace(pickFace(half), half, spanScale);
    built = traceLegs(legsFor(a, b, half), segments, jitter, half);
  }
  return built;
}

export interface SurfaceBranch {
  path: Vec3[];
  strength: number;
  forkVertex: number;
}

/** Short forks that stay on the same face as the vertex they leave. */
export function sampleSurfaceBranches(
  bolt: SurfacePolyline,
  branchProb: number,
  jitter: number,
  halfBox: EllipsoidParams,
): SurfaceBranch[] {
  const p = Math.max(0, Math.min(1, branchProb));
  if (p <= 0 || bolt.points.length < 3) return [];
  const half = halfOf(halfBox);
  const branches: SurfaceBranch[] = [];
  const remainFrom = (index: number) => {
    let total = 0;
    for (let i = index + 1; i < bolt.points.length; i++) {
      total += Math.hypot(
        bolt.points[i][0] - bolt.points[i - 1][0],
        bolt.points[i][1] - bolt.points[i - 1][1],
        bolt.points[i][2] - bolt.points[i - 1][2],
      );
    }
    return total;
  };
  for (let vi = 1; vi < bolt.points.length - 1; vi++) {
    if (rand() >= p) continue;
    const face = bolt.faces[vi] ?? bolt.faces[vi - 1] ?? 0;
    const origin = faceCoords(face, bolt.points[vi]);
    let du = rand() * 2 - 1;
    let dv = rand() * 2 - 1;
    const dlen = Math.hypot(du, dv) || 1;
    du /= dlen;
    dv /= dlen;
    const branchLen = Math.max(1e-4, remainFrom(vi) * (0.25 + rand() * 0.2));
    const segs = 2 + Math.floor(rand() * 3);
    const pts: Vec3[] = [bolt.points[vi]];
    let u = origin.u;
    let v = origin.v;
    let blocked = false;
    for (let k = 1; k <= segs; k++) {
      if (blocked) break;
      const step = branchLen / segs;
      const anchor = Math.sin((k / segs) * Math.PI);
      const j = (rand() * 2 - 1) * jitter * branchLen * 0.25 * anchor;
      const nu = u + du * step - dv * j;
      const nv = v + dv * step + du * j;
      const clamped = clampFace(face, nu, nv, half);
      blocked =
        Math.abs(clamped.u - nu) > 1e-6 || Math.abs(clamped.v - nv) > 1e-6;
      u = clamped.u;
      v = clamped.v;
      pts.push(onFace(face, u, v, half));
    }
    if (pts.length < 2) continue;
    branches.push({
      path: pts,
      strength: 0.45 + rand() * 0.2,
      forkVertex: vi,
    });
  }
  return branches;
}

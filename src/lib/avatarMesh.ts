import rawObj from '../assets/faceModelRaw.json';

export const LANDMARKS = {
  eye_l: [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],
  eye_r: [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466],
  brow_l: [70, 63, 105, 66, 107],
  brow_r: [300, 293, 334, 296, 336],
  lips_out: [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185],
  lips_in: [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191],
};

export const JAW_PIVOT: [number, number, number] = [0, 0.06, -0.34];
export const JAW_MAX = 0.115;

const SKULL_C: [number, number, number] = [0.0, 2.0, -1.0];
const SKULL_R: [number, number, number] = [8.4, 12.4, 8.2];
const SKULL_POLE: [number, number, number] = [0.0, 0.42, -1.0];
const SKULL_RINGS = 6;
const SKULL_BLEND = 1.7;
const SKULL_BULGE = 1.04;
const NECK_RINGS = 9;
const NECK_SEGS = 14;
const NECK_Z = -1.6;
const WIRE_STRIDE = 3;

export interface HeadMesh {
  verts: Float32Array; // 3 * N
  normals: Float32Array; // 3 * N
  faces: Int32Array; // 3 * F
  faceGroup: Uint8Array; // 1 = head, 0 = neck
  edges: Int32Array; // 2 * E
  jaw: Float32Array;
  brow: Float32Array;
  lips: Float32Array;
  lipCentre: [number, number, number];
  fade: Float32Array;
  nVerts: number;
  nFaces: number;
  nEdges: number;
  nHead: number;
  span: number;
}

type Vec3 = [number, number, number];

function norm3(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1e-9;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function slerpVec(a: Vec3, b: Vec3, t: number): Vec3 {
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const om = Math.acos(dot);
  const so = Math.sin(om);
  if (so < 1e-6) {
    return norm3([a[0] * (1 - t) + b[0] * t, a[1] * (1 - t) + b[1] * t, a[2] * (1 - t) + b[2] * t]);
  }
  const wa = Math.sin((1 - t) * om) / so;
  const wb = Math.sin(t * om) / so;
  return norm3([a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb]);
}

function boundaryLoop(faces: number[][]): number[] {
  const seen = new Map<string, { edge: [number, number]; count: number }>();
  for (const [a, b, c] of faces) {
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const k = u < v ? `${u}_${v}` : `${v}_${u}`;
      const cur = seen.get(k);
      if (cur) cur.count++;
      else seen.set(k, { edge: u < v ? [u, v] : [v, u], count: 1 });
    }
  }
  const adj = new Map<number, number[]>();
  let start = 0;
  for (const { edge, count } of seen.values()) {
    if (count === 1) {
      start = edge[0];
      if (!adj.has(edge[0])) adj.set(edge[0], []);
      if (!adj.has(edge[1])) adj.set(edge[1], []);
      adj.get(edge[0])!.push(edge[1]);
      adj.get(edge[1])!.push(edge[0]);
    }
  }
  const loop = [start];
  let prev = -1;
  let cur = start;
  while (true) {
    const nbrs = adj.get(cur) || [];
    const nxt = nbrs.find((v) => v !== prev);
    if (nxt === undefined || nxt === start) break;
    prev = cur;
    cur = nxt;
    loop.push(cur);
    if (loop.length > 500) break;
  }
  return loop;
}

let cachedMesh: HeadMesh | null = null;

export function getHeadMesh(): HeadMesh {
  if (cachedMesh) return cachedMesh;

  const verts: Vec3[] = rawObj.v.map((p) => [p[0], p[1], p[2]]);
  const faces: [number, number, number][] = rawObj.f.map((f) => [f[0], f[1], f[2]]);

  // Cranium sweep
  let loop = boundaryLoop(faces);
  let cx2 = 0,
    cy2 = 0;
  for (const idx of loop) {
    cx2 += verts[idx][0];
    cy2 += verts[idx][1];
  }
  cx2 /= loop.length;
  cy2 /= loop.length;

  let windSum = 0;
  for (let i = 0; i < loop.length; i++) {
    const a0 = Math.atan2(verts[loop[i]][1] - cy2, verts[loop[i]][0] - cx2);
    const a1 = Math.atan2(verts[loop[(i + 1) % loop.length]][1] - cy2, verts[loop[(i + 1) % loop.length]][0] - cx2);
    let d = a1 - a0;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    windSum += d;
  }
  if (windSum < 0) loop = loop.slice().reverse();

  const pole = norm3(SKULL_POLE);
  let chinY = Infinity;
  for (const v of verts) if (v[1] < chinY) chinY = v[1];

  const rimR: number[] = [];
  const rimD: Vec3[] = [];
  for (const idx of loop) {
    const dx = verts[idx][0] - SKULL_C[0];
    const dy = verts[idx][1] - SKULL_C[1];
    const dz = verts[idx][2] - SKULL_C[2];
    const r = Math.hypot(dx, dy, dz) || 1e-9;
    rimR.push(r);
    rimD.push([dx / r, dy / r, dz / r]);
  }

  const ellR = (d: Vec3) =>
    1.0 / Math.sqrt((d[0] / SKULL_R[0]) ** 2 + (d[1] / SKULL_R[1]) ** 2 + (d[2] / SKULL_R[2]) ** 2);

  let prevIdx = loop;
  for (let s = 1; s <= SKULL_RINGS; s++) {
    const t = s / SKULL_RINGS;
    const w = (1.0 - t) ** SKULL_BLEND;
    const base = verts.length;
    const curIdx: number[] = [];
    for (let i = 0; i < loop.length; i++) {
      if (s === SKULL_RINGS) {
        const pr = ellR(pole);
        verts.push([SKULL_C[0] + pole[0] * pr, SKULL_C[1] + pole[1] * pr, SKULL_C[2] + pole[2] * pr]);
      } else {
        const d = slerpVec(pole, rimD[i], 1.0 - t);
        const r = ellR(d) * (1.0 + (SKULL_BULGE - 1.0) * Math.sin(Math.PI * t) ** 0.8);
        const rad = w * rimR[i] + (1.0 - w) * r;
        let vx = SKULL_C[0] + d[0] * rad;
        let vy = SKULL_C[1] + d[1] * rad;
        let vz = SKULL_C[2] + d[2] * rad;
        if (vy < chinY) {
          vy = chinY;
          vx *= 0.55;
          vz = NECK_Z + (vz - NECK_Z) * 0.55;
        }
        verts.push([vx, vy, vz]);
      }
      curIdx.push(base + i);
    }
    for (let i = 0; i < loop.length; i++) {
      const a0 = prevIdx[i];
      const b0 = prevIdx[(i + 1) % loop.length];
      const a1 = curIdx[i];
      const b1 = curIdx[(i + 1) % loop.length];
      faces.push([a0, a1, b1]);
      faces.push([a0, b1, b0]);
    }
    prevIdx = curIdx;
  }

  const nHead = verts.length;

  // Neck
  const neckBase = verts.length;
  const fadeArr = new Array<number>(nHead).fill(1.0);
  for (let i = 0; i < NECK_RINGS; i++) {
    const t = i / (NECK_RINGS - 1);
    const y = -5.5 + t * -7.5;
    const d = (y + 5.5) / -7.5;
    const rx = 4.6 * (1.0 + 0.52 * d ** 1.9);
    const rz = 4.1 * (1.0 + 0.38 * d ** 1.9);
    const fVal = 1.0 - 0.72 * Math.max(0, Math.min(1, d)) ** 1.5;
    for (let j = 0; j < NECK_SEGS; j++) {
      const ph = (2 * Math.PI * j) / NECK_SEGS;
      verts.push([rx * Math.cos(ph), y, NECK_Z + rz * Math.sin(ph)]);
      fadeArr.push(fVal);
    }
  }
  for (let i = 0; i < NECK_RINGS - 1; i++) {
    for (let j = 0; j < NECK_SEGS; j++) {
      const a = neckBase + i * NECK_SEGS + j;
      const b = neckBase + i * NECK_SEGS + ((j + 1) % NECK_SEGS);
      const c = neckBase + (i + 1) * NECK_SEGS + ((j + 1) % NECK_SEGS);
      const e = neckBase + (i + 1) * NECK_SEGS + j;
      faces.push([a, b, c]);
      faces.push([a, c, e]);
    }
  }

  // Normalize crown -> +1, chin -> -1
  let crown = -Infinity;
  let chin = Infinity;
  for (let i = 0; i < nHead; i++) {
    if (verts[i][1] > crown) crown = verts[i][1];
    if (verts[i][1] < chin) chin = verts[i][1];
  }
  const scale = 2.0 / (crown - chin);
  const cyMid = (crown + chin) * 0.5;
  for (let i = 0; i < verts.length; i++) {
    verts[i] = [verts[i][0] * scale, (verts[i][1] - cyMid) * scale, verts[i][2] * scale];
  }

  const nVerts = verts.length;
  const nFaces = faces.length;

  // Vertex normals
  let headMeanY = 0;
  for (let i = 0; i < nHead; i++) headMeanY += verts[i][1];
  headMeanY /= nHead;

  const normAcc = new Float32Array(nVerts * 3);
  for (const [ia, ib, ic] of faces) {
    const ax = verts[ia][0],
      ay = verts[ia][1],
      az = verts[ia][2];
    const ux = verts[ib][0] - ax,
      uy = verts[ib][1] - ay,
      uz = verts[ib][2] - az;
    const vx = verts[ic][0] - ax,
      vy = verts[ic][1] - ay,
      vz = verts[ic][2] - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const idx of [ia, ib, ic]) {
      normAcc[idx * 3] += nx;
      normAcc[idx * 3 + 1] += ny;
      normAcc[idx * 3 + 2] += nz;
    }
  }

  for (let i = 0; i < nVerts; i++) {
    let nx = normAcc[i * 3],
      ny = normAcc[i * 3 + 1],
      nz = normAcc[i * 3 + 2];
    const len = Math.hypot(nx, ny, nz) || 1e-9;
    nx /= len;
    ny /= len;
    nz /= len;
    const ox = verts[i][0];
    const oy = i < nHead ? verts[i][1] - headMeanY : 0;
    const oz = i < nHead ? verts[i][2] : verts[i][2] - NECK_Z * scale;
    if (nx * ox + ny * oy + nz * oz < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    normAcc[i * 3] = nx;
    normAcc[i * 3 + 1] = ny;
    normAcc[i * 3 + 2] = nz;
  }

  // Jaw, brow, lip weights
  let mouthY = 0;
  for (const idx of LANDMARKS.lips_out) mouthY += verts[idx][1];
  mouthY /= LANDMARKS.lips_out.length;

  let normChin = Infinity;
  for (let i = 0; i < nHead; i++) if (verts[i][1] < normChin) normChin = verts[i][1];

  const jaw = new Float32Array(nVerts);
  for (let i = 0; i < nHead; i++) {
    const base = Math.max(0, Math.min(1, (mouthY - verts[i][1]) / (mouthY - normChin))) ** 0.8;
    const zWeight = Math.max(0, Math.min(1, 0.3 + 0.85 * (verts[i][2] / 0.55)));
    jaw[i] = base * zWeight;
  }
  for (const idx of LANDMARKS.lips_in.slice(0, 10)) jaw[idx] = 1.0;
  for (const idx of LANDMARKS.lips_out.slice(0, 10)) jaw[idx] = 0.95;

  const browIndices = [...LANDMARKS.brow_l, ...LANDMARKS.brow_r];
  let browY = 0;
  for (const idx of browIndices) browY += verts[idx][1];
  browY /= browIndices.length;
  const brow = new Float32Array(nVerts);
  for (let i = 0; i < nHead; i++) {
    const wY = Math.exp(-(((verts[i][1] - browY) / 0.115) ** 2));
    const wZ = Math.max(0, Math.min(1, verts[i][2] / 0.35));
    const wX = Math.exp(-((verts[i][0] / 0.42) ** 2));
    brow[i] = wY * wZ * wX;
  }

  let lipCx = 0,
    lipCy = 0,
    lipCz = 0;
  for (const idx of LANDMARKS.lips_out) {
    lipCx += verts[idx][0];
    lipCy += verts[idx][1];
    lipCz += verts[idx][2];
  }
  lipCx /= LANDMARKS.lips_out.length;
  lipCy /= LANDMARKS.lips_out.length;
  lipCz /= LANDMARKS.lips_out.length;

  const lips = new Float32Array(nVerts);
  for (let i = 0; i < nHead; i++) {
    const wY = Math.exp(-(((verts[i][1] - lipCy) / 0.155) ** 2));
    const wX = Math.exp(-((verts[i][0] / 0.3) ** 2));
    const wZ = Math.max(0, Math.min(1, verts[i][2] / 0.4));
    lips[i] = wY * wX * wZ;
  }

  // Unique edges strided
  const edgeSet = new Set<string>();
  const allEdges: [number, number][] = [];
  for (const [a, b, c] of faces) {
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const lo = u < v ? u : v;
      const hi = u < v ? v : u;
      const k = `${lo}_${hi}`;
      if (!edgeSet.has(k)) {
        edgeSet.add(k);
        allEdges.push([lo, hi]);
      }
    }
  }
  const stridedEdges: number[] = [];
  for (let i = 0; i < allEdges.length; i += WIRE_STRIDE) {
    stridedEdges.push(allEdges[i][0], allEdges[i][1]);
  }

  const vertsFlat = new Float32Array(nVerts * 3);
  let minY = Infinity;
  for (let i = 0; i < nVerts; i++) {
    vertsFlat[i * 3] = verts[i][0];
    vertsFlat[i * 3 + 1] = verts[i][1];
    vertsFlat[i * 3 + 2] = verts[i][2];
    if (verts[i][1] < minY) minY = verts[i][1];
  }

  const facesFlat = new Int32Array(nFaces * 3);
  const faceGroup = new Uint8Array(nFaces);
  for (let i = 0; i < nFaces; i++) {
    facesFlat[i * 3] = faces[i][0];
    facesFlat[i * 3 + 1] = faces[i][1];
    facesFlat[i * 3 + 2] = faces[i][2];
    faceGroup[i] = faces[i][0] >= nHead && faces[i][1] >= nHead && faces[i][2] >= nHead ? 0 : 1;
  }

  cachedMesh = {
    verts: vertsFlat,
    normals: normAcc,
    faces: facesFlat,
    faceGroup,
    edges: new Int32Array(stridedEdges),
    jaw,
    brow,
    lips,
    lipCentre: [lipCx, lipCy, lipCz],
    fade: new Float32Array(fadeArr),
    nVerts,
    nFaces,
    nEdges: stridedEdges.length / 2,
    nHead,
    span: 1.0 - minY,
  };

  return cachedMesh;
}

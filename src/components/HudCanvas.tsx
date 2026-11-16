import React, { useEffect, useRef } from 'react';
import { getHeadMesh, JAW_MAX, JAW_PIVOT, LANDMARKS } from '../lib/avatarMesh';
import type { HudPalette } from '../lib/theme';

export type AssistantState = 'INITIALISING' | 'STANDBY' | 'LISTENING' | 'THINKING' | 'SPEAKING' | 'MUTED';

interface HudCanvasProps {
  hudStyle: 'face' | 'reactor';
  state: AssistantState;
  assistantName: string;
  audioLevel: number; // 0..1
  palette: HudPalette;
}

function hexRgb(hex: string): [number, number, number] {
  const c = hex.replace('#', '');
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
}

function rgbaStr(rgb: [number, number, number], a: number): string {
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}

function blendHex(bg: [number, number, number], fg: [number, number, number], f: number): string {
  const t = Math.max(0, Math.min(1, f));
  return `rgb(${Math.round(bg[0] + (fg[0] - bg[0]) * t)},${Math.round(bg[1] + (fg[1] - bg[1]) * t)},${Math.round(
    bg[2] + (fg[2] - bg[2]) * t
  )})`;
}

export const HudCanvas: React.FC<HudCanvasProps> = ({
  hudStyle,
  state,
  assistantName,
  audioLevel,
  palette,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const propsRef = useRef({ hudStyle, state, assistantName, audioLevel, palette });
  propsRef.current = { hudStyle, state, assistantName, audioLevel, palette };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const mesh = getHeadMesh();
    const animVerts = new Float32Array(mesh.nVerts * 3);
    const projX = new Float32Array(mesh.nVerts);
    const projY = new Float32Array(mesh.nVerts);
    const projZ = new Float32Array(mesh.nVerts);

    // Precompute Reactor3D rings
    const N_RING = 72;
    const N_GLOBE = 44;
    const SPHERE_R = 0.46;
    const FLOOR_Y = -1.02;
    const PITCH = (17 * Math.PI) / 180;
    const CAM_D = 4.2;

    const ringPts: [number, number, number][] = [];
    for (let i = 0; i < N_RING; i++) {
      const t = (2 * Math.PI * i) / N_RING;
      ringPts.push([Math.cos(t), 0, Math.sin(t)]);
    }

    const latRings: [number, number, number][][] = [-58, -30, 0, 30, 58].map((deg) => {
      const la = (deg * Math.PI) / 180;
      const pts: [number, number, number][] = [];
      for (let i = 0; i < N_GLOBE; i++) {
        const g = (2 * Math.PI * i) / N_GLOBE;
        pts.push([Math.cos(g) * Math.cos(la), Math.sin(la), Math.sin(g) * Math.cos(la)]);
      }
      return pts;
    });

    const lonRings: [number, number, number][][] = Array.from({ length: 6 }, (_, k) => {
      const lo = (k * Math.PI) / 6;
      const pts: [number, number, number][] = [];
      for (let i = 0; i < N_GLOBE; i++) {
        const g = (2 * Math.PI * i) / N_GLOBE;
        pts.push([Math.cos(g) * Math.cos(lo), Math.sin(g), Math.cos(g) * Math.sin(lo)]);
      }
      return pts;
    });

    // Animation state
    let t = 0;
    let sway = 0;
    let mouth = 0;
    let glow = 0;
    let scan = -1.6;
    let blink = 0;
    let blinkAt = 2.8;
    let brow = 0;
    let wide = 0;
    let reactorPhase = 0;
    let smoothLevel = 0;
    const waveBars = new Float32Array(44);

    let lastTs = performance.now();
    let rafId = 0;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(300, Math.floor(rect.width * dpr));
      const h = Math.max(260, Math.floor(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    };

    const drawFace = (
      w: number,
      h: number,
      dt: number,
      priRgb: [number, number, number],
      accRgb: [number, number, number],
      bgRgb: [number, number, number],
      whiteRgb: [number, number, number],
      curState: AssistantState,
      lvl: number
    ) => {
      const speaking = curState === 'SPEAKING';
      const thinking = curState === 'THINKING';
      const muted = curState === 'MUTED';

      const targetMouth = speaking ? Math.min(1, lvl * 1.45 + 0.14 * Math.sin(t * 14)) : 0;
      mouth += (targetMouth - mouth) * (1 - Math.exp(-dt / (targetMouth > mouth ? 0.025 : 0.045)));
      const targetGlow = speaking ? Math.max(0.45, lvl) : curState === 'LISTENING' ? Math.max(0.25, lvl * 0.9) : 0.12;
      glow += (targetGlow - glow) * (1 - Math.exp(-dt / 0.08));
      brow += ((speaking ? lvl * 0.65 : thinking ? -0.25 : 0) - brow) * (1 - Math.exp(-dt / 0.12));
      wide += ((speaking ? Math.sin(t * 6.5) * 0.45 : 0) - wide) * (1 - Math.exp(-dt / 0.1));

      if (t >= blinkAt) {
        blink = 1.0;
        blinkAt = t + 2.6 + Math.random() * 3.4;
      } else {
        blink = Math.max(0, blink - dt * 7.5);
      }

      scan += dt * 0.9;
      if (scan > 1.4) scan = -1.6;

      const swayRate = speaking ? 1.5 : thinking ? 1.8 : 0.8;
      sway += dt * swayRate;
      const yaw = (thinking ? 0.14 : 0.07) * Math.sin(sway * 0.85) + (muted ? 0.04 : 0);
      const pitch = 0.04 * Math.sin(sway * 0.6) + (thinking ? -0.05 : 0) + (speaking ? -0.025 * lvl : 0);

      // Transform vertices (rig + rotation)
      const jawAngle = mouth * JAW_MAX;
      const cosJ = Math.cos(jawAngle);
      const sinJ = Math.sin(jawAngle);
      const cosY = Math.cos(yaw);
      const sinY = Math.sin(yaw);
      const cosP = Math.cos(pitch);
      const sinP = Math.sin(pitch);

      const cx = w * 0.5;
      const cy = h * 0.46;
      const scalePx = Math.min(w * 0.34, h * 0.39);
      const CAM_D_FACE = 4.6;

      for (let i = 0; i < mesh.nVerts; i++) {
        let vx = mesh.verts[i * 3];
        let vy = mesh.verts[i * 3 + 1];
        let vz = mesh.verts[i * 3 + 2];

        // Brow lift
        const bw = mesh.brow[i];
        if (bw > 0) vy += bw * brow * 0.09;

        // Lip spread / round
        const lw = mesh.lips[i];
        if (lw > 0 && mouth > 0.02) {
          vx += (vx - mesh.lipCentre[0]) * lw * wide * 0.14;
          vz += lw * (-wide * 0.025);
        }

        // Jaw rotation around pivot
        const jw = mesh.jaw[i];
        if (jw > 0 && jawAngle > 0.001) {
          const dy = vy - JAW_PIVOT[1];
          const dz = vz - JAW_PIVOT[2];
          const a = jawAngle * jw;
          const ca = Math.cos(a);
          const sa = Math.sin(a);
          vy = JAW_PIVOT[1] + dy * ca - dz * sa;
          vz = JAW_PIVOT[2] + dy * sa + dz * ca;
        }
        void cosJ;
        void sinJ;

        // Head yaw (around Y) then pitch (around X)
        const rx = vx * cosY + vz * sinY;
        const rz0 = -vx * sinY + vz * cosY;
        const ry = vy * cosP - rz0 * sinP;
        const rz = vy * sinP + rz0 * cosP;

        animVerts[i * 3] = rx;
        animVerts[i * 3 + 1] = ry;
        animVerts[i * 3 + 2] = rz;

        const persp = CAM_D_FACE / Math.max(0.5, CAM_D_FACE - rz);
        projX[i] = cx + rx * scalePx * persp;
        projY[i] = cy - ry * scalePx * persp;
        projZ[i] = rz;
      }

      // Soft radial aura behind head
      const auraR = scalePx * (1.28 + glow * 0.28);
      const aura = ctx.createRadialGradient(cx, cy, scalePx * 0.1, cx, cy, auraR);
      const auraColor = speaking ? accRgb : priRgb;
      aura.addColorStop(0, rgbaStr(auraColor, 0.15 + glow * 0.14));
      aura.addColorStop(0.55, rgbaStr(priRgb, 0.05));
      aura.addColorStop(1, rgbaStr(bgRgb, 0));
      ctx.fillStyle = aura;
      ctx.beginPath();
      ctx.arc(cx, cy, auraR, 0, Math.PI * 2);
      ctx.fill();

      // Depth-sort triangles (neck first, then back-to-front head)
      const faceOrder: { idx: number; z: number; group: number }[] = [];
      for (let f = 0; f < mesh.nFaces; f++) {
        const ia = mesh.faces[f * 3];
        const ib = mesh.faces[f * 3 + 1];
        const ic = mesh.faces[f * 3 + 2];
        // Backface cull in screen space
        const ax = projX[ib] - projX[ia];
        const ay = projY[ib] - projY[ia];
        const bx = projX[ic] - projX[ia];
        const by = projY[ic] - projY[ia];
        if (ax * by - ay * bx >= 0) continue;
        const zAvg = (projZ[ia] + projZ[ib] + projZ[ic]) / 3;
        faceOrder.push({ idx: f, z: zAvg, group: mesh.faceGroup[f] });
      }
      faceOrder.sort((a, b) => (a.group !== b.group ? a.group - b.group : a.z - b.z));

      // Light vector
      const lx = 0.25,
        ly = 0.42,
        lz = 0.87;

      // Render shaded holographic facets
      for (let k = 0; k < faceOrder.length; k++) {
        const f = faceOrder[k].idx;
        const ia = mesh.faces[f * 3];
        const ib = mesh.faces[f * 3 + 1];
        const ic = mesh.faces[f * 3 + 2];

        const nx = (mesh.normals[ia * 3] + mesh.normals[ib * 3] + mesh.normals[ic * 3]) / 3;
        const ny = (mesh.normals[ia * 3 + 1] + mesh.normals[ib * 3 + 1] + mesh.normals[ic * 3 + 1]) / 3;
        const nz = (mesh.normals[ia * 3 + 2] + mesh.normals[ib * 3 + 2] + mesh.normals[ic * 3 + 2]) / 3;
        const rnx = nx * cosY + nz * sinY;
        const rnz0 = -nx * sinY + nz * cosY;
        const rny = ny * cosP - rnz0 * sinP;
        const rnz = ny * sinP + rnz0 * cosP;

        const diff = Math.max(0.08, rnx * lx + rny * ly + rnz * lz);
        const rim = (1 - Math.max(0, rnz)) ** 2 * 0.42;
        const fade = (mesh.fade[ia] + mesh.fade[ib] + mesh.fade[ic]) / 3;
        const yMid = (animVerts[ia * 3 + 1] + animVerts[ib * 3 + 1] + animVerts[ic * 3 + 1]) / 3;
        const scanBoost = Math.exp(-(((yMid - scan) / 0.14) ** 2)) * 0.22;

        const intensity = Math.min(1, (diff * 0.34 + rim + scanBoost + glow * 0.08) * fade);
        ctx.fillStyle = blendHex(bgRgb, priRgb, intensity * 0.72);
        ctx.beginPath();
        ctx.moveTo(projX[ia], projY[ia]);
        ctx.lineTo(projX[ib], projY[ib]);
        ctx.lineTo(projX[ic], projY[ic]);
        ctx.closePath();
        ctx.fill();
      }

      // Wireframe lattice over front-facing vertices
      ctx.lineWidth = 0.8;
      ctx.strokeStyle = rgbaStr(priRgb, muted ? 0.18 : 0.34 + glow * 0.15);
      ctx.beginPath();
      for (let e = 0; e < mesh.nEdges; e++) {
        const u = mesh.edges[e * 2];
        const v = mesh.edges[e * 2 + 1];
        if (projZ[u] < -0.35 && projZ[v] < -0.35) continue;
        ctx.moveTo(projX[u], projY[u]);
        ctx.lineTo(projX[v], projY[v]);
      }
      ctx.stroke();

      // Landmark highlights: eyes, brows, lips
      const drawRing = (indices: number[], close: boolean, color: string, width: number, squashY = 1) => {
        if (indices.length < 2) return;
        let my = 0;
        for (const id of indices) my += projY[id];
        my /= indices.length;
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        for (let i = 0; i < indices.length; i++) {
          const id = indices[i];
          const py = my + (projY[id] - my) * squashY;
          if (i === 0) ctx.moveTo(projX[id], py);
          else ctx.lineTo(projX[id], py);
        }
        if (close) ctx.closePath();
        ctx.stroke();
      };

      const eyeOpen = Math.max(0.08, 1 - blink * 0.92) * (muted ? 0.45 : 1);
      const eyeCol = rgbaStr(whiteRgb, muted ? 0.35 : 0.85);
      drawRing(LANDMARKS.eye_l, true, eyeCol, 1.35, eyeOpen);
      drawRing(LANDMARKS.eye_r, true, eyeCol, 1.35, eyeOpen);
      drawRing(LANDMARKS.brow_l, false, rgbaStr(priRgb, 0.72), 1.3);
      drawRing(LANDMARKS.brow_r, false, rgbaStr(priRgb, 0.72), 1.3);
      drawRing(LANDMARKS.lips_out, true, rgbaStr(speaking ? accRgb : priRgb, 0.8), 1.35);
      drawRing(LANDMARKS.lips_in, true, rgbaStr(whiteRgb, speaking ? 0.65 : 0.35), 1.0);

      // Holographic reticle circles around head
      ctx.strokeStyle = rgbaStr(priRgb, 0.14);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, scalePx * 1.18, 0, Math.PI * 2);
      ctx.stroke();

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(t * 0.25);
      ctx.setLineDash([10, 18]);
      ctx.strokeStyle = rgbaStr(priRgb, 0.26);
      ctx.beginPath();
      ctx.arc(0, 0, scalePx * 1.26, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    };

    const drawReactor = (
      w: number,
      h: number,
      dt: number,
      priRgb: [number, number, number],
      accRgb: [number, number, number],
      bgRgb: [number, number, number],
      whiteRgb: [number, number, number],
      curState: AssistantState,
      lvl: number
    ) => {
      const spinMult = curState === 'SPEAKING' ? 2.4 : curState === 'THINKING' ? 3.2 : curState === 'LISTENING' ? 1.5 : 0.8;
      reactorPhase += dt * spinMult;

      const cx = w * 0.5;
      const cy = h * 0.45;
      const R = Math.min(w * 0.26, h * 0.28);

      const cosPitch = Math.cos(PITCH);
      const sinPitch = Math.sin(PITCH);

      const projectPt = (x: number, y: number, z: number): [number, number, number] => {
        const ry = y * cosPitch - z * sinPitch;
        const rz = y * sinPitch + z * cosPitch;
        const p = CAM_D / Math.max(0.5, CAM_D - rz);
        return [cx + x * R * p, cy - ry * R * p, rz];
      };

      const rotY = (pt: [number, number, number], a: number): [number, number, number] => {
        const c = Math.cos(a),
          s = Math.sin(a);
        return [pt[0] * c + pt[2] * s, pt[1], -pt[0] * s + pt[2] * c];
      };
      const rotX = (pt: [number, number, number], a: number): [number, number, number] => {
        const c = Math.cos(a),
          s = Math.sin(a);
        return [pt[0], pt[1] * c - pt[2] * s, pt[1] * s + pt[2] * c];
      };
      const rotZ = (pt: [number, number, number], a: number): [number, number, number] => {
        const c = Math.cos(a),
          s = Math.sin(a);
        return [pt[0] * c - pt[1] * s, pt[0] * s + pt[1] * c, pt[2]];
      };

      // Core glow
      const glowR = R * (0.85 + lvl * 0.35);
      const grad = ctx.createRadialGradient(cx, cy, R * 0.05, cx, cy, glowR);
      const coreCol = curState === 'SPEAKING' ? accRgb : priRgb;
      grad.addColorStop(0, rgbaStr(whiteRgb, 0.32 + lvl * 0.35));
      grad.addColorStop(0.38, rgbaStr(coreCol, 0.24 + lvl * 0.2));
      grad.addColorStop(1, rgbaStr(bgRgb, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
      ctx.fill();

      // Projector platform rings at FLOOR_Y
      for (const rad of [1.18, 0.92, 0.65]) {
        ctx.beginPath();
        for (let i = 0; i <= N_RING; i++) {
          const p = ringPts[i % N_RING];
          const [sx, sy] = projectPt(p[0] * rad, FLOOR_Y, p[2] * rad);
          if (i === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        }
        ctx.strokeStyle = rgbaStr(priRgb, rad > 1 ? 0.34 : 0.2);
        ctx.lineWidth = rad > 1 ? 1.4 : 1;
        ctx.stroke();
      }

      // Platform audio spectrum ticks
      for (let i = 0; i < 36; i++) {
        const a = (i / 36) * Math.PI * 2 + reactorPhase * 0.2;
        const barH = 0.04 + lvl * 0.22 * (0.5 + 0.5 * Math.sin(i * 1.9 + reactorPhase * 5));
        const [x0, y0] = projectPt(Math.cos(a) * 1.18, FLOOR_Y, Math.sin(a) * 1.18);
        const [x1, y1] = projectPt(Math.cos(a) * 1.18, FLOOR_Y + barH, Math.sin(a) * 1.18);
        ctx.strokeStyle = rgbaStr(curState === 'SPEAKING' ? accRgb : priRgb, 0.55);
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }

      const draw3DRing = (
        pts: [number, number, number][],
        backOnly: boolean,
        col: [number, number, number],
        alphaFront: number,
        alphaBack: number,
        width: number
      ) => {
        for (let i = 0; i < pts.length; i++) {
          const p0 = pts[i];
          const p1 = pts[(i + 1) % pts.length];
          const [x0, y0, z0] = projectPt(p0[0], p0[1], p0[2]);
          const [x1, y1, z1] = projectPt(p1[0], p1[1], p1[2]);
          const isBack = (z0 + z1) * 0.5 < 0;
          if (isBack !== backOnly) continue;
          ctx.strokeStyle = rgbaStr(col, isBack ? alphaBack : alphaFront);
          ctx.lineWidth = width;
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.stroke();
        }
      };

      const g1Pts = ringPts.map((p) =>
        rotZ(rotX(rotY([p[0] * 0.86, p[1] * 0.86, p[2] * 0.86], reactorPhase * 0.8), 0.72), reactorPhase * 0.35)
      );
      const g2Pts = ringPts.map((p) =>
        rotX(rotZ(rotY([p[0] * 0.72, p[1] * 0.72, p[2] * 0.72], -reactorPhase * 1.1), -0.82), 0.55)
      );
      const orbitPts = ringPts.map((p) => rotY([p[0] * 1.06, p[1], p[2] * 1.06], reactorPhase * 0.6));

      // Back halves
      draw3DRing(g1Pts, true, priRgb, 0.85, 0.16, 1.5);
      draw3DRing(g2Pts, true, coreCol, 0.85, 0.16, 1.4);
      draw3DRing(orbitPts, true, priRgb, 0.45, 0.1, 1);

      // Globe latitude & longitude lines
      for (const ring of latRings) {
        const sPts = ring.map((p) => [p[0] * SPHERE_R, p[1] * SPHERE_R, p[2] * SPHERE_R] as [number, number, number]);
        draw3DRing(sPts, true, priRgb, 0.5, 0.12, 0.9);
        draw3DRing(sPts, false, priRgb, 0.55, 0.12, 1.0);
      }
      for (const ring of lonRings) {
        const sPts = ring.map((p) =>
          rotY([p[0] * SPHERE_R, p[1] * SPHERE_R, p[2] * SPHERE_R], reactorPhase * 0.45)
        );
        draw3DRing(sPts, true, priRgb, 0.48, 0.12, 0.9);
        draw3DRing(sPts, false, priRgb, 0.55, 0.12, 1.0);
      }

      // Front halves
      draw3DRing(g1Pts, false, priRgb, 0.9, 0.18, 1.8);
      draw3DRing(g2Pts, false, coreCol, 0.9, 0.18, 1.6);
      draw3DRing(orbitPts, false, priRgb, 0.5, 0.1, 1.1);

      // 3 orbital tracers
      for (let k = 0; k < 3; k++) {
        const idx = Math.floor(((k / 3 + reactorPhase * 0.12) % 1) * N_RING);
        const pt = orbitPts[idx];
        const [sx, sy] = projectPt(pt[0], pt[1], pt[2]);
        ctx.fillStyle = rgbaStr(whiteRgb, 0.95);
        ctx.beginPath();
        ctx.arc(sx, sy, 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const render = (now: number) => {
      const dt = Math.min(0.05, Math.max(0.001, (now - lastTs) / 1000));
      lastTs = now;
      t += dt;

      resize();
      const w = canvas.width;
      const h = canvas.height;
      const { hudStyle: style, state: curState, assistantName: name, audioLevel: rawLvl, palette: pal } = propsRef.current;

      smoothLevel += (rawLvl - smoothLevel) * (1 - Math.exp(-dt / 0.06));

      const bgRgb = hexRgb(pal.BG);
      const priRgb = hexRgb(pal.PRI);
      const accRgb = hexRgb(pal.ACC);
      const greenRgb = hexRgb(pal.GREEN);
      const redRgb = hexRgb(pal.MUTED_C);
      const whiteRgb = hexRgb(pal.WHITE);

      ctx.fillStyle = pal.BG;
      ctx.fillRect(0, 0, w, h);

      // Subtle HUD grid lines
      ctx.strokeStyle = rgbaStr(priRgb, 0.04);
      ctx.lineWidth = 1;
      const step = 36;
      ctx.beginPath();
      for (let x = step; x < w; x += step) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
      }
      for (let y = step; y < h; y += step) {
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
      ctx.stroke();

      // Corner HUD brackets
      const m = 14;
      const bLen = 18;
      ctx.strokeStyle = rgbaStr(priRgb, 0.45);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(m, m + bLen);
      ctx.lineTo(m, m);
      ctx.lineTo(m + bLen, m);
      ctx.moveTo(w - m - bLen, m);
      ctx.lineTo(w - m, m);
      ctx.lineTo(w - m, m + bLen);
      ctx.moveTo(m, h - m - bLen);
      ctx.lineTo(m, h - m);
      ctx.lineTo(m + bLen, h - m);
      ctx.moveTo(w - m - bLen, h - m);
      ctx.lineTo(w - m, h - m);
      ctx.lineTo(w - m, h - m - bLen);
      ctx.stroke();

      if (style === 'reactor') {
        drawReactor(w, h, dt, priRgb, accRgb, bgRgb, whiteRgb, curState, smoothLevel);
      } else {
        drawFace(w, h, dt, priRgb, accRgb, bgRgb, whiteRgb, curState, smoothLevel);
      }

      // Assistant Nameplate + State line below centrepiece
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const labelY = h - 62 * dpr;
      ctx.textAlign = 'center';
      ctx.font = `300 ${Math.round(13 * dpr)}px "Segoe UI", sans-serif`;
      ctx.fillStyle = rgbaStr(whiteRgb, 0.78);
      ctx.fillText(name.toUpperCase().split('').join(' '), w * 0.5, labelY);

      const stateColor =
        curState === 'SPEAKING'
          ? accRgb
          : curState === 'LISTENING'
          ? greenRgb
          : curState === 'MUTED'
          ? redRgb
          : priRgb;
      ctx.font = `600 ${Math.round(10 * dpr)}px "Consolas", monospace`;
      ctx.fillStyle = rgbaStr(stateColor, 0.9);
      ctx.fillText(`[ ${curState} ]`, w * 0.5, labelY + 18 * dpr);

      // Dual-sided audio waveform at bottom
      const waveY = h - 24 * dpr;
      const barCount = waveBars.length;
      const barW = 3 * dpr;
      const gap = 3 * dpr;
      const totalWaveW = barCount * (barW + gap);
      const startX = (w - totalWaveW) * 0.5;
      const activeWave = curState === 'SPEAKING' || curState === 'LISTENING';
      for (let i = 0; i < barCount; i++) {
        const distCenter = 1 - Math.abs(i - barCount / 2) / (barCount / 2);
        const target = activeWave
          ? (0.15 + smoothLevel * 0.85) *
            distCenter *
            (0.45 + 0.55 * Math.abs(Math.sin(t * 11 + i * 0.55)))
          : 0.06 + 0.04 * Math.sin(t * 2.5 + i * 0.4);
        waveBars[i] += (target - waveBars[i]) * 0.28;
        const bh = Math.max(2 * dpr, waveBars[i] * 18 * dpr);
        ctx.fillStyle = rgbaStr(stateColor, activeWave ? 0.8 : 0.3);
        ctx.fillRect(startX + i * (barW + gap), waveY - bh * 0.5, barW, bh);
      }

      rafId = requestAnimationFrame(render);
    };

    rafId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(rafId);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full block"
      aria-label="Mark-XXX Holographic HUD Canvas"
    />
  );
};

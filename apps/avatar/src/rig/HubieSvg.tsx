/**
 * Hubie v2 — layered, shaded vector rig traced from assets/hubie/hubie-reference.png (400×400 space).
 *
 * Layer tree (back → front):
 *   ground shadow
 *   character (bounce / lean / forward / shake)
 *     body: back fur, tuxedo (satin lapels, folds), shirt (pleats), vest, gold buttons
 *     neck shadow (ambient occlusion)
 *     head (pivot at neck: tilt, nod, turn)
 *       face (canonical frame rotated -20°, the reference 3/4 tilt)
 *         head fur + fur strands + rim lights, face mask + cheeks, eye patches,
 *         brows, eyes (sclera, iris, pupil, highlights, lids, lashes), nose, mouth, blush
 *       brim shadow, hat (tilt / lift / slide)
 *     bow tie
 *     arms ×2 (elbow pivot off-frame; paw wrist rotation; pointing claw)
 *   sleepy Z's
 *
 * Pure component: params in → SVG out. No filters on animated groups (performance);
 * soft shading uses gradients only.
 */
import React from 'react';
import type { RigParams } from './params.ts';

const C = {
  fur: '#95562f', furLight: '#cf8b52', furMid: '#a8653a', furDark: '#5a3019', furDeep: '#3e1f0f', furRim: '#f0a050',
  cream: '#e6b282', creamLight: '#f8d6ad', creamShade: '#c98f60', patch: '#673a20', patchDark: '#3a1d0e',
  nose: '#2e1c18', mouthIn: '#3a0d0b', tongue: '#d2625e', teeth: '#fffaf2',
  hat: '#101a28', hatHi: '#2a3b58', hatBand: '#060c15', gold: '#f0b549', goldLight: '#ffe7a3', goldDark: '#a5661c',
  tux: '#0f1a2a', tuxHi: '#253854', lapel: '#16243b', shirt: '#fff6e3', shirtShade: '#e6d3b0',
  cyan: '#3cd8ff', orange: '#f19a3a', claw: '#f3dcb8', clawShade: '#c9a87e', cuff: '#fff3dc',
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

/** Deterministic pseudo-random for static fur detail. */
function rnd(i: number, seed: number) { return Math.abs(Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453) % 1; }

/** Fluffy closed path around an ellipse with irregular fur tufts. */
function furPath(cx: number, cy: number, rx: number, ry: number, tufts: number, depth: number, startDeg = 0, seed = 1): string {
  const pts: Array<[number, number]> = [];
  const n = tufts * 2;
  for (let i = 0; i < n; i++) {
    const a = ((startDeg + (360 * i) / n) * Math.PI) / 180;
    const j = 0.25 + 0.75 * rnd(i, seed);
    const r = i % 2 === 0 ? 1 + (depth / Math.max(rx, ry)) * j : 1 - (depth * 0.25) / Math.max(rx, ry);
    pts.push([cx + Math.cos(a) * rx * r, cy + Math.sin(a) * ry * r]);
  }
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 1; i <= n; i++) {
    const p = pts[i % n], prev = pts[i - 1];
    d += ` Q${prev[0].toFixed(1)},${prev[1].toFixed(1)} ${((prev[0] + p[0]) / 2).toFixed(1)},${((prev[1] + p[1]) / 2).toFixed(1)}`;
  }
  return d + 'Z';
}

/** Short curved fur strands along an ellipse band (static detail for texture). */
function strands(cx: number, cy: number, rx: number, ry: number, n: number, len: number, fromDeg: number, toDeg: number, seed: number): string {
  let d = '';
  for (let i = 0; i < n; i++) {
    const a = ((fromDeg + ((toDeg - fromDeg) * (i + rnd(i, seed) * 0.6)) / n) * Math.PI) / 180;
    const r0 = 0.82 + rnd(i + 3, seed) * 0.16;
    const x0 = cx + Math.cos(a) * rx * r0, y0 = cy + Math.sin(a) * ry * r0;
    const l = len * (0.6 + rnd(i + 7, seed) * 0.6);
    const x1 = x0 + Math.cos(a) * l, y1 = y0 + Math.sin(a) * l;
    const bend = (rnd(i + 11, seed) - 0.5) * l;
    d += `M${x0.toFixed(1)},${y0.toFixed(1)} Q${((x0 + x1) / 2 + Math.sin(a) * bend).toFixed(1)},${((y0 + y1) / 2 - Math.cos(a) * bend).toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)} `;
  }
  return d;
}

const HEAD_FUR = furPath(198, 194, 124, 92, 15, 10, 4, 1.3);
const HEAD_FUR_BACK = furPath(198, 198, 131, 98, 13, 16, 10, 2.1);
const FACE_MASK = furPath(203, 205, 100, 70, 18, 5, 0, 3.7);
const FUR_STRANDS_DARK = strands(198, 194, 124, 92, 46, 9, 20, 340, 4.2);
const FUR_STRANDS_LIGHT = strands(198, 190, 112, 82, 30, 7, 190, 330, 7.7);
const FACE_STRANDS = strands(203, 210, 92, 62, 26, 5, 30, 150, 9.1);

/* ---------------- Mouth ---------------- */
export function mouthGeometry(p: RigParams) {
  const open = clamp(p.mouthOpen), wide = clamp(p.mouthWide), round = clamp(p.mouthRound);
  const smile = clamp(p.mouthSmile, -1, 1), smirk = clamp(p.mouthSmirk, -1, 1);
  const cx = 204, cy = 211;
  const halfW = lerp(44, 21, round) * lerp(1, 1.12, wide) * lerp(1, 0.86, open * 0.6);
  const lift = 9 * smile;
  const L = [cx - halfW, cy - lift - 1 + 5 * smirk * Math.max(0, smile)] as const;
  const R = [cx + halfW, cy - lift - 7 * smirk * Math.max(0, smile) - 2] as const;
  const upperDip = 13 * smile - open * 4 + round * 2;
  const lowerDrop = 10 * smile + open * lerp(30, 26, wide) + round * open * 7;
  const upper = `M${L[0].toFixed(1)},${L[1].toFixed(1)} Q${cx},${(cy + upperDip).toFixed(1)} ${R[0].toFixed(1)},${R[1].toFixed(1)}`;
  const lower = `Q${cx},${(cy + lowerDrop + 4).toFixed(1)} ${L[0].toFixed(1)},${L[1].toFixed(1)}`;
  return { L, R, cx, cy, upperDip, lowerDrop, upper, inner: `${upper} ${lower}Z`, open };
}

function Mouth({ p }: { p: RigParams }) {
  const g = mouthGeometry(p);
  const lineOnly = g.open < 0.06;
  const teethH = 4 + 4 * clamp(p.mouthWide);
  return (
    <g id="mouth">
      {lineOnly ? (
        <>
          <path d={g.upper} fill="none" stroke={C.patchDark} strokeWidth={4.4} strokeLinecap="round" />
          <path d={g.upper} fill="none" stroke="#fff" strokeWidth={1.2} strokeLinecap="round" opacity={0.12} transform="translate(0 3)" />
          <path d={`M${g.R[0] - 2},${g.R[1] - 4} q6,1 7,6`} fill="none" stroke={C.patchDark} strokeWidth={2.6} strokeLinecap="round" />
          <path d={`M${g.L[0] + 2},${g.L[1] - 3} q-5,2 -5,6`} fill="none" stroke={C.patchDark} strokeWidth={2} strokeLinecap="round" opacity={0.7} />
        </>
      ) : (
        <>
          <clipPath id="mouthClip"><path d={g.inner} /></clipPath>
          <path d={g.inner} fill="url(#mouthGrad)" />
          <g clipPath="url(#mouthClip)">
            <ellipse cx={g.cx + 4} cy={g.cy + g.lowerDrop - 1} rx={25} ry={13} fill="url(#tongueGrad)" />
            <rect x={g.cx - 42} y={g.cy + g.upperDip - 10} width={84} height={10 + teethH} rx={3} fill={C.teeth} opacity={g.open > 0.22 ? 1 : 0} />
            <rect x={g.cx - 42} y={g.cy + g.upperDip + teethH - 1} width={84} height={2} fill="#d9c6b0" opacity={g.open > 0.22 ? 0.8 : 0} />
          </g>
          <path d={g.inner} fill="none" stroke={C.patchDark} strokeWidth={3.2} strokeLinejoin="round" />
        </>
      )}
    </g>
  );
}

/* ---------------- Eyes ---------------- */
function Eye({ cx, cy, w, h, lid, lower, wide, gx, gy, brow, browTilt, side, sparkle }: {
  cx: number; cy: number; w: number; h: number; lid: number; lower: number; wide: number; gx: number; gy: number;
  brow: number; browTilt: number; side: 'L' | 'R'; sparkle: number;
}) {
  const id = `eye${side}`;
  const m = side === 'R' ? -1 : 1;
  const H = h * (1 + 0.45 * clamp(wide));
  const almond = side === 'L'
    ? `M${cx - w},${cy} Q${cx - w * 0.2},${cy - H * 1.6} ${cx + w},${cy - H * 0.25} Q${cx + w * 0.1},${cy + H * 1.3} ${cx - w},${cy}Z`
    : `M${cx + w},${cy} Q${cx + w * 0.2},${cy - H * 1.6} ${cx - w},${cy - H * 0.25} Q${cx - w * 0.1},${cy + H * 1.3} ${cx + w},${cy}Z`;
  const topY = cy - H * 1.1, botY = cy + H * 0.8;
  const lidEdge = lerp(topY, botY + 2, clamp(lid));
  const slant = browTilt * 4 * m;
  const lowerEdge = lerp(botY + 3, cy - H * 0.1, clamp(lower) * 0.85);
  const ix = cx + gx * w * 0.38, iy = cy + gy * H * 0.35 + 1;
  const irisR = h * 0.95 * (1 - 0.12 * clamp(wide));
  const browY = cy - h * 1.95 - brow * 8 - wide * 4;
  const tilt = browTilt * 7;
  const lashY = Math.min(lidEdge, cy + 2);
  return (
    <g id={id}>
      <clipPath id={`${id}clip`}><path d={almond} /></clipPath>
      <path d={almond} fill="url(#scleraGrad)" />
      <g clipPath={`url(#${id}clip)`}>
        <circle cx={ix} cy={iy} r={irisR} fill="url(#irisGrad)" />
        <circle cx={ix} cy={iy} r={irisR} fill="none" stroke="#24100a" strokeWidth={1.4} opacity={0.8} />
        <circle cx={ix} cy={iy} r={irisR * (0.42 - 0.12 * clamp(wide))} fill="#120604" />
        <circle cx={ix - 3.2 * m} cy={iy - 3.4} r={2.9 + sparkle * 1.6} fill="#fff" />
        <circle cx={ix + 3 * m} cy={iy + 3} r={1.2 + sparkle * 1.1} fill="#fff" opacity={0.85} />
        {sparkle > 0.3 && <path d={`M${ix + 4 * m},${iy - 6} l1.2,2.4 l2.4,1.2 l-2.4,1.2 l-1.2,2.4 l-1.2,-2.4 l-2.4,-1.2 l2.4,-1.2z`} fill="#fff" opacity={sparkle} />}
        {/* lid shadow on the eyeball */}
        <rect x={cx - w - 4} y={lidEdge - 2} width={w * 2 + 8} height={7} fill="#5a2d18" opacity={0.28} />
        {/* upper lid */}
        <path d={`M${cx - w - 4},${topY - 14} L${cx + w + 4},${topY - 14} L${cx + w + 4},${lidEdge - slant} Q${cx},${lidEdge + 3} ${cx - w - 4},${lidEdge + slant} Z`} fill="url(#lidGrad)" />
        {/* lower lid */}
        <path d={`M${cx - w - 4},${botY + 14} L${cx + w + 4},${botY + 14} L${cx + w + 4},${lowerEdge} Q${cx},${lowerEdge - 3} ${cx - w - 4},${lowerEdge} Z`} fill={C.patch} />
      </g>
      {/* lash line + outer lashes */}
      <path d={`M${cx - w - 1},${lashY + slant} Q${cx},${lashY + 3} ${cx + w + 1},${lashY - slant}`} fill="none" stroke={C.patchDark} strokeWidth={3.4} strokeLinecap="round" />
      <path d={side === 'L' ? `M${cx - w},${lashY + slant} l-5,-3 M${cx - w + 3},${lashY + slant - 1} l-4,-5` : `M${cx + w},${lashY - slant} l5,-3 M${cx + w - 3},${lashY - slant - 1} l4,-5`} stroke={C.patchDark} strokeWidth={2} strokeLinecap="round" />
      {/* lower lid crease (squint/happy) */}
      <path d={`M${cx - w * 0.7},${lowerEdge + 2} Q${cx},${lowerEdge - 2} ${cx + w * 0.7},${lowerEdge + 2}`} fill="none" stroke={C.patchDark} strokeWidth={1.6} opacity={0.25 + 0.5 * clamp(lower)} />
      {/* brow tuft (tapered, furry) */}
      <path d={`M${cx - w * 1.05},${browY + tilt * m * -1 + 5} Q${cx - w * 0.2},${browY - 5} ${cx + w * 1.05},${browY + tilt * m + 5} Q${cx},${browY + 2} ${cx - w * 1.05},${browY + tilt * m * -1 + 5}Z`} fill={C.patchDark} opacity={0.75} />
      <path d={`M${cx - w * 0.8},${browY + tilt * m * -0.8 + 2} Q${cx},${browY - 6} ${cx + w * 0.8},${browY + tilt * m * 0.8 + 2}`} fill="none" stroke={C.furMid} strokeWidth={1.4} opacity={0.6} />
    </g>
  );
}

/* ---------------- Arms ---------------- */
function Arm({ side, r, x, y, pr, pt, t, shoulders }: { side: 'L' | 'R'; r: number; x: number; y: number; pr: number; pt: number; t: number; shoulders: number }) {
  const s = side === 'L' ? 1 : -1;
  const px = side === 'L' ? 70 : 350, py = 430;
  const transform = `translate(${x * s} ${y - shoulders}) rotate(${r * s} ${px} ${py})`;
  const pawC = side === 'L' ? [160, 305] : [298, 310];
  const pawT = `rotate(${pr * s} ${pawC[0]} ${pawC[1]})`;
  void t;
  if (side === 'L') {
    return (
      <g id="armL" transform={transform}>
        <path d="M-40,560 L18,420 C40,380 70,345 100,325 L150,352 C130,380 110,405 98,430 L60,600 Z" fill="url(#sleeveGrad)" />
        <path d="M30,410 C52,378 76,352 100,336" fill="none" stroke={C.tuxHi} strokeWidth={2} opacity={0.5} />
        <path d="M100,325 L150,352" stroke={C.cyan} strokeWidth={2} opacity={0.35} />
        <g transform="rotate(32 128 348)">
          <rect x={100} y={326} width={56} height={42} rx={9} fill="url(#cuffGrad)" />
          <rect x={100} y={326} width={56} height={9} rx={4.5} fill={C.shirtShade} opacity={0.8} />
          <circle cx={120} cy={360} r={6.2} fill="url(#goldGrad)" stroke={C.goldDark} strokeWidth={1.4} />
          <circle cx={118} cy={358} r={1.8} fill="#fff" opacity={0.8} />
        </g>
        <g transform={pawT}>
          <path d="M118,318 C122,292 146,280 170,284 C188,288 196,302 190,318 C182,336 150,346 132,338 C122,334 116,328 118,318Z" fill="url(#pawGrad)" />
          <path d={strands(156, 312, 30, 22, 10, 5, 180, 330, 2.2)} stroke={C.furLight} strokeWidth={1.3} fill="none" opacity={0.55} />
          <path d="M128,326 C140,330 160,330 176,320" fill="none" stroke={C.furDark} strokeWidth={2} opacity={0.6} />
          <path d={pt > 0.5 ? 'M168,288 C186,272 206,268 216,272 C204,276 188,284 176,296Z' : 'M168,288 C182,280 196,284 202,294 C194,290 184,290 174,296Z'} fill="url(#clawGrad)" />
          <path d="M176,300 C190,294 204,298 208,308 C200,304 190,304 180,310Z" fill="url(#clawGrad)" />
          <path d="M178,312 C190,310 200,314 204,322 C196,318 188,318 180,322Z" fill="url(#clawGrad)" />
        </g>
      </g>
    );
  }
  return (
    <g id="armR" transform={transform}>
      <path d="M460,560 L402,420 C385,385 362,352 334,330 L290,352 C306,378 318,404 326,430 L360,600 Z" fill="url(#sleeveGrad)" />
      <path d="M390,410 C372,380 352,356 334,342" fill="none" stroke={C.tuxHi} strokeWidth={2} opacity={0.4} />
      <path d="M334,330 L290,352" stroke={C.orange} strokeWidth={2} opacity={0.35} />
      <g transform="rotate(-28 330 350)">
        <rect x={300} y={330} width={58} height={42} rx={9} fill="url(#cuffGrad)" />
        <rect x={300} y={330} width={58} height={9} rx={4.5} fill={C.shirtShade} opacity={0.8} />
        <circle cx={340} cy={364} r={6.2} fill="url(#goldGrad)" stroke={C.goldDark} strokeWidth={1.4} />
        <circle cx={338} cy={362} r={1.8} fill="#fff" opacity={0.8} />
      </g>
      <g transform={pawT}>
        <path d="M330,322 C330,298 312,284 290,286 C272,288 264,302 270,318 C276,334 300,344 316,340 C326,336 332,330 330,322Z" fill="url(#pawGrad)" />
        <path d={strands(300, 314, 30, 22, 10, 5, 210, 360, 5.5)} stroke={C.furLight} strokeWidth={1.3} fill="none" opacity={0.55} />
        <path d="M282,328 C296,334 312,334 324,326" fill="none" stroke={C.furDark} strokeWidth={2} opacity={0.6} />
        <path d={pt > 0.5 ? 'M290,290 C272,274 252,270 242,274 C254,278 270,286 282,298Z' : 'M290,290 C278,282 264,284 258,294 C266,290 276,290 284,298Z'} fill="url(#clawGrad)" />
        <path d="M284,302 C272,296 258,300 254,310 C262,306 272,306 280,312Z" fill="url(#clawGrad)" />
        <path d="M284,314 C272,312 262,316 258,324 C266,320 274,320 282,324Z" fill="url(#clawGrad)" />
      </g>
    </g>
  );
}

/* ---------------- Hat ---------------- */
function Hat({ tilt, lift, x }: { tilt: number; lift: number; x: number }) {
  return (
    <g id="hat" transform={`translate(${148 + x} 130) rotate(${-30 + tilt}) translate(0 ${-lift})`}>
      <ellipse cx={0} cy={0} rx={104} ry={26} fill={C.hatBand} />
      <path d="M-62,-4 C-60,-40 -64,-80 -60,-96 C-30,-104 30,-104 60,-96 C62,-80 58,-40 62,-4 C30,6 -30,6 -62,-4Z" fill="url(#hatCrownGrad)" />
      <path d="M-60,-96 C-30,-104 30,-104 60,-96 C40,-88 -40,-88 -60,-96Z" fill="url(#hatTopGrad)" />
      {/* felt sheen */}
      <path d="M-38,-92 C-42,-70 -38,-40 -40,-16" fill="none" stroke="#ffffff" strokeWidth={9} opacity={0.06} strokeLinecap="round" />
      <path d="M-28,-94 C-30,-70 -27,-44 -29,-20" fill="none" stroke="#ffffff" strokeWidth={3} opacity={0.08} strokeLinecap="round" />
      <path d="M-62,-6 C-60,-40 -64,-80 -60,-96" fill="none" stroke={C.cyan} strokeWidth={4} strokeLinecap="round" opacity={0.9} />
      <path d="M60,-96 C62,-80 58,-40 62,-6" fill="none" stroke={C.orange} strokeWidth={3} strokeLinecap="round" opacity={0.85} />
      {/* satin band */}
      <path d="M-62,-30 C-30,-22 30,-22 62,-30 L62,-6 C30,4 -30,4 -62,-6Z" fill="url(#bandGrad)" />
      {/* H badge with bevel */}
      <g transform="translate(-10 -30)">
        <rect x={-17} y={-18} width={34} height={32} rx={4} fill="url(#goldGrad)" stroke={C.goldDark} strokeWidth={2} />
        <rect x={-13} y={-14} width={26} height={24} rx={2} fill="none" stroke={C.goldLight} strokeWidth={1} opacity={0.7} />
        <path d="M-8,-11 V8 M8,-11 V8 M-8,-1 H8" stroke={C.hatBand} strokeWidth={5} strokeLinecap="square" />
        <path d="M-13,-15 L3,-15" stroke="#fff" strokeWidth={1.5} opacity={0.6} strokeLinecap="round" />
      </g>
      <path d="M-104,0 C-90,22 90,22 104,0 C90,12 -90,12 -104,0Z" fill={C.hat} />
      <path d="M-104,0 C-92,20 -40,26 0,26" fill="none" stroke={C.cyan} strokeWidth={4} strokeLinecap="round" />
      <path d="M50,22 C80,18 98,10 104,0" fill="none" stroke={C.orange} strokeWidth={2.5} strokeLinecap="round" opacity={0.8} />
    </g>
  );
}

/* ---------------- Whole character ---------------- */
export function HubieSvg({ p, t = 0, width = 400, height = 400, showBg = false }: { p: RigParams; t?: number; width?: number; height?: number; showBg?: boolean }) {
  const breathY = 1 + 0.012 * p.breath;
  const fwd = clamp(p.forward, -1, 1);
  const scaleF = 1 + 0.045 * fwd;
  const shakeX = p.shake * Math.sin(t * 38) * 2.2, shakeY = p.shake * Math.cos(t * 31) * 1.6;
  const nod = clamp(p.headNod, -1, 1);
  const turn = clamp(p.headTurn, -1, 1);
  // character root transform: bounce + shake + forward lean (scale around feet)
  const root = `translate(${shakeX} ${-p.bounce + shakeY + fwd * 6}) translate(210 400) scale(${scaleF}) rotate(${p.bodyLean}) translate(-210 -400)`;
  const headT = `translate(${p.headX + turn * 6} ${p.headY + nod * 7 - p.shoulders * 0.4}) rotate(${p.headRot} 222 270)`;
  const faceT = `rotate(-20 200 195) translate(${turn * 7} ${nod * 4}) scale(1 ${1 - Math.abs(nod) * 0.03})`;
  return (
    <svg viewBox="0 0 400 400" width={width} height={height} xmlns="http://www.w3.org/2000/svg" style={{ overflow: 'visible' }}>
      <defs>
        <radialGradient id="furGrad" cx="42%" cy="35%" r="70%">
          <stop offset="0%" stopColor={C.furLight} /><stop offset="45%" stopColor={C.furMid} /><stop offset="80%" stopColor={C.fur} /><stop offset="100%" stopColor={C.furDark} />
        </radialGradient>
        <radialGradient id="faceGrad" cx="48%" cy="40%" r="62%">
          <stop offset="0%" stopColor={C.creamLight} /><stop offset="70%" stopColor={C.cream} /><stop offset="100%" stopColor={C.creamShade} />
        </radialGradient>
        <radialGradient id="patchGrad" cx="50%" cy="40%" r="65%">
          <stop offset="0%" stopColor="#7c4a2b" /><stop offset="100%" stopColor="#4b2614" />
        </radialGradient>
        <radialGradient id="scleraGrad" cx="45%" cy="40%" r="70%">
          <stop offset="0%" stopColor="#fffaf2" /><stop offset="100%" stopColor="#e9cdb4" />
        </radialGradient>
        <radialGradient id="irisGrad" cx="40%" cy="35%" r="70%">
          <stop offset="0%" stopColor="#a5602e" /><stop offset="45%" stopColor="#6d3416" /><stop offset="100%" stopColor="#2a1107" />
        </radialGradient>
        <linearGradient id="lidGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#7b4527" /><stop offset="100%" stopColor="#5c3019" />
        </linearGradient>
        <radialGradient id="noseGrad" cx="38%" cy="28%" r="80%">
          <stop offset="0%" stopColor="#6b4a40" /><stop offset="35%" stopColor="#3a2420" /><stop offset="100%" stopColor="#1b0f0c" />
        </radialGradient>
        <linearGradient id="mouthGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#24060a" /><stop offset="100%" stopColor="#5a1612" />
        </linearGradient>
        <radialGradient id="tongueGrad" cx="50%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#ee8a82" /><stop offset="100%" stopColor="#b44a47" />
        </radialGradient>
        <linearGradient id="tuxGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={C.tuxHi} /><stop offset="40%" stopColor={C.tux} /><stop offset="100%" stopColor="#080f1b" />
        </linearGradient>
        <linearGradient id="sleeveGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#0a1220" /><stop offset="55%" stopColor="#15233a" /><stop offset="100%" stopColor="#0b1424" />
        </linearGradient>
        <linearGradient id="lapelGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#2a3f63" /><stop offset="35%" stopColor="#172640" /><stop offset="70%" stopColor="#0f1b2e" /><stop offset="100%" stopColor="#1d2f4d" />
        </linearGradient>
        <linearGradient id="shirtGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#fffbf1" /><stop offset="100%" stopColor="#ecdcbc" />
        </linearGradient>
        <linearGradient id="cuffGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#fffaf0" /><stop offset="100%" stopColor="#e6d4b2" />
        </linearGradient>
        <linearGradient id="goldGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={C.goldLight} /><stop offset="45%" stopColor={C.gold} /><stop offset="100%" stopColor={C.goldDark} />
        </linearGradient>
        <linearGradient id="hatCrownGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#24344f" /><stop offset="30%" stopColor="#141f31" /><stop offset="75%" stopColor="#0a111c" /><stop offset="100%" stopColor="#1a1712" />
        </linearGradient>
        <linearGradient id="hatTopGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#33476a" /><stop offset="100%" stopColor="#1c2a42" />
        </linearGradient>
        <linearGradient id="bandGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#04070d" /><stop offset="35%" stopColor="#1b283c" /><stop offset="55%" stopColor="#0a111c" /><stop offset="100%" stopColor="#04070d" />
        </linearGradient>
        <linearGradient id="bowGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#1f3150" /><stop offset="55%" stopColor="#0d1828" /><stop offset="100%" stopColor="#060c16" />
        </linearGradient>
        <radialGradient id="pawGrad" cx="40%" cy="30%" r="80%">
          <stop offset="0%" stopColor={C.furLight} /><stop offset="60%" stopColor={C.fur} /><stop offset="100%" stopColor={C.furDark} />
        </radialGradient>
        <linearGradient id="clawGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#fff2da" /><stop offset="100%" stopColor={C.clawShade} />
        </linearGradient>
        <radialGradient id="aoGrad" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#000" stopOpacity={0.5} /><stop offset="100%" stopColor="#000" stopOpacity={0} />
        </radialGradient>
        <radialGradient id="cheekGrad" cx="50%" cy="40%" r="60%">
          <stop offset="0%" stopColor="#fbdcb6" /><stop offset="100%" stopColor="#f0c08f" stopOpacity={0} />
        </radialGradient>
        <radialGradient id="bgGrad" cx="50%" cy="40%" r="70%">
          <stop offset="0%" stopColor="#063a42" /><stop offset="100%" stopColor="#011a1e" />
        </radialGradient>
      </defs>
      {showBg && <rect width={400} height={400} fill="url(#bgGrad)" />}
      {/* ground shadow */}
      <ellipse cx={215} cy={402} rx={190} ry={18} fill="url(#aoGrad)" opacity={0.7} />

      <g id="character" transform={root}>
        <g id="body" transform={`translate(0 ${-(breathY - 1) * 400 - p.shoulders * 0.5}) scale(1 ${breathY})`}>
          {/* long back fur flowing over the right shoulder */}
          <path d="M296,214 C330,240 352,270 372,300 C388,326 396,360 400,400 L360,400 C356,360 340,320 318,290 C306,272 296,250 290,232Z" fill="url(#furGrad)" />
          {[0, 1, 2, 3, 4].map((i) => (
            <path key={i} d={`M${300 + i * 6},${220 + i * 8} C${334 + i * 8},${262 + i * 6} ${360 + i * 8},${310 + i * 4} ${370 + i * 7},${400}`} fill="none" stroke={i % 2 ? C.furRim : C.furLight} strokeWidth={i === 2 ? 2.6 : 1.8} opacity={0.7} />
          ))}
          {/* tuxedo torso */}
          <path d="M0,400 L0,330 C24,300 70,282 128,272 L176,266 L296,258 C338,266 372,284 400,306 L400,400 Z" fill="url(#tuxGrad)" />
          <path d="M0,330 C24,300 70,282 128,272" fill="none" stroke={C.cyan} strokeWidth={4} opacity={0.85} />
          <path d="M296,258 C338,266 372,284 400,306" fill="none" stroke={C.orange} strokeWidth={2} opacity={0.4} />
          {/* fabric folds */}
          <path d="M40,360 C60,340 80,330 110,322 M330,300 C350,320 362,340 370,370" fill="none" stroke="#000" strokeWidth={3} opacity={0.25} strokeLinecap="round" />
          {/* shirt + pleats */}
          <path d="M194,280 L286,274 L296,400 L222,400 Z" fill="url(#shirtGrad)" />
          <path d="M232,300 L238,400 M262,296 L270,400" stroke={C.shirtShade} strokeWidth={1.4} opacity={0.8} />
          <path d="M222,400 L210,300 L240,296 L244,400Z" fill={C.shirtShade} opacity={0.35} />
          {/* vest */}
          <path d="M222,346 C240,356 270,352 298,340 L300,400 L226,400 Z" fill="#0b1422" />
          <path d="M226,352 C246,360 272,356 298,346" fill="none" stroke={C.tuxHi} strokeWidth={1.5} opacity={0.6} />
          <circle cx={248} cy={326} r={3.2} fill={C.tux} /><circle cx={252} cy={354} r={3.2} fill={C.tux} />
          <circle cx={258} cy={388} r={6.8} fill="url(#goldGrad)" stroke={C.goldDark} strokeWidth={1.4} />
          <circle cx={256} cy={386} r={2} fill="#fff" opacity={0.75} />
          {/* satin lapels */}
          <path d="M128,272 L196,280 L226,400 L150,400 C162,350 152,308 128,272Z" fill="url(#lapelGrad)" />
          <path d="M196,280 L226,400" stroke="#3a5480" strokeWidth={2} opacity={0.8} />
          <path d="M150,300 C162,330 168,360 170,398" fill="none" stroke="#fff" strokeWidth={5} opacity={0.05} />
          <path d="M296,258 L284,276 L296,400 L336,400 C324,340 330,296 296,258Z" fill="url(#lapelGrad)" />
          <path d="M284,276 L296,400" stroke="#3a5480" strokeWidth={2} opacity={0.8} />
          {/* collar points */}
          <path d="M196,276 L214,302 L222,282Z" fill={C.shirt} /><path d="M286,270 L266,298 L260,280Z" fill={C.shirt} />
          {/* neck / chin ambient occlusion */}
          <ellipse cx={232} cy={276} rx={70} ry={18} fill="url(#aoGrad)" opacity={0.9} />

          {/* ---------- head ---------- */}
          <g id="head" transform={headT}>
            <g id="face" transform={faceT}>
              <path d={HEAD_FUR_BACK} fill={C.furDeep} />
              <path d={HEAD_FUR} fill="url(#furGrad)" />
              <path d={FUR_STRANDS_DARK} stroke={C.furDark} strokeWidth={1.6} fill="none" opacity={0.45} strokeLinecap="round" />
              <path d={FUR_STRANDS_LIGHT} stroke={C.furLight} strokeWidth={1.4} fill="none" opacity={0.45} strokeLinecap="round" />
              {/* rim lights */}
              <path d="M84,150 C70,180 72,220 92,250" fill="none" stroke={C.cyan} strokeWidth={3.5} strokeLinecap="round" opacity={0.75} />
              <path d="M310,160 C326,190 324,226 304,256" fill="none" stroke={C.furRim} strokeWidth={3} strokeLinecap="round" opacity={0.8} />
              <path d={FACE_MASK} fill="url(#faceGrad)" />
              <path d={FACE_STRANDS} stroke={C.creamShade} strokeWidth={1.2} fill="none" opacity={0.35} strokeLinecap="round" />
              {/* forehead fur widow's peak */}
              <path d="M170,132 C186,150 196,160 204,176 C212,160 222,150 238,132 C214,124 194,124 170,132Z" fill={C.furMid} opacity={0.55} />
              {/* cheeks rise when smiling/laughing */}
              <ellipse cx={156} cy={226 - p.cheek * 8} rx={30} ry={17} fill="url(#cheekGrad)" opacity={0.5 + p.cheek * 0.5} />
              <ellipse cx={258} cy={222 - p.cheek * 8} rx={30} ry={17} fill="url(#cheekGrad)" opacity={0.5 + p.cheek * 0.5} />
              {/* eye patches */}
              <path d="M168,176 C150,168 120,172 104,190 C96,200 98,212 108,214 C124,216 150,204 170,196 C178,190 176,180 168,176Z" fill="url(#patchGrad)" />
              <path d="M232,172 C250,164 280,166 296,182 C304,192 302,204 292,206 C276,208 250,198 232,190 C224,184 224,176 232,172Z" fill="url(#patchGrad)" />
              <Eye side="L" cx={150} cy={186} w={19} h={11} lid={p.lidL} lower={p.lowerL} wide={p.eyeWide} gx={p.gazeX} gy={p.gazeY} brow={p.browL} browTilt={p.browTiltL} sparkle={p.sparkle} />
              <Eye side="R" cx={252} cy={183} w={19} h={11} lid={p.lidR} lower={p.lowerR} wide={p.eyeWide} gx={p.gazeX} gy={p.gazeY} brow={p.browR} browTilt={p.browTiltR} sparkle={p.sparkle} />
              {/* blush */}
              <ellipse cx={150} cy={224 - p.cheek * 6} rx={18} ry={8} fill="#e2735f" opacity={0.5 * p.blush} />
              <ellipse cx={262} cy={220 - p.cheek * 6} rx={18} ry={8} fill="#e2735f" opacity={0.5 * p.blush} />
              {/* nose */}
              <path d="M182,188 C181,174 228,172 229,188 C230,201 214,208 205,210 C196,208 181,201 182,188Z" fill="url(#noseGrad)" />
              <ellipse cx={197} cy={182} rx={8} ry={3.4} fill="#9a7a70" opacity={0.65} />
              <path d="M205,210 L205,216" stroke={C.patchDark} strokeWidth={2.4} strokeLinecap="round" />
              <Mouth p={p} />
              <path d="M176,254 q8,6 16,2 M206,258 q8,4 16,-2" fill="none" stroke={C.creamShade} strokeWidth={2} opacity={0.6} />
            </g>
            {/* soft shadow the brim casts on the head */}
            <ellipse cx={176} cy={150} rx={92} ry={18} transform="rotate(-28 176 150)" fill="url(#aoGrad)" opacity={0.8} />
            <Hat tilt={p.hatTilt} lift={p.hatLift} x={p.hatX} />
          </g>

          {/* bow tie */}
          <g id="bowtie" transform={`rotate(${Math.sin(t * 7) * 2 * p.bowWiggle} 240 294)`}>
            <path d="M240,294 L190,268 C180,282 182,310 194,322 Z" fill="url(#bowGrad)" />
            <path d="M240,294 L290,266 C300,282 300,310 288,322 Z" fill="url(#bowGrad)" />
            <path d="M240,294 L196,276 C192,288 194,304 198,312Z" fill={C.tuxHi} opacity={0.45} />
            <path d="M240,294 L284,274 C290,288 288,304 284,312Z" fill={C.tuxHi} opacity={0.35} />
            <path d="M200,282 L222,292 M200,306 L222,298 M280,280 L258,292 M280,306 L258,298" stroke="#000" strokeWidth={1.4} opacity={0.35} />
            <rect x={228} y={282} width={24} height={24} rx={7} fill="url(#bowGrad)" stroke="#000" strokeOpacity={0.3} />
            <path d="M232,286 L246,286" stroke="#3a5480" strokeWidth={1.5} opacity={0.7} strokeLinecap="round" />
          </g>
        </g>

        <Arm side="L" r={p.aLr} x={p.aLx} y={p.aLy} pr={p.aLp} pt={p.aLpt} t={t} shoulders={p.shoulders} />
        <Arm side="R" r={p.aRr} x={p.aRx} y={p.aRy} pr={p.aRp} pt={p.aRpt} t={t} shoulders={p.shoulders} />
      </g>

      {/* sleepy Z's */}
      {p.zzz > 0.05 && [0, 1, 2].map((i) => {
        const ph = (t * 0.5 + i / 3) % 1;
        return <text key={i} x={300 + ph * 40 + i * 6} y={110 - ph * 70} fontSize={14 + ph * 16} fontWeight={800} fill="#cfe9ff" opacity={p.zzz * (1 - ph)} fontFamily="Fredoka, sans-serif">Z</text>;
      })}
    </svg>
  );
}

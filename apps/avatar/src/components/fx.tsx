import React, { useEffect, useMemo, useState } from 'react';

export function useStageScale(w: number, h: number) {
  const calc = () => Math.min(window.innerWidth / w, window.innerHeight / h);
  const [s, setS] = useState(calc);
  useEffect(() => { const f = () => setS(calc()); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f); }, []);
  return s;
}

/** Slowly drifting leaves — subtle, cheap CSS animation. */
export function Leaves() {
  const leaves = useMemo(() => Array.from({ length: 10 }, (_, i) => ({
    left: (i * 97) % 100, delay: -(i * 3.7) % 24, dur: 18 + (i * 5) % 12, size: 14 + (i * 7) % 14, hue: i % 3,
  })), []);
  return (
    <div className="leaves">
      {leaves.map((l, i) => (
        <svg key={i} className="leaf" viewBox="0 0 20 20" width={l.size} height={l.size}
          style={{ left: `${l.left}%`, animationDelay: `${l.delay}s`, animationDuration: `${l.dur}s` }}>
          <path d="M10 1 C17 5 18 13 10 19 C2 13 3 5 10 1Z" fill={['#2f7d5b', '#3e9a6e', '#c9a34a'][l.hue]} opacity="0.5" />
          <path d="M10 3 L10 18" stroke="#0b2a22" strokeWidth="0.8" opacity="0.5" />
        </svg>
      ))}
    </div>
  );
}

export function Confetti({ trigger }: { trigger: number }) {
  const [active, setActive] = useState(0);
  useEffect(() => { if (!trigger) return; setActive(trigger); const t = setTimeout(() => setActive(0), 3500); return () => clearTimeout(t); }, [trigger]);
  const bits = useMemo(() => Array.from({ length: 70 }, (_, i) => ({
    x: Math.random() * 100, d: Math.random() * 0.6, r: Math.random() * 720 - 360, c: ['#f0b549', '#3cd8ff', '#ffffff', '#f19a3a', '#7ee0a3'][i % 5], w: 8 + Math.random() * 8,
  })), [active]);
  if (!active) return null;
  return (
    <div className="confetti" key={active}>
      {bits.map((b, i) => (
        <i key={i} style={{ left: `${b.x}%`, animationDelay: `${b.d}s`, background: b.c, width: b.w, height: b.w * 0.45, ['--r' as any]: `${b.r}deg` }} />
      ))}
    </div>
  );
}

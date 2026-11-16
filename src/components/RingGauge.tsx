import React from 'react';

interface RingGaugeProps {
  label: string;
  value: number; // 0..100
  displayText: string;
  accentColor?: string;
}

export const RingGauge: React.FC<RingGaugeProps> = ({
  label,
  value,
  displayText,
  accentColor,
}) => {
  const clamped = Math.max(0, Math.min(100, value));
  const r = 21;
  const c = 2 * Math.PI * r;
  const dashOffset = c * (1 - clamped / 100);
  const stroke =
    accentColor ||
    (clamped > 85 ? 'var(--hud-red)' : clamped > 68 ? 'var(--hud-acc)' : 'var(--hud-pri)');

  return (
    <div className="flex flex-col items-center justify-center py-0.5">
      <div className="relative w-14 h-14 flex items-center justify-center">
        <svg className="w-14 h-14 -rotate-90" viewBox="0 0 52 52">
          <circle
            cx="26"
            cy="26"
            r={r}
            fill="none"
            stroke="var(--hud-bar-bg)"
            strokeWidth="4"
          />
          <circle
            cx="26"
            cy="26"
            r={r}
            fill="none"
            stroke={stroke}
            strokeWidth="4"
            strokeDasharray={c}
            strokeDashoffset={dashOffset}
            strokeLinecap="butt"
            style={{ transition: 'stroke-dashoffset 0.35s ease' }}
          />
        </svg>
        <span
          className="absolute text-[10px] font-mono font-semibold"
          style={{ color: 'var(--hud-white)' }}
        >
          {displayText}
        </span>
      </div>
      <span
        className="text-[9px] font-semibold tracking-[1.5px] uppercase mt-0.5"
        style={{ color: 'var(--hud-text-dim)' }}
      >
        {label}
      </span>
    </div>
  );
};

interface SparklineProps {
  points: number[];
}

export const Sparkline: React.FC<SparklineProps> = ({ points }) => {
  const w = 180;
  const h = 40;
  const vals = points.length > 1 ? points : [12, 18, 15, 22, 19, 25];
  const max = Math.max(10, ...vals);
  const coords = vals.map((v, i) => {
    const x = (i / Math.max(1, vals.length - 1)) * w;
    const y = h - 4 - (v / max) * (h - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-10 block">
      <polyline
        fill="none"
        stroke="var(--hud-pri)"
        strokeWidth="1.5"
        points={coords.join(' ')}
      />
      <polygon
        fill="var(--hud-pri-gho)"
        opacity="0.65"
        points={`0,${h} ${coords.join(' ')} ${w},${h}`}
      />
    </svg>
  );
};

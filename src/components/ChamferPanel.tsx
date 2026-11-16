import React from 'react';

interface ChamferPanelProps {
  title: string;
  code?: string;
  headerRight?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export const ChamferPanel: React.FC<ChamferPanelProps> = ({
  title,
  code,
  headerRight,
  children,
  className = '',
}) => {
  return (
    <div
      className={`hud-chamfer relative flex flex-col border ${className}`}
      style={{
        backgroundColor: 'var(--hud-panel)',
        borderColor: 'var(--hud-border)',
      }}
    >
      {/* Header strip */}
      <div
        className="flex items-center justify-between px-3 py-1.5 border-b shrink-0"
        style={{
          backgroundColor: 'var(--hud-panel2)',
          borderColor: 'var(--hud-border)',
        }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="w-1.5 h-3 shrink-0"
            style={{ backgroundColor: 'var(--hud-pri)' }}
          />
          <span
            className="text-[10px] font-semibold tracking-[2px] uppercase truncate"
            style={{ color: 'var(--hud-text)' }}
          >
            {title}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {code && (
            <span
              className="text-[9px] font-mono tracking-[1.4px] uppercase"
              style={{ color: 'var(--hud-pri-dim)' }}
            >
              {code}
            </span>
          )}
          {headerRight}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 flex flex-col p-2.5">{children}</div>
    </div>
  );
};

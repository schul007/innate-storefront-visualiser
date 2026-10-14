import { useRef, useState, useCallback } from 'react';

/**
 * Draggable before/after comparison slider.
 * The AFTER image is the flow "base" and sets the box at its natural aspect
 * ratio, so the whole composite (and its planters) is always visible – never
 * cropped. The BEFORE image is an overlay revealed by a clip-path.
 */
export function BeforeAfter({
  before, after, beforeLabel = 'Frontage', afterLabel = 'With planters',
}: {
  before: string; after: string; beforeLabel?: string; afterLabel?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(50);

  const move = useCallback((clientX: number) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setPos(Math.max(0, Math.min(100, pct)));
  }, []);

  return (
    <div
      ref={ref}
      className="ba"
      onMouseMove={(e) => e.buttons === 1 && move(e.clientX)}
      onMouseDown={(e) => move(e.clientX)}
      onTouchMove={(e) => move(e.touches[0].clientX)}
      role="slider"
      aria-label="Before and after comparison"
      aria-valuenow={Math.round(pos)}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') setPos((p) => Math.max(0, p - 4));
        if (e.key === 'ArrowRight') setPos((p) => Math.min(100, p + 4));
      }}
    >
      <img className="ba-base" src={after} alt={afterLabel} draggable={false} />
      <img
        className="ba-over"
        src={before}
        alt={beforeLabel}
        draggable={false}
        style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
      />
      <span className="ba-tag ba-tag-left">{beforeLabel}</span>
      <span className="ba-tag ba-tag-right">{afterLabel}</span>
      <div className="ba-handle" style={{ left: `${pos}%` }}>
        <span className="ba-grip">‹ ›</span>
      </div>
    </div>
  );
}

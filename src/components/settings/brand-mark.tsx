'use client';

import { useState, type ReactNode } from 'react';

/**
 * Shows an official brand asset from /public (e.g. /brand/whatsapp.svg)
 * and quietly falls back to `fallback` when no file is there, so the UI
 * never shows a broken-image icon.
 *
 * `srcs` are tried in order (svg, then png, then webp, …); the first one
 * that loads wins.
 *
 * Brand logos (WhatsApp, Facebook) are not drawn in code — drop the
 * official files from the owners' brand-resource pages into public/brand/.
 */
export function BrandMark({
  srcs,
  alt,
  className,
  fallback = null,
}: {
  srcs: string[];
  alt: string;
  className?: string;
  fallback?: ReactNode;
}) {
  const [index, setIndex] = useState(0);
  if (index >= srcs.length) return <>{fallback}</>;
  const current = index;
  const next = () => setIndex((i) => (i === current ? i + 1 : i));
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      key={srcs[current]}
      src={srcs[current]}
      alt={alt}
      className={className}
      onError={next}
      // The image can fail before React attaches onError (server-rendered
      // markup); catch that case when the node mounts.
      ref={(el) => {
        if (el && el.complete && el.naturalWidth === 0) {
          queueMicrotask(next);
        }
      }}
    />
  );
}
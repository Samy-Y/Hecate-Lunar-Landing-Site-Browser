/**
 * Finite-disk visibility (spec v2.0 sec. 2.3).
 *
 * Disk of angular radius r centred at elevation el, local terrain horizon h at that
 * azimuth (treated as locally flat across the 0.53 deg disk). With x = (el - h)/r:
 *   x >=  1  -> fully visible (f = 1)
 *   x <= -1  -> fully occulted (f = 0)
 *   else     -> circular-segment area fraction  f = (acos(-x) + x sqrt(1 - x^2)) / pi
 */
export function diskFraction(el: number, h: number, r: number): number {
  const x = (el - h) / r;
  if (x >= 1) return 1;
  if (x <= -1) return 0;
  return (Math.acos(-x) + x * Math.sqrt(1 - x * x)) / Math.PI;
}

/** Inverse of diskFraction: offset (el - h) at which the visible fraction equals f. */
export function offsetForFraction(f: number, r: number): number {
  if (f <= 0) return -r;
  if (f >= 1) return r;
  let lo = -r, hi = r;
  for (let i = 0; i < 60; i++) {
    const m = (lo + hi) / 2;
    if (diskFraction(m, 0, r) < f) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

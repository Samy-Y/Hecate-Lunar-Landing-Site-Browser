/**
 * Brent's method (Brent 1973, "zeroin") for a bracketed root of f on [a, b].
 * Used by the two-stage temporal engine to refine horizon-crossing epochs to
 * <= tol (default 2 s) after the 1-hour coarse bracket scan (spec v2.0 sec. 5.3).
 */
export interface BrentResult {
  x: number;
  iterations: number;
}

export function brent(f: (x: number) => number, a: number, b: number, fa = f(a), fb = f(b), tol = 2000, maxIter = 60): BrentResult {
  if (fa === 0) return { x: a, iterations: 0 };
  if (fb === 0) return { x: b, iterations: 0 };
  if (fa * fb > 0) throw new Error('brent: root not bracketed');
  let c = a, fc = fa, d = b - a, e = d;
  let it = 0;
  for (; it < maxIter; it++) {
    if (fb * fc > 0) {
      c = a; fc = fa; d = b - a; e = d;
    }
    if (Math.abs(fc) < Math.abs(fb)) {
      a = b; b = c; c = a;
      fa = fb; fb = fc; fc = fa;
    }
    const tol1 = 2 * Number.EPSILON * Math.abs(b) + 0.5 * tol;
    const xm = 0.5 * (c - b);
    if (Math.abs(xm) <= tol1 || fb === 0) break;
    if (Math.abs(e) >= tol1 && Math.abs(fa) > Math.abs(fb)) {
      // Attempt inverse quadratic interpolation (or secant).
      const s = fb / fa;
      let p: number, q: number;
      if (a === c) {
        p = 2 * xm * s;
        q = 1 - s;
      } else {
        const qq = fa / fc, r = fb / fc;
        p = s * (2 * xm * qq * (qq - r) - (b - a) * (r - 1));
        q = (qq - 1) * (r - 1) * (s - 1);
      }
      if (p > 0) q = -q;
      p = Math.abs(p);
      if (2 * p < Math.min(3 * xm * q - Math.abs(tol1 * q), Math.abs(e * q))) {
        e = d;
        d = p / q;
      } else {
        d = xm; e = d;
      }
    } else {
      d = xm; e = d;
    }
    a = b; fa = fb;
    b += Math.abs(d) > tol1 ? d : xm > 0 ? tol1 : -tol1;
    fb = f(b);
  }
  return { x: b, iterations: it };
}

/**
 * Lightweight math typesetting for UI strings: turns the plain-text notation used across the app
 * (θ_sun,min · σ_h,max · C_data · u_{k}) into real subscripts, so symbols read like the equations in
 * the specification instead of raw underscore markup. Superscripts are already Unicode (², ³).
 */
import { Fragment, type ReactNode } from 'react';

// <symbol char>_<subscript>: a word with an optional ",word" qualifier (θ_sun,min), or a {braced} group.
const SUB = /([A-Za-zͰ-ϿΔΣ])_(\{([^}]+)\}|[A-Za-z0-9Ͱ-Ͽ]+(?:,[A-Za-z0-9]+)?)/g;

export function tx(node: ReactNode): ReactNode {
  if (Array.isArray(node)) return node.map((n, i) => <Fragment key={i}>{tx(n)}</Fragment>);
  if (typeof node !== 'string' || !node.includes('_')) return node;
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  SUB.lastIndex = 0;
  while ((m = SUB.exec(node))) {
    out.push(node.slice(last, m.index) + m[1]);
    out.push(<sub key={m.index}>{m[3] ?? m[2]}</sub>);
    last = m.index + m[0].length;
  }
  out.push(node.slice(last));
  return out;
}

/** `<Tx>θ_sun,min</Tx>` renders θ<sub>sun,min</sub>. */
export function Tx({ children }: { children?: ReactNode }) {
  return <>{tx(children)}</>;
}

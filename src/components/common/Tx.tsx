/**
 * Inline mathematical typesetting via KaTeX.
 *
 * - `<MathTex tex="..." />` renders a standalone LaTeX expression with KaTeX.
 * - `tx("Slope $\\alpha_{\\max}$ at $L_{\\mathrm{base}}$")` parses `$...$` segments into KaTeX
 *   components while also converting legacy bare `A_b` / `A_{b}` tokens outside `$...$` via KaTeX.
 */
import katex from 'katex';
import { Fragment, useMemo, type ReactNode } from 'react';

const SUB = /([A-Za-zͰ-ϿΔΣ])_(\{([^}]+)\}|[A-Za-z0-9Ͱ-Ͽ]+(?:,[A-Za-z0-9]+)?)/g;

const GREEK_TEX: Record<string, string> = {
  α: '\\alpha', β: '\\beta', Δ: '\\Delta', δ: '\\delta', η: '\\eta',
  θ: '\\theta', Θ: '\\Theta', λ: '\\lambda', π: '\\pi', σ: '\\sigma',
  Σ: '\\Sigma', φ: '\\varphi', ψ: '\\psi',
};

function legacyToTex(sym: string, sub: string): string {
  const s = GREEK_TEX[sym] ?? sym;
  return `${s}_{\\mathrm{${sub}}}`;
}

export function MathTex({ tex, display = false, className }: { tex: string; display?: boolean; className?: string }) {
  const html = useMemo(
    () => katex.renderToString(tex, { throwOnError: false, strict: 'ignore', displayMode: display }),
    [tex, display],
  );
  return <span className={className ? `katex-inline ${className}` : 'katex-inline'} dangerouslySetInnerHTML={{ __html: html }} />;
}

function renderPlainSegment(str: string, keyPrefix: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let i = 0;
  SUB.lastIndex = 0;
  for (let m; (m = SUB.exec(str)); ) {
    if (m.index > i) parts.push(str.slice(i, m.index));
    const sub = m[3] ?? m[2];
    parts.push(<MathTex key={`${keyPrefix}-s${m.index}`} tex={legacyToTex(m[1], sub)} />);
    i = m.index + m[0].length;
  }
  if (i < str.length) parts.push(str.slice(i));
  return parts;
}

/** Render strings containing `$...$` KaTeX math spans (or bare `X_sub` tokens) into React nodes. */
export function tx(node: ReactNode): ReactNode {
  if (typeof node !== 'string') {
    if (Array.isArray(node)) return node.map((n, i) => <Fragment key={i}>{tx(n)}</Fragment>);
    return node;
  }
  if (!node.includes('$')) {
    const out = renderPlainSegment(node, 'p');
    return out.length === 1 && typeof out[0] === 'string' ? out[0] : out;
  }
  const parts: ReactNode[] = [];
  const rx = /\$([^$]+)\$/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(node))) {
    if (m.index > last) parts.push(...renderPlainSegment(node.slice(last, m.index), `t${last}`));
    parts.push(<MathTex key={`m${m.index}`} tex={m[1]} />);
    last = m.index + m[0].length;
  }
  if (last < node.length) parts.push(...renderPlainSegment(node.slice(last), `t${last}`));
  return parts;
}

/** Strip `$` math delimiters and simple TeX commands for plain aria-label / title attributes. */
export function plainMath(text: string): string {
  return text
    .replace(/\$/g, '')
    .replace(/\\(?:mathrm|text|operatorname)\{([^}]*)\}/g, '$1')
    .replace(/\\(alpha|beta|theta|sigma|Delta|phi|varphi|eta|pi|ge|le|pm|cdot|overline)\b/g, '$1')
    .replace(/[{}]/g, '');
}

/** `<Tx>Slope $\alpha_{\max}$ at $L_{\mathrm{base}}$</Tx>` renders KaTeX inline math. */
export function Tx({ children }: { children?: ReactNode }) {
  return <>{tx(children)}</>;
}

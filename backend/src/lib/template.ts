const VAR_RE = /\{\{\s*([a-zA-Z_][\w.\-]*)\s*\}\}/g;

export function extractVariables(...texts: string[]): string[] {
  const found = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(VAR_RE)) found.add(m[1]);
  return [...found];
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: any = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    // Own-property lookup only — never walk the prototype chain with user-supplied paths.
    if (typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
}

export function stringify(v: unknown): string {
  if (v === undefined || v === null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
}

export interface RenderResult {
  text: string;
  missing: string[];
}

/** Replace `{{name}}` / `{{a.b}}` placeholders. Unknown variables render empty and are reported in `missing`. */
export function render(template: string, vars: Record<string, unknown>): RenderResult {
  const missing = new Set<string>();
  const text = template.replace(VAR_RE, (_m, name: string) => {
    const v = getPath(vars, name);
    if (v === undefined) {
      missing.add(name);
      return '';
    }
    return stringify(v);
  });
  return { text, missing: [...missing] };
}

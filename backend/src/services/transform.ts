import { getPath, render, stringify } from '../lib/template';

/**
 * Declarative data transforms. There is deliberately NO eval / user-supplied code execution:
 * workflow definitions are user-authored, so transforms are a fixed menu of safe operations.
 */
export type TransformMode = 'template' | 'json_parse' | 'pick' | 'regex_extract' | 'uppercase' | 'lowercase' | 'trim' | 'split_lines' | 'join';

export interface TransformConfig {
  mode?: TransformMode;
  template?: string;
  path?: string;
  pattern?: string;
  flags?: string;
  group?: number;
  separator?: string;
}

const MAX_INPUT = 200_000;
const MAX_PATTERN = 200;

export function runTransform(cfg: TransformConfig, input: unknown, vars: Record<string, unknown>): unknown {
  const mode = cfg.mode ?? 'template';
  switch (mode) {
    case 'template':
      return render(cfg.template ?? '{{input}}', { ...vars, input }).text;
    case 'json_parse': {
      const s = stringify(input).trim();
      if (s.length > MAX_INPUT) throw new Error('Input too large to parse');
      // Models often wrap JSON in ``` fences.
      const unfenced = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      try {
        return JSON.parse(unfenced);
      } catch {
        throw new Error('Transform json_parse: input is not valid JSON');
      }
    }
    case 'pick': {
      if (!cfg.path) throw new Error('Transform pick: "path" is required');
      return getPath(input, cfg.path) ?? null;
    }
    case 'regex_extract': {
      if (!cfg.pattern) throw new Error('Transform regex_extract: "pattern" is required');
      if (cfg.pattern.length > MAX_PATTERN) throw new Error('Regex pattern too long');
      const s = stringify(input);
      if (s.length > MAX_INPUT) throw new Error('Input too large for regex');
      const flags = (cfg.flags ?? '').replace(/[^gimsu]/g, '');
      let re: RegExp;
      try {
        re = new RegExp(cfg.pattern, flags);
      } catch {
        throw new Error('Transform regex_extract: invalid pattern');
      }
      if (flags.includes('g')) return [...s.matchAll(re)].map((m) => m[cfg.group ?? 0] ?? '');
      const m = re.exec(s);
      return m ? (m[cfg.group ?? 0] ?? '') : '';
    }
    case 'uppercase':
      return stringify(input).toUpperCase();
    case 'lowercase':
      return stringify(input).toLowerCase();
    case 'trim':
      return stringify(input).trim();
    case 'split_lines':
      return stringify(input)
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    case 'join':
      return Array.isArray(input) ? input.map(stringify).join(cfg.separator ?? '\n') : stringify(input);
    default:
      throw new Error(`Unknown transform mode "${String(mode)}"`);
  }
}

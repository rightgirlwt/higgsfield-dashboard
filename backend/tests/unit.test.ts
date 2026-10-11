import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../src/lib/crypto';
import { calcCostUsd } from '../src/lib/pricing';
import { extractVariables, render } from '../src/lib/template';
import { csvCell } from '../src/routes/util';
import { runTransform } from '../src/services/transform';
import { topoOrder, validateWorkflow, type WorkflowDefinition } from '../src/services/workflowEngine';
import { splitSql } from '../src/db/migrations';

describe('pricing', () => {
  it('computes cost from per-million-token rates', () => {
    // sonnet-5-5: $2 in / $10 out per MTok
    expect(calcCostUsd('claude-sonnet-5-5', 1_000_000, 1_000_000)).toBeCloseTo(12, 6);
    expect(calcCostUsd('claude-haiku-5-5', 2000, 500)).toBeCloseTo(0.0002 + 0.00025, 8);
    expect(calcCostUsd('nope', 100, 100)).toBe(0);
  });
});

describe('templates', () => {
  it('extracts and renders variables, reporting missing ones', () => {
    expect(extractVariables('Hi {{name}}, {{ a.b }} and {{name}}')).toEqual(['name', 'a.b']);
    const r = render('Hi {{name}} {{missing}} {{o.k}}', { name: 'Ada', o: { k: 5 } });
    expect(r.text).toBe('Hi Ada  5');
    expect(r.missing).toEqual(['missing']);
  });
  it('does not walk the prototype chain', () => {
    expect(render('{{constructor}} {{__proto__.x}}', {}).missing.sort()).toEqual(['__proto__.x', 'constructor']);
  });
});

describe('secrets crypto', () => {
  it('round-trips and uses random IVs', () => {
    const a = encryptSecret('sk-ant-test-1234');
    const b = encryptSecret('sk-ant-test-1234');
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe('sk-ant-test-1234');
  });
  it('rejects tampered ciphertext', () => {
    const buf = Buffer.from(encryptSecret('secret-value'), 'base64');
    buf[buf.length - 1] ^= 1;
    expect(() => decryptSecret(buf.toString('base64'))).toThrow();
  });
});

describe('csv', () => {
  it('neutralises formula injection and quotes specials', () => {
    expect(csvCell('=cmd|calc')).toBe("'=cmd|calc");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });
});

describe('transform', () => {
  it('parses fenced JSON, picks paths, extracts regex', () => {
    const parsed = runTransform({ mode: 'json_parse' }, '```json\n{"a":{"b":7}}\n```', {});
    expect(parsed).toEqual({ a: { b: 7 } });
    expect(runTransform({ mode: 'pick', path: 'a.b' }, parsed, {})).toBe(7);
    expect(runTransform({ mode: 'regex_extract', pattern: '#(\\d+)', group: 1 }, 'Invoice #4471', {})).toBe('4471');
    expect(runTransform({ mode: 'template', template: '[{{input}}]' }, 'x', {})).toBe('[x]');
  });
  it('fails loudly on bad input', () => {
    expect(() => runTransform({ mode: 'json_parse' }, 'not json', {})).toThrow(/valid JSON/);
    expect(() => runTransform({ mode: 'regex_extract', pattern: '(' }, 'x', {})).toThrow(/invalid pattern/);
  });
});

const node = (id: string, type: any, data = {}) => ({ id, type, data });
const edge = (s: string, t: string) => ({ id: `${s}-${t}`, source: s, target: t });

describe('workflow validation', () => {
  const good: WorkflowDefinition = {
    nodes: [node('t', 'trigger'), node('l', 'llm', { userPrompt: 'hi {{input}}' }), node('o', 'output')],
    edges: [edge('t', 'l'), edge('l', 'o')],
  };
  it('accepts a valid graph and orders it topologically', () => {
    expect(validateWorkflow(good).filter((i) => i.level === 'error')).toEqual([]);
    expect(topoOrder(good)).toEqual(['t', 'l', 'o']);
  });
  it('flags missing trigger, cycles, empty prompts and bad edges', () => {
    const cyc: WorkflowDefinition = { nodes: [node('t', 'trigger'), node('a', 'transform'), node('b', 'transform')], edges: [edge('t', 'a'), edge('a', 'b'), edge('b', 'a')] };
    expect(validateWorkflow(cyc).map((i) => i.message)).toContain('Workflow contains a cycle');
    expect(validateWorkflow({ nodes: [node('l', 'llm')], edges: [] }).map((i) => i.message)).toEqual(expect.arrayContaining(['Workflow needs a Trigger node', 'LLM node needs a user prompt']));
    const bad = validateWorkflow({ nodes: [node('t', 'trigger')], edges: [edge('t', 'ghost')] });
    expect(bad.some((i) => /missing node/.test(i.message))).toBe(true);
    const into = validateWorkflow({ nodes: [node('t', 'trigger'), node('x', 'transform')], edges: [edge('x', 't')] });
    expect(into.some((i) => /incoming/.test(i.message))).toBe(true);
  });
});

describe('sql splitting', () => {
  it('splits statements on line-terminating semicolons', () => {
    expect(splitSql('CREATE TABLE a (x int);\nCREATE TABLE b (y int);\n')).toHaveLength(2);
  });
});

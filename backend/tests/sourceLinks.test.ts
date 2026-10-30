import { describe, expect, it } from 'vitest';
import { signSourceLink, sourceLinkValid } from '../src/services/sourceLinks';

const id = '11111111-1111-4111-8111-111111111111';
const parts = (link: string) => {
  const u = new URL(link, 'http://x');
  return { exp: u.searchParams.get('exp'), sig: u.searchParams.get('sig') };
};

describe('source video links', () => {
  it('accepts its own link, for that video only', () => {
    const { exp, sig } = parts(signSourceLink(id));
    expect(sourceLinkValid(id, exp, sig)).toBe(true);
    expect(sourceLinkValid('22222222-2222-4222-8222-222222222222', exp, sig)).toBe(false);
  });

  it('rejects an expired or tampered link', () => {
    const { exp, sig } = parts(signSourceLink(id, 1_000));
    expect(sourceLinkValid(id, exp, sig, 1_000 + 3 * 60 * 60_000)).toBe(false);
    const fresh = parts(signSourceLink(id));
    expect(sourceLinkValid(id, String(Number(fresh.exp) + 1000), fresh.sig)).toBe(false);
    expect(sourceLinkValid(id, fresh.exp, 'abc')).toBe(false);
    expect(sourceLinkValid(id, undefined, undefined)).toBe(false);
  });
});

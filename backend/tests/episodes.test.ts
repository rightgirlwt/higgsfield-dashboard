import { describe, expect, it } from 'vitest';
import { composeGroup, episodesOf, inEpisode, parseGroup, resolveEpisode } from '../../frontend/src/lib/episodes';

describe('episodes in a micro drama shot list', () => {
  it('reads the episode and the scene out of "Ep 4 · Scene 2"', () => {
    expect(parseGroup('Ep 4 · Scene 2')).toEqual({ episode: 4, scene: 'Scene 2' });
    expect(parseGroup('Ep 12 · Scene 1')).toEqual({ episode: 12, scene: 'Scene 1' });
    // the other ways the Director or a person might write it
    expect(parseGroup('Episode 3 - The Party')).toEqual({ episode: 3, scene: 'The Party' });
    expect(parseGroup('ep.2: Scene 5')).toEqual({ episode: 2, scene: 'Scene 5' });
    expect(parseGroup('EP 7')).toEqual({ episode: 7, scene: '' });
    expect(parseGroup('Ep 1 · Scene 1 · Night')).toEqual({ episode: 1, scene: 'Scene 1 · Night' });
  });

  it('leaves text that does not start with an episode alone', () => {
    expect(parseGroup('Teaser')).toEqual({ episode: null, scene: 'Teaser' });
    expect(parseGroup('')).toEqual({ episode: null, scene: '' });
    expect(parseGroup('Epilogue')).toEqual({ episode: null, scene: 'Epilogue' }); // starts with "Ep" but is not an episode
    expect(parseGroup('Step 3')).toEqual({ episode: null, scene: 'Step 3' });
  });

  it('writes them back the same way, so saving a shot does not rewrite its place', () => {
    expect(composeGroup(4, 'Scene 2')).toBe('Ep 4 · Scene 2');
    expect(composeGroup(4, '')).toBe('Ep 4');
    expect(composeGroup(null, 'Teaser')).toBe('Teaser');
    expect(composeGroup(null, '  ')).toBe('');
    expect(composeGroup(0, 'Scene 1')).toBe('Scene 1');
    for (const g of ['Ep 4 · Scene 1', 'Ep 10 · Scene 12', 'Ep 2', 'Teaser', '']) {
      const p = parseGroup(g);
      expect(composeGroup(p.episode, p.scene)).toBe(g);
    }
  });

  const items = [
    { group: 'Ep 4 · Scene 1', status: 'approved' },
    { group: 'Ep 4 · Scene 2', status: 'approved' },
    { group: 'Ep 5 · Scene 1', status: 'review' },
    { group: 'Ep 5 · Scene 2', status: 'draft' },
    { group: 'Ep 5 · Scene 3', status: 'draft' },
    { group: 'Ep 1 · Scene 1', status: 'approved' },
    { group: 'Teaser', status: 'draft' },
  ];

  it('lists the episodes newest first, with shots that have no episode last', () => {
    expect(episodesOf(items)).toEqual([
      { episode: 5, shots: 3, approved: 0 },
      { episode: 4, shots: 2, approved: 2 },
      { episode: 1, shots: 1, approved: 1 },
      { episode: null, shots: 1, approved: 0 },
    ]);
    expect(episodesOf([])).toEqual([]);
  });

  it('opens the newest episode until one is picked, and falls back when the pick is gone', () => {
    const eps = episodesOf(items);
    expect(resolveEpisode(null, eps)).toBe(5);
    expect(resolveEpisode(4, eps)).toBe(4);
    expect(resolveEpisode('all', eps)).toBe('all');
    expect(resolveEpisode('none', eps)).toBe('none');
    expect(resolveEpisode(9, eps)).toBe(5); // episode 9 no longer exists
    expect(resolveEpisode('none', episodesOf(items.slice(0, 2)))).toBe('all'); // nothing without an episode any more
    expect(resolveEpisode(null, episodesOf([{ group: 'Teaser', status: 'draft' }]))).toBe('all'); // only no-episode shots
    expect(resolveEpisode(null, [])).toBe('all');
  });

  it('picks the shots that belong to the open episode', () => {
    expect(items.filter((i) => inEpisode(i.group, 5))).toHaveLength(3);
    expect(items.filter((i) => inEpisode(i.group, 'none'))).toEqual([{ group: 'Teaser', status: 'draft' }]);
    expect(items.filter((i) => inEpisode(i.group, 'all'))).toHaveLength(7);
    expect(items.filter((i) => inEpisode(i.group, 1))).toHaveLength(1);
  });
});

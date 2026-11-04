/**
 * Micro drama shots keep their place in one text field, written "Ep 4 · Scene 2" (the Director writes it that way too).
 * These turn that text into an episode number and a scene name, and back, so the page can offer them as separate fields and pick an episode.
 */

export interface ParsedGroup {
  /** null when the text does not start with an episode. */
  episode: number | null;
  /** What is left once the episode is taken off: "Scene 2", or whatever was written. */
  scene: string;
}

export function parseGroup(group: string): ParsedGroup {
  const m = /^\s*ep(?:isode)?\.?\s*(\d+)\s*(?:[·•|:,\-–—]\s*)?(.*)$/i.exec(group);
  if (!m) return { episode: null, scene: group.trim() };
  return { episode: Number(m[1]), scene: m[2].trim() };
}

export function composeGroup(episode: number | null, scene: string): string {
  const s = scene.trim();
  if (episode === null || !Number.isFinite(episode) || episode < 1) return s;
  return s ? `Ep ${Math.floor(episode)} · ${s}` : `Ep ${Math.floor(episode)}`;
}

export interface EpisodeInfo {
  /** null is the bucket for shots with no episode. */
  episode: number | null;
  shots: number;
  approved: number;
}

/** Every episode that has shots, newest (highest number) first, with the shots that have no episode last. */
export function episodesOf(items: { group: string; status: string }[]): EpisodeInfo[] {
  const m = new Map<number | null, EpisodeInfo>();
  for (const i of items) {
    const { episode } = parseGroup(i.group);
    const e = m.get(episode) ?? { episode, shots: 0, approved: 0 };
    e.shots++;
    if (i.status === 'approved') e.approved++;
    m.set(episode, e);
  }
  return [...m.values()].sort((a, b) => (a.episode === null ? 1 : b.episode === null ? -1 : b.episode - a.episode));
}

/** What the page shows: one episode, the shots without one, or everything. */
export type EpisodeChoice = number | 'none' | 'all';

/** The choice made, or (when none was made yet, or it no longer exists) the newest episode. */
export function resolveEpisode(choice: EpisodeChoice | null, episodes: EpisodeInfo[]): EpisodeChoice {
  if (choice === 'all') return 'all';
  if (choice === 'none') return episodes.some((e) => e.episode === null) ? 'none' : 'all';
  if (typeof choice === 'number' && episodes.some((e) => e.episode === choice)) return choice;
  const newest = episodes.find((e) => e.episode !== null);
  return newest ? newest.episode! : 'all';
}

export const inEpisode = (group: string, choice: EpisodeChoice) => {
  if (choice === 'all') return true;
  const { episode } = parseGroup(group);
  return choice === 'none' ? episode === null : episode === choice;
};

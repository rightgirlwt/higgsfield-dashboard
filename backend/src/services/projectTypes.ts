/**
 * Project types are data. Each one defines the brief (story bible / brand kit) fields shown in the UI,
 * the words used for the board, and the guidance handed to the Claude "director" chat.
 * To add a type (e.g. music video), add an entry here and extend the CHECK constraint in a new migration.
 */
export const PROJECT_TYPE_IDS = ['micro_drama', 'ad_campaign'] as const;
export type ProjectType = (typeof PROJECT_TYPE_IDS)[number];

export interface BriefField {
  key: string;
  label: string;
  placeholder: string;
  rows: number;
}

export interface ProjectTypeDef {
  id: ProjectType;
  label: string;
  description: string;
  /** What a board card is called, and what groups of cards are called. */
  itemKind: 'shot' | 'ad_unit';
  itemLabel: string;
  groupLabel: string;
  defaultAspect: string;
  briefFields: BriefField[];
  /** One-click openers for the chat. */
  starters: string[];
  /** Added to the director's system prompt. */
  guidance: string;
}

export const PROJECT_TYPES: Record<ProjectType, ProjectTypeDef> = {
  micro_drama: {
    id: 'micro_drama',
    label: 'Micro drama',
    description: 'Short vertical episodes: a story bible, scenes and shots, with the same characters throughout.',
    itemKind: 'shot',
    itemLabel: 'Shot',
    groupLabel: 'Scene',
    defaultAspect: '9:16',
    briefFields: [
      { key: 'logline', label: 'Logline', placeholder: 'One or two sentences: who wants what, and what stands in the way.', rows: 2 },
      { key: 'genre', label: 'Genre and tone', placeholder: 'e.g. Romantic thriller, glossy and tense, cliffhanger endings.', rows: 2 },
      { key: 'setting', label: 'World and setting', placeholder: 'Where and when it happens; the places that recur.', rows: 3 },
      { key: 'characters', label: 'Characters', placeholder: 'Name, age, look, wardrobe, personality for each lead. Used to keep prompts consistent.', rows: 5 },
      { key: 'visualStyle', label: 'Visual style', placeholder: 'Camera language, lighting, colour, lens feel. Added to every shot for consistency.', rows: 3 },
      { key: 'episodePlan', label: 'Episode plan', placeholder: 'Episode count and length, and the beat each episode ends on.', rows: 4 },
    ],
    starters: [
      'Help me develop a story bible for a micro drama. Ask me what you need.',
      'Turn my logline into an episode 1 shot list of about 8 shots.',
      'Review my shot list for continuity problems and cost.',
    ],
    guidance: [
      'This is a MICRO DRAMA project: short vertical episodes. The board holds SHOTS grouped into SCENES (use the group field like "Ep 1 · Scene 2").',
      'Each shot is one short clip (usually 3–8 seconds). Write each shot prompt as a complete, self-contained description: subject, action, setting, camera, lighting, mood. Always repeat the character descriptions and the visual style from the brief, because every generation starts cold.',
      'For continuity, prefer a two-step approach when it is worth the cost: an image shot (a keyframe) and then a video shot that uses it as the start frame (set meta.startFromItemId to the image item id). Use a Soul ID character (settings.custom_reference_id) on image shots when the project has one.',
      'Dialogue and captions belong in the notes field, not the prompt, unless the chosen video model generates audio.',
    ].join('\n'),
  },
  ad_campaign: {
    id: 'ad_campaign',
    label: 'Ad campaign',
    description: 'Concepts, hooks and formats for paid social: a brand kit, ad units and a variant matrix with cost preview.',
    itemKind: 'ad_unit',
    itemLabel: 'Ad unit',
    groupLabel: 'Concept',
    defaultAspect: '9:16',
    briefFields: [
      { key: 'brand', label: 'Brand and voice', placeholder: 'Who the brand is, how it sounds, what it never says.', rows: 3 },
      { key: 'product', label: 'Product or offer', placeholder: 'What is being sold, its single biggest benefit, the offer and price if any.', rows: 3 },
      { key: 'audience', label: 'Audience', placeholder: 'Who this is for and what they care about.', rows: 3 },
      { key: 'platforms', label: 'Platforms and formats', placeholder: 'e.g. TikTok and Reels 9:16 at 15s, Meta feed 1:1 or 4:5, YouTube 16:9.', rows: 2 },
      { key: 'visualStyle', label: 'Look and feel', placeholder: 'Polished product, UGC-style, lifestyle, colour palette, mood.', rows: 3 },
      { key: 'mustInclude', label: 'Must include', placeholder: 'Logo placement, claims, disclaimers, call to action.', rows: 2 },
      { key: 'avoid', label: 'Avoid', placeholder: 'Competitors, banned claims, imagery to stay away from.', rows: 2 },
    ],
    starters: [
      'Help me fill in the brand kit for this campaign. Ask me what you need.',
      'Suggest 3 concepts for this campaign, each with 5 hook options.',
      'Plan a set of variants across TikTok, Reels and Meta and tell me what it would cost.',
    ],
    guidance: [
      'This is an AD CAMPAIGN project. The board holds AD UNITS grouped by CONCEPT (use the group field for the concept name).',
      'Ads live or die in the first two seconds, so write the hook first. Each ad unit prompt must describe a single visual (subject, action, setting, camera, lighting) that carries the hook, written to be generated without any on-screen text unless asked, and mention the product accurately as described in the brief.',
      'Put the hook line, script/voiceover and call to action in notes, and the platform and aspect ratio in meta (meta.platform).',
      'To produce variants across hooks and formats, create one base unit and use expand_variants. Always give the cost of a variant set before asking for approval.',
      'Never invent product claims, prices or statistics that are not in the brief.',
    ].join('\n'),
  },
};

export const isProjectType = (v: unknown): v is ProjectType => typeof v === 'string' && (PROJECT_TYPE_IDS as readonly string[]).includes(v);

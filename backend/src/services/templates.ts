import type { WorkflowDefinition } from './workflowEngine';

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  definition: WorkflowDefinition;
}

const pos = (x: number, y: number) => ({ x, y });

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'summarize-notify',
    name: 'Summarize & notify team',
    description: 'Takes text input, summarizes it with Claude, posts the summary to the team and returns it.',
    category: 'Productivity',
    definition: {
      nodes: [
        { id: 't', type: 'trigger', position: pos(0, 80), data: { label: 'Manual input', source: 'manual', sampleInput: 'Paste any long text here.' } },
        { id: 'l', type: 'llm', position: pos(280, 80), data: { label: 'Summarize', model: 'claude-haiku-5-5', systemPrompt: 'You are a precise editor.', userPrompt: 'Summarize the following in 3 bullet points:\n\n{{input}}', maxTokens: 512 } },
        { id: 'a', type: 'action', position: pos(560, 0), data: { label: 'Notify team', action: 'notify', message: '{{input}}' } },
        { id: 'o', type: 'output', position: pos(560, 160), data: { label: 'Summary' } },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'l' },
        { id: 'e2', source: 'l', target: 'a' },
        { id: 'e3', source: 'l', target: 'o' },
      ],
    },
  },
  {
    id: 'caption-archive',
    name: 'Caption & archive new generations',
    description: 'Pulls recent Higgsfield generations, writes a caption for the batch and saves an archive entry to the media timeline.',
    category: 'Media',
    definition: {
      nodes: [
        { id: 't', type: 'trigger', position: pos(0, 80), data: { label: 'Higgsfield generations', source: 'higgsfield' } },
        { id: 'l', type: 'llm', position: pos(280, 80), data: { label: 'Write caption', model: 'claude-sonnet-5-5', userPrompt: 'Here are recent generations as JSON:\n{{input}}\n\nWrite one short, vivid caption (max 20 words) for the batch.', maxTokens: 200 } },
        { id: 'x', type: 'transform', position: pos(560, 80), data: { label: 'Trim', mode: 'trim' } },
        { id: 'a', type: 'action', position: pos(840, 80), data: { label: 'Save to timeline', action: 'save_media', mediaType: 'photo', title: '{{input}}', tags: 'archive, auto' } },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'l' },
        { id: 'e2', source: 'l', target: 'x' },
        { id: 'e3', source: 'x', target: 'a' },
      ],
    },
  },
  {
    id: 'extract-structured',
    name: 'Extract structured JSON',
    description: 'Asks Claude to return JSON, parses it and picks a single field.',
    category: 'Data',
    definition: {
      nodes: [
        { id: 't', type: 'trigger', position: pos(0, 80), data: { label: 'Manual input', source: 'manual', sampleInput: 'Invoice #4471 from Acme Corp, total $1,284.50 due 2026-11-02.' } },
        { id: 'l', type: 'llm', position: pos(260, 80), data: { label: 'Extract fields', model: 'claude-haiku-5-5', userPrompt: 'Return ONLY JSON with keys vendor, total, due_date for this text:\n{{input}}', maxTokens: 300 } },
        { id: 'p', type: 'transform', position: pos(520, 80), data: { label: 'Parse JSON', mode: 'json_parse' } },
        { id: 'k', type: 'transform', position: pos(780, 80), data: { label: 'Pick vendor', mode: 'pick', path: 'vendor' } },
        { id: 'o', type: 'output', position: pos(1040, 80), data: { label: 'Vendor' } },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'l' },
        { id: 'e2', source: 'l', target: 'p' },
        { id: 'e3', source: 'p', target: 'k' },
        { id: 'e4', source: 'k', target: 'o' },
      ],
    },
  },
  {
    id: 'render-board-cards',
    name: 'Render board cards',
    description: 'Project workflow: generates every draft or ready card on the board with its own model and settings, and moves each to review. Shows the total cost before it runs.',
    category: 'Projects',
    definition: {
      nodes: [
        { id: 't', type: 'trigger', position: pos(0, 80), data: { label: 'Cards to render', source: 'project', statuses: ['draft', 'ready', 'rejected'] } },
        { id: 'f', type: 'foreach', position: pos(300, 80), data: { label: 'Render each card', mode: 'cards', maxItems: 20, concurrency: 2 } },
        { id: 'o', type: 'output', position: pos(600, 80), data: { label: 'Results' } },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'f' },
        { id: 'e2', source: 'f', target: 'o' },
      ],
    },
  },
  {
    id: 'polish-then-render',
    name: 'Polish prompts with Claude, then render',
    description: 'Project workflow: Claude rewrites each card’s prompt using the project’s visual style and characters, then every polished prompt is generated.',
    category: 'Projects',
    definition: {
      nodes: [
        { id: 't', type: 'trigger', position: pos(0, 80), data: { label: 'Cards to render', source: 'project', statuses: ['draft', 'ready', 'rejected'] } },
        {
          id: 'l', type: 'llm', position: pos(280, 80),
          data: {
            label: 'Polish prompts', model: 'claude-sonnet-5-5', maxTokens: 4000,
            systemPrompt: 'You are a cinematographer who writes prompts for AI image and video models. Keep every prompt self-contained and visual: subject, action, setting, camera, light, mood.',
            userPrompt: 'Visual style: {{project.brief.visualStyle}}\nCharacters: {{project.brief.characters}}\n\nHere are the cards as JSON:\n{{input}}\n\nRewrite each card\'s prompt so it repeats the characters and style consistently. Return ONLY a JSON array of objects with "id" (unchanged) and "prompt".',
          },
        },
        { id: 'f', type: 'foreach', position: pos(580, 80), data: { label: 'Render each prompt', mode: 'prompt', model: 'wan-3', prompt: '{{item.prompt}}', settings: { aspect_ratio: '9:16' }, maxItems: 20, concurrency: 2 } },
        { id: 'o', type: 'output', position: pos(880, 80), data: { label: 'Results' } },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'l' },
        { id: 'e2', source: 'l', target: 'f' },
        { id: 'e3', source: 'f', target: 'o' },
      ],
    },
  },
  {
    id: 'ad-hooks-to-images',
    name: 'Ad hooks to images',
    description: 'Paste product notes; Claude writes five distinct ad concepts, and each becomes an image. A cheap way to explore directions before spending on video.',
    category: 'Projects',
    definition: {
      nodes: [
        { id: 't', type: 'trigger', position: pos(0, 80), data: { label: 'Product notes', source: 'manual', sampleInput: 'Reusable stainless steel water bottle, keeps drinks cold for 24 hours. Audience: busy commuters.' } },
        {
          id: 'l', type: 'llm', position: pos(280, 80),
          data: {
            label: 'Five concepts', model: 'claude-sonnet-5-5', maxTokens: 2000,
            systemPrompt: 'You are an advertising creative director.',
            userPrompt: 'Product notes:\n{{input}}\n\nWrite 5 distinct visual ad concepts. Return ONLY a JSON array of 5 objects, each with "prompt": a vivid image description (subject, setting, light, camera) with no text in the picture.',
          },
        },
        { id: 'p', type: 'transform', position: pos(560, 80), data: { label: 'Parse JSON', mode: 'json_parse' } },
        { id: 'f', type: 'foreach', position: pos(840, 80), data: { label: 'Make each image', mode: 'prompt', model: 'z-image-turbo', prompt: '{{item.prompt}}', maxItems: 5, concurrency: 2 } },
        { id: 'o', type: 'output', position: pos(1120, 80), data: { label: 'Images' } },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'l' },
        { id: 'e2', source: 'l', target: 'p' },
        { id: 'e3', source: 'p', target: 'f' },
        { id: 'e4', source: 'f', target: 'o' },
      ],
    },
  },
  {
    id: 'daily-digest',
    name: 'Daily generation digest',
    description: 'On a schedule, summarizes the latest Higgsfield activity and notifies the team.',
    category: 'Monitoring',
    definition: {
      nodes: [
        { id: 't', type: 'trigger', position: pos(0, 80), data: { label: 'Every 24h', source: 'schedule', intervalMinutes: 1440 } },
        { id: 'l', type: 'llm', position: pos(280, 80), data: { label: 'Digest', model: 'claude-haiku-5-5', userPrompt: 'Write a two-sentence digest of this activity:\n{{input}}', maxTokens: 250 } },
        { id: 'a', type: 'action', position: pos(560, 80), data: { label: 'Notify', action: 'notify', message: '{{input}}' } },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'l' },
        { id: 'e2', source: 'l', target: 'a' },
      ],
    },
  },
];

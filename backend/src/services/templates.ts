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

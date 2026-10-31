// Copies the writing skills from the Claude app into backend/voices/, where the dashboard reads them when it writes a caption.
// Run after changing a skill in Claude:   npm run sync-voices   (from the backend folder)
// The skills stay the source of truth. Do not edit the copies by hand; the next sync replaces them.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = os.homedir();
const ROOTS = [
  path.join(home, 'AppData', 'Local', 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude', 'local-agent-mode-sessions', 'skills-plugin'),
  path.join(home, 'AppData', 'Local', 'Claude-Data', 'claude_pzs8sxrjxfjjc', 'local-agent-mode-sessions', 'skills-plugin'),
];
const OUT = path.join(__dirname, '..', 'voices');

/** Newest SKILL.md for a skill name under the Claude install(s). Only goes a few folders deep. */
function findSkill(name) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (e.name === name && fs.existsSync(path.join(p, 'SKILL.md'))) found.push(path.join(p, 'SKILL.md'));
      else walk(p, depth + 1);
    }
  };
  for (const r of ROOTS) walk(r, 0);
  found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return found[0] ?? null;
}

const stripFrontmatter = (s) => s.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();

/** The sections of a markdown file whose heading line matches, each running until the next heading of the same or a higher level. */
function sections(md, wanted) {
  const lines = md.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6}) (.*)$/.exec(lines[i]);
    if (!m || !wanted.some((re) => re.test(lines[i]))) continue;
    let j = i + 1;
    while (j < lines.length) {
      const n = /^(#{1,6}) /.exec(lines[j]);
      if (n && n[1].length <= m[1].length) break;
      j++;
    }
    out.push(lines.slice(i, j).join('\n').replace(/\n-{3,}\s*$/, '').trim());
  }
  return out;
}

const header = (skill, file) => `<!-- Copied from the "${skill}" skill (${new Date(fs.statSync(file).mtime).toISOString().slice(0, 10)}) by scripts/sync-voices.cjs. Do not edit here; change the skill and run the sync again. -->\n\n`;

const jobs = [
  { skill: 'glg-content-system', out: 'glg-content-system.md', pick: (md) => stripFrontmatter(md) },
  { skill: 'anti-ai-writing', out: 'anti-ai-writing.md', pick: (md) => stripFrontmatter(md) },
  {
    // The caption-relevant parts of the content writer: not its email, blog, carousel or batch rules
    skill: 'rgm-content-writer',
    out: 'rgm-content-writer.md',
    pick: (md) => {
      const parts = sections(stripFrontmatter(md), [
        /^### 1\. .*Social Media Captions/,
        /^## Platform Format Quick Reference/,
        /^## Hook Style Library/,
        /^## CTA Rotation Library/,
        /^## Client Voice Library/,
        /^### Framework 1: Viral Hooks/,
        /^### Framework 3: Dumbify/,
        /^## Output Quality Standards/,
      ]);
      if (parts.length < 8) throw new Error(`Expected 8 sections in rgm-content-writer, found ${parts.length}. Its headings may have changed; update scripts/sync-voices.cjs.`);
      return parts.join('\n\n');
    },
  },
];

fs.mkdirSync(OUT, { recursive: true });
let failed = false;
for (const j of jobs) {
  const file = findSkill(j.skill);
  if (!file) {
    console.error(`NOT FOUND: the "${j.skill}" skill. Is the Claude app installed on this computer?`);
    failed = true;
    continue;
  }
  try {
    const text = header(j.skill, file) + j.pick(fs.readFileSync(file, 'utf8')) + '\n';
    fs.writeFileSync(path.join(OUT, j.out), text);
    console.log(`${j.out}: ${text.length} characters from ${file}`);
  } catch (e) {
    console.error(`FAILED: ${j.skill}: ${e.message}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);

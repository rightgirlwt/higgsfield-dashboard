/** Self-contained SVG thumbnails (data URIs) so the media timeline works with no external image hosting. */
const PALETTES: [string, string][] = [
  ['#0e7490', '#6d28d9'],
  ['#be185d', '#7c3aed'],
  ['#047857', '#0369a1'],
  ['#b45309', '#be123c'],
  ['#4338ca', '#0f766e'],
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]!);

export function placeholderImage(title: string, type: 'photo' | 'video', seed = title): string {
  const h = hash(seed);
  const [a, b] = PALETTES[h % PALETTES.length];
  const cx = 80 + (h % 480);
  const cy = 60 + ((h >> 3) % 240);
  const icon =
    type === 'video'
      ? '<circle cx="320" cy="180" r="38" fill="rgba(255,255,255,0.22)"/><path d="M308 160 L308 200 L340 180 Z" fill="white"/>'
      : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" width="640" height="360">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
<rect width="640" height="360" fill="url(#g)"/>
<circle cx="${cx}" cy="${cy}" r="${70 + (h % 60)}" fill="rgba(255,255,255,0.10)"/>
<circle cx="${640 - cx}" cy="${360 - cy}" r="${40 + (h % 50)}" fill="rgba(0,0,0,0.18)"/>
${icon}
<text x="20" y="338" font-family="system-ui,sans-serif" font-size="20" fill="rgba(255,255,255,0.85)">${esc(title.slice(0, 48))}</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

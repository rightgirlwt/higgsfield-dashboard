// Regenerates src/theme.css (all UI colours as CSS variables, light + dark).
// To change the brand colour: edit the `brand` scale below (500 = your base colour), then run:  npm run theme
const colors = require('tailwindcss/colors');
const shades = [50,100,200,300,400,500,600,700,800,900,950];
const rgb = (hex) => { const h = hex.replace('#',''); return [0,2,4].map(i => parseInt(h.slice(i,i+2),16)).join(' '); };
// hand-picked scales: 'cyan' = BRAND accent built around #99577A; 'violet' = muted teal secondary (kept distinct for charts/badges)
const brand = { 50:'#FAF3F7',100:'#F3E4EC',200:'#E8CCDB',300:'#D6A8C0',400:'#BE7FA0',500:'#99577A',600:'#854A6A',700:'#6D3B56',800:'#5A3248',900:'#492B3B',950:'#2B1723' };
const teal = { 50:'#F0F8F9',100:'#D9EEF1',200:'#B6DDE3',300:'#86C4CE',400:'#5AA8B5',500:'#3D8B96',600:'#31717B',700:'#2B5C65',800:'#264A52',900:'#213D44',950:'#14252B' };
const slateDark = colors.slate;
const slateLight = { 50:'#140E12',100:'#21191F',200:'#342830',300:'#4C3C46',400:'#63505C',500:'#796471',600:'#8C7683',700:'#DBCDD6',800:'#ECE3E9',900:'#FFFFFF',950:'#F5F0F4' };
const hues = { cyan: brand, violet: teal, emerald: colors.emerald, amber: colors.amber, rose: colors.rose, sky: colors.sky, pink: colors.pink };
let dark = '', light = '';
for (const [name, scale] of Object.entries(hues)) {
  for (const s of shades) dark += `  --${name}-${s}: ${rgb(scale[s])};\n`;
  // light theme: text-ish shades 50-400 mirror to their dark counterparts so coloured text stays readable on white
  const mirror = { 50:950, 100:900, 200:800, 300:700, 400:600 };
  for (const [s, m] of Object.entries(mirror)) light += `  --${name}-${s}: ${rgb(scale[m])};\n`;
}
for (const s of shades) { dark += `  --slate-${s}: ${rgb(slateDark[s])};\n`; light += `  --slate-${s}: ${rgb(slateLight[s])};\n`; }
const css = `/* GENERATED palette. Brand accent #99577A (exposed as the "cyan" scale so existing classes pick it up);
   "violet" is a muted teal secondary. Light theme is the default; dark is html[data-theme="dark"]. */
:root[data-theme='dark'], :root:not([data-theme]) {
${dark}  --sidebar: 73 43 59;
  --shadow: 0 0 0;
  --shadow-alpha: 0.35;
  color-scheme: dark;
}
:root[data-theme='light'] {
${dark}${light}  --sidebar: 153 87 122;
  --shadow: 70 35 55;
  --shadow-alpha: 0.08;
  color-scheme: light;
}
`;
require('fs').writeFileSync(process.argv[2], css);
console.log('lines', css.split('\n').length);

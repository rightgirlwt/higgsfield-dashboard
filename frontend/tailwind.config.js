/** @type {import('tailwindcss').Config} */
const shades = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

/** Colour scale backed by CSS variables (see src/theme.css) so the whole UI re-themes light/dark without per-class changes. */
const scale = (name) => Object.fromEntries(shades.map((s) => [s, `rgb(var(--${name}-${s}) / <alpha-value>)`]));

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        slate: scale('slate'),
        // "cyan" is the BRAND accent (#99577A family) and "violet" a muted teal secondary: the class names
        // are historical; the actual colours come from theme.css.
        cyan: scale('cyan'),
        violet: scale('violet'),
        emerald: scale('emerald'),
        amber: scale('amber'),
        rose: scale('rose'),
        sky: scale('sky'),
        pink: scale('pink'),
        sidebar: 'rgb(var(--sidebar) / <alpha-value>)',
      },
      boxShadow: {
        card: '0 10px 30px -12px rgb(var(--shadow) / var(--shadow-alpha))',
      },
      keyframes: {
        fadeIn: { from: { opacity: '0', transform: 'translateY(4px)' }, to: { opacity: '1', transform: 'none' } },
      },
      animation: { 'fade-in': 'fadeIn 180ms ease-out both' },
    },
  },
  plugins: [],
};

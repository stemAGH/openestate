/** @type {import('tailwindcss').Config} */

// Every colour comes from src/styles/tokens.css (RGB channels), so a theme is
// a change of CSS variables, not of class names.
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;
const scale = (family, steps) => Object.fromEntries(steps.map((s) => [s, v(`${family}-${s}`)]));

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '"Inter Variable"',
          'ui-sans-serif',
          'system-ui',
          'sans-serif',
          '"Apple Color Emoji"',
          '"Segoe UI Emoji"',
          '"Segoe UI Symbol"',
          '"Noto Color Emoji"',
        ],
      },
      // 6 px controls, 8 px cards and tables, 12 px dialogs.
      borderRadius: {
        md: '6px',
        lg: '8px',
        xl: '12px',
      },
      boxShadow: {
        sm: 'var(--shadow-e1)',
        lg: 'var(--shadow-e2)',
      },
      colors: {
        // semantic tokens (new code and src/ui/)
        bg: v('bg'),
        surface: { DEFAULT: v('surface'), muted: v('surface-muted') },
        line: { DEFAULT: v('line'), input: v('line-input') },
        fg: { DEFAULT: v('fg'), 2: v('fg-2'), 3: v('fg-3') },
        primary: {
          DEFAULT: v('primary'),
          hover: v('primary-hover'),
          soft: v('primary-soft'),
          fg: v('primary-fg'),
          on: v('on-primary'),
        },
        success: { DEFAULT: v('success'), soft: v('success-soft') },
        warning: { DEFAULT: v('warning'), soft: v('warning-soft') },
        danger: { DEFAULT: v('danger'), soft: v('danger-soft') },
        info: { DEFAULT: v('info'), soft: v('info-soft') },
        focus: v('focus'),
        // the Tailwind scales existing screens use, on the same palette
        slate: scale('slate', [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]),
        blue: scale('blue', [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]),
        red: scale('red', [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]),
        amber: scale('amber', [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]),
        emerald: scale('emerald', [50, 100, 200, 600, 700, 800]),
        green: { 50: v('emerald-50'), 200: v('emerald-200'), 700: v('emerald-700') },
        orange: { 50: v('orange-50'), 700: v('orange-700') },
      },
    },
  },
  plugins: [],
};

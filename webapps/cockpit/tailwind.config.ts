// Tailwind reads the design tokens of docs/development/design-tokens.css (ui-guide.md §4.1, §4.2) as CSS custom
// properties: one source for the values, Tailwind only names them. src/index.css imports the token file.
import type { Config } from 'tailwindcss';

const token = (name: string) => `var(--vc-${name})`;

export default {
  content: { relative: true, files: ['./index.html', './src/**/*.{ts,tsx}'] },
  theme: {
    extend: {
      colors: {
        background: token('background'),
        surface: token('surface'),
        text: token('text'),
        muted: token('muted'),
        border: token('border'),
        primary: token('primary'),
        success: { text: token('success-text'), bg: token('success-bg') },
        warning: { text: token('warning-text'), bg: token('warning-bg') },
        danger: { text: token('danger-text'), bg: token('danger-bg') },
        info: { text: token('info-text'), bg: token('info-bg') },
      },
      fontFamily: { sans: token('font-sans') },
      fontSize: {
        body: token('font-size-body'),
        form: token('font-size-form'),
        label: token('font-size-label'),
        section: token('font-size-section'),
        title: token('font-size-title'),
      },
      borderRadius: { card: token('radius-card'), input: token('radius-input') },
      maxWidth: { content: token('content-max-width') },
      width: { nav: token('nav-width') },
      minHeight: { touch: token('touch-target') },
      minWidth: { touch: token('touch-target') },
    },
  },
  plugins: [],
} satisfies Config;

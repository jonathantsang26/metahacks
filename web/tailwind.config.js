/** Design tokens live in src/index.css (DESIGN.md §2); Tailwind just names them. */
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        chrome: 'var(--bg-chrome)',
        card: 'var(--bg-card)',
        rail: 'var(--bg-rail)',
        section: 'var(--bg-section-head)',
        tabgroup: 'var(--bg-tabgroup)',
        tabactive: 'var(--bg-tab-active)',
        selected: 'var(--bg-row-selected)',
        ink: 'var(--text)',
        muted: 'var(--text-muted)',
        hairline: 'var(--hairline)',
        accent: 'var(--accent)',
        live: 'var(--live)',
        badge: 'var(--badge)',
        ok: 'var(--ok)',
        okbg: 'var(--chip-ok-bg)',
        btndark: 'var(--btn-dark)',
        hud: 'var(--hud-bg)'
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"SF Mono"', 'ui-monospace', 'monospace']
      },
      fontSize: {
        '2xs': ['10px', '14px'],
        xs: ['11px', '15px'],
        sm: ['12px', '16px'],
        base: ['13px', '18px']
      }
    }
  },
  plugins: []
};

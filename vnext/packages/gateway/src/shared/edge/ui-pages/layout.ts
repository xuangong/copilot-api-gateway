// Base HTML layout for the server-rendered pages (login, device, guide).
// Tailwind 3 CDN + Alpine.js + Geist fonts. Colours follow the dashboard's design
// tokens (apps/dashboard/src/styles.css); the older class and variable names stay
// as aliases of those tokens so the page markup barely changes.
import { renderI18nScript } from "./i18n"

const DEFAULT_DESCRIPTION =
  "Copilot Gateway puts one API key in front of Claude, GPT and Gemini models for Claude Code, Codex CLI and Gemini CLI."

export function Layout({
  title,
  description = DEFAULT_DESCRIPTION,
  children,
}: {
  title: string
  description?: string
  children: string
}): string {
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} — Copilot Gateway</title>
  <meta name="description" content="${description}" />
  <link rel="icon" type="image/png" href="/favicon.png" />
  <script src="/cdn/tailwind.js"></script>
  <script defer src="/cdn/alpine.js"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=Geist+Mono:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <script>
    // Theme init - before paint
    (function() {
      var saved = localStorage.getItem('theme');
      var sys = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      var theme = saved || sys;
      document.documentElement.setAttribute('data-theme', theme);
      window.__currentTheme = theme;
    })();

    function toggleTheme() {
      var current = document.documentElement.getAttribute('data-theme');
      var next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('theme', next);
      window.__currentTheme = next;
      window.dispatchEvent(new CustomEvent('theme-changed', { detail: next }));
    }

    function isDarkTheme() {
      return document.documentElement.getAttribute('data-theme') === 'dark';
    }
  </script>
  ${renderI18nScript()}
  <script>
    // Tailwind 3 drops opacity modifiers (bg-x/10) on colours written as a bare
    // var(--x), so every colour goes through its RGB channel variable.
    (function() {
      function rgb(name) { return 'rgb(var(--' + name + '-rgb) / <alpha-value>)'; }
      var accent = {
        violet: rgb('brand-text'),
        violetDim: rgb('brand-hover'),
        cyan: rgb('info'),
        teal: rgb('success'),
        amber: rgb('warn'),
        red: rgb('danger'),
      };
      tailwind.config = {
        theme: {
          extend: {
            fontFamily: {
              sans: ['Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'],
              mono: ['Geist Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
            },
            colors: {
              surface: {
                '900': rgb('surface-900'),
                '800': rgb('surface-800'),
                '700': rgb('surface-700'),
                '600': rgb('surface-600'),
                '500': rgb('surface-500'),
              },
              accent: accent,
              brand: {
                DEFAULT: rgb('brand'),
                hover: rgb('brand-hover'),
                text: rgb('brand-text'),
                fg: rgb('brand-foreground'),
              },
            },
            // As text, the status colours use their darker *-text tokens so they
            // reach 4.5:1 on their own tints; cyan is the info colour.
            textColor: {
              accent: Object.assign({}, accent, {
                teal: rgb('success-text'),
                amber: rgb('warn-text'),
                red: rgb('danger-text'),
              }),
            },
            borderColor: {
              DEFAULT: 'var(--border-color)',
            },
          },
        },
      };
    })();
  </script>
  <style>
    /* ===== Design tokens (copied from apps/dashboard/src/styles.css) ===== */
    :root,
    [data-theme="light"] {
      color-scheme: light;
      --surface-900: #ffffff;
      --surface-800: #fafafa;
      --surface-700: #f2f2f2;
      --surface-600: #e0e0e0;
      --surface-500: #c4c4c4;
      --text-primary: #0a0a0a;
      --text-secondary: #525252;
      --text-dim: #737373;
      --border-color: #ebebeb;
      --input-border: #8f8f8f;
      --control-border: #d9d9d9;
      --input-bg: #ffffff;
      --brand: #7c3aed;
      --brand-hover: #6d28d9;
      --brand-text: #7c3aed;
      --brand-foreground: #ffffff;
      --ring: color-mix(in oklab, #7c3aed 35%, transparent);
      --info: #0e7490;
      --success: #047857;
      --warn: #b45309;
      --danger: #dc2626;
      --success-text: #065f46;
      --warn-text: #92400e;
      --danger-text: #b91c1c;

      /* RGB channels of the tokens above, for Tailwind's opacity modifiers. */
      --surface-900-rgb: 255 255 255;
      --surface-800-rgb: 250 250 250;
      --surface-700-rgb: 242 242 242;
      --surface-600-rgb: 224 224 224;
      --surface-500-rgb: 196 196 196;
      --brand-rgb: 124 58 237;
      --brand-hover-rgb: 109 40 217;
      --brand-text-rgb: 124 58 237;
      --brand-foreground-rgb: 255 255 255;
      --info-rgb: 14 116 144;
      --success-rgb: 4 120 87;
      --warn-rgb: 180 83 9;
      --danger-rgb: 220 38 38;
      --success-text-rgb: 6 95 70;
      --warn-text-rgb: 146 64 14;
      --danger-text-rgb: 185 28 28;
    }

    [data-theme="dark"] {
      color-scheme: dark;
      --surface-900: #0a0a0a;
      --surface-800: #111111;
      --surface-700: #1a1a1a;
      --surface-600: #262626;
      --surface-500: #333333;
      --text-primary: #ededed;
      --text-secondary: #a1a1a1;
      --text-dim: #8f8f8f;
      --border-color: #262626;
      --input-border: #616161;
      --control-border: #333333;
      --input-bg: #0a0a0a;
      --brand: #7c3aed;
      --brand-hover: #6d28d9;
      --brand-text: #a78bfa;
      --brand-foreground: #ffffff;
      --ring: color-mix(in oklab, #a78bfa 45%, transparent);
      --info: #22d3ee;
      --success: #34d399;
      --warn: #fbbf24;
      --danger: #f87171;
      --success-text: var(--success);
      --warn-text: var(--warn);
      --danger-text: var(--danger);

      --surface-900-rgb: 10 10 10;
      --surface-800-rgb: 17 17 17;
      --surface-700-rgb: 26 26 26;
      --surface-600-rgb: 38 38 38;
      --surface-500-rgb: 51 51 51;
      --brand-rgb: 124 58 237;
      --brand-hover-rgb: 109 40 217;
      --brand-text-rgb: 167 139 250;
      --brand-foreground-rgb: 255 255 255;
      --info-rgb: 34 211 238;
      --success-rgb: 52 211 153;
      --warn-rgb: 251 191 36;
      --danger-rgb: 248 113 113;
      --success-text-rgb: 52 211 153;
      --warn-text-rgb: 251 191 36;
      --danger-text-rgb: 248 113 113;
    }

    :root {
      /* Tinted boxes and borders used by inline styles on the pages. */
      --brand-edge: color-mix(in oklab, var(--brand-text) 35%, transparent);
      --success-wash: color-mix(in oklab, var(--success) 8%, transparent);
      --success-edge: color-mix(in oklab, var(--success) 30%, transparent);
      --warn-wash: color-mix(in oklab, var(--warn) 6%, transparent);
      --warn-edge: color-mix(in oklab, var(--warn) 28%, transparent);

      /* Legacy names, kept as aliases so the page markup keeps working. */
      --glass-bg: var(--surface-900);
      --glass-border: var(--border-color);
      --glow-border: var(--border-color);
      --glow-color: transparent;
      --card-shadow: none;
      /* One accent colour: the old teal buttons become brand buttons. */
      --accent-teal: var(--brand);
    }

    body {
      background: var(--surface-900);
      color: var(--text-primary);
      font-family: 'Geist', ui-sans-serif, system-ui, sans-serif;
      font-size: 14px;
      font-variant-numeric: tabular-nums;
      -webkit-font-smoothing: antialiased;
    }

    /* Cards: solid surface, hairline border, no blur or shadow. */
    .glass-card {
      background: var(--surface-900);
      border: 1px solid var(--border-color);
      border-radius: 8px;
    }
    .glow-primary { box-shadow: none; }
    .glow-border { border: 1px solid var(--border-color); }

    /* Animations */
    @keyframes fadeSlideUp {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .animate-in {
      animation: fadeSlideUp 0.2s ease-out forwards;
      opacity: 0;
    }
    .delay-1 { animation-delay: 0.03s; }
    .delay-2 { animation-delay: 0.06s; }
    .delay-3 { animation-delay: 0.09s; }
    .delay-4 { animation-delay: 0.12s; }
    .delay-5 { animation-delay: 0.15s; }
    @media (prefers-reduced-motion: reduce) {
      .animate-in { animation: none; opacity: 1; }
    }

    /* Inputs: dashboard colours and focus ring; the padding stays at the old
       size so inputs line up with the full-width buttons. */
    input[type="text"], input[type="password"], input[type="email"] {
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      border-radius: 6px;
      padding: 12px 16px;
      color: var(--text-primary);
      font-family: inherit;
      font-size: 14px;
      font-variant-numeric: inherit;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
      outline: none;
      width: 100%;
    }
    /* The device code keeps a monospace face (tells 0/O and 1/I apart); this
       must beat the input rule above, which outranks the font-mono utility. */
    input.font-mono {
      font-family: 'Geist Mono', ui-monospace, SFMono-Regular, monospace;
    }
    input::placeholder {
      color: var(--text-dim);
      opacity: 1;
    }
    input:focus {
      border-color: var(--brand-text);
      box-shadow: 0 0 0 3px var(--ring);
    }

    select option {
      background: var(--surface-800);
      color: var(--text-primary);
    }

    /* Buttons */
    .btn-primary {
      background: var(--brand);
      color: var(--brand-foreground);
      font-weight: 500;
      padding: 12px 24px;
      border-radius: 6px;
      border: none;
      cursor: pointer;
      transition: background-color 0.15s ease;
      font-family: inherit;
      font-size: 14px;
    }
    .btn-primary:hover:not(:disabled) {
      background: var(--brand-hover);
      /* Buttons that set background: var(--accent-teal) inline pick this up too. */
      --accent-teal: var(--brand-hover);
    }
    .btn-primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .theme-toggle {
      background: transparent;
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 6px;
      cursor: pointer;
      color: var(--text-secondary);
      transition: background-color 0.15s ease, color 0.15s ease;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .theme-toggle:hover { background: var(--surface-700); color: var(--text-primary); }

    .btn-primary:focus-visible,
    .theme-toggle:focus-visible {
      /* A solid outline, not the translucent --ring halo: a focus indicator needs 3:1. */
      outline: 2px solid var(--brand-text);
      outline-offset: 2px;
      box-shadow: none;
    }

    /* Adaptive text utility classes */
    .text-themed { color: var(--text-primary); }
    .text-themed-secondary { color: var(--text-secondary); }
    .text-themed-dim { color: var(--text-dim); }

    .border-themed { border-color: var(--border-color); }
    /* CDN Tailwind does not generate variants for these plain classes. */
    .hover\\:text-themed-secondary:hover { color: var(--text-secondary); }

    /* Links inside running text (incl. x-html i18n strings) need more than colour */
    :where(p, li) a[href] {
      text-decoration-line: underline;
      text-decoration-thickness: 1px;
      text-underline-offset: 2px;
    }
  </style>
</head>
<body class="min-h-screen">
  ${children}
</body>
</html>`
}

// Base HTML layout - Midnight Aurora / Clean White dual-theme
// Tailwind CDN + Alpine.js + Outfit + IBM Plex Mono fonts

export function Layout({ title, children }: { title: string; children: string }): string {
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} — Copilot Gateway</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
  <link href="https://cdn.jsdelivr.net/npm/prismjs@1/themes/prism-okaidia.min.css" rel="stylesheet" />
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/prism.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-bash.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-toml.min.js"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600&family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
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
  <script>
    tailwind.config = {
      theme: {
        extend: {
          fontFamily: {
            sans: ['Outfit', 'system-ui', 'sans-serif'],
            mono: ['IBM Plex Mono', 'monospace'],
          },
          colors: {
            surface: {
              '900': 'var(--surface-900)',
              '800': 'var(--surface-800)',
              '700': 'var(--surface-700)',
              '600': 'var(--surface-600)',
              '500': 'var(--surface-500)',
            },
            accent: {
              violet: '#8b5cf6',
              violetDim: '#7c3aed',
              violetGlow: 'rgba(139, 92, 246, 0.15)',
              cyan: '#06b6d4',
              teal: '#10b981',
              amber: '#f59e0b',
              red: '#ef4444',
            }
          }
        }
      }
    }
  </script>
  <style>
    /* ===== Theme CSS Variables ===== */
    :root,
    [data-theme="light"] {
      --surface-900: #ffffff;
      --surface-800: #f4f4f5;
      --surface-700: #e4e4e7;
      --surface-600: #d4d4d8;
      --surface-500: #a1a1aa;
      --text-primary: #09090b;
      --text-secondary: #52525b;
      --text-dim: #a1a1aa;
      --border-color: rgba(0, 0, 0, 0.08);
      --glass-bg: rgba(255, 255, 255, 0.85);
      --glass-bg2: rgba(244, 244, 245, 0.9);
      --glass-border: rgba(0, 0, 0, 0.06);
      --glow-color: rgba(139, 92, 246, 0.08);
      --glow-border: rgba(139, 92, 246, 0.15);
      --card-shadow: 0 1px 3px rgba(0,0,0,0.06), 0 4px 16px rgba(0,0,0,0.04);
      --input-bg: rgba(0, 0, 0, 0.03);
      --input-border: rgba(0, 0, 0, 0.12);
      --noise-opacity: 0.015;
      --tooltip-bg: rgba(255, 255, 255, 0.95);
      --tooltip-border: rgba(0, 0, 0, 0.08);
      --tooltip-text: #09090b;
      --tooltip-text2: #52525b;
      --grid-color: rgba(0, 0, 0, 0.05);
      --tick-color: #71717a;
    }

    [data-theme="dark"] {
      --surface-900: #08090d;
      --surface-800: #0f1117;
      --surface-700: #161922;
      --surface-600: #1e2230;
      --surface-500: #282d3e;
      --text-primary: #e4e4e7;
      --text-secondary: #a1a1aa;
      --text-dim: #71717a;
      --border-color: rgba(255, 255, 255, 0.07);
      --glass-bg: linear-gradient(135deg, rgba(22, 25, 34, 0.8), rgba(15, 17, 23, 0.95));
      --glass-bg2: rgba(15, 17, 23, 0.9);
      --glass-border: rgba(255, 255, 255, 0.06);
      --glow-color: rgba(139, 92, 246, 0.12);
      --glow-border: rgba(139, 92, 246, 0.2);
      --card-shadow: 0 2px 8px rgba(0,0,0,0.3), 0 8px 32px rgba(0,0,0,0.2);
      --input-bg: rgba(255, 255, 255, 0.04);
      --input-border: rgba(255, 255, 255, 0.1);
      --noise-opacity: 0.025;
      --tooltip-bg: rgba(12, 14, 20, 0.95);
      --tooltip-border: rgba(255, 255, 255, 0.08);
      --tooltip-text: #e4e4e7;
      --tooltip-text2: #a1a1aa;
      --grid-color: rgba(255, 255, 255, 0.04);
      --tick-color: #71717a;
    }

    body {
      background: var(--surface-900);
      color: var(--text-primary);
      font-family: 'Outfit', system-ui, sans-serif;
      transition: background-color 0.3s ease, color 0.3s ease;
    }

    /* Subtle noise texture */
    body::before {
      content: '';
      position: fixed;
      inset: 0;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.03'/%3E%3C/svg%3E");
      opacity: var(--noise-opacity);
      pointer-events: none;
      z-index: -1;
    }

    /* Glass card - adaptive */
    .glass-card {
      background: var(--glass-bg);
      backdrop-filter: blur(12px);
      border: 1px solid var(--glass-border);
      border-radius: 16px;
      box-shadow: var(--card-shadow);
      transition: background 0.3s ease, border-color 0.3s ease, box-shadow 0.3s ease;
    }

    .glow-primary {
      box-shadow: 0 0 20px var(--glow-color),
                  0 0 60px rgba(139, 92, 246, 0.05);
    }

    .glow-border {
      border: 1px solid var(--glow-border);
    }

    /* Aurora gradient border effect */
    .aurora-border {
      position: relative;
      border: none;
      background: var(--glass-bg);
    }
    .aurora-border::before {
      content: '';
      position: absolute;
      inset: -1px;
      border-radius: 17px;
      background: conic-gradient(from 180deg, #8b5cf6, #06b6d4, #10b981, #8b5cf6);
      opacity: 0.3;
      z-index: -1;
      transition: opacity 0.3s ease;
    }
    .aurora-border:hover::before {
      opacity: 0.5;
    }

    /* Animations */
    @keyframes fadeSlideUp {
      from { opacity: 0; transform: translateY(16px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .animate-in {
      animation: fadeSlideUp 0.5s ease-out forwards;
      opacity: 0;
    }

    .delay-1 { animation-delay: 0.1s; }
    .delay-2 { animation-delay: 0.2s; }
    .delay-3 { animation-delay: 0.3s; }
    .delay-4 { animation-delay: 0.4s; }
    .delay-5 { animation-delay: 0.5s; }

    .progress-track {
      height: 8px;
      border-radius: 4px;
      background: var(--input-bg);
      overflow: hidden;
    }

    .progress-fill {
      height: 100%;
      border-radius: 4px;
      transition: width 0.8s cubic-bezier(0.22, 1, 0.36, 1);
    }

    @keyframes pulse-dot {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    .status-pulse {
      animation: pulse-dot 2s ease-in-out infinite;
    }

    .hover-lift {
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }
    .hover-lift:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
    }

    /* Inputs */
    input[type="text"], input[type="password"] {
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      border-radius: 10px;
      padding: 12px 16px;
      color: var(--text-primary);
      font-family: 'IBM Plex Mono', monospace;
      font-size: 14px;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
      outline: none;
      width: 100%;
    }
    input:focus {
      border-color: rgba(139, 92, 246, 0.5);
      box-shadow: 0 0 0 3px rgba(139, 92, 246, 0.1);
    }

    /* Select styling */
    select option {
      background: var(--surface-800);
      color: var(--text-primary);
    }

    /* Buttons */
    .btn-primary {
      background: linear-gradient(135deg, #8b5cf6, #06b6d4);
      color: #ffffff;
      font-weight: 600;
      padding: 12px 24px;
      border-radius: 10px;
      border: none;
      cursor: pointer;
      transition: all 0.2s ease;
      font-family: 'Outfit', system-ui, sans-serif;
      font-size: 14px;
      letter-spacing: 0.02em;
    }
    .btn-primary:hover {
      filter: brightness(1.15);
      box-shadow: 0 4px 20px rgba(139, 92, 246, 0.3);
    }
    .btn-primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .btn-ghost {
      background: var(--input-bg);
      color: var(--text-secondary);
      font-weight: 500;
      padding: 10px 20px;
      border-radius: 10px;
      border: 1px solid var(--input-border);
      cursor: pointer;
      transition: all 0.2s ease;
      font-family: 'Outfit', system-ui, sans-serif;
      font-size: 13px;
    }
    .btn-ghost:hover {
      background: var(--surface-700);
      border-color: var(--glow-border);
    }

    /* Theme toggle button */
    .theme-toggle {
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      border-radius: 8px;
      padding: 6px;
      cursor: pointer;
      color: var(--text-secondary);
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .theme-toggle:hover {
      color: #8b5cf6;
      border-color: rgba(139, 92, 246, 0.3);
    }

    /* Code blocks - theme aware */
    .code-block {
      border: 1px solid var(--border-color);
    }
    [data-theme="dark"] .code-block {
      background: #0f1117;
    }
    [data-theme="light"] .code-block {
      background: #f4f4f5;
    }
    .code-block-btn {
      color: var(--text-dim);
    }
    .code-block-btn:hover {
      color: #8b5cf6;
      background: var(--input-bg);
    }

    /* Prism code theme */
    code[class*="language-"],
    pre[class*="language-"] {
      background: transparent !important;
      text-shadow: none !important;
      font-family: 'IBM Plex Mono', monospace !important;
      font-size: 11px !important;
      line-height: 1.6 !important;
    }

    /* Dark mode: light text + syntax colors */
    [data-theme="dark"] code[class*="language-"],
    [data-theme="dark"] pre[class*="language-"] {
      color: #e4e4e7 !important;
    }
    [data-theme="dark"] .token.comment, [data-theme="dark"] .token.prolog, [data-theme="dark"] .token.doctype, [data-theme="dark"] .token.cdata { color: #71717a; }
    [data-theme="dark"] .token.punctuation { color: #a1a1aa; }
    [data-theme="dark"] .token.property, [data-theme="dark"] .token.tag, [data-theme="dark"] .token.boolean, [data-theme="dark"] .token.number, [data-theme="dark"] .token.constant, [data-theme="dark"] .token.symbol { color: #8b5cf6; }
    [data-theme="dark"] .token.selector, [data-theme="dark"] .token.attr-name, [data-theme="dark"] .token.string, [data-theme="dark"] .token.char, [data-theme="dark"] .token.builtin { color: #06b6d4; }
    [data-theme="dark"] .token.operator, [data-theme="dark"] .token.entity, [data-theme="dark"] .token.url { color: #a1a1aa; }
    [data-theme="dark"] .token.atrule, [data-theme="dark"] .token.attr-value, [data-theme="dark"] .token.keyword { color: #ec4899; }
    [data-theme="dark"] .token.function, [data-theme="dark"] .token.class-name { color: #a855f7; }
    [data-theme="dark"] .token.regex, [data-theme="dark"] .token.important, [data-theme="dark"] .token.variable { color: #f59e0b; }
    [data-theme="dark"] .token.assign-left { color: #a1a1aa; }

    /* Light mode: all black text */
    [data-theme="light"] code[class*="language-"],
    [data-theme="light"] pre[class*="language-"] {
      color: #1a1a1a !important;
    }
    [data-theme="light"] .token { color: #1a1a1a !important; }

    .token.table { display: inline !important; }
    .token.table .punctuation { display: inline !important; }

    /* Adaptive text utility classes */
    .text-themed { color: var(--text-primary); }
    .text-themed-secondary { color: var(--text-secondary); }
    .text-themed-dim { color: var(--text-dim); }

    /* Override Tailwind white/black opacity borders for theme awareness */
    .border-themed { border-color: var(--border-color); }

    /* Scrollbar hide utility */
    .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }
    .scrollbar-hide::-webkit-scrollbar { display: none; }
  </style>
</head>
<body class="min-h-screen">
  ${children}
</body>
</html>`
}

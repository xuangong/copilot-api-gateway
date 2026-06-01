// Renders the React-based dashboard at /dashboard.
// JS and CSS are inlined into the worker bundle via text imports so
// the same Response works on Cloudflare Workers and local Bun.
import dashboardJsModule from "./dist/dashboard.js" with { type: "text" }
import dashboardCss from "./dist/dashboard.css" with { type: "text" }
import { renderI18nScript } from "../i18n"

const dashboardJs = dashboardJsModule as unknown as string

// React's bundle contains a literal "</script>" string that would prematurely
// close our inline <script> tag. Escape it so the browser parses the whole bundle.
const safeJs = dashboardJs.replace(/<\/script/gi, "<\\/script")

export function DashboardPage(): string {
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Dashboard — Copilot Gateway</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600&family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
<script src="/cdn/chart.js"></script>
${renderI18nScript()}
<script>
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
</script>
<style>${dashboardCss}</style>
</head>
<body class="min-h-screen">
<div id="app"></div>
<script type="module">${safeJs}</script>
</body>
</html>`
}

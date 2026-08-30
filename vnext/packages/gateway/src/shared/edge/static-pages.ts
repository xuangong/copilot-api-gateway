// Static page + CDN proxy routes ported 1:1 from src/index.ts (旧项目 route #17/19 缺口收口).
// HTML 与 dashboard SPA 沿用旧 src/ui/* 模板（已整体 cp 到 ./ui-pages/），
// dashboard JS/CSS 通过 .txt 文本导入打进 worker bundle，
// 与旧 wrangler.toml `[[rules]] type = "Text"` 行为一致（vNext wrangler.jsonc 已带等价 rule）。
import { Hono } from 'hono'
import { LoginPage } from './ui-pages/login'
import { DashboardPage } from './ui-pages/dashboard-app/page'
import { DevicePage } from './ui-pages/device'
import { GuidePage } from './ui-pages/guide'
import faviconB64Module from './assets/favicon.png.txt'

const CDN_MAP: Record<string, string> = {
  'tailwind.js': 'https://cdn.tailwindcss.com/3.4.17',
  'alpine.js': 'https://unpkg.com/alpinejs@3/dist/cdn.min.js',
  'prism.css': 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-okaidia.min.css',
  'prism.js': 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js',
  'prism-bash.js': 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-bash.min.js',
  'prism-toml.js': 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-toml.min.js',
  'prism-json.js': 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-json.min.js',
}

const html = (body: string) =>
  new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })

// The tab icon: a 64×64 PNG of the same three-layer glyph the dashboard header
// wears, carried as base64 text for the same reason the dashboard bundle is —
// a Text import is the only asset channel that works identically on Workers and
// on Bun. Decoded once at module load, not per request.
const faviconBytes = Uint8Array.from(
  atob(faviconB64Module as unknown as string),
  (ch) => ch.charCodeAt(0),
)
const faviconResponse = () =>
  new Response(faviconBytes, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=604800, immutable',
    },
  })

export const staticPages = new Hono()

staticPages.get('/', (c) => {
  const accept = c.req.header('accept') ?? ''
  if (accept.includes('application/json') && !accept.includes('text/html')) {
    return c.json({ status: 'ok', service: 'copilot-gateway-vnext' })
  }
  return html(LoginPage())
})
staticPages.on('HEAD', '/', (c) => c.body(null, 200))

staticPages.get('/dashboard', () => html(DashboardPage()))
staticPages.on('HEAD', '/dashboard', (c) => c.body(null, 200))
staticPages.get('/device/login', () => html(DevicePage()))
staticPages.get('/guide', () => html(GuidePage()))
// Both paths serve the same PNG. `/favicon.ico` is what a browser probes on its
// own when a page declares no icon; PNG bytes under an .ico name are what every
// current browser expects there.
staticPages.get('/favicon.ico', faviconResponse)
staticPages.get('/favicon.png', faviconResponse)

staticPages.get('/cdn/:file', async (c) => {
  const file = c.req.param('file')
  const url = CDN_MAP[file]
  if (!url) return c.text('Not found', 404)
  const resp = await fetch(url)
  const contentType = file.endsWith('.css') ? 'text/css' : 'application/javascript'
  return new Response(resp.body, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=604800, immutable',
      'Access-Control-Allow-Origin': '*',
    },
  })
})

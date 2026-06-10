# filter.fyi — system map (public build)

Self-contained, **CSP-safe** build of the public system map. No CDN, no Babel,
no `eval` — it runs under your existing Worker security headers unchanged.

## Files (deploy all 7 together)

```
index.html                      ← the page
data.js                         ← softened/public architecture data
map.js  panel.js  app.js        ← precompiled from .jsx (plain React.createElement)
react.production.min.js         ← self-hosted React 18.3.1 (UMD prod)
react-dom.production.min.js     ← self-hosted ReactDOM 18.3.1 (UMD prod)
```

## Deploy to the Cloudflare Worker repo

1. Copy this whole folder into the frontend's static assets dir as
   **`public/system-map/`** (so the 7 files live at `public/system-map/index.html`, etc).
2. No `worker.ts` change needed — the catch-all already falls through to
   `env.ASSETS.fetch(req)` for any non-`/api/*` path.
3. Visit **`https://filter.fyi/system-map/`** — note the **trailing slash**.
   The relative script paths resolve against `/system-map/`. Without the slash,
   the browser resolves them against `/` and 404s. Cloudflare normally
   308-redirects to add the slash when an `index.html` is present; if you ever
   serve it from a path where that doesn't happen, add `<base href="/system-map/">`
   to `index.html`.

## Why it's CSP-safe

Your `withSecurityHeaders()` sets:
`script-src 'self' 'unsafe-inline'` · `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`
· `font-src https://fonts.gstatic.com` · `connect-src 'self'`.

This build uses only same-origin `<script src>` (covered by `'self'`), the inline
`<style>` (covered by `'unsafe-inline'`), and Google Fonts (already allowed). No
`unpkg`, no `text/babel`, no `eval` → nothing to loosen.

## Updating the data later

Edit the source in the parent folder (`data.public.js`) and re-run the build, or
just hand-edit `data.js` here — it's plain JS. The compiled `map/panel/app.js`
only need regenerating if you change `../*.jsx` logic.

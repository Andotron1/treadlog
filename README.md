# TreadLog

Bluetooth (FTMS) controller + run tracker for a Sportstech F37 treadmill. Android Chrome PWA, no build step.

## Run locally
    python3 -m http.server 8000      # then open http://localhost:8000 in Chrome (secure context)
    node test/test.mjs               # unit tests

## Deploy (needs HTTPS for Web Bluetooth)
Any static host: GitHub Pages, Cloudflare Pages, Netlify. Upload this folder as-is.
Open the URL in Chrome on the tablet → menu → "Install app".

## Files
- js/ftms.js     FTMS parsing, control point commands, reconnect
- js/metrics.js  run recorder, calories, formatting, weekly totals
- js/db.js       IndexedDB storage
- js/app.js      UI
- sw.js          offline shell (network-first)

If the F37 does not expose FTMS, Settings > Diagnostics shows every service it does expose.

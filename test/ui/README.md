# Browser tests

These drive a real Chromium browser against a running app and check what a
person would actually see. They need Playwright, which is NOT bundled with the
app (the app itself has no dependencies):

```bash
npm install -D playwright && npx playwright install chromium
node test/ui/run-all.js
```

The app must already be running on http://localhost:3000.
Skip these if you don't want the extra tooling — `node test/smoke.js` covers
the whole API without installing anything.

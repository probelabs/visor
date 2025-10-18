Visor Workshop
===============

Quick instructions to present and explore the Visor workshop content.

 - One‑click setup (pins reveal‑md 6.1.2):
   - `npm run workshop:setup`
- Live slides:
  - `npm run workshop:serve`
  - Opens a local server with auto‑reload. Press `S` for speaker notes.
  - **Custom styling**: `custom.css` provides visual hierarchy with color-coded headers

- Export static site:
  - `npm run workshop:export`
  - Open `workshop/build/slides.html` in a browser.

- Export PDF (US Letter by default):
  - `npm run workshop:pdf`
  - A4 variant: `npm run workshop:pdf:a4`
  - In CI/containers: `npm run workshop:pdf:ci` (adds `--no-sandbox` flags)

- Build everything (static + PDF):
  - `npm run workshop:build`

- Recommended viewport: 1280×720 or 1920×1080.

- Labs:
  - Self‑contained sample configs are under `workshop/labs/`.
  - You can also use richer configs from `examples/`.

Tip: If you prefer zero install, you can still run:
`npx reveal-md workshop/slides.md -w`

Labs quicklinks (using npx):
- Basic: `npx -y visor@latest --config workshop/labs/lab-01-basic.yaml --tags local,fast --output table`
- Command: `npx -y visor@latest --config workshop/labs/lab-02-command.yaml --check unit-tests --output markdown`
- Debug: `npx -y visor@latest --config workshop/labs/lab-03-debug.yaml --check debug-check --output markdown --debug`
- Planner (mock provider): `npx -y visor@latest --config workshop/labs/lab-04-planner.yaml --output markdown`

Notes on AI providers
- If your shell exports real AI keys (e.g., `GOOGLE_API_KEY`), Visor will auto‑select that provider and make network calls.
- For quick, offline demos set `ai.provider: mock` per check (already set in `lab-01` and `lab-04`), and temporarily unset provider env vars, for example:

```bash
env -u GOOGLE_API_KEY -u ANTHROPIC_API_KEY -u OPENAI_API_KEY \
npx -y visor@latest --config workshop/labs/lab-04-planner.yaml --output markdown
```

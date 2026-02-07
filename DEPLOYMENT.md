# Visor Cloudflare Pages Deployment

This document describes how to deploy the Visor landing page to Cloudflare Pages with worker routing from `probelabs.com/visor`.

## Architecture

The deployment consists of two components:

1. **Cloudflare Pages Site**: Hosts the static `index.html` at `https://visor-site.pages.dev`
2. **Cloudflare Worker**: Routes requests from `probelabs.com/visor/*` to the Pages site

## Files Structure

```
/Users/leonidbugaev/go/src/gates/
├── wrangler.toml              # Worker configuration
├── worker.js                  # Worker routing script
├── package.json              # Deployment scripts
└── site/
    ├── index.html            # Visor landing page
    └── _routes.json          # Pages routing configuration
```

## Configuration Files

### wrangler.toml
Configures the Cloudflare Worker named `visor-router` that handles routing from `probelabs.com/visor` and `probelabs.com/visor/*` to the Pages deployment.

### worker.js
The worker script that:
- Redirects `probelabs.com/visor` to `probelabs.com/visor/` (with trailing slash)
- Proxies requests from `probelabs.com/visor/*` to `https://visor-site.pages.dev`
- Updates HTML content to prefix absolute URLs with `/visor`

### site/_routes.json
Cloudflare Pages routing configuration that includes all `/visor/*` routes.

## Deployment Process

### Prerequisites

1. Install Wrangler CLI and authenticate:
   ```bash
   npm install -g wrangler
   wrangler login
   ```

2. Install project dependencies:
   ```bash
   cd /Users/leonidbugaev/go/src/gates
   npm install
   ```

### Deploy the Pages Site

Deploy the static site to Cloudflare Pages:

```bash
npm run deploy:site
```

This runs: `cd site && npx wrangler pages deploy . --project-name=visor-site --commit-dirty=true`

### Deploy the Worker

Deploy the routing worker:

```bash
npm run deploy:worker
```

This runs: `npx wrangler deploy`

### Full Deployment

Deploy both components:

```bash
npm run deploy
```

## Verification

After deployment:

1. **Pages Site**: Visit `https://visor-site.pages.dev` to verify the site loads correctly
2. **Worker Routing**: Visit `https://probelabs.com/visor` to verify it redirects to `https://probelabs.com/visor/`
3. **Content Proxying**: Verify that `https://probelabs.com/visor/` shows the Visor landing page with correctly prefixed URLs

## Configuration Details

### Pages Project Name
The Pages deployment uses project name `visor-site`, which creates the URL `https://visor-site.pages.dev`.

### Worker Routes
The worker is configured to handle:
- `probelabs.com/visor` (exact match)
- `probelabs.com/visor/*` (wildcard match)

### URL Transformation
The worker transforms URLs by:
1. Removing `/visor` prefix from incoming requests
2. Forwarding to `https://visor-site.pages.dev`
3. Updating HTML content to add `/visor` prefix to absolute URLs

## Maintenance

### Updating the Site
1. Modify `/Users/leonidbugaev/go/src/gates/site/index.html`
2. Run `npm run deploy:site`

### Updating the Worker
1. Modify `/Users/leonidbugaev/go/src/gates/worker.js`
2. Run `npm run deploy:worker`

### Logs and Monitoring
- View worker logs: `wrangler tail visor-router`
- Monitor Pages deployment: Check Cloudflare Dashboard > Pages > visor-site
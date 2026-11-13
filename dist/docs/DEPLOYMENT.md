# Visor Cloudflare Pages Deployment

This document describes how to deploy the Visor landing page to Cloudflare Pages with worker routing from `probelabs.com/visor`.

## Architecture

The deployment consists of two components:

1. **Cloudflare Pages Site**: Hosts the static `index.html` at `https://visor-site.pages.dev`
2. **Cloudflare Worker**: Routes requests from `probelabs.com/visor/*` to the Pages site

## Files Structure

```
visor/
├── package.json               # Deployment scripts (deploy:site, deploy:worker, deploy)
└── site/
    ├── wrangler.toml          # Worker configuration
    ├── worker.js              # Worker routing script
    ├── _routes.json           # Pages routing configuration
    ├── index.html             # Visor landing page
    └── visor.png              # Site assets
```

## Configuration Files

### site/wrangler.toml
Configures the Cloudflare Worker named `visor-router` that handles routing from `probelabs.com/visor` and `probelabs.com/visor/*` to the Pages deployment.

### site/worker.js
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

**Note**: The worker deployment uses the `site/wrangler.toml` configuration file.

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
1. Modify `site/index.html`
2. Run `npm run deploy:site`

### Updating the Worker
1. Modify `site/worker.js`
2. Run `npm run deploy:worker`

### Logs and Monitoring
- View worker logs: `wrangler tail visor-router`
- Monitor Pages deployment: Check Cloudflare Dashboard > Pages > visor-site

## Troubleshooting

### Common Issues

#### Worker Not Routing Correctly
- **Symptom**: Requests to `probelabs.com/visor` return 404 or incorrect content
- **Diagnosis**: Run `wrangler tail visor-router` to view real-time logs
- **Solution**: Verify routes in `site/wrangler.toml` match expected patterns

#### Pages Site Shows Old Content
- **Symptom**: Changes to `site/index.html` not appearing after deployment
- **Diagnosis**: Check deployment status in Cloudflare Dashboard > Pages
- **Solution**:
  1. Clear browser cache and CDN cache
  2. Re-run `npm run deploy:site`
  3. Verify the deployment completed successfully in the dashboard

#### Authentication Errors During Deployment
- **Symptom**: `wrangler deploy` fails with authentication error
- **Solution**:
  ```bash
  wrangler logout
  wrangler login
  ```

#### URL Prefixes Not Applied in HTML
- **Symptom**: Assets load from root instead of `/visor/` path
- **Diagnosis**: Check browser network tab for failed asset requests
- **Solution**: Review the regex patterns in `site/worker.js` that transform URLs

#### Worker Deployment Fails
- **Symptom**: `npm run deploy:worker` fails
- **Diagnosis**: Check the error message for specific issues
- **Solution**:
  1. Ensure `site/wrangler.toml` has valid syntax
  2. Verify your Cloudflare account has Workers enabled
  3. Check that the zone `probelabs.com` is in your account

### Checking Deployment Status

```bash
# List all Workers
wrangler deployments list

# Check Pages deployment status
wrangler pages deployment list --project-name=visor-site
```

## Rollback Procedures

### Rolling Back the Pages Site

1. **Via Cloudflare Dashboard**:
   - Go to Cloudflare Dashboard > Pages > visor-site
   - Navigate to "Deployments"
   - Find the previous working deployment
   - Click the three-dot menu and select "Rollback to this deployment"

2. **Via CLI** (using a previous commit):
   ```bash
   # Check out the previous working version
   git log --oneline site/index.html
   git checkout <commit-hash> -- site/index.html

   # Redeploy
   npm run deploy:site
   ```

### Rolling Back the Worker

1. **Via Cloudflare Dashboard**:
   - Go to Cloudflare Dashboard > Workers & Pages
   - Select `visor-router`
   - Navigate to "Deployments"
   - Select a previous version and click "Rollback"

2. **Via CLI** (using a previous commit):
   ```bash
   # Check out the previous working version
   git log --oneline site/worker.js
   git checkout <commit-hash> -- site/worker.js

   # Redeploy
   npm run deploy:worker
   ```

### Emergency Rollback

If the worker is causing issues and you need to disable it immediately:

```bash
# Delete the worker routes (stops routing through the worker)
wrangler delete visor-router
```

**Note**: This will cause `probelabs.com/visor` to return 404 until the worker is redeployed.

### Verifying Rollback Success

After any rollback:
1. Visit `https://visor-site.pages.dev` to verify the Pages site
2. Visit `https://probelabs.com/visor/` to verify the full routing path
3. Check `wrangler tail visor-router` for any errors

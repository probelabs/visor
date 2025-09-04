// Cloudflare Worker for routing probelabs.com/visor/* to Visor Pages site
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Check if this is a request to probelabs.com/visor or /visor/*
    if (url.hostname === 'probelabs.com' && url.pathname.startsWith('/visor')) {
      // Handle /visor without trailing slash by redirecting to /visor/
      if (url.pathname === '/visor') {
        return Response.redirect(url.origin + '/visor/', 301);
      }
      
      // Remove /visor from the path and proxy to the Pages site
      const newPath = url.pathname.replace('/visor', '') || '/';
      const pagesUrl = `https://visor-site.pages.dev${newPath}${url.search}`;
      
      // Fetch from the Pages deployment
      const response = await fetch(pagesUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body
      });
      
      // Create new response with same content but updated headers
      const newResponse = new Response(response.body, response);
      
      // Update any absolute links in HTML content to include /visor prefix
      if (response.headers.get('content-type')?.includes('text/html')) {
        const html = await response.text();
        const updatedHtml = html
          .replace(/href="\//g, 'href="/visor/')
          .replace(/src="\//g, 'src="/visor/')
          .replace(/url\(\//g, 'url(/visor/');
        return new Response(updatedHtml, {
          status: response.status,
          headers: response.headers
        });
      }
      
      return newResponse;
    }
    
    // For any other requests, pass through
    return fetch(request);
  },
};
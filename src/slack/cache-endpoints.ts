import * as http from 'http';
import { SlackAdapter } from './adapter';
import { logger } from '../logger';
import { SlackCacheObservabilityConfig } from '../types/bot';

/**
 * Cache endpoint handlers for Slack bot observability
 * Provides REST API for monitoring and managing thread cache
 */
export class CacheEndpointHandler {
  private adapter: SlackAdapter;
  private config: SlackCacheObservabilityConfig;
  private adminToken?: string;

  constructor(adapter: SlackAdapter, config?: SlackCacheObservabilityConfig) {
    this.adapter = adapter;
    this.config = config || {};
    this.adminToken = config?.cache_admin_token;
  }

  /**
   * Check if cache endpoints are enabled
   */
  isEnabled(): boolean {
    return this.config.enable_cache_endpoints === true;
  }

  /**
   * Authenticate admin requests (POST, DELETE operations)
   * @param req HTTP request
   * @returns true if authenticated or no token configured
   */
  private authenticateAdmin(req: http.IncomingMessage): boolean {
    // If no admin token configured, allow all requests (not recommended for production)
    if (!this.adminToken) {
      return true;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return false;
    }

    const token = authHeader.substring(7);
    return token === this.adminToken;
  }

  /**
   * Handle cache endpoint requests
   * Routes to appropriate handler based on path and method
   */
  async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    if (!this.isEnabled()) {
      return false;
    }

    const url = req.url || '/';
    const path = url.split('?')[0];
    const method = req.method || 'GET';

    logger.debug(`Cache endpoint request: ${method} ${path}`);

    try {
      // GET /_visor/cache/stats - Cache statistics
      if (method === 'GET' && path === '/_visor/cache/stats') {
        await this.handleGetStats(req, res);
        return true;
      }

      // GET /_visor/cache/threads - List all cached threads
      if (method === 'GET' && path === '/_visor/cache/threads') {
        await this.handleGetThreads(req, res);
        return true;
      }

      // GET /_visor/cache/threads/:threadId - Get specific thread
      if (method === 'GET' && path.startsWith('/_visor/cache/threads/')) {
        const threadId = decodeURIComponent(path.substring('/_visor/cache/threads/'.length));
        await this.handleGetThread(req, res, threadId);
        return true;
      }

      // POST /_visor/cache/clear - Clear all cache (admin)
      if (method === 'POST' && path === '/_visor/cache/clear') {
        if (!this.authenticateAdmin(req)) {
          this.sendUnauthorized(res);
          return true;
        }
        await this.handleClearCache(req, res);
        return true;
      }

      // DELETE /_visor/cache/threads/:threadId - Evict specific thread (admin)
      if (method === 'DELETE' && path.startsWith('/_visor/cache/threads/')) {
        if (!this.authenticateAdmin(req)) {
          this.sendUnauthorized(res);
          return true;
        }
        const threadId = decodeURIComponent(path.substring('/_visor/cache/threads/'.length));
        await this.handleEvictThread(req, res, threadId);
        return true;
      }

      return false;
    } catch (error) {
      logger.error(
        `Cache endpoint error: ${error instanceof Error ? error.message : String(error)}`
      );
      this.sendError(res, 500, 'Internal server error');
      return true;
    }
  }

  /**
   * GET /_visor/cache/stats
   * Returns comprehensive cache statistics
   */
  private async handleGetStats(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const stats = this.adapter.getCacheStats();
    const hitRate = this.adapter.getCacheHitRate();

    // Get time window stats
    const cache = (this.adapter as any).cache; // Access internal cache
    const timeWindows = cache ? cache.getAllTimeWindowStats() : new Map();
    const efficiency = cache ? cache.getCacheEfficiency() : 0;
    const mostActive = cache ? cache.getMostActiveThreads(10) : [];

    const timeWindowsObj: Record<string, any> = {};
    if (timeWindows) {
      for (const [windowSize, windowStats] of timeWindows.entries()) {
        const label = windowSize === 60 ? '1min' : windowSize === 300 ? '5min' : '15min';
        timeWindowsObj[label] = {
          windowSeconds: windowStats.windowSeconds,
          hits: windowStats.hits,
          misses: windowStats.misses,
          hitRate: Math.round(windowStats.hitRate * 100) / 100,
        };
      }
    }

    const response = {
      stats: {
        hits: stats.hits,
        misses: stats.misses,
        evictions: stats.evictions,
        size: stats.size,
        capacity: cache ? cache.capacity() : 0,
        utilization: cache ? Math.round((stats.size / cache.capacity()) * 100 * 100) / 100 : 0,
        hitRate: Math.round(hitRate * 100) / 100,
        evictionsByReason: stats.evictionsByReason || {},
        totalAccesses: stats.totalAccesses || 0,
        avgThreadSize: Math.round(stats.avgThreadSize || 0),
        totalBytes: stats.totalBytes || 0,
      },
      timeWindows: timeWindowsObj,
      efficiency: {
        score: efficiency,
        description: this.getEfficiencyDescription(efficiency),
      },
      mostActiveThreads: mostActive,
      timestamp: new Date().toISOString(),
    };

    logger.info(
      `Cache stats requested: size=${stats.size}, hitRate=${Math.round(hitRate * 100) / 100}%, efficiency=${efficiency}`
    );

    this.sendJson(res, 200, response);
  }

  /**
   * GET /_visor/cache/threads
   * Returns list of all cached threads with metadata
   */
  private async handleGetThreads(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const cache = (this.adapter as any).cache;
    if (!cache) {
      this.sendJson(res, 200, { threads: [] });
      return;
    }

    const threads = cache.getAllThreads();

    // Parse query parameters for filtering/sorting
    const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    const sortBy = url.searchParams.get('sort') || 'lastAccessedAt';
    const order = url.searchParams.get('order') || 'desc';
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);

    // Sort threads
    threads.sort((a: any, b: any) => {
      let aVal = a[sortBy];
      let bVal = b[sortBy];

      // Convert ISO strings to timestamps for comparison
      if (sortBy.includes('At')) {
        aVal = new Date(aVal).getTime();
        bVal = new Date(bVal).getTime();
      }

      return order === 'desc' ? bVal - aVal : aVal - bVal;
    });

    // Apply limit
    const limitedThreads = threads.slice(0, limit);

    logger.info(
      `Cache threads requested: ${threads.length} total, ${limitedThreads.length} returned`
    );

    this.sendJson(res, 200, {
      threads: limitedThreads,
      total: threads.length,
      limit,
      sortBy,
      order,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * GET /_visor/cache/threads/:threadId
   * Returns detailed information about a specific thread
   */
  private async handleGetThread(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    threadId: string
  ): Promise<void> {
    const cache = (this.adapter as any).cache;
    if (!cache) {
      this.sendNotFound(res, 'Cache not available');
      return;
    }

    const thread = cache.getThread(threadId);
    if (!thread) {
      this.sendNotFound(res, `Thread not found: ${threadId}`);
      return;
    }

    logger.info(`Cache thread details requested: ${threadId}`);

    this.sendJson(res, 200, {
      thread,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * POST /_visor/cache/clear
   * Clears all cache entries (admin operation)
   */
  private async handleClearCache(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const cache = (this.adapter as any).cache;
    if (!cache) {
      this.sendError(res, 503, 'Cache not available');
      return;
    }

    const beforeSize = cache.size();
    cache.clear();
    const afterSize = cache.size();

    logger.warn(`Cache cleared by admin: removed ${beforeSize} threads`);

    this.sendJson(res, 200, {
      success: true,
      message: 'Cache cleared successfully',
      removed: beforeSize,
      remaining: afterSize,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * DELETE /_visor/cache/threads/:threadId
   * Evicts a specific thread from cache (admin operation)
   */
  private async handleEvictThread(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    threadId: string
  ): Promise<void> {
    const cache = (this.adapter as any).cache;
    if (!cache) {
      this.sendError(res, 503, 'Cache not available');
      return;
    }

    const existed = cache.evict(threadId);

    if (!existed) {
      this.sendNotFound(res, `Thread not found: ${threadId}`);
      return;
    }

    logger.warn(`Cache thread evicted by admin: ${threadId}`);

    this.sendJson(res, 200, {
      success: true,
      message: 'Thread evicted successfully',
      threadId,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Get efficiency description based on score
   */
  private getEfficiencyDescription(score: number): string {
    if (score >= 90) return 'Excellent';
    if (score >= 75) return 'Good';
    if (score >= 60) return 'Fair';
    if (score >= 40) return 'Poor';
    return 'Very Poor';
  }

  /**
   * Send JSON response
   */
  private sendJson(res: http.ServerResponse, status: number, data: any): void {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    res.end(JSON.stringify(data, null, 2));
  }

  /**
   * Send 404 Not Found
   */
  private sendNotFound(res: http.ServerResponse, message: string): void {
    this.sendJson(res, 404, {
      error: 'Not Found',
      message,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Send 401 Unauthorized
   */
  private sendUnauthorized(res: http.ServerResponse): void {
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer',
    });
    res.end(
      JSON.stringify({
        error: 'Unauthorized',
        message: 'Admin authentication required',
        timestamp: new Date().toISOString(),
      })
    );
  }

  /**
   * Send error response
   */
  private sendError(res: http.ServerResponse, status: number, message: string): void {
    this.sendJson(res, status, {
      error: http.STATUS_CODES[status] || 'Error',
      message,
      timestamp: new Date().toISOString(),
    });
  }
}

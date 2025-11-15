import * as crypto from 'crypto';
import * as http from 'http';
import { SlackClient } from './client';
import { SlackAdapter } from './adapter';
import { getPromptStateManager } from './prompt-state';
import { WorkerPool } from './worker-pool';
import { WorkflowExecutor, WorkflowExecutionRequest } from './workflow-executor';
import { RateLimiter, RateLimitConfig } from './rate-limiter';
import { logger } from '../logger';
import { SlackBotConfig, ConversationContext, BotSessionContext } from '../types/bot';
import { VisorConfig } from '../types/config';

/**
 * Slack event payload structure
 */
interface SlackEvent {
  type: string;
  event_id?: string;
  event_time?: number;
  team_id?: string;
  api_app_id?: string;
  event?: {
    type: string;
    user?: string;
    text?: string;
    ts?: string;
    channel?: string;
    thread_ts?: string;
    event_ts?: string;
  };
  challenge?: string;
}

/**
 * Work item for async processing
 */
export interface SlackWorkItem {
  eventId: string;
  eventType: string;
  channel: string;
  threadTs: string;
  messageTs: string;
  userId: string;
  text: string;
  timestamp: number;
  /** Conversation context fetched by adapter */
  conversation?: ConversationContext;
  /** Rate limit tracking (for releasing concurrent slots) */
  rateLimitRequest?: {
    botId: string;
    userId: string;
    channelId: string;
  };
}

/**
 * Slack webhook handler
 * Handles incoming Slack webhook events with signature verification
 */
export class SlackWebhookHandler {
  private slackClient: SlackClient;
  private slackAdapter: SlackAdapter;
  private signingSecret: string;
  private config: SlackBotConfig;
  private visorConfig: VisorConfig;
  private botId: string;
  private workQueue: SlackWorkItem[] = [];
  private processedEventIds: Set<string> = new Set();
  private workerPool: WorkerPool<WorkflowExecutionRequest>;
  private workflowExecutor: WorkflowExecutor;
  private rateLimiter?: RateLimiter;

  constructor(config: SlackBotConfig, visorConfig: VisorConfig, botId: string) {
    this.config = config;
    this.visorConfig = visorConfig;
    this.botId = botId;
    this.signingSecret = config.signing_secret;
    this.slackClient = new SlackClient(config.bot_token);
    this.slackAdapter = new SlackAdapter(this.slackClient, config, undefined, botId);
    this.workflowExecutor = new WorkflowExecutor();

    // Initialize worker pool
    // Use max_parallelism from Visor config, default to 3
    const poolSize = visorConfig.max_parallelism ?? 3;
    // Use queue_capacity from Slack worker_pool config, default to 100
    const queueCapacity = config.worker_pool?.queue_capacity ?? 100;
    // Use task_timeout from Slack worker_pool config, default to 5 minutes
    const taskTimeout = config.worker_pool?.task_timeout ?? 5 * 60 * 1000;

    this.workerPool = new WorkerPool(
      async (request: WorkflowExecutionRequest) => {
        return await this.workflowExecutor.execute(request);
      },
      {
        poolSize,
        queueCapacity,
        taskTimeout,
      }
    );

    // Listen to worker pool events
    this.workerPool.on('queueFull', workItem => {
      logger.warn(`Worker pool queue is full, rejecting work item: ${workItem.id}`);
    });

    this.workerPool.on('workCompleted', result => {
      logger.info(
        `Work item ${result.workItemId} completed: ${result.success ? 'success' : 'failed'}`
      );
    });

    // Initialize rate limiter if configured
    if (config.rate_limiting?.enabled) {
      this.rateLimiter = new RateLimiter(config.rate_limiting as RateLimitConfig);
      logger.info(`Bot ${this.botId}: Rate limiting enabled`);
    }

    logger.info(
      `Bot ${this.botId}: Slack webhook handler initialized with worker pool (size: ${poolSize}, queue: ${queueCapacity}, timeout: ${taskTimeout}ms)`
    );
  }

  /**
   * Verify Slack request signature
   * Uses HMAC-SHA256 to verify the request came from Slack
   */
  private verifySignature(requestBody: string, timestamp: string, signature: string): boolean {
    try {
      // Reject requests older than 5 minutes to prevent replay attacks
      const currentTime = Math.floor(Date.now() / 1000);
      const requestTime = parseInt(timestamp, 10);

      if (Math.abs(currentTime - requestTime) > 60 * 5) {
        logger.warn('Slack request rejected: timestamp too old');
        return false;
      }

      // Construct the signature base string
      const sigBaseString = `v0:${timestamp}:${requestBody}`;

      // Calculate expected signature
      const hmac = crypto.createHmac('sha256', this.signingSecret);
      hmac.update(sigBaseString, 'utf8');
      const expectedSignature = `v0=${hmac.digest('hex')}`;

      // Use timing-safe comparison
      return crypto.timingSafeEqual(
        Buffer.from(expectedSignature, 'utf8'),
        Buffer.from(signature, 'utf8')
      );
    } catch (error) {
      logger.error(
        `Signature verification failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }

  /**
   * Parse request body with size limits
   */
  private async parseRequestBody(req: http.IncomingMessage): Promise<string> {
    const MAX_BODY_SIZE = 1024 * 1024; // 1MB limit

    return new Promise((resolve, reject) => {
      let body = '';
      let totalSize = 0;

      // Check Content-Length header first if present
      const contentLength = req.headers['content-length'];
      if (contentLength) {
        const length = parseInt(contentLength, 10);
        if (isNaN(length) || length > MAX_BODY_SIZE) {
          reject(new Error(`Request body too large. Maximum size allowed: ${MAX_BODY_SIZE} bytes`));
          return;
        }
      }

      req.on('data', chunk => {
        totalSize += chunk.length;

        // Check if we've exceeded the size limit
        if (totalSize > MAX_BODY_SIZE) {
          reject(new Error(`Request body too large. Maximum size allowed: ${MAX_BODY_SIZE} bytes`));
          return;
        }

        body += chunk.toString();
      });

      req.on('end', () => {
        resolve(body);
      });

      req.on('error', reject);
    });
  }

  /**
   * Check if message is a direct mention of the bot
   */
  private async isDirectMention(text: string, _userId?: string): Promise<boolean> {
    try {
      const botUserId = await this.slackClient.getBotUserId();

      // Check for @bot mention in text
      const mentionPattern = new RegExp(`<@${botUserId}>`, 'i');
      const hasMention = mentionPattern.test(text);

      logger.debug(`Direct mention check: ${hasMention} (text: "${text}", bot: ${botUserId})`);
      return hasMention;
    } catch (error) {
      logger.error(
        `Failed to check direct mention: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }

  /**
   * Check if channel is in the allowlist
   */
  private isChannelAllowed(channel: string): boolean {
    if (!this.config.channel_allowlist || this.config.channel_allowlist.length === 0) {
      // No allowlist configured, allow all channels
      return true;
    }

    // Check if channel matches any pattern in allowlist
    for (const pattern of this.config.channel_allowlist) {
      // Support wildcard patterns like "CENG*"
      const regexPattern = pattern.replace(/\*/g, '.*');
      const regex = new RegExp(`^${regexPattern}$`, 'i');
      if (regex.test(channel)) {
        return true;
      }
    }

    logger.debug(`Channel ${channel} not in allowlist`);
    return false;
  }

  /**
   * Handle incoming Slack webhook request
   */
  async handleWebhook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      // Only accept POST requests
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('Method Not Allowed');
        return;
      }

      // Parse request body
      const rawBody = await this.parseRequestBody(req);

      // Verify signature
      const timestamp = req.headers['x-slack-request-timestamp'] as string;
      const signature = req.headers['x-slack-signature'] as string;

      if (!timestamp || !signature) {
        logger.warn('Slack request missing signature headers');
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('Unauthorized');
        return;
      }

      if (!this.verifySignature(rawBody, timestamp, signature)) {
        logger.warn('Slack request signature verification failed');
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('Unauthorized');
        return;
      }

      // Parse event payload
      let event: SlackEvent;
      try {
        event = JSON.parse(rawBody);
      } catch {
        logger.error('Failed to parse Slack event payload');
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request');
        return;
      }

      // Handle URL verification challenge
      if (event.type === 'url_verification') {
        logger.info('Handling Slack URL verification challenge');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(event.challenge);
        return;
      }

      // Handle event callback
      if (event.type === 'event_callback' && event.event) {
        const innerEvent = event.event;

        // Filter event types - only process app_mention and message events
        if (innerEvent.type !== 'app_mention' && innerEvent.type !== 'message') {
          logger.debug(`Ignoring event type: ${innerEvent.type}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ignored' }));
          return;
        }

        // Check for required fields
        if (!innerEvent.channel || !innerEvent.text || !innerEvent.ts) {
          logger.warn('Slack event missing required fields');
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Bad Request');
          return;
        }

        // Check channel allowlist
        if (!this.isChannelAllowed(innerEvent.channel)) {
          logger.info(`Channel ${innerEvent.channel} not in allowlist, ignoring event`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ignored' }));
          return;
        }

        // Check for direct mention
        const isDirect = await this.isDirectMention(innerEvent.text, innerEvent.user);
        if (!isDirect) {
          logger.debug('Message does not contain direct mention, ignoring');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ignored' }));
          return;
        }

        // Rate limiting check
        if (this.rateLimiter) {
          const rateLimitResult = await this.rateLimiter.check({
            botId: this.botId,
            userId: innerEvent.user || 'unknown',
            channelId: innerEvent.channel,
            timestamp: event.event_time ? event.event_time * 1000 : Date.now(),
          });

          if (!rateLimitResult.allowed) {
            logger.warn(
              `Request rate limited: bot=${this.botId}, user=${innerEvent.user}, channel=${innerEvent.channel}, blocked_by=${rateLimitResult.blocked_by}, limit=${rateLimitResult.limit}, remaining=${rateLimitResult.remaining}, reset=${rateLimitResult.reset}`
            );

            // Send ephemeral message to user if configured
            const ephemeralConfig = this.rateLimiter.getEphemeralMessageConfig();
            if (ephemeralConfig.enabled && innerEvent.user) {
              try {
                await this.slackClient.postEphemeralMessage(
                  innerEvent.channel,
                  innerEvent.user,
                  ephemeralConfig.message,
                  innerEvent.thread_ts || innerEvent.ts
                );
              } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                logger.error(`Failed to send rate limit ephemeral message: ${errorMsg}`);
              }
            }

            // Return 429 Too Many Requests with rate limit headers
            res.writeHead(429, {
              'Content-Type': 'application/json',
              'X-RateLimit-Limit': rateLimitResult.limit?.toString() || '',
              'X-RateLimit-Remaining': rateLimitResult.remaining?.toString() || '0',
              'X-RateLimit-Reset': rateLimitResult.reset?.toString() || '',
              'Retry-After': rateLimitResult.retry_after?.toString() || '60',
            });
            res.end(
              JSON.stringify({
                status: 'rate_limited',
                message: 'Too many requests',
                retry_after: rateLimitResult.retry_after,
              })
            );
            return;
          }
        }

        // Deduplication check
        const eventId = event.event_id || innerEvent.event_ts || innerEvent.ts;
        if (this.processedEventIds.has(eventId)) {
          logger.debug(`Event ${eventId} already processed, ignoring duplicate`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'duplicate' }));
          return;
        }

        // Mark as processed
        this.processedEventIds.add(eventId);

        // Clean up old event IDs (keep last 1000)
        if (this.processedEventIds.size > 1000) {
          const toDelete = Array.from(this.processedEventIds).slice(0, 100);
          toDelete.forEach(id => this.processedEventIds.delete(id));
        }

        // Determine thread timestamp
        const threadTs = innerEvent.thread_ts || innerEvent.ts;

        // Create work item for async processing
        const workItem: SlackWorkItem = {
          eventId,
          eventType: innerEvent.type,
          channel: innerEvent.channel,
          threadTs,
          messageTs: innerEvent.ts,
          userId: innerEvent.user || 'unknown',
          text: innerEvent.text,
          timestamp: event.event_time || Date.now() / 1000,
          // Store rate limit request for releasing concurrent slots later
          rateLimitRequest: this.rateLimiter
            ? {
                botId: this.botId,
                userId: innerEvent.user || 'unknown',
                channelId: innerEvent.channel,
              }
            : undefined,
        };

        // Enqueue work item
        this.workQueue.push(workItem);

        logger.info(
          `Enqueued Slack event ${eventId} for processing (channel: ${innerEvent.channel}, thread: ${threadTs})`
        );

        // Submit work to worker pool
        const submitted = this.submitWorkToPool(workItem);

        if (!submitted) {
          // Queue is full, respond with 503 Service Unavailable
          // Slack will retry based on its retry policy
          logger.warn(`Work queue is full, rejecting event ${eventId}`);
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ status: 'busy', message: 'Server is busy, please try again later' })
          );
          return;
        }

        // Respond with 200 OK within 1 second (Slack requirement)
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'accepted' }));

        return;
      }

      // Unknown event type
      logger.warn(`Unknown Slack event type: ${event.type}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ignored' }));
    } catch (error) {
      logger.error(
        `Error handling Slack webhook: ${error instanceof Error ? error.message : String(error)}`
      );

      // Return 500 for errors (Slack will retry)
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  }

  /**
   * Submit work item to worker pool
   */
  private submitWorkToPool(workItem: SlackWorkItem): boolean {
    // Process work item asynchronously through the pool
    this.processWorkItemAsync(workItem).catch(error => {
      logger.error(
        `Failed to prepare work item ${workItem.eventId}: ${error instanceof Error ? error.message : String(error)}`
      );
    });

    return true; // Always return true since we process async
  }

  /**
   * Process work item asynchronously (prepare and submit to pool)
   */
  private async processWorkItemAsync(workItem: SlackWorkItem): Promise<void> {
    try {
      logger.info(`Processing work item ${workItem.eventId}...`);

      // Add "eyes" reaction to indicate processing started
      await this.slackClient.addReaction(workItem.channel, workItem.messageTs, 'eyes');

      // Fetch conversation context using adapter (cache-first approach)
      const conversation = await this.slackAdapter.fetchConversation(
        workItem.channel,
        workItem.threadTs,
        {
          ts: workItem.messageTs,
          user: workItem.userId,
          text: workItem.text,
          timestamp: workItem.timestamp,
        }
      );

      // Store conversation context in work item for workflow execution
      workItem.conversation = conversation;

      logger.info(
        `Fetched conversation context for thread ${conversation.thread.id} with ${conversation.messages.length} messages`
      );
      logger.debug(
        `Cache stats: ${JSON.stringify(this.slackAdapter.getCacheStats())} (hit rate: ${this.slackAdapter.getCacheHitRate().toFixed(2)}%)`
      );

      // Check if this thread is waiting for human input
      const promptState = getPromptStateManager();
      const waitingInfo = promptState.getWaiting(conversation.thread.id);

      if (waitingInfo) {
        logger.info(
          `Thread ${conversation.thread.id} is waiting for input (check: ${waitingInfo.checkName})`
        );
        logger.info(
          `User responded with: "${workItem.text.substring(0, 50)}..." - will resume workflow`
        );
      }

      // Create bot session context from conversation
      const botSession: BotSessionContext = {
        id: conversation.thread.id,
        botId: this.botId,
        transport: 'slack',
        currentMessage: conversation.current,
        history: conversation.messages,
        attributes: conversation.attributes,
        state: {
          channel: workItem.channel,
          threadTs: workItem.threadTs,
          eventId: workItem.eventId,
        },
      };

      // Determine which workflow to run
      // Use bot-specific workflow if configured, otherwise use the first workflow/check
      let workflowName = this.config.workflow;
      if (!workflowName) {
        workflowName = Object.keys(this.visorConfig.checks || {})[0];
      }
      if (!workflowName) {
        throw new Error(`Bot ${this.botId}: No workflows defined in configuration`);
      }

      logger.info(`Submitting workflow ${workflowName} to worker pool for execution`);

      // Create workflow execution request
      const executionRequest: WorkflowExecutionRequest = {
        id: workItem.eventId,
        workflowName,
        config: this.visorConfig,
        botContext: botSession,
      };

      // Submit to worker pool
      const submitted = this.workerPool.submitWork({
        id: workItem.eventId,
        data: executionRequest,
      });

      if (!submitted) {
        // Queue is full, handle backpressure
        logger.warn(`Worker pool queue is full, cannot submit work item ${workItem.eventId}`);

        // Update reaction to indicate error
        await this.slackClient.removeReaction(workItem.channel, workItem.messageTs, 'eyes');
        await this.slackClient.addReaction(workItem.channel, workItem.messageTs, 'x');

        // Post error message
        const errorText =
          this.config.response?.fallback ||
          'Sorry, the bot is currently busy. Please try again later.';
        await this.slackClient.postMessage(workItem.channel, errorText, workItem.threadTs);

        return;
      }

      // Listen for completion
      const completionHandler = async (result: any) => {
        if (result.workItemId === workItem.eventId) {
          this.workerPool.off('workCompleted', completionHandler);
          this.workerPool.off('workFailed', failureHandler);

          try {
            await this.handleWorkflowCompletion(workItem, result);
          } catch (error) {
            logger.error(
              `Failed to handle workflow completion for ${workItem.eventId}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
      };

      const failureHandler = async (result: any) => {
        if (result.workItemId === workItem.eventId) {
          this.workerPool.off('workCompleted', completionHandler);
          this.workerPool.off('workFailed', failureHandler);

          try {
            await this.handleWorkflowFailure(workItem, result);
          } catch (error) {
            logger.error(
              `Failed to handle workflow failure for ${workItem.eventId}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
      };

      this.workerPool.on('workCompleted', completionHandler);
      this.workerPool.on('workFailed', failureHandler);
    } catch (error) {
      logger.error(
        `Failed to process work item ${workItem.eventId}: ${error instanceof Error ? error.message : String(error)}`
      );

      // Try to indicate error with reaction
      try {
        await this.slackClient.removeReaction(workItem.channel, workItem.messageTs, 'eyes');
        await this.slackClient.addReaction(workItem.channel, workItem.messageTs, 'x');
      } catch {
        logger.error('Failed to add error reaction');
      }

      // Post error message if configured
      if (this.config.response?.fallback) {
        try {
          await this.slackClient.postMessage(
            workItem.channel,
            this.config.response.fallback,
            workItem.threadTs
          );
        } catch {
          logger.error('Failed to post error message');
        }
      }
    }
  }

  /**
   * Handle successful workflow completion
   */
  private async handleWorkflowCompletion(workItem: SlackWorkItem, result: any): Promise<void> {
    try {
      logger.info(`Workflow completed successfully for ${workItem.eventId}`);

      // Update reaction to success
      await this.slackClient.removeReaction(workItem.channel, workItem.messageTs, 'eyes');
      await this.slackClient.addReaction(workItem.channel, workItem.messageTs, 'white_check_mark');

      // Post response with workflow results
      const responseText = result.result?.slackOutput || 'Workflow completed successfully!';
      const response = await this.slackClient.postMessage(
        workItem.channel,
        responseText,
        workItem.threadTs
      );

      // Update cache with bot response
      if (workItem.conversation) {
        this.slackAdapter.updateCache(workItem.channel, workItem.threadTs, {
          role: 'bot',
          text: responseText,
          timestamp: response.ts,
          origin: 'visor',
        });
      }
    } finally {
      // Release rate limit concurrent slot
      if (this.rateLimiter && workItem.rateLimitRequest) {
        await this.rateLimiter.release(workItem.rateLimitRequest);
      }
    }
  }

  /**
   * Handle workflow failure
   */
  private async handleWorkflowFailure(workItem: SlackWorkItem, result: any): Promise<void> {
    try {
      logger.error(`Workflow failed for ${workItem.eventId}: ${result.error || 'Unknown error'}`);

      // Update reaction to failure
      await this.slackClient.removeReaction(workItem.channel, workItem.messageTs, 'eyes');
      await this.slackClient.addReaction(workItem.channel, workItem.messageTs, 'x');

      // Post error message
      const errorText =
        result.result?.slackOutput ||
        this.config.response?.fallback ||
        'Workflow execution failed. Please check the logs for details.';
      await this.slackClient.postMessage(workItem.channel, errorText, workItem.threadTs);
    } finally {
      // Release rate limit concurrent slot
      if (this.rateLimiter && workItem.rateLimitRequest) {
        await this.rateLimiter.release(workItem.rateLimitRequest);
      }
    }
  }

  /**
   * Get work queue for testing/debugging
   */
  getWorkQueue(): SlackWorkItem[] {
    return [...this.workQueue];
  }

  /**
   * Clear work queue for testing/debugging
   */
  clearWorkQueue(): void {
    this.workQueue = [];
  }

  /**
   * Get Slack client instance
   */
  getClient(): SlackClient {
    return this.slackClient;
  }

  /**
   * Get Slack adapter instance
   */
  getAdapter(): SlackAdapter {
    return this.slackAdapter;
  }

  /**
   * Set Slack adapter instance (used for Redis persistence initialization)
   */
  setAdapter(adapter: SlackAdapter): void {
    this.slackAdapter = adapter;
  }

  /**
   * Get worker pool statistics
   */
  getWorkerPoolStatus() {
    return this.workerPool.getStatus();
  }

  /**
   * Gracefully shutdown the handler and worker pool
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down Slack webhook handler...');
    await this.workerPool.shutdown();
    logger.info('Slack webhook handler shutdown complete');
  }
}

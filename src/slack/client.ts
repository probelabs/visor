// Lightweight Slack Web API wrapper implemented with fetch (no external deps).
// Only methods needed by SlackFrontend are implemented.

export class SlackClient {
  private token: string;

  constructor(botToken: string) {
    if (!botToken || typeof botToken !== 'string') {
      throw new Error('SlackClient: botToken is required');
    }
    this.token = botToken;
  }

  public readonly reactions = {
    add: async ({
      channel,
      timestamp,
      name,
    }: {
      channel: string;
      timestamp: string;
      name: string;
    }) => {
      const resp: any = await this.api('reactions.add', { channel, timestamp, name });
      if (!resp || resp.ok !== true) {
        // Non-fatal in CLI/test runs – log and continue
        const err = (resp && resp.error) || 'unknown_error';
        console.warn(`Slack reactions.add failed (non-fatal): ${err}`);
        return { ok: false as const };
      }
      return { ok: true } as const;
    },
    remove: async ({
      channel,
      timestamp,
      name,
    }: {
      channel: string;
      timestamp: string;
      name: string;
    }) => {
      const resp: any = await this.api('reactions.remove', { channel, timestamp, name });
      if (!resp || resp.ok !== true) {
        const err = (resp && resp.error) || 'unknown_error';
        console.warn(`Slack reactions.remove failed (non-fatal): ${err}`);
        return { ok: false as const };
      }
      return { ok: true } as const;
    },
  };

  public readonly chat = {
    postMessage: async ({
      channel,
      text,
      thread_ts,
    }: {
      channel: string;
      text: string;
      thread_ts?: string;
    }) => {
      try {
        const resp: any = await this.api('chat.postMessage', { channel, text, thread_ts });
        if (!resp || resp.ok !== true) {
          const err = (resp && resp.error) || 'unknown_error';
          const warnings = Array.isArray(resp?.response_metadata?.warnings)
            ? resp.response_metadata.warnings.join(',')
            : '';
          console.warn(
            `Slack chat.postMessage failed (non-fatal): error=${err} channel=${channel} thread_ts=${
              thread_ts || '-'
            } text_len=${text.length}${warnings ? ` warnings=${warnings}` : ''}`
          );
          return {
            ok: false as const,
            ts: undefined,
            message: undefined,
            data: resp,
            error: err,
          };
        }
        // Normalize common fields for tests/frontend
        return {
          ok: true as const,
          ts: resp.ts || (resp.message && resp.message.ts) || undefined,
          message: resp.message,
          data: resp,
          error: undefined,
        };
      } catch (e) {
        console.warn(
          `Slack chat.postMessage threw (non-fatal): channel=${channel} thread_ts=${thread_ts || '-'} text_len=${
            text.length
          } error=${e instanceof Error ? e.message : String(e)}`
        );
        return {
          ok: false as const,
          ts: undefined,
          message: undefined,
          data: undefined,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    },
    update: async ({ channel, ts, text }: { channel: string; ts: string; text: string }) => {
      try {
        const resp: any = await this.api('chat.update', { channel, ts, text });
        if (!resp || resp.ok !== true) {
          const err = (resp && resp.error) || 'unknown_error';
          const warnings = Array.isArray(resp?.response_metadata?.warnings)
            ? resp.response_metadata.warnings.join(',')
            : '';
          console.warn(
            `Slack chat.update failed (non-fatal): error=${err} channel=${channel} ts=${ts} text_len=${
              text.length
            }${warnings ? ` warnings=${warnings}` : ''}`
          );
          return { ok: false as const, ts, error: err, data: resp };
        }
        return { ok: true as const, ts: resp.ts || ts, error: undefined, data: resp };
      } catch (e) {
        console.warn(
          `Slack chat.update threw (non-fatal): channel=${channel} ts=${ts} text_len=${text.length} error=${
            e instanceof Error ? e.message : String(e)
          }`
        );
        return {
          ok: false as const,
          ts,
          error: e instanceof Error ? e.message : String(e),
          data: undefined,
        };
      }
    },
  };

  async getBotUserId(): Promise<string> {
    const resp: any = await this.api('auth.test', {});
    if (!resp || resp.ok !== true || !resp.user_id) {
      console.warn('Slack auth.test failed (non-fatal); bot user id unavailable');
      return 'UNKNOWN_BOT';
    }
    return String(resp.user_id);
  }

  /**
   * Fetch user info from Slack API.
   * Returns user profile including guest status flags, email, display name, and timezone.
   */
  async getUserInfo(userId: string): Promise<{
    ok: boolean;
    user?: {
      id: string;
      name?: string; // username
      real_name?: string; // full name
      email?: string; // requires users:read.email scope
      is_restricted?: boolean; // Multi-channel guest
      is_ultra_restricted?: boolean; // Single-channel guest
      is_bot?: boolean;
      is_app_user?: boolean;
      deleted?: boolean;
      tz?: string; // IANA timezone (e.g., "America/New_York")
      tz_offset?: number; // Timezone offset in seconds from UTC
    };
  }> {
    try {
      const resp: any = await this.api('users.info', { user: userId });
      if (!resp || resp.ok !== true || !resp.user) {
        return { ok: false };
      }
      return {
        ok: true,
        user: {
          id: resp.user.id,
          name: resp.user.name,
          real_name: resp.user.real_name || resp.user.profile?.real_name,
          email: resp.user.profile?.email,
          is_restricted: resp.user.is_restricted,
          is_ultra_restricted: resp.user.is_ultra_restricted,
          is_bot: resp.user.is_bot,
          is_app_user: resp.user.is_app_user,
          deleted: resp.user.deleted,
          tz: resp.user.tz,
          tz_offset: resp.user.tz_offset,
        },
      };
    } catch (e) {
      console.warn(`Slack users.info failed: ${e instanceof Error ? e.message : String(e)}`);
      return { ok: false };
    }
  }

  /**
   * Open a DM channel with a user.
   * Returns the DM channel ID.
   */
  async openDM(userId: string): Promise<{ ok: boolean; channel?: string }> {
    try {
      const resp: any = await this.api('conversations.open', { users: userId });
      if (!resp || resp.ok !== true || !resp.channel?.id) {
        console.warn(`Slack conversations.open failed: ${resp?.error || 'unknown_error'}`);
        return { ok: false };
      }
      return { ok: true, channel: resp.channel.id };
    } catch (e) {
      console.warn(
        `Slack conversations.open failed: ${e instanceof Error ? e.message : String(e)}`
      );
      return { ok: false };
    }
  }

  async fetchThreadReplies(
    channel: string,
    thread_ts: string,
    limit: number = 40
  ): Promise<
    Array<{
      ts: string;
      user?: string;
      text?: string;
      bot_id?: string;
      thread_ts?: string;
      files?: any[];
    }>
  > {
    try {
      // Use query-string GET semantics similar to Slack WebClient to avoid
      // subtle JSON/form encoding issues that can cause invalid_arguments
      const params = new URLSearchParams({
        channel,
        ts: thread_ts,
        limit: String(limit),
      });
      const res = await fetch(`https://slack.com/api/conversations.replies?${params.toString()}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      });
      const resp: any = await res.json();
      if (!resp || resp.ok !== true || !Array.isArray(resp.messages)) {
        const err = (resp && resp.error) || 'unknown_error';
        console.warn(
          `Slack conversations.replies failed (non-fatal): ${err} (channel=${channel}, ts=${thread_ts}, limit=${limit})`
        );
        return [];
      }
      return resp.messages.map((m: any) => ({
        ts: String(m.ts || ''),
        user: m.user,
        text: m.text,
        bot_id: m.bot_id,
        thread_ts: m.thread_ts,
        files: Array.isArray(m.files) ? m.files : undefined,
      }));
    } catch (e) {
      console.warn(
        `Slack conversations.replies failed (non-fatal): ${
          e instanceof Error ? e.message : String(e)
        } (channel=${channel}, ts=${thread_ts}, limit=${limit})`
      );
      return [];
    }
  }

  public readonly files = {
    /**
     * Upload a file to Slack using files.uploadV2 API
     * @param options Upload options including file content, filename, channel, and thread_ts
     */
    uploadV2: async ({
      content,
      filename,
      channel,
      thread_ts,
      title,
      initial_comment,
    }: {
      content: Buffer;
      filename: string;
      channel: string;
      thread_ts?: string;
      title?: string;
      initial_comment?: string;
    }): Promise<{ ok: boolean; file?: { id: string; permalink?: string } }> => {
      try {
        // Step 1: Get upload URL (uses form-urlencoded — this endpoint rejects JSON bodies)
        const getUrlResp: any = await this.apiForm('files.getUploadURLExternal', {
          filename,
          length: String(content.length),
        });
        if (!getUrlResp || getUrlResp.ok !== true || !getUrlResp.upload_url) {
          console.warn(
            `Slack files.getUploadURLExternal failed: ${getUrlResp?.error || 'unknown'}`
          );
          return { ok: false };
        }

        // Step 2: Upload file content to the URL
        const uploadResp = await fetch(getUrlResp.upload_url, {
          method: 'POST',
          body: content,
        });
        if (!uploadResp.ok) {
          console.warn(`Slack file upload to URL failed: ${uploadResp.status}`);
          return { ok: false };
        }

        // Step 3: Complete the upload and share to channel
        const completeResp: any = await this.api('files.completeUploadExternal', {
          files: [{ id: getUrlResp.file_id, title: title || filename }],
          channel_id: channel,
          thread_ts,
          initial_comment,
        });
        if (!completeResp || completeResp.ok !== true) {
          console.warn(
            `Slack files.completeUploadExternal failed: ${completeResp?.error || 'unknown'}`
          );
          return { ok: false };
        }

        return {
          ok: true,
          file: completeResp.files?.[0] || { id: getUrlResp.file_id },
        };
      } catch (e) {
        console.warn(`Slack file upload failed: ${e instanceof Error ? e.message : String(e)}`);
        return { ok: false };
      }
    },
  };

  getWebClient(): any {
    return {
      conversations: {
        history: async ({ channel, limit }: { channel: string; limit?: number }) =>
          (await this.api('conversations.history', { channel, limit })) as any,
        open: async ({ users }: { users: string }) =>
          (await this.api('conversations.open', { users })) as any,
        replies: async ({ channel, ts, limit }: { channel: string; ts: string; limit?: number }) =>
          (await this.api('conversations.replies', { channel, ts, limit })) as any,
      },
    };
  }

  private async api(method: string, body: Record<string, unknown>): Promise<unknown> {
    // Node 18+ global fetch
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(body),
    });
    return (await res.json()) as unknown;
  }

  /** Send a Slack API request as application/x-www-form-urlencoded (required by some file methods). */
  private async apiForm(method: string, params: Record<string, string>): Promise<unknown> {
    const body = new URLSearchParams(params);
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${this.token}`,
      },
      body: body.toString(),
    });
    return (await res.json()) as unknown;
  }
}

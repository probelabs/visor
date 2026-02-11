import {
  extractTextFromJson,
  init_json_text_extractor
} from "./chunk-H5BOW5CR.mjs";
import {
  __esm
} from "./chunk-J7LXIPZS.mjs";

// src/tui/chat-state.ts
function getChatStateManager() {
  if (!globalStateManager) {
    globalStateManager = new ChatStateManager();
  }
  return globalStateManager;
}
var ChatStateManager, globalStateManager;
var init_chat_state = __esm({
  "src/tui/chat-state.ts"() {
    "use strict";
    ChatStateManager = class {
      _history = [];
      _isProcessing = false;
      _waitingState;
      _inputQueue = [];
      _maxMessages;
      _messageCounter = 0;
      _statusText = "Ready";
      constructor(options = {}) {
        this._maxMessages = options.maxMessages ?? 1e3;
      }
      get history() {
        return [...this._history];
      }
      get isProcessing() {
        return this._isProcessing;
      }
      get isWaiting() {
        return this._waitingState !== void 0;
      }
      get waitingState() {
        return this._waitingState;
      }
      get hasQueuedInput() {
        return this._inputQueue.length > 0;
      }
      get statusText() {
        return this._statusText;
      }
      setStatus(text) {
        this._statusText = text;
      }
      addMessage(role, content, checkId) {
        const message = {
          id: `msg-${++this._messageCounter}`,
          role,
          content,
          timestamp: /* @__PURE__ */ new Date(),
          checkId
        };
        this._history.push(message);
        while (this._history.length > this._maxMessages) {
          this._history.shift();
        }
        return message;
      }
      setProcessing(processing) {
        this._isProcessing = processing;
        if (processing) {
          this._statusText = "Processing...";
        } else if (!this._waitingState) {
          this._statusText = "Ready";
        }
      }
      setWaiting(state) {
        this._waitingState = state;
        if (state) {
          this._statusText = "Awaiting input...";
        } else if (!this._isProcessing) {
          this._statusText = "Ready";
        }
      }
      clearWaiting() {
        this._waitingState = void 0;
        if (!this._isProcessing) {
          this._statusText = "Ready";
        }
      }
      queueInput(input) {
        this._inputQueue.push(input);
      }
      dequeueInput() {
        return this._inputQueue.shift();
      }
      clearQueue() {
        this._inputQueue = [];
      }
      clearHistory() {
        this._history = [];
      }
      getRecentMessages(count) {
        return this._history.slice(-count);
      }
      formatMessageForDisplay(message) {
        const time = message.timestamp.toLocaleTimeString("en-US", {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit"
        });
        const content = this.escapeTags(message.content);
        if (message.role === "user") {
          const header2 = `{black-bg}{bold} > You {/bold}[${time}]{/black-bg}`;
          const body = content.split("\n").map((l) => `{black-bg} ${l} {/black-bg}`).join("\n");
          return `${header2}
${body}`;
        }
        if (message.role === "assistant") {
          const header2 = `{bold}{green-fg}\u25CF{/green-fg} Assistant{/bold} {gray-fg}[${time}]{/gray-fg}`;
          return `${header2}
${content}`;
        }
        const header = `{gray-fg}\u2298 Visor [${time}]`;
        return `${header}
${content}{/gray-fg}`;
      }
      escapeTags(text) {
        return text.replace(/\{/g, "\\{");
      }
      formatHistoryForDisplay() {
        if (this._history.length === 0) {
          return "{gray-fg}No messages yet. Type a message to start...{/gray-fg}";
        }
        const separator = "\n\n";
        return this._history.map((msg) => this.formatMessageForDisplay(msg)).join(separator);
      }
    };
  }
});

// src/tui/tui-frontend.ts
var TuiFrontend;
var init_tui_frontend = __esm({
  "src/tui/tui-frontend.ts"() {
    init_chat_state();
    init_json_text_extractor();
    TuiFrontend = class {
      name = "tui";
      subs = [];
      chatTui;
      constructor(config) {
        this.chatTui = config?.chatTui;
      }
      setChatTUI(tui) {
        this.chatTui = tui;
      }
      start(ctx) {
        const bus = ctx.eventBus;
        try {
          ctx.logger.info(`[tui-frontend] started; hasChatTui=${!!this.chatTui}`);
        } catch {
        }
        this.subs.push(
          bus.on("CheckCompleted", async (env) => {
            try {
              const ev = env && env.payload || env;
              this.handleCheckCompleted(ctx, ev.checkId, ev.result);
            } catch {
            }
          })
        );
        this.subs.push(
          bus.on("CheckErrored", async (env) => {
            const ev = env && env.payload || env;
            const message = ev?.error?.message || "Execution error";
            this.handleError(ctx, ev?.checkId, message);
          })
        );
        this.subs.push(
          bus.on("HumanInputRequested", async (env) => {
            const ev = env && env.payload || env;
            if (!ev || typeof ev.prompt !== "string" || !ev.checkId) return;
            this.handleHumanInputRequested(ctx, ev);
          })
        );
        this.subs.push(
          bus.on("StateTransition", async (env) => {
            const ev = env && env.payload || env;
            this.handleStateTransition(ctx, ev);
          })
        );
        this.subs.push(
          bus.on("Shutdown", async (env) => {
            const ev = env && env.payload || env;
            const message = ev?.error?.message || "Workflow completed";
            this.handleShutdown(ctx, message);
          })
        );
      }
      stop() {
        for (const s of this.subs) s.unsubscribe();
        this.subs = [];
      }
      handleCheckCompleted(ctx, checkId, result) {
        try {
          if (!this.chatTui) return;
          const cfg = ctx.config || {};
          const checkCfg = cfg.checks?.[checkId];
          if (!checkCfg) return;
          if (checkCfg.criticality === "internal") return;
          let text;
          const out = result?.output;
          if (out) {
            const extracted = extractTextFromJson(out);
            if (extracted) {
              text = extracted.trim();
            } else if (typeof out.text === "string" && out.text.trim()) {
              text = out.text.trim();
            } else if (typeof out === "string" && out.trim()) {
              text = out.trim();
            }
          }
          if (!text && typeof result?.content === "string" && result.content.trim()) {
            text = result.content.trim();
          }
          if (!text) {
            const logResult = result;
            if (typeof logResult?.logOutput === "string" && logResult.logOutput.trim()) {
              text = logResult.logOutput.trim();
            }
          }
          if (!text) return;
          this.chatTui.addAssistantMessage(text, checkId);
          try {
            ctx.logger.info(`[tui-frontend] displayed AI response for ${checkId}`);
          } catch {
          }
        } catch (err) {
          try {
            ctx.logger.warn(
              `[tui-frontend] handleCheckCompleted failed: ${err instanceof Error ? err.message : String(err)}`
            );
          } catch {
          }
        }
      }
      handleError(_ctx, checkId, message) {
        if (!this.chatTui) return;
        const errorText = checkId ? `[Error in ${checkId}] ${message}` : `[Error] ${message}`;
        this.chatTui.addSystemMessage(errorText);
        this.chatTui.setStatus("Error occurred");
      }
      handleHumanInputRequested(_ctx, ev) {
        if (!this.chatTui) return;
        const stateManager = getChatStateManager();
        stateManager.setWaiting({
          checkId: String(ev.checkId),
          prompt: String(ev.prompt),
          placeholder: ev.placeholder,
          multiline: ev.multiline,
          timeout: ev.timeout,
          defaultValue: ev.default,
          allowEmpty: ev.allowEmpty
        });
        this.chatTui.setWaiting(true, ev.prompt);
      }
      handleStateTransition(_ctx, ev) {
        if (!this.chatTui) return;
        const to = ev?.to;
        if (to === "Completed" || to === "Error") {
          this.chatTui.setProcessing(false);
          this.chatTui.setStatus(to === "Completed" ? "Workflow completed" : "Workflow failed");
        } else if (to === "Running" || to === "Executing") {
          this.chatTui.setProcessing(true);
          this.chatTui.setStatus("Processing...");
        } else if (to === "Waiting") {
        }
      }
      handleShutdown(_ctx, message) {
        if (!this.chatTui) return;
        this.chatTui.setProcessing(false);
        this.chatTui.setStatus(message);
      }
    };
  }
});
init_tui_frontend();
export {
  TuiFrontend
};
//# sourceMappingURL=tui-frontend-T56PZB67.mjs.map
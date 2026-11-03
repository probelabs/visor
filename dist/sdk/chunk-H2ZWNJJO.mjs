import {
  __esm
} from "./chunk-J7LXIPZS.mjs";

// src/agent-protocol/types.ts
var InvalidStateTransitionError, TaskNotFoundError, ContextMismatchError, InvalidRequestError, ParseError, A2ATimeoutError, A2ARequestError, A2AMaxTurnsExceededError, A2AInputRequiredError, A2AAuthRequiredError, A2ATaskFailedError, A2ATaskRejectedError, AgentCardFetchError, InvalidAgentCardError;
var init_types = __esm({
  "src/agent-protocol/types.ts"() {
    "use strict";
    InvalidStateTransitionError = class extends Error {
      constructor(fromState, toState, detail) {
        super(
          `Invalid state transition from '${fromState}' to '${toState}'${detail ? `: ${detail}` : ""}`
        );
        this.fromState = fromState;
        this.toState = toState;
        this.name = "InvalidStateTransitionError";
      }
      fromState;
      toState;
    };
    TaskNotFoundError = class extends Error {
      constructor(taskId) {
        super(`Task not found: ${taskId}`);
        this.taskId = taskId;
        this.name = "TaskNotFoundError";
      }
      taskId;
    };
    ContextMismatchError = class extends Error {
      constructor(providedContextId, existingContextId) {
        super(
          `Context ID mismatch: provided '${providedContextId}' but task belongs to '${existingContextId}'`
        );
        this.providedContextId = providedContextId;
        this.existingContextId = existingContextId;
        this.name = "ContextMismatchError";
      }
      providedContextId;
      existingContextId;
    };
    InvalidRequestError = class extends Error {
      constructor(message) {
        super(message);
        this.name = "InvalidRequestError";
      }
    };
    ParseError = class extends Error {
      constructor(message) {
        super(message);
        this.name = "ParseError";
      }
    };
    A2ATimeoutError = class extends Error {
      constructor(taskId, timeoutMs) {
        super(`A2A task ${taskId} timed out after ${timeoutMs}ms`);
        this.taskId = taskId;
        this.timeoutMs = timeoutMs;
        this.name = "A2ATimeoutError";
      }
      taskId;
      timeoutMs;
    };
    A2ARequestError = class extends Error {
      constructor(url, statusCode, body) {
        super(`A2A request to ${url} failed with status ${statusCode}: ${body}`);
        this.url = url;
        this.statusCode = statusCode;
        this.body = body;
        this.name = "A2ARequestError";
      }
      url;
      statusCode;
      body;
    };
    A2AMaxTurnsExceededError = class extends Error {
      constructor(taskId, maxTurns) {
        super(`A2A task ${taskId} exceeded max turns (${maxTurns})`);
        this.taskId = taskId;
        this.maxTurns = maxTurns;
        this.name = "A2AMaxTurnsExceededError";
      }
      taskId;
      maxTurns;
    };
    A2AInputRequiredError = class extends Error {
      constructor(taskId, prompt) {
        super(`A2A task ${taskId} requires input: ${prompt}`);
        this.taskId = taskId;
        this.prompt = prompt;
        this.name = "A2AInputRequiredError";
      }
      taskId;
      prompt;
    };
    A2AAuthRequiredError = class extends Error {
      constructor(taskId) {
        super(`A2A task ${taskId} requires authentication`);
        this.taskId = taskId;
        this.name = "A2AAuthRequiredError";
      }
      taskId;
    };
    A2ATaskFailedError = class extends Error {
      constructor(taskId, detail) {
        super(`A2A task ${taskId} failed: ${detail}`);
        this.taskId = taskId;
        this.detail = detail;
        this.name = "A2ATaskFailedError";
      }
      taskId;
      detail;
    };
    A2ATaskRejectedError = class extends Error {
      constructor(taskId, state) {
        super(`A2A task ${taskId} was ${state}`);
        this.taskId = taskId;
        this.state = state;
        this.name = "A2ATaskRejectedError";
      }
      taskId;
      state;
    };
    AgentCardFetchError = class extends Error {
      constructor(url, statusCode, statusText) {
        super(`Failed to fetch Agent Card from ${url}: ${statusCode} ${statusText}`);
        this.url = url;
        this.statusCode = statusCode;
        this.statusText = statusText;
        this.name = "AgentCardFetchError";
      }
      url;
      statusCode;
      statusText;
    };
    InvalidAgentCardError = class extends Error {
      constructor(url, detail) {
        super(`Invalid Agent Card from ${url}: ${detail}`);
        this.url = url;
        this.detail = detail;
        this.name = "InvalidAgentCardError";
      }
      url;
      detail;
    };
  }
});

// src/agent-protocol/state-transitions.ts
function assertValidTransition(from, to) {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new InvalidStateTransitionError(from, to);
  }
}
function isTerminalState(state) {
  return TERMINAL_STATES.has(state);
}
var VALID_TRANSITIONS, TERMINAL_STATES;
var init_state_transitions = __esm({
  "src/agent-protocol/state-transitions.ts"() {
    "use strict";
    init_types();
    VALID_TRANSITIONS = {
      submitted: ["working", "canceled", "rejected"],
      working: ["completed", "failed", "canceled", "input_required", "auth_required"],
      input_required: ["working", "canceled", "failed"],
      auth_required: ["working", "canceled", "failed"],
      // Terminal states: no outgoing transitions
      completed: [],
      failed: [],
      canceled: [],
      rejected: []
    };
    TERMINAL_STATES = /* @__PURE__ */ new Set([
      "completed",
      "failed",
      "canceled",
      "rejected"
    ]);
  }
});

export {
  InvalidStateTransitionError,
  TaskNotFoundError,
  ContextMismatchError,
  InvalidRequestError,
  ParseError,
  A2ATimeoutError,
  A2ARequestError,
  A2AMaxTurnsExceededError,
  A2AInputRequiredError,
  A2AAuthRequiredError,
  A2ATaskFailedError,
  A2ATaskRejectedError,
  AgentCardFetchError,
  InvalidAgentCardError,
  init_types,
  assertValidTransition,
  isTerminalState,
  init_state_transitions
};
//# sourceMappingURL=chunk-H2ZWNJJO.mjs.map
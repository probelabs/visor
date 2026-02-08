/**
 * TUI Module - Persistent Chat Interface
 *
 * Exports all TUI-related components for use in CLI and other entry points.
 */

// Main TUI class
export { ChatTUI, type ChatTUIOptions } from './chat-tui';

// State management
export {
  ChatStateManager,
  type ChatMessage,
  type WaitingState,
  type ChatStateManagerOptions,
  getChatStateManager,
  setChatStateManager,
  resetChatStateManager,
} from './chat-state';

// Chat runner (message loop)
export { TuiChatRunner, type TuiChatRunnerConfig, startChatTUI } from './chat-runner';

// TUI Frontend (EventBus integration)
export { TuiFrontend, type TuiFrontendConfig } from './tui-frontend';

// UI Components
export { ChatBox, type ChatBoxOptions } from './components/chat-box';
export { InputBar, type InputBarOptions } from './components/input-bar';
export { StatusBar, type StatusBarOptions, type StatusMode } from './components/status-bar';

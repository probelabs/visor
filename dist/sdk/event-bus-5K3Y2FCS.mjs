import {
  __esm
} from "./chunk-J7LXIPZS.mjs";

// src/event-bus/event-bus.ts
var EventBus;
var init_event_bus = __esm({
  "src/event-bus/event-bus.ts"() {
    EventBus = class {
      handlers = /* @__PURE__ */ new Map();
      anyHandlers = /* @__PURE__ */ new Set();
      on(eventType, handler) {
        const set = this.handlers.get(eventType) || /* @__PURE__ */ new Set();
        set.add(handler);
        this.handlers.set(eventType, set);
        return {
          unsubscribe: () => {
            set.delete(handler);
          }
        };
      }
      onAny(handler) {
        this.anyHandlers.add(handler);
        return { unsubscribe: () => this.anyHandlers.delete(handler) };
      }
      async emit(event) {
        const type = event?.payload?.type ?? event?.type ?? "unknown";
        const list = [
          ...Array.from(this.anyHandlers),
          ...Array.from(this.handlers.get(type) || [])
        ];
        for (const h of list) {
          await h(event);
        }
      }
    };
  }
});
init_event_bus();
export {
  EventBus
};
//# sourceMappingURL=event-bus-5K3Y2FCS.mjs.map
import {
  __esm
} from "./chunk-J7LXIPZS.mjs";

// src/utils/json-text-extractor.ts
function extractTextFieldFromMalformedJson(content) {
  const fieldPatterns = [
    /^\s*\{\s*"text"\s*:\s*"/i,
    /^\s*\{\s*"response"\s*:\s*"/i,
    /^\s*\{\s*"message"\s*:\s*"/i
  ];
  for (const pattern of fieldPatterns) {
    const match = pattern.exec(content);
    if (match) {
      const valueStart = match[0].length;
      const remaining = content.substring(valueStart);
      let value = "";
      let i = 0;
      while (i < remaining.length) {
        const char = remaining[i];
        if (char === "\\" && i + 1 < remaining.length) {
          const nextChar = remaining[i + 1];
          if (nextChar === "n") {
            value += "\n";
          } else if (nextChar === "r") {
            value += "\r";
          } else if (nextChar === "t") {
            value += "	";
          } else if (nextChar === '"') {
            value += '"';
          } else if (nextChar === "\\") {
            value += "\\";
          } else {
            value += char + nextChar;
          }
          i += 2;
        } else if (char === '"') {
          break;
        } else {
          value += char;
          i++;
        }
      }
      if (value.trim().length > 0) {
        return value.trim();
      }
    }
  }
  return void 0;
}
function extractTextFromJson(content) {
  if (content === void 0 || content === null) return void 0;
  let parsed = content;
  if (typeof content === "string") {
    const trimmed = content.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      return trimmed.length > 0 ? trimmed : void 0;
    }
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      const extracted = extractTextFieldFromMalformedJson(trimmed);
      if (extracted) {
        return extracted;
      }
      return trimmed.length > 0 ? trimmed : void 0;
    }
  }
  if (parsed && typeof parsed === "object") {
    const txt = parsed.text || parsed.response || parsed.message;
    if (typeof txt === "string" && txt.trim()) {
      return txt.trim();
    }
  }
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : void 0;
  }
  return void 0;
}
var init_json_text_extractor = __esm({
  "src/utils/json-text-extractor.ts"() {
    "use strict";
  }
});

export {
  extractTextFromJson,
  init_json_text_extractor
};
//# sourceMappingURL=chunk-H5BOW5CR.mjs.map
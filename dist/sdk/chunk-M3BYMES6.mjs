import {
  __esm
} from "./chunk-J7LXIPZS.mjs";

// src/slack/markdown.ts
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
function extractMermaidDiagrams(text) {
  const diagrams = [];
  const regex = /```mermaid\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    diagrams.push({
      fullMatch: match[0],
      code: match[1].trim(),
      startIndex: match.index,
      endIndex: match.index + match[0].length
    });
  }
  return diagrams;
}
async function renderMermaidToPng(mermaidCode) {
  const tmpDir = os.tmpdir();
  const inputFile = path.join(
    tmpDir,
    `mermaid-${Date.now()}-${Math.random().toString(36).slice(2)}.mmd`
  );
  const outputFile = path.join(
    tmpDir,
    `mermaid-${Date.now()}-${Math.random().toString(36).slice(2)}.png`
  );
  try {
    fs.writeFileSync(inputFile, mermaidCode, "utf-8");
    const chromiumPaths = [
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome",
      "/usr/bin/chrome"
    ];
    let chromiumPath;
    for (const p of chromiumPaths) {
      if (fs.existsSync(p)) {
        chromiumPath = p;
        break;
      }
    }
    const env = { ...process.env };
    if (chromiumPath) {
      env.PUPPETEER_EXECUTABLE_PATH = chromiumPath;
    }
    const result = await new Promise((resolve) => {
      const proc = spawn(
        "npx",
        [
          "--yes",
          "@mermaid-js/mermaid-cli",
          "-i",
          inputFile,
          "-o",
          outputFile,
          "-e",
          "png",
          "-b",
          "white",
          "-w",
          "1200"
        ],
        {
          timeout: 6e4,
          // 60 second timeout (first run may download packages)
          stdio: ["pipe", "pipe", "pipe"],
          env
        }
      );
      let stderr = "";
      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });
      proc.on("close", (code) => {
        if (code === 0) {
          resolve({ success: true });
        } else {
          resolve({ success: false, error: stderr || `Exit code ${code}` });
        }
      });
      proc.on("error", (err) => {
        resolve({ success: false, error: err.message });
      });
    });
    if (!result.success) {
      console.warn(`Mermaid rendering failed: ${result.error}`);
      return null;
    }
    if (!fs.existsSync(outputFile)) {
      console.warn("Mermaid output file not created");
      return null;
    }
    const pngBuffer = fs.readFileSync(outputFile);
    return pngBuffer;
  } catch (e) {
    console.warn(`Mermaid rendering error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  } finally {
    try {
      if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile);
      if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
    } catch {
    }
  }
}
function replaceMermaidBlocks(text, diagrams, replacement = "_(See diagram above)_") {
  if (diagrams.length === 0) return text;
  const sorted = [...diagrams].sort((a, b) => b.startIndex - a.startIndex);
  let result = text;
  sorted.forEach((diagram, sortedIndex) => {
    const originalIndex = diagrams.length - 1 - sortedIndex;
    const rep = typeof replacement === "function" ? replacement(originalIndex) : replacement;
    result = result.slice(0, diagram.startIndex) + rep + result.slice(diagram.endIndex);
  });
  return result;
}
function markdownToSlack(text) {
  if (!text || typeof text !== "string") return "";
  let out = text;
  out = out.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_m, alt, url) => `<${url}|${alt || "image"}>`
  );
  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_m, label, url) => `<${url}|${label}>`
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, inner) => `*${inner}*`);
  out = out.replace(/__([^_]+)__/g, (_m, inner) => `*${inner}*`);
  const lines = out.split(/\r?\n/);
  let inCodeBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (/^```/.test(trimmed)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;
    const headerMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (headerMatch) {
      const [, hashes, headerText] = headerMatch;
      const prevLine = i > 0 ? lines[i - 1].trim() : "";
      const prevIsHeaderOrFence = /^#{1,6}\s+/.test(prevLine) || /^\*[^*]+\*$/.test(prevLine) || /^```/.test(prevLine);
      if (hashes.length <= 2 && i > 0 && prevLine !== "" && !prevIsHeaderOrFence) {
        lines[i] = `
*${headerText.trim()}*`;
      } else {
        lines[i] = `*${headerText.trim()}*`;
      }
      continue;
    }
    const bulletMatch = /^(\s*)([-*])\s+(.+)$/.exec(line);
    if (bulletMatch) {
      const [, indent, , rest] = bulletMatch;
      lines[i] = `${indent}\u2022 ${rest}`;
    }
  }
  out = lines.join("\n");
  return out;
}
function extractFileSections(text) {
  const sections = [];
  const delimRegex = /^--- ([\w][\w.\-]*\.\w+) ---$/gm;
  const delimiters = [];
  let m;
  while ((m = delimRegex.exec(text)) !== null) {
    delimiters.push({
      filename: m[1],
      start: m.index,
      end: m.index + m[0].length
    });
  }
  if (delimiters.length === 0) return sections;
  for (let i = 0; i < delimiters.length; i++) {
    const open = delimiters[i];
    const contentStart = open.end < text.length && text[open.end] === "\n" ? open.end + 1 : open.end;
    const sectionEnd = i + 1 < delimiters.length ? delimiters[i + 1].start : text.length;
    const content = text.substring(contentStart, sectionEnd).trim();
    if (content.length > 0) {
      sections.push({
        fullMatch: text.substring(open.start, sectionEnd),
        filename: open.filename,
        content,
        startIndex: open.start,
        endIndex: sectionEnd
      });
    }
  }
  return sections;
}
function replaceFileSections(text, sections, replacement = (idx) => `_(See file: ${sections[idx].filename} above)_`) {
  if (sections.length === 0) return text;
  const sorted = [...sections].sort((a, b) => b.startIndex - a.startIndex);
  let result = text;
  sorted.forEach((section, sortedIndex) => {
    const originalIndex = sections.length - 1 - sortedIndex;
    const rep = typeof replacement === "function" ? replacement(originalIndex) : replacement;
    result = result.slice(0, section.startIndex) + rep + result.slice(section.endIndex);
  });
  return result;
}
function formatSlackText(text) {
  return markdownToSlack(text);
}
var init_markdown = __esm({
  "src/slack/markdown.ts"() {
    "use strict";
  }
});

export {
  extractMermaidDiagrams,
  renderMermaidToPng,
  replaceMermaidBlocks,
  extractFileSections,
  replaceFileSections,
  formatSlackText,
  init_markdown
};
//# sourceMappingURL=chunk-M3BYMES6.mjs.map
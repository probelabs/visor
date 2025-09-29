#!/usr/bin/env node
/*
 Validates README.md internal anchors (Table of Contents) and doc links.
 - Checks that all (#anchor) links map to existing headings
 - Checks that all docs/*.md links point to existing files
 - Warns about docs/*.md files not referenced from README
 - Exits with non‑zero code if errors are found
*/
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const README = path.join(ROOT, 'README.md');
const DOCS_DIR = path.join(ROOT, 'docs');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

// Minimal GitHub‑like slugger. Handles duplicates with numeric suffixes.
function makeSlugger() {
  const seen = new Map();
  return function slugify(raw) {
    // Remove Markdown emphasis/backticks and emoji
    let text = String(raw)
      .replace(/[`*_~]/g, '')
      .replace(/<[^>]+>/g, '') // HTML tags
      .replace(/:[^:\s]+:/g, '') // :emoji:
      .replace(/[\u{1F300}-\u{1FAFF}]/gu, '') // unicode emoji range
      .trim()
      .toLowerCase();
    // Replace non alphanum with hyphens
    text = text
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-');
    // Trim hyphens
    text = text.replace(/^-+/, '').replace(/-+$/, '');
    let slug = text;
    if (seen.has(slug)) {
      const n = seen.get(slug) + 1;
      seen.set(slug, n);
      slug = `${slug}-${n}`;
    } else {
      seen.set(slug, 0);
    }
    return slug;
  };
}

function extractHeadings(md) {
  const lines = md.split(/\r?\n/);
  const slug = makeSlugger();
  const headings = [];
  for (const line of lines) {
    const m = /^(#{2,6})\s+(.+)$/.exec(line.trim()); // H2..H6 only
    if (m) {
      const level = m[1].length;
      const title = m[2].trim();
      const anchor = slug(title);
      headings.push({ level, title, anchor });
    }
  }
  return headings;
}

function extractLinks(md) {
  const links = [];
  const re = /\[([^\]]+)\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(md))) {
    links.push({ text: m[1], href: m[2] });
  }
  return links;
}

function main() {
  const errors = [];
  const warnings = [];
  if (!fs.existsSync(README)) {
    console.error('README.md not found');
    process.exit(2);
  }
  const md = read(README);
  const headings = extractHeadings(md);
  const anchors = new Set(headings.map(h => `#${h.anchor}`));
  const links = extractLinks(md);

  // Validate internal anchor links
  const internal = links.filter(l => l.href.startsWith('#'));
  for (const l of internal) {
    if (!anchors.has(l.href)) {
      errors.push(`Broken anchor in README: [${l.text}](${l.href})`);
    }
  }

  // Validate docs links
  const docLinks = links.filter(l => l.href.startsWith('docs/'));
  for (const l of docLinks) {
    const file = path.join(ROOT, l.href);
    if (!fs.existsSync(file)) {
      errors.push(`Missing doc file referenced from README: ${l.href}`);
    }
  }

  // Warn about docs that are not referenced
  if (fs.existsSync(DOCS_DIR)) {
    const allDocs = fs.readdirSync(DOCS_DIR).filter(f => f.endsWith('.md'));
    const referenced = new Set(docLinks.map(l => path.basename(l.href)));
    for (const f of allDocs) {
      if (!referenced.has(f)) {
        warnings.push(`Doc not referenced from README: docs/${f}`);
      }
    }
  }

  // Report
  if (warnings.length) {
    console.warn('Warnings:');
    for (const w of warnings) console.warn('  -', w);
  }
  if (errors.length) {
    console.error('Errors:');
    for (const e of errors) console.error('  -', e);
    process.exit(1);
  }
  console.log('README links look good.');
}

if (require.main === module) {
  main();
}


import { extractFileSections, replaceFileSections } from '../../src/slack/markdown';

describe('extractFileSections', () => {
  it('extracts file section with closing delimiter (text after is separate)', () => {
    const text = `Here are the results:

--- report.csv ---
id,name,status
1,Alice,active
2,Bob,inactive
--- report.csv ---

The report contains 2 records.`;

    const sections = extractFileSections(text);
    // First delimiter starts section, second delimiter starts new section
    // but "The report contains 2 records." after second delimiter becomes content
    expect(sections).toHaveLength(2);
    expect(sections[0].filename).toBe('report.csv');
    expect(sections[0].content).toBe('id,name,status\n1,Alice,active\n2,Bob,inactive');
    // Second section has the trailing text
    expect(sections[1].content).toBe('The report contains 2 records.');
  });

  it('extracts an unclosed file section extending to end of text', () => {
    const text = `Here are the results:

--- report.csv ---
id,name,status
1,Alice,active
2,Bob,inactive`;

    const sections = extractFileSections(text);
    expect(sections).toHaveLength(1);
    expect(sections[0].filename).toBe('report.csv');
    expect(sections[0].content).toBe('id,name,status\n1,Alice,active\n2,Bob,inactive');
  });

  it('extracts unclosed section from output() buffer with double newlines', () => {
    // Simulates ProbeAgent output buffer joining with \n\n
    const text = `--- report.csv ---

ticket_id,subject,status

25006,"MDCB ALB",solved

24986,"Helm Upgrade",solved`;

    const sections = extractFileSections(text);
    expect(sections).toHaveLength(1);
    expect(sections[0].filename).toBe('report.csv');
    expect(sections[0].content).toContain('ticket_id,subject,status');
    expect(sections[0].content).toContain('25006');
    expect(sections[0].content).toContain('24986');
  });

  it('extracts multiple file sections separated by different filenames', () => {
    const text = `--- data.json ---
{"key": "value"}
--- results.txt ---
line 1
line 2`;

    const sections = extractFileSections(text);
    expect(sections).toHaveLength(2);
    expect(sections[0].filename).toBe('data.json');
    expect(sections[0].content).toBe('{"key": "value"}');
    expect(sections[1].filename).toBe('results.txt');
    expect(sections[1].content).toBe('line 1\nline 2');
  });

  it('extracts multiple unclosed sections separated by different filenames', () => {
    const text = `--- report.csv ---
csv data here
--- summary.txt ---
summary text here`;

    const sections = extractFileSections(text);
    expect(sections).toHaveLength(2);
    expect(sections[0].filename).toBe('report.csv');
    expect(sections[0].content).toBe('csv data here');
    expect(sections[1].filename).toBe('summary.txt');
    expect(sections[1].content).toBe('summary text here');
  });

  it('handles various file extensions', () => {
    const extensions = ['csv', 'json', 'txt', 'md', 'yaml', 'yml', 'xml', 'py', 'ts', 'js'];
    for (const ext of extensions) {
      const text = `--- file.${ext} ---\ncontent`;
      const sections = extractFileSections(text);
      expect(sections).toHaveLength(1);
      expect(sections[0].filename).toBe(`file.${ext}`);
    }
  });

  it('handles filenames with dots and hyphens', () => {
    const text = `--- my-report.2024.csv ---
data`;

    const sections = extractFileSections(text);
    expect(sections).toHaveLength(1);
    expect(sections[0].filename).toBe('my-report.2024.csv');
  });

  it('ignores delimiters with no file extension', () => {
    const text = `--- noextension ---
content
--- noextension ---`;

    const sections = extractFileSections(text);
    expect(sections).toHaveLength(0);
  });

  it('does not match delimiters that are not on their own line', () => {
    const text = `some text --- report.csv --- more text
content here`;

    const sections = extractFileSections(text);
    expect(sections).toHaveLength(0);
  });

  it('does not false-positive on markdown horizontal rules', () => {
    const text = `Some text

---

More text

---

End`;

    const sections = extractFileSections(text);
    expect(sections).toHaveLength(0);
  });

  it('does not match bare --- separators without filenames', () => {
    const text = `---
content
---`;

    const sections = extractFileSections(text);
    expect(sections).toHaveLength(0);
  });

  it('returns correct start and end indices', () => {
    const prefix = 'Hello world\n\n';
    const fileBlock = '--- test.txt ---\nsome content';
    const text = prefix + fileBlock;

    const sections = extractFileSections(text);
    expect(sections).toHaveLength(1);
    expect(sections[0].startIndex).toBe(prefix.length);
    expect(sections[0].endIndex).toBe(text.length);
  });

  it('returns correct start and end indices for unclosed section at end', () => {
    const prefix = 'Hello world\n\n';
    const fileBlock = '--- test.txt ---\nsome content';
    const text = prefix + fileBlock;

    const sections = extractFileSections(text);
    expect(sections).toHaveLength(1);
    expect(sections[0].startIndex).toBe(prefix.length);
    expect(sections[0].endIndex).toBe(text.length);
  });

  it('returns empty array for text with no file sections', () => {
    const text = 'Just some regular text with no file sections.';
    const sections = extractFileSections(text);
    expect(sections).toHaveLength(0);
  });

  it('skips empty file sections', () => {
    const text = `--- empty.txt ---
--- other.txt ---`;

    // First section has no content (only whitespace before next delimiter)
    const sections = extractFileSections(text);
    expect(sections).toHaveLength(0);
  });

  it('treats second same-name delimiter as new section, not a close', () => {
    const text = `--- report.csv ---
data row 1
--- report.csv ---
data row 2`;

    const sections = extractFileSections(text);
    // Each delimiter starts a new section
    expect(sections).toHaveLength(2);
    expect(sections[0].content).toBe('data row 1');
    expect(sections[1].content).toBe('data row 2');
  });

  it('handles the ProbeAgent output buffer append scenario', () => {
    // Simulates: AI attempt_completion has partial CSV, then output buffer
    // appended with full CSV data. After JSON recovery, trailing content
    // is appended to text field.
    const text = `I have generated the SLA report.

--- report.csv ---
ticket_id,subject
25006,"MDCB ALB"

--- report.csv ---

ticket_id,subject

25006,"MDCB ALB"

24986,"Helm Upgrade"

24965,"Another ticket"`;

    const sections = extractFileSections(text);
    expect(sections).toHaveLength(2);
    // First section: partial data from AI attempt_completion
    expect(sections[0].content).toBe('ticket_id,subject\n25006,"MDCB ALB"');
    // Second section: full output buffer data (the one we want)
    expect(sections[1].content).toContain('ticket_id,subject');
    expect(sections[1].content).toContain('24986');
    expect(sections[1].content).toContain('24965');
  });
});

describe('extractFileSections with pre-normalized literal \\n', () => {
  it('extracts file section after literal \\n is normalized to actual newlines', () => {
    // Simulates DSL output buffer where AI used "\\n" instead of "\n":
    // output("--- sla_report.csv ---\\n" + csv)
    // After normalization (replace literal \n with newline), it should parse correctly
    const raw = '--- sla_report.csv ---\\nticket_id,subject,status\\n1,Alice,active\\n';
    const normalized = raw.replace(/\\n/g, '\n');
    const sections = extractFileSections(normalized);
    expect(sections).toHaveLength(1);
    expect(sections[0].filename).toBe('sla_report.csv');
    expect(sections[0].content).toContain('ticket_id,subject,status');
    expect(sections[0].content).toContain('1,Alice,active');
  });

  it('extracts file section from full AI response with literal \\n in output buffer', () => {
    // Simulates the exact pattern from a real trace: AI text + \n\n + output buffer with literal \n
    const raw =
      'I have generated the SLA report.\n\n' +
      '--- sla_report.csv ---\\nticket_id,subject,status\\n25006,MDCB ALB,solved\\n';
    const normalized = raw.replace(/\\n/g, '\n');
    const sections = extractFileSections(normalized);
    expect(sections).toHaveLength(1);
    expect(sections[0].filename).toBe('sla_report.csv');
    expect(sections[0].content).toContain('ticket_id');
    expect(sections[0].content).toContain('25006');
  });
});

describe('replaceFileSections', () => {
  it('replaces a section with default replacement', () => {
    const text = `Before

--- report.csv ---
id,name,status`;

    const sections = extractFileSections(text);
    const result = replaceFileSections(text, sections);
    expect(result).toContain('_(See file: report.csv above)_');
    expect(result).not.toContain('--- report.csv ---');
    expect(result).toContain('Before');
  });

  it('replaces an unclosed section at end of text', () => {
    const text = `Before

--- report.csv ---
id,name,status`;

    const sections = extractFileSections(text);
    const result = replaceFileSections(text, sections);
    expect(result).toContain('_(See file: report.csv above)_');
    expect(result).toContain('Before');
    expect(result).not.toContain('id,name,status');
  });

  it('replaces multiple sections back-to-front preserving indices', () => {
    const text = `intro

--- a.txt ---
alpha
--- b.txt ---
beta`;

    const sections = extractFileSections(text);
    expect(sections).toHaveLength(2);
    const result = replaceFileSections(text, sections, idx => `[file-${idx}]`);
    expect(result).toContain('[file-0]');
    expect(result).toContain('[file-1]');
    expect(result).toContain('intro');
    expect(result).not.toContain('--- a.txt ---');
    expect(result).not.toContain('--- b.txt ---');
  });

  it('replaces with a static string', () => {
    const text = `--- data.json ---
{}`;

    const sections = extractFileSections(text);
    const result = replaceFileSections(text, sections, '[uploaded]');
    expect(result).toBe('[uploaded]');
  });

  it('returns original text when no sections provided', () => {
    const text = 'No sections here';
    const result = replaceFileSections(text, []);
    expect(result).toBe(text);
  });

  it('handles callback with different replacements per index', () => {
    const text = `--- ok.csv ---
ok data
--- fail.csv ---
fail data`;

    const sections = extractFileSections(text);
    expect(sections).toHaveLength(2);
    const uploadedIndices = [0]; // only first succeeded
    const result = replaceFileSections(text, sections, idx =>
      uploadedIndices.includes(idx)
        ? `_(See file: ${sections[idx].filename} above)_`
        : `_(File upload failed: ${sections[idx].filename})_`
    );
    expect(result).toContain('_(See file: ok.csv above)_');
    expect(result).toContain('_(File upload failed: fail.csv)_');
  });
});

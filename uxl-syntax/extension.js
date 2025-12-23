// UXL folding support for Cursor/VS Code engine.
// Provides folding ranges for:
// - Pages: P\... (root-level) inside fenced blocks ```UXL ... ```
// - UXL files themselves (.uxl / .uxl.txt)
//
// Notes:
// - In Markdown/HTML we scan the whole document text and locate UXL fences.
// - We normalize indentation inside each fence block so indented fences (e.g. in lists)
//   still fold correctly.

const vscode = require("vscode");

function countLeadingSpaces(s) {
  let i = 0;
  while (i < s.length && s[i] === " ") i++;
  return i;
}

function isUxlFenceStart(line) {
  // Allow ```UXL at end of line, optionally preceded by other text (e.g. <pre>```UXL).
  return /```+\s*(uxl)\s*$/i.test(line);
}

function isFenceEnd(line) {
  // End fence: ``` possibly followed by whitespace and optional </pre>
  return /```+\s*(?:<\/pre>\s*)?$/i.test(line);
}

function isRootPLine(line) {
  // "P" at start (after indentation), followed by word boundary.
  // Examples: "P\home\...", "P \home", "P"
  return /^P\b/.test(line);
}

function findUxlFenceBlocks(document) {
  const blocks = [];
  const lineCount = document.lineCount;

  let i = 0;
  while (i < lineCount) {
    const lineText = document.lineAt(i).text;
    if (!isUxlFenceStart(lineText)) {
      i++;
      continue;
    }
    const startFenceLine = i;

    // Find end fence
    let j = i + 1;
    while (j < lineCount) {
      const t = document.lineAt(j).text;
      if (isFenceEnd(t)) break;
      j++;
    }
    if (j >= lineCount) break; // unterminated fence -> ignore

    const endFenceLine = j;

    // Compute minimal indent inside the fence content (ignore blank lines).
    let minIndent = null;
    for (let k = startFenceLine + 1; k <= endFenceLine - 1; k++) {
      const lt = document.lineAt(k).text;
      if (!lt.trim()) continue;
      const ind = countLeadingSpaces(lt);
      if (minIndent == null || ind < minIndent) minIndent = ind;
    }
    if (minIndent == null) minIndent = 0;

    blocks.push({ startFenceLine, endFenceLine, minIndent });
    i = endFenceLine + 1;
  }

  return blocks;
}

function foldingRangesForUxlLines(getLineText, startLine, endLineExclusive, minIndent) {
  // Compute folding ranges for root-level P blocks.
  const pLines = [];
  for (let i = startLine; i < endLineExclusive; i++) {
    const raw = getLineText(i);
    if (!raw.trim()) continue;
    const normalized = raw.length >= minIndent ? raw.slice(minIndent) : raw;
    const indent = countLeadingSpaces(normalized);
    if (indent !== 0) continue;
    const head = normalized.trimStart();
    if (isRootPLine(head)) pLines.push(i);
  }

  const ranges = [];
  for (let idx = 0; idx < pLines.length; idx++) {
    const pLine = pLines[idx];
    const nextP = pLines[idx + 1] ?? endLineExclusive;
    const endLine = nextP - 1;
    if (endLine > pLine) {
      ranges.push(new vscode.FoldingRange(pLine, endLine, vscode.FoldingRangeKind.Region));
    }
  }

  return ranges;
}

function makeProvider(kind) {
  return {
    provideFoldingRanges(document) {
      try {
        if (kind === "uxl") {
          return foldingRangesForUxlLines(
            (i) => document.lineAt(i).text,
            0,
            document.lineCount,
            0,
          );
        }

        // markdown/html: find fenced ```UXL blocks and fold P ranges inside them
        const blocks = findUxlFenceBlocks(document);
        const out = [];
        for (const b of blocks) {
          // content lines: (startFenceLine+1) .. (endFenceLine-1) inclusive
          const start = b.startFenceLine + 1;
          const endExclusive = b.endFenceLine; // exclusive
          out.push(
            ...foldingRangesForUxlLines(
              (i) => document.lineAt(i).text,
              start,
              endExclusive,
              b.minIndent,
            ),
          );
        }
        return out;
      } catch {
        return [];
      }
    },
  };
}

function activate(context) {
  const md = vscode.languages.registerFoldingRangeProvider({ language: "markdown" }, makeProvider("md"));
  const html = vscode.languages.registerFoldingRangeProvider({ language: "html" }, makeProvider("html"));
  const uxl = vscode.languages.registerFoldingRangeProvider({ language: "uxl" }, makeProvider("uxl"));

  context.subscriptions.push(md, html, uxl);
}

function deactivate() {}

module.exports = { activate, deactivate };



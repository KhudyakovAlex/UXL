/* UXL browser parser + renderer
 *
 * - Parses UXL blocks (as specified in UXL.md)
 * - Renders: interface map (pages + goto arrows) + per-page render + hints with callouts
 * - Mermaid-like: can replace source blocks in the DOM with rendered output
 */
(() => {
  "use strict";

  class UxlParseError extends Error {
    constructor(message, { line = null, col = null, sourceName = "UXL", lineText = null } = {}) {
      super(message);
      this.name = "UxlParseError";
      this.line = line;
      this.col = col;
      this.sourceName = sourceName;
      this.lineText = lineText;
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function isBlankOrComment(rawLine) {
    const trimmed = rawLine.trim();
    if (!trimmed) return true;
    const afterIndent = rawLine.replace(/^\s+/, "");
    return afterIndent.startsWith(";");
  }

  function countLeadingSpaces(line) {
    let i = 0;
    while (i < line.length && line[i] === " ") i++;
    return i;
  }

  function assertNoTabs(line, meta) {
    if (line.includes("\t")) {
      throw new UxlParseError("Табуляция запрещена (используйте пробелы).", meta);
    }
  }

  function trimField(s) {
    return s.trim();
  }

  function unescapeQuotedField(s, meta) {
    // s includes the leading quote. Parse up to closing quote.
    // Allowed escapes: \" and \\ only.
    if (!s.startsWith('"')) return s;
    let out = "";
    let i = 1;
    for (; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"') {
        // rest must be whitespace
        const rest = s.slice(i + 1);
        if (rest.trim().length !== 0) {
          throw new UxlParseError('Лишние символы после закрывающей кавычки в поле.', meta);
        }
        return out;
      }
      if (ch === "\\") {
        const next = s[i + 1];
        if (next === '"' || next === "\\") {
          out += next;
          i++;
          continue;
        }
        throw new UxlParseError("Недопустимый escape в кавычечном поле (разрешены только \\\" и \\\\).", meta);
      }
      out += ch;
    }
    throw new UxlParseError("Незакрытые кавычки в поле.", meta);
  }

  function splitFields(lineNoIndent, meta) {
    // Split by backslash not inside quotes.
    // Inside quotes, supports escaping for \" and \\ (validated later).
    const parts = [];
    let cur = "";
    let inQuotes = false;
    let escaped = false;

    for (let i = 0; i < lineNoIndent.length; i++) {
      const ch = lineNoIndent[i];
      if (inQuotes) {
        cur += ch;
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === '"') {
          inQuotes = false;
          continue;
        }
        continue;
      }

      if (ch === '"') {
        inQuotes = true;
        cur += ch;
        continue;
      }
      if (ch === "\\") {
        parts.push(cur);
        cur = "";
        continue;
      }
      cur += ch;
    }

    if (inQuotes) {
      throw new UxlParseError("Незакрытые кавычки в строке.", meta);
    }

    parts.push(cur);

    return parts.map((raw) => {
      const t = trimField(raw);
      if (t.startsWith('"')) return unescapeQuotedField(t, meta);
      return t;
    });
  }

  function parseWindowSizeIfPresent(lines, startIndex, sourceName) {
    // Find first significant line, attempt to parse WxH (integers >0). If not present, default 500x500.
    for (let i = startIndex; i < lines.length; i++) {
      const rawLine = lines[i];
      if (isBlankOrComment(rawLine)) continue;
      const meta = { line: i + 1, col: 1, sourceName, lineText: rawLine };
      assertNoTabs(rawLine, meta);
      const s = rawLine.trim();
      const m = /^(\d+)\s*x\s*(\d+)$/.exec(s);
      if (!m) return { size: { w: 500, h: 500 }, nextIndex: i };
      const w = Number(m[1]);
      const h = Number(m[2]);
      if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
        throw new UxlParseError("Некорректный размер окна (ожидается W>0, H>0, целые).", meta);
      }
      return { size: { w, h }, nextIndex: i + 1 };
    }
    return { size: { w: 500, h: 500 }, nextIndex: lines.length };
  }

  function parseDim(raw, meta) {
    if (raw == null || raw === "") return null;
    if (raw.toLowerCase().includes("px")) {
      throw new UxlParseError('Суффикс "px" запрещен. Пиксели задаются числом без суффикса.', meta);
    }
    if (raw.endsWith("%")) {
      const n = raw.slice(0, -1);
      if (!/^\d+$/.test(n)) throw new UxlParseError("Проценты должны быть целым числом (например 33%).", meta);
      const v = Number(n);
      if (!Number.isInteger(v) || v < 0 || v > 100) throw new UxlParseError("Проценты должны быть в диапазоне 0..100%.", meta);
      return { unit: "%", value: v };
    }
    if (!/^\d+$/.test(raw)) throw new UxlParseError("Пиксели должны быть целым числом без суффикса.", meta);
    const v = Number(raw);
    if (!Number.isInteger(v) || v < 0) throw new UxlParseError("Пиксели должны быть целым числом >= 0.", meta);
    return { unit: "px", value: v };
  }

  function parseSize(sizeStr, meta) {
    if (!sizeStr) return { w: null, h: null };
    // allow partial: Wx, xH, W%x, xH%
    const idx = sizeStr.indexOf("x");
    if (idx === -1) throw new UxlParseError('SIZE должен быть в формате "WxH" (допустимы частичные Wx / xH).', meta);
    const wRaw = sizeStr.slice(0, idx);
    const hRaw = sizeStr.slice(idx + 1);
    return { w: parseDim(wRaw, meta), h: parseDim(hRaw, meta) };
  }

  function parseAlign(alignStr, meta) {
    const s = (alignStr || "").trim().toUpperCase();
    if (!s) return { L: false, R: false, T: false, B: false };
    if (!/^[LRTB]+$/.test(s)) throw new UxlParseError("ALIGN может содержать только символы L, R, T, B.", meta);
    return { L: s.includes("L"), R: s.includes("R"), T: s.includes("T"), B: s.includes("B") };
  }

  function normalizeId(id) {
    return (id || "").trim().toLowerCase();
  }

  function parseAction(actionStr, meta, mode) {
    const s = (actionStr || "").trim();
    if (!s) return null;
    const m = /^GOTO:(.+)$/.exec(s);
    if (m) return { type: "GOTO", target: m[1].trim() };
    const old = /^GOTO:P(.+)$/.exec(s);
    if (old) return { type: "GOTO", target: old[1].trim() };
    if (mode === "strict") throw new UxlParseError(`Неизвестная команда ACTION: "${s}".`, meta);
    return null; // permissive: ignore
  }

  function ensureTrailingBackslashAbsent(rawLine, meta, mode) {
    // Spec says trailing '\' is forbidden. In permissive, we still treat it as error by default,
    // because it breaks field counting; if needed, can be relaxed later.
    if (rawLine.trimEnd().endsWith("\\")) {
      throw new UxlParseError('Завершающий "\\" запрещен: если дальше нет полей, "\\" не пишется.', meta);
    }
  }

  function parseTagLine(rawLine, lineNo, sourceName, mode) {
    const meta = { line: lineNo, col: 1, sourceName, lineText: rawLine };
    assertNoTabs(rawLine, meta);
    ensureTrailingBackslashAbsent(rawLine, meta, mode);

    const indent = countLeadingSpaces(rawLine);
    if (indent % 2 !== 0) {
      throw new UxlParseError("Отступ должен быть кратен двум пробелам.", meta);
    }
    const text = rawLine.trim();
    const fields = splitFields(text, meta);
    const tag = (fields[0] || "").trim().toUpperCase();
    if (!tag) throw new UxlParseError("Пустой TAG.", meta);

    // default format: TAG\ID\CAPTION\SIZE\ALIGN\ACTION\HINT
    const get = (idx) => (fields[idx] == null ? "" : fields[idx]);

    if (tag === "P") {
      const id = get(1);
      const caption = get(2);
      if (!id) throw new UxlParseError("Для тега P поле ID обязательно.", meta);
      const extra = fields.slice(3).some((x) => (x || "").trim() !== "");
      if (extra && mode === "strict") {
        throw new UxlParseError("Тег P допускает только формат P\\ID\\CAPTION. Лишние поля запрещены.", meta);
      }
      return { indent, node: { tag, id, caption, size: null, align: null, action: null, hint: null, rawLineNo: lineNo } };
    }

    if (tag === "TC") {
      const cols = fields.slice(1).map((cell) => cell);
      if (cols.length === 0) throw new UxlParseError("TC должен содержать хотя бы одну колонку.", meta);
      return { indent, node: { tag, cols, rawLineNo: lineNo } };
    }

    if (tag === "TH" || tag === "TD") {
      const cells = fields.slice(1);
      return { indent, node: { tag, cells, rawLineNo: lineNo } };
    }

    const id = get(1);
    const caption = get(2);
    const sizeStr = get(3);
    const alignStr = get(4);
    const actionStr = get(5);
    const hint = get(6);

    const size = sizeStr ? parseSize(sizeStr, meta) : null;
    const align = alignStr ? parseAlign(alignStr, meta) : null;
    const action = actionStr ? parseAction(actionStr, meta, mode) : null;

    return {
      indent,
      node: {
        tag,
        id: id || "",
        caption: caption || "",
        size,
        align,
        action,
        hint: hint || "",
        rawLineNo: lineNo,
      },
    };
  }

  function validateTcFormat(tcNode, meta) {
    // Each entry: W or WA, where W is int 0..100, A optional L/R
    const cols = [];
    for (let i = 0; i < tcNode.cols.length; i++) {
      const raw = (tcNode.cols[i] || "").trim().toUpperCase();
      if (!raw) throw new UxlParseError("Пустое значение колонки в TC.", meta);
      const m = /^(\d+)([LR])?$/.exec(raw);
      if (!m) throw new UxlParseError(`Некорректный формат колонки TC: "${raw}" (ожидается например 20R).`, meta);
      const w = Number(m[1]);
      if (!Number.isInteger(w) || w < 0 || w > 100) throw new UxlParseError("W в TC должен быть целым числом 0..100.", meta);
      cols.push({ w, align: m[2] || null });
    }

    // Normalize to sum 100 (deterministic)
    const sum = cols.reduce((a, c) => a + c.w, 0);
    if (sum === 0) throw new UxlParseError("Сумма процентов в TC равна 0 — невозможно нормализовать.", meta);
    if (sum !== 100) {
      const raws = cols.map((c) => ({
        raw: (c.w * 100) / sum,
        base: Math.floor((c.w * 100) / sum),
      }));
      let baseSum = raws.reduce((a, x) => a + x.base, 0);
      let remaining = 100 - baseSum;
      const order = raws
        .map((x, idx) => ({ idx, frac: x.raw - x.base }))
        .sort((a, b) => (b.frac !== a.frac ? b.frac - a.frac : a.idx - b.idx));
      const wNorm = raws.map((x) => x.base);
      for (let k = 0; k < remaining; k++) {
        wNorm[order[k % order.length].idx] += 1;
      }
      for (let i = 0; i < cols.length; i++) cols[i].w = wNorm[i];
    }

    return cols;
  }

  function parseUxl(uxlText, { mode = "permissive", sourceName = "UXL" } = {}) {
    const lines = String(uxlText).replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
    const { size: windowSize, nextIndex } = parseWindowSizeIfPresent(lines, 0, sourceName);

    const stack = []; // {indent, node}
    const roots = [];
    let prevIndent = 0;
    let firstTagSeen = false;

    for (let i = nextIndex; i < lines.length; i++) {
      const rawLine = lines[i];
      if (isBlankOrComment(rawLine)) continue;
      const lineNo = i + 1;
      const meta = { line: lineNo, col: 1, sourceName, lineText: rawLine };
      assertNoTabs(rawLine, meta);

      const { indent, node } = parseTagLine(rawLine, lineNo, sourceName, mode);

      if (!firstTagSeen) {
        firstTagSeen = true;
        prevIndent = indent;
      } else {
        if (indent > prevIndent + 2) {
          throw new UxlParseError("Нельзя перескакивать на несколько уровней вложенности за одну строку.", meta);
        }
        prevIndent = indent;
      }

      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      if (stack.length === 0) {
        roots.push(node);
      } else {
        const parent = stack[stack.length - 1].node;
        parent.children = parent.children || [];
        parent.children.push(node);
      }
      stack.push({ indent, node });
    }

    // Validate structure + build pages list
    for (const r of roots) {
      if (r.tag !== "P") {
        throw new UxlParseError("В корне UXL-блока разрешены только теги P.", {
          line: r.rawLineNo,
          col: 1,
          sourceName,
          lineText: lines[r.rawLineNo - 1],
        });
      }
    }

    // ID uniqueness by tag type (case-insensitive)
    const idsByTag = new Map(); // tag -> Set(lowerId)
    function registerId(tag, id, rawLineNo) {
      const norm = normalizeId(id);
      if (!norm) return;
      if (!idsByTag.has(tag)) idsByTag.set(tag, new Set());
      const set = idsByTag.get(tag);
      if (set.has(norm)) {
        throw new UxlParseError(`Дублирующийся ID "${id}" для тега ${tag} (case-insensitive).`, {
          line: rawLineNo,
          col: 1,
          sourceName,
          lineText: lines[rawLineNo - 1],
        });
      }
      set.add(norm);
    }

    const pages = [];
    const pagesById = new Map(); // lower -> page

    function walk(node, parent) {
      node.parent = parent || null;
      node.children = node.children || [];

      // Validate ID charset for nodes that have ID provided
      if (node.tag === "P") {
        if (!/^[A-Za-z0-9_-]+$/.test(node.id)) {
          throw new UxlParseError("Некорректный ID у P (разрешены латиница/цифры/_/-).", {
            line: node.rawLineNo,
            col: 1,
            sourceName,
            lineText: lines[node.rawLineNo - 1],
          });
        }
        registerId("P", node.id, node.rawLineNo);
        const key = normalizeId(node.id);
        if (pagesById.has(key)) {
          // already caught by registerId, but keep safe
          throw new UxlParseError(`Дублирующийся ID страницы "${node.id}".`, {
            line: node.rawLineNo,
            col: 1,
            sourceName,
            lineText: lines[node.rawLineNo - 1],
          });
        }
        pagesById.set(key, node);
        pages.push(node);
      } else if (node.id) {
        if (!/^[A-Za-z0-9_-]+$/.test(node.id)) {
          throw new UxlParseError("Некорректный ID (разрешены латиница/цифры/_/-).", {
            line: node.rawLineNo,
            col: 1,
            sourceName,
            lineText: lines[node.rawLineNo - 1],
          });
        }
        registerId(node.tag, node.id, node.rawLineNo);
      }

      for (const ch of node.children) walk(ch, node);
    }
    for (const r of roots) walk(r, null);

    // structure validation
    function validateNode(node) {
      const tag = node.tag;
      const kids = node.children || [];

      if (tag !== "P" && node.parent == null) {
        throw new UxlParseError("В корне разрешены только P.", {
          line: node.rawLineNo,
          col: 1,
          sourceName,
          lineText: lines[node.rawLineNo - 1],
        });
      }
      if (tag === "P") {
        if (node.parent != null) {
          throw new UxlParseError("P не может быть вложенным элементом.", {
            line: node.rawLineNo,
            col: 1,
            sourceName,
            lineText: lines[node.rawLineNo - 1],
          });
        }
        for (const ch of kids) {
          if (!["F", "B", "C", "T"].includes(ch.tag)) {
            throw new UxlParseError(`Недопустимый дочерний тег "${ch.tag}" внутри P.`, {
              line: ch.rawLineNo,
              col: 1,
              sourceName,
              lineText: lines[ch.rawLineNo - 1],
            });
          }
        }
      } else if (tag === "F") {
        for (const ch of kids) {
          if (!["F", "B", "C", "T"].includes(ch.tag)) {
            throw new UxlParseError(`Недопустимый дочерний тег "${ch.tag}" внутри F.`, {
              line: ch.rawLineNo,
              col: 1,
              sourceName,
              lineText: lines[ch.rawLineNo - 1],
            });
          }
        }
      } else if (tag === "T") {
        for (const ch of kids) {
          if (!["TC", "TH", "TD"].includes(ch.tag)) {
            throw new UxlParseError(`Недопустимый дочерний тег "${ch.tag}" внутри T.`, {
              line: ch.rawLineNo,
              col: 1,
              sourceName,
              lineText: lines[ch.rawLineNo - 1],
            });
          }
        }
        // order: TC (required), then TH (0/1), then TD (0..)
        const tcIdx = kids.findIndex((k) => k.tag === "TC");
        if (tcIdx !== 0) {
          throw new UxlParseError("Внутри T первым должен идти TC (обязателен).", {
            line: node.rawLineNo,
            col: 1,
            sourceName,
            lineText: lines[node.rawLineNo - 1],
          });
        }
        const thCount = kids.filter((k) => k.tag === "TH").length;
        if (thCount > 1) {
          throw new UxlParseError("TH внутри T допускается не более одного раза.", {
            line: node.rawLineNo,
            col: 1,
            sourceName,
            lineText: lines[node.rawLineNo - 1],
          });
        }
        const firstTd = kids.findIndex((k) => k.tag === "TD");
        const thIdx = kids.findIndex((k) => k.tag === "TH");
        if (thIdx !== -1 && firstTd !== -1 && thIdx > firstTd) {
          throw new UxlParseError("TH должен идти до любых TD.", {
            line: node.rawLineNo,
            col: 1,
            sourceName,
            lineText: lines[node.rawLineNo - 1],
          });
        }

        // T ACTION rule
        if (node.action && mode === "strict") {
          throw new UxlParseError("ACTION у T не поддерживается (strict: ошибка).", {
            line: node.rawLineNo,
            col: 1,
            sourceName,
            lineText: lines[node.rawLineNo - 1],
          });
        }
        if (node.action && mode !== "strict") node.action = null; // permissive ignore
      } else if (["B", "C", "TC", "TH", "TD"].includes(tag)) {
        if (kids.length) {
          throw new UxlParseError(`${tag} не может иметь дочерних элементов.`, {
            line: node.rawLineNo,
            col: 1,
            sourceName,
            lineText: lines[node.rawLineNo - 1],
          });
        }
      } else {
        throw new UxlParseError(`Неизвестный тег: "${tag}".`, {
          line: node.rawLineNo,
          col: 1,
          sourceName,
          lineText: lines[node.rawLineNo - 1],
        });
      }

      // validate sizes/align for generic nodes
      if (node.size && node.size.w) parseDim(node.size.w.unit === "%" ? `${node.size.w.value}%` : `${node.size.w.value}`, {
        line: node.rawLineNo,
        col: 1,
        sourceName,
        lineText: lines[node.rawLineNo - 1],
      });

      for (const ch of kids) validateNode(ch);
    }
    for (const p of pages) validateNode(p);

    // Validate tables cell counts + normalize TC
    function validateTables(node) {
      if (node.tag === "T") {
        const kids = node.children || [];
        const tc = kids.find((k) => k.tag === "TC");
        const meta = { line: tc.rawLineNo, col: 1, sourceName, lineText: lines[tc.rawLineNo - 1] };
        const cols = validateTcFormat(tc, meta);
        node._tcCols = cols;
        const colCount = cols.length;
        const th = kids.find((k) => k.tag === "TH");
        if (th && th.cells.length !== colCount) {
          throw new UxlParseError(`Количество ячеек в TH (${th.cells.length}) не равно количеству колонок TC (${colCount}).`, {
            line: th.rawLineNo,
            col: 1,
            sourceName,
            lineText: lines[th.rawLineNo - 1],
          });
        }
        for (const td of kids.filter((k) => k.tag === "TD")) {
          if (td.cells.length !== colCount) {
            throw new UxlParseError(`Количество ячеек в TD (${td.cells.length}) не равно количеству колонок TC (${colCount}).`, {
              line: td.rawLineNo,
              col: 1,
              sourceName,
              lineText: lines[td.rawLineNo - 1],
            });
          }
        }
      }
      for (const ch of node.children || []) validateTables(ch);
    }
    for (const p of pages) validateTables(p);

    // Collect edges (one per from->to)
    const edges = new Map(); // key "from=>to" -> {fromId,toId}

    function nearestPageId(node) {
      let cur = node;
      while (cur && cur.tag !== "P") cur = cur.parent;
      return cur ? cur.id : null;
    }

    function collectEdges(node) {
      if (node.action && node.action.type === "GOTO") {
        const fromId = nearestPageId(node);
        const toId = node.action.target;
        if (fromId) {
          const fromKey = normalizeId(fromId);
          const toKey = normalizeId(toId);
          const key = `${fromKey}=>${toKey}`;
          edges.set(key, { fromId, toId });
        }
      }
      for (const ch of node.children || []) collectEdges(ch);
    }
    for (const p of pages) collectEdges(p);

    // Validate GOTO targets
    for (const e of edges.values()) {
      const toKey = normalizeId(e.toId);
      if (!pagesById.has(toKey)) {
        throw new UxlParseError(`GOTO ссылается на несуществующую страницу "${e.toId}".`, {
          line: null,
          col: null,
          sourceName,
          lineText: null,
        });
      }
    }

    // Assign uids
    let uidSeq = 1;
    function assignUid(node) {
      node.uid = `n${uidSeq++}`;
      for (const ch of node.children || []) assignUid(ch);
    }
    for (const p of pages) assignUid(p);

    return {
      kind: "UXL",
      mode,
      sourceName,
      window: windowSize,
      pages,
      edges: Array.from(edges.values()),
      _lines: lines,
    };
  }

  function extractUxlBlocksFromMarkdown(mdText) {
    const text = String(mdText).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    const blocks = [];
    const re = /```UXL[^\n]*\n([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(text))) {
      blocks.push(m[1]);
    }
    return blocks;
  }

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("data-")) node.setAttribute(k, v);
      else node.setAttribute(k, v);
    }
    for (const ch of Array.isArray(children) ? children : [children]) {
      if (ch == null) continue;
      node.append(ch);
    }
    return node;
  }

  function formatMapCaption(caption) {
    const s = String(caption || "").trim();
    if (!s) return "";
    const words = s.split(/\s+/).filter(Boolean);
    if (words.length <= 3) return escapeHtml(s);
    // Insert line breaks every 3 words.
    const lines = [];
    for (let i = 0; i < words.length; i += 3) lines.push(words.slice(i, i + 3).join(" "));
    return lines.map(escapeHtml).join("<br>");
  }

  function renderError(err) {
    const root = el("div", { class: "uxl-root" });
    const head = el("div", { class: "uxl-error__head", text: "UXL error" });
    const metaParts = [];
    if (err.sourceName) metaParts.push(err.sourceName);
    if (err.line != null) metaParts.push(`line ${err.line}`);
    if (err.col != null) metaParts.push(`col ${err.col}`);
    const meta = el("div", { class: "uxl-error__meta", text: `${metaParts.join(": ")}\n${err.message}` });
    const box = el("div", { class: "uxl-error" }, [head, meta]);
    if (err.lineText) {
      box.append(el("div", { class: "uxl-error__line", text: err.lineText }));
    }
    root.append(box);
    return root;
  }

  function resolveDim(dim, parentPx) {
    if (!dim) return null;
    if (dim.unit === "px") return dim.value;
    if (dim.unit === "%") return Math.round((dim.value / 100) * parentPx);
    return null;
  }

  function computeRect({ parentW, parentH, size, align, isContainer }) {
    // width/height
    const a = align || { L: false, R: false, T: false, B: false };
    const stretchX = a.L && a.R;
    const stretchY = a.T && a.B;

    let w = size?.w ? resolveDim(size.w, parentW) : null;
    let h = size?.h ? resolveDim(size.h, parentH) : null;

    if (w == null && stretchX) w = parentW;
    if (h == null && stretchY) h = parentH;

    // Heuristic for containers without explicit size: occupy parent space so children can be positioned.
    if (isContainer) {
      if (w == null) w = parentW;
      if (h == null) h = parentH;
    }

    // x/y (center by default)
    const x = stretchX ? 0 : a.L ? 0 : a.R ? Math.max(0, parentW - w) : Math.max(0, (parentW - w) / 2);
    const y = stretchY ? 0 : a.T ? 0 : a.B ? Math.max(0, parentH - h) : Math.max(0, (parentH - h) / 2);

    return { x, y, w, h };
  }

  function layoutTree(containerEl, rootNode, windowSize) {
    // rootNode is P; containerEl is .uxl-canvas
    const domByUid = new Map();

    function renderNode(node, parentEl) {
      const tag = node.tag;
      let nodeEl;

      // F is invisible: used only for layout, not rendered as a DOM element.
      if (tag === "F") {
        for (const ch of node.children || []) renderNode(ch, parentEl);
        return null;
      }

      if (tag === "C") nodeEl = el("div", { class: "uxl-node uxl-C", "data-uxl-uid": node.uid, text: node.caption || "" });
      else if (tag === "B") {
        nodeEl = el("button", { class: "uxl-node uxl-B", type: "button", "data-uxl-uid": node.uid, text: node.caption || "" });
      } else if (tag === "T") {
        nodeEl = el("div", { class: "uxl-node uxl-T", "data-uxl-uid": node.uid });
        const table = el("table");
        const colgroup = el("colgroup");
        for (const col of node._tcCols || []) {
          colgroup.append(el("col", { style: `width:${col.w}%;` }));
        }
        table.append(colgroup);
        const thead = el("thead");
        const tbody = el("tbody");
        const thNode = (node.children || []).find((k) => k.tag === "TH");
        if (thNode) {
          const tr = el("tr");
          thNode.cells.forEach((cell, idx) => {
            const colAlign = (node._tcCols?.[idx]?.align || "").toUpperCase();
            const align = colAlign === "L" ? "left" : colAlign === "R" ? "right" : "center";
            tr.append(el("th", { style: `text-align:${align};`, text: cell }));
          });
          thead.append(tr);
        }
        const tdNodes = (node.children || []).filter((k) => k.tag === "TD");
        for (const td of tdNodes) {
          const tr = el("tr");
          td.cells.forEach((cell, idx) => {
            const colAlign = (node._tcCols?.[idx]?.align || "").toUpperCase();
            const align = colAlign === "L" ? "left" : colAlign === "R" ? "right" : "center";
            tr.append(el("td", { style: `text-align:${align};`, text: cell }));
          });
          tbody.append(tr);
        }
        if (thead.childNodes.length) table.append(thead);
        table.append(tbody);
        nodeEl.append(table);
      } else {
        nodeEl = el("div", { class: "uxl-node", "data-uxl-uid": node.uid });
      }

      if (node.hint) nodeEl.title = node.hint;
      domByUid.set(node.uid, nodeEl);
      parentEl.append(nodeEl);

      // No nested rendering needed: T children are structural; F is invisible and handled above.
      return nodeEl;
    }

    // Render children of P
    for (const ch of rootNode.children || []) renderNode(ch, containerEl);

    // Layout pass (top-down)
    function applyLayout(node, parentRect, offset) {
      const tag = node.tag;
      const isContainer = tag === "F" || tag === "T";
      const size = node.size || null;
      const align = node.align || null;
      const rect = computeRect({ parentW: parentRect.w, parentH: parentRect.h, size, align, isContainer });

      const nodeEl = domByUid.get(node.uid);
      if (nodeEl) {
        nodeEl.style.left = `${offset.x + rect.x}px`;
        nodeEl.style.top = `${offset.y + rect.y}px`;
        if (rect.w != null) nodeEl.style.width = `${rect.w}px`;
        if (rect.h != null) nodeEl.style.height = `${rect.h}px`;
      }

      if (tag === "F") {
        // F is an invisible container: children coords are relative to its rect, but rendered in the same canvas.
        const nextOffset = { x: offset.x + rect.x, y: offset.y + rect.y };
        for (const ch of node.children || []) applyLayout(ch, rect, nextOffset);
      }
      // T has no UI children beyond its table; B/C have no children by validation.
    }

    const rootRect = { x: 0, y: 0, w: windowSize.w, h: windowSize.h };
    // Apply layout starting at children of P (relative to canvas)
    for (const ch of rootNode.children || []) applyLayout(ch, rootRect, { x: 0, y: 0 });

    return domByUid;
  }

  function pointsToRoundedPath(points, radius) {
    if (!points || points.length < 2) return "";
    const rDefault = radius ?? 10;
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const unit = (a, b) => {
      const d = dist(a, b) || 1;
      return { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
    };

    let d = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length - 1; i++) {
      const p0 = points[i - 1];
      const p1 = points[i];
      const p2 = points[i + 1];
      const u01 = unit(p1, p0);
      const u12 = unit(p1, p2);
      const r = Math.min(rDefault, dist(p1, p0) / 2, dist(p1, p2) / 2);
      const a = { x: p1.x + u01.x * r, y: p1.y + u01.y * r };
      const b = { x: p1.x + u12.x * r, y: p1.y + u12.y * r };
      d += ` L ${a.x} ${a.y} Q ${p1.x} ${p1.y} ${b.x} ${b.y}`;
    }
    const last = points[points.length - 1];
    d += ` L ${last.x} ${last.y}`;
    return d;
  }

  function drawOrthogonalRounded(svg, start, end) {
    const midX = Math.round((start.x + end.x) / 2);
    const pts = [
      { x: Math.round(start.x), y: Math.round(start.y) },
      { x: midX, y: Math.round(start.y) },
      { x: midX, y: Math.round(end.y) },
      { x: Math.round(end.x), y: Math.round(end.y) },
    ];
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", pointsToRoundedPath(pts, 10));
    svg.append(path);

    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", String(Math.round(end.x)));
    circle.setAttribute("cy", String(Math.round(end.y)));
    circle.setAttribute("r", "4");
    svg.append(circle);
  }

  function renderMap(ast) {
    const map = el("div", { class: "uxl-map" });
    const grid = el("div", { class: "uxl-map__grid" });
    const overlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    overlay.classList.add("uxl-overlay");
    overlay.setAttribute("xmlns", "http://www.w3.org/2000/svg");

    const pageEls = new Map(); // lowerId -> el
    for (const p of ast.pages) {
      const idKey = normalizeId(p.id);
      const pageEl = el("div", { class: "uxl-map__page", "data-page-id": idKey });
      // Use controlled <br> wrapping for long captions (more than 3 words).
      pageEl.innerHTML = formatMapCaption(p.caption || p.id);
      pageEls.set(idKey, pageEl);
      grid.append(pageEl);
    }

    map.append(grid, overlay);

    function redraw() {
      // clear
      while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
      const mapRect = map.getBoundingClientRect();
      overlay.setAttribute("viewBox", `0 0 ${Math.round(mapRect.width)} ${Math.round(mapRect.height)}`);
      overlay.setAttribute("width", String(Math.round(mapRect.width)));
      overlay.setAttribute("height", String(Math.round(mapRect.height)));

      for (const e of ast.edges) {
        const fromEl = pageEls.get(normalizeId(e.fromId));
        const toEl = pageEls.get(normalizeId(e.toId));
        if (!fromEl || !toEl) continue;
        const a = fromEl.getBoundingClientRect();
        const b = toEl.getBoundingClientRect();
        const start = { x: a.right - mapRect.left, y: a.top + a.height / 2 - mapRect.top };
        const end = { x: b.left - mapRect.left, y: b.top + b.height / 2 - mapRect.top };
        drawOrthogonalRounded(overlay, start, end);
      }
    }

    queueMicrotask(() => redraw());
    window.addEventListener("resize", () => redraw());

    return map;
  }

  function renderPageSection(ast, pageNode) {
    const page = el("div", { class: "uxl-page", "data-page-id": normalizeId(pageNode.id) });
    const headText = pageNode.caption || pageNode.id;
    const head = el("div", { class: "uxl-page__head", text: `Страница ${headText}` });
    const body = el("div", { class: "uxl-page__body" });
    const canvasWrap = el("div", { class: "uxl-canvas-wrap" });
    const canvas = el("div", { class: "uxl-canvas" });
    canvas.style.width = `${ast.window.w}px`;
    canvas.style.height = `${ast.window.h}px`;
    canvasWrap.append(canvas);

    const hints = el("div", { class: "uxl-hints" });
    const list = el("ul", { class: "uxl-hints__list" });
    hints.append(list);

    const overlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    overlay.classList.add("uxl-overlay", "uxl-overlay--hints");
    overlay.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    body.append(canvasWrap, hints, overlay);
    page.append(head, body);

    // Render + layout
    const domByUid = layoutTree(canvas, pageNode, ast.window);

    // Collect hints (only nodes with non-empty hint)
    const hintItems = [];
    function collectHints(node) {
      if (node.hint && String(node.hint).trim() !== "") {
        hintItems.push(node);
      }
      for (const ch of node.children || []) collectHints(ch);
    }
    for (const ch of pageNode.children || []) collectHints(ch);

    for (const n of hintItems) {
      const dot = el("span", { class: "uxl-hint-dot", "data-uxl-dot": "1" });
      const text = el("span", { class: "uxl-hint-text", text: n.hint });
      const li = el("li", { class: "uxl-hints__item", "data-uxl-uid": n.uid }, [dot, text]);
      list.append(li);
    }

    function redrawHintLines() {
      while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
      const bodyRect = body.getBoundingClientRect();
      overlay.setAttribute("viewBox", `0 0 ${Math.round(bodyRect.width)} ${Math.round(bodyRect.height)}`);
      overlay.setAttribute("width", String(Math.round(bodyRect.width)));
      overlay.setAttribute("height", String(Math.round(bodyRect.height)));

      for (const n of hintItems) {
        const li = list.querySelector(`li[data-uxl-uid="${CSS.escape(n.uid)}"]`);
        const target = domByUid.get(n.uid);
        if (!li || !target) continue;
        const dot = li.querySelector('[data-uxl-dot="1"]');
        if (!dot) continue;
        const liRect = li.getBoundingClientRect();
        const dotRect = dot.getBoundingClientRect();
        const tRect = target.getBoundingClientRect();

        const start = { x: dotRect.left + dotRect.width / 2 - bodyRect.left, y: dotRect.top + dotRect.height / 2 - bodyRect.top };
        const end = { x: tRect.left + tRect.width / 2 - bodyRect.left, y: tRect.top + tRect.height / 2 - bodyRect.top };
        drawOrthogonalRounded(overlay, start, end);
      }
    }

    queueMicrotask(() => redrawHintLines());
    window.addEventListener("resize", () => redrawHintLines());

    return page;
  }

  function renderAst(ast) {
    const root = el("div", { class: "uxl-root" });
    root.append(el("div", { class: "uxl-map__title", text: "Карта интерфейса" }));
    root.append(renderMap(ast));
    const pagesWrap = el("div", { class: "uxl-pages" });
    for (const p of ast.pages) pagesWrap.append(renderPageSection(ast, p));
    root.append(pagesWrap);
    return root;
  }

  function renderUxlText(uxlText, opts = {}) {
    try {
      const ast = parseUxl(uxlText, opts);
      return renderAst(ast);
    } catch (e) {
      if (e instanceof UxlParseError) return renderError(e);
      const err = new UxlParseError(e?.message || String(e), { sourceName: opts.sourceName || "UXL" });
      return renderError(err);
    }
  }

  function renderAll({ selector = "pre.uxl-md-block", mode = "permissive" } = {}) {
    const nodes = Array.from(document.querySelectorAll(selector));
    for (const node of nodes) {
      const raw = node.textContent || "";
      const blocks = extractUxlBlocksFromMarkdown(raw);
      if (blocks.length === 0) {
        node.replaceWith(renderUxlText(raw, { mode, sourceName: "UXL" }));
        continue;
      }
      const wrapper = el("div");
      for (const [idx, b] of blocks.entries()) {
        wrapper.append(renderUxlText(b, { mode, sourceName: `UXL block ${idx + 1}` }));
      }
      node.replaceWith(wrapper);
    }
  }

  window.UXL = {
    UxlParseError,
    parse: parseUxl,
    renderUxlText,
    renderAll,
    extractUxlBlocksFromMarkdown,
  };
})();



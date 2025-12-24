/* UXL browser parser + renderer
 *
 * - Parses UXL blocks (as specified in UXL.md)
 * - Renders: interface map (pages + goto arrows) + per-page render + hints with callouts
 * - Mermaid-like: can replace source blocks in the DOM with rendered output
 */
(() => {
  "use strict";

  const RENDERER_VERSION = "0.2.0";
  const SUPPORTED_UXL_VERSION = "1.0";

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

  function getScrollbarThicknessPx() {
    // Measure once per page; scrollbar width/height is usually the same.
    // This is used so scrollbars do not "eat" the working area: we expand the outer box instead.
    const outer = document.createElement("div");
    outer.style.position = "absolute";
    outer.style.top = "-9999px";
    outer.style.left = "-9999px";
    outer.style.width = "100px";
    outer.style.height = "100px";
    outer.style.overflow = "scroll";
    outer.style.border = "0";
    outer.style.padding = "0";
    outer.style.visibility = "hidden";
    const inner = document.createElement("div");
    inner.style.width = "100%";
    inner.style.height = "100%";
    outer.append(inner);
    document.body.append(outer);
    const w = outer.offsetWidth - outer.clientWidth;
    const h = outer.offsetHeight - outer.clientHeight;
    outer.remove();
    return { w: Math.max(0, w), h: Math.max(0, h) };
  }

  function isBlankOrComment(rawLine) {
    const trimmed = rawLine.trim();
    if (!trimmed) return true;
    const afterIndent = rawLine.replace(/^\s+/, "");
    return afterIndent.startsWith("#");
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

  function parseUxlVersionIfPresent(lines, startIndex, sourceName) {
    // First significant line may be a version header: UXL:1.0
    for (let i = startIndex; i < lines.length; i++) {
      const rawLine = lines[i];
      if (isBlankOrComment(rawLine)) continue;
      const meta = { line: i + 1, col: 1, sourceName, lineText: rawLine };
      assertNoTabs(rawLine, meta);
      const s = rawLine.trim();
      const m = /^UXL\s*:\s*([0-9]+(?:\.[0-9]+){1,2})$/i.exec(s);
      if (!m) return { version: null, nextIndex: i };
      return { version: m[1], nextIndex: i + 1 };
    }
    return { version: null, nextIndex: lines.length };
  }

  function parseWindowSizeIfPresent(lines, startIndex, sourceName, mode) {
    // Find first significant line, attempt to parse WxH (integers >0), with optional overflow suffix per axis.
    // Axis syntax: number [C|S]  (window size is always px; '%' is forbidden here)
    // If not present, default 500x500.
    for (let i = startIndex; i < lines.length; i++) {
      const rawLine = lines[i];
      if (isBlankOrComment(rawLine)) continue;
      const meta = { line: i + 1, col: 1, sourceName, lineText: rawLine };
      assertNoTabs(rawLine, meta);
      const s = rawLine.trim();
      const m = /^(\d+)([CS])?\s*[xX]\s*(\d+)([CS])?$/i.exec(s);
      if (!m) return { size: { w: 500, h: 500, overflowW: null, overflowH: null }, nextIndex: i };
      const w = Number(m[1]);
      const overflowW = m[2] ? (String(m[2]).toUpperCase() === "C" ? "crop" : "scroll") : null;
      const h = Number(m[3]);
      const overflowH = m[4] ? (String(m[4]).toUpperCase() === "C" ? "crop" : "scroll") : null;
      if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
        throw new UxlParseError("Некорректный размер окна (ожидается W>0, H>0, целые).", meta);
      }
      if (mode === "strict") {
        // Guard against invalid combos (e.g. both C and S). Regex already prevents it; keep for clarity.
    }
      return { size: { w, h, overflowW, overflowH }, nextIndex: i + 1 };
    }
    return { size: { w: 500, h: 500, overflowW: null, overflowH: null }, nextIndex: lines.length };
  }

  function parseDim(raw, meta, { allowPercent = true, allowOverflow = true } = {}) {
    // Axis syntax: number[%][C|S]
    // Overflow suffix requires explicit number (no "Cx").
    if (raw == null || raw === "") return null;
    if (raw.toLowerCase().includes("px")) {
      throw new UxlParseError('Суффикс "px" запрещен. Пиксели задаются числом без суффикса.', meta);
    }
    const s = String(raw).trim();
    if (!s) return null;

    // Extract overflow suffix (C/S) if present.
    let overflow = null;
    let core = s;
    if (allowOverflow) {
      const last = core.slice(-1).toUpperCase();
      if (last === "C" || last === "S") {
        overflow = last === "C" ? "crop" : "scroll";
        core = core.slice(0, -1);
      }
    }

    // Overflow suffix requires explicit number; "Cx" is handled earlier at SIZE-level, but keep guard here.
    if (overflow && (!core || core === "%")) {
      throw new UxlParseError("crop/scroll требует явного числа по оси (например 100C или 30%S).", meta);
    }

    if (core.endsWith("%")) {
      if (!allowPercent) throw new UxlParseError("Проценты здесь запрещены.", meta);
      const n = core.slice(0, -1);
      if (!/^\d+$/.test(n)) throw new UxlParseError("Проценты должны быть целым числом (например 33%).", meta);
      const v = Number(n);
      if (!Number.isInteger(v) || v < 0 || v > 100) throw new UxlParseError("Проценты должны быть в диапазоне 0..100%.", meta);
      return { unit: "%", value: v, overflow };
    }

    if (!/^\d+$/.test(core)) throw new UxlParseError("Пиксели должны быть целым числом без суффикса.", meta);
    const v = Number(core);
    if (!Number.isInteger(v) || v < 0) throw new UxlParseError("Пиксели должны быть целым числом >= 0.", meta);
    return { unit: "px", value: v, overflow };
  }

  function parseSize(sizeStr, meta) {
    if (!sizeStr) return { w: null, h: null };
    // allow partial: Wx, xH, W%x, xH%
    const idx = sizeStr.indexOf("x");
    if (idx === -1) throw new UxlParseError('SIZE должен быть в формате "WxH" (допустимы частичные Wx / xH).', meta);
    const wRaw = sizeStr.slice(0, idx);
    const hRaw = sizeStr.slice(idx + 1);
    // Guard: "Cx100" / "Sx100" etc are invalid (overflow requires explicit number)
    if (/^[CS]$/i.test(wRaw.trim())) throw new UxlParseError("crop/scroll требует явного числа по ширине (например 100C).", meta);
    if (/^[CS]$/i.test(hRaw.trim())) throw new UxlParseError("crop/scroll требует явного числа по высоте (например 100S).", meta);
    return { w: parseDim(wRaw, meta, { allowPercent: true, allowOverflow: true }), h: parseDim(hRaw, meta, { allowPercent: true, allowOverflow: true }) };
  }

  function parseAlign(alignStr, meta) {
    const s = (alignStr || "").trim().toUpperCase();
    if (!s) return { h: null, v: null };
    if (!/^[LRTBCM]+$/.test(s)) throw new UxlParseError("ALIGN может содержать только символы L, R, T, B, C, M.", meta);
    const hasL = s.includes("L");
    const hasR = s.includes("R");
    const hasC = s.includes("C");
    const hasT = s.includes("T");
    const hasB = s.includes("B");
    const hasM = s.includes("M");
    const hCount = Number(hasL) + Number(hasR) + Number(hasC);
    const vCount = Number(hasT) + Number(hasB) + Number(hasM);
    if (hCount > 1) throw new UxlParseError("ALIGN: по горизонтали можно указать только одно из L/R/C.", meta);
    if (vCount > 1) throw new UxlParseError("ALIGN: по вертикали можно указать только одно из T/B/M.", meta);
    // C/M mean "center"/"middle" which maps to null (default center) on that axis.
    return { h: hasL ? "L" : hasR ? "R" : null, v: hasT ? "T" : hasB ? "B" : null };
  }

  function normalizeId(id) {
    return (id || "").trim().toLowerCase();
  }

  function parseAction(actionStr, meta, mode) {
    const s = (actionStr || "").trim();
    if (!s) return null;
    if (/^GOTOBACK$/i.test(s)) return { type: "GOTOBACK" };
    const m = /^GOTO:(.+)$/.exec(s);
    if (m) return { type: "GOTO", target: m[1].trim() };
    const old = /^GOTO:P(.+)$/.exec(s);
    if (old) return { type: "GOTO", target: old[1].trim() };
    if (mode === "strict") throw new UxlParseError(`Неизвестная команда ACTION: "${s}".`, meta);
    return null; // permissive: ignore
  }

  function stripTrailingBackslash(rawLine) {
    // Allow trailing '\' (treated as if it wasn't there). Trim only the final backslash with trailing spaces.
    if (rawLine.trimEnd().endsWith("\\")) {
      return rawLine.replace(/\s*\\\s*$/, "");
    }
    return rawLine;
  }

  function parseTagLine(rawLine, lineNo, sourceName, mode) {
    const meta = { line: lineNo, col: 1, sourceName, lineText: rawLine };
    assertNoTabs(rawLine, meta);
    rawLine = stripTrailingBackslash(rawLine);

    const indent = countLeadingSpaces(rawLine);
    if (indent % 2 !== 0) {
      throw new UxlParseError("Отступ должен быть кратен двум пробелам.", meta);
    }
    const text = rawLine.trim();
    const fields = splitFields(text, meta);
    const tag = (fields[0] || "").trim().toUpperCase();
    if (!tag) throw new UxlParseError("Пустой TAG.", meta);

    const get = (idx) => (fields[idx] == null ? "" : fields[idx]);

    function tagFormatHelp(t) {
      switch (t) {
        case "P":
          return {
            format:
              "P\\CAPTION[\\...поля...] или P\\ID\\CAPTION[\\...поля...] (поля в любом порядке: IN:M10=padding, IN:<ALIGN>, IN:H|IN:V, GOTOAFTER:3, TYPE:G, HINT)",
            example: "P\\users\\Пользователи\\TYPE:G\\GOTOAFTER:3\\IN:M12\\IN:LT\\IN:V\\Подсказка страницы",
          };
        case "F":
          return {
            format: 'F\\[SIZE/ALIGN/IN:M10/IN:<ALIGN>/IN:H|IN:V/#RRGGBB/BG:"<url>"/HINT...] (поля в любом порядке)',
            example: 'F\\100%x\\T\\IN:M12\\IN:H\\BG:"src/yarmap.PNG"\\#f0f0f0\\Контейнер',
          };
        case "I":
          return {
            format:
              'I\\SRC:"<url>"|<iconName>\\[SIZE/ALIGN/FIT|CROP/ICON:NAME[:SIZE]/M10/R6/HINT...] (поля в любом порядке; без PADDING). Если SRC — это имя встроенной иконки, рисуется SVG-иконка.',
            example: "I\\home\\24x24\\OUT:LT\\Подсказка иконки",
          };
        case "B":
          return {
            format: "B\\CAPTION|ICON:NAME[:SIZE]\\[SIZE/ALIGN/ACTION/ICON:NAME[:SIZE]/OUT:<ALIGN>[:M10]/IN:M10/IN:L|IN:C|IN:R/R6/HINT...] (поля в любом порядке)",
            example: "B\\ICON:search:18\\100x\\OUT:RB:M6\\IN:M8\\IN:L\\R8\\GOTO:users\\Поиск",
          };
        case "C":
          return {
            format: "C\\CAPTION\\[SIZE/ALIGN/OUT:<ALIGN>[:M10]/IN:M10/IN:L|IN:C|IN:R/FONT:24[:BI]/HINT...] (поля в любом порядке)",
            example: "C\\Текст\\x20\\OUT:LT:M4\\IN:M6\\IN:C\\FONT:24:BI\\Подсказка",
          };
        case "T":
          return {
            format: "T\\COLS:...\\[SIZE/ALIGN/OUT:<ALIGN>[:M10]/IN:M10/IN:L|IN:C|IN:R/HINT...] (поля в любом порядке; IN:M10 задаёт padding ячеек TH/TD)",
            example: "T\\COLS:20R,80L\\100%x100%\\OUT:T:M10\\IN:M6\\IN:L\\Таблица",
          };
        case "S":
          return {
            format:
              "S\\VALUE\\OPT\\OPT...[\\SIZE/ALIGN/OUT:<ALIGN>[:M10]/IN:M10/HINT...] (VALUE — индекс 0..N-1; OPT: пусто (\\\\\\\\), текст или ICON:NAME[:SIZE])",
            example: "S\\0\\\\ICON:grid3x3\\Сетка\\120x28\\OUT:LT:M6\\IN:M2\\Переключатель",
          };
        case "TH":
          return { format: "TH\\C\\C\\...", example: "TH\\ID\\ФИО\\Роль" };
        case "TD":
          return { format: "TD\\C\\C\\...", example: "TD\\1\\Алексей\\Админ" };
        default:
          return { format: "см. UXL.md", example: "" };
      }
    }

    function formatError(t, details) {
      const h = tagFormatHelp(t);
      const extra = details ? ` ${details}` : "";
      const ex = h.example ? ` Пример: ${h.example}` : "";
      return new UxlParseError(`Неверный формат тега ${t}.${extra} Ожидается: ${h.format}.${ex}`, meta);
    }

    function parseCommon({ caption = "", sizeStr = "", alignStr = "", actionStr = "", hint = "" } = {}) {
      const size = sizeStr ? parseSize(sizeStr, meta) : null;
      const align = alignStr ? parseAlign(alignStr, meta) : { h: null, v: null };
      const action = actionStr ? parseAction(actionStr, meta, mode) : null;
      return { caption: caption || "", size, align, action, hint: hint || "" };
    }

    function isSizeToken(s) {
      const v = String(s || "").trim();
      // SIZE must look like WxH (partial forms allowed: Wx / xH), with optional % and overflow suffix C/S.
      // We intentionally do NOT treat arbitrary text containing "x" as SIZE (e.g. hints like "xH, aspect").
      // Examples: "100x", "x20", "50%x30%S", "100Cx"
      if (!v) return false;
      if (/\s/.test(v)) return false;
      return /^(\d+%?[CS]?)?[xX](\d+%?[CS]?)?$/.test(v) && v.toLowerCase() !== "x";
    }

    function isAlignToken(s) {
      const v = String(s || "").trim().toUpperCase();
      if (!v) return false;
      if (!/^[LRTBCM]+$/.test(v)) return false;
      const hasL = v.includes("L");
      const hasR = v.includes("R");
      const hasC = v.includes("C");
      const hasT = v.includes("T");
      const hasB = v.includes("B");
      const hasM = v.includes("M");
      if (Number(hasL) + Number(hasR) + Number(hasC) > 1) return false;
      if (Number(hasT) + Number(hasB) + Number(hasM) > 1) return false;
      return true;
    }

    function parseOutToken(raw) {
      const v = String(raw || "").trim();
      if (!/^OUT:/i.test(v)) return null;
      const rest = v.slice(4);
      if (!rest) return null;
      const parts = rest.split(":").map((p) => p.trim()).filter(Boolean);
      if (!parts.length) return null;

      let align = "";
      let marginPx = null;

      for (const p of parts) {
        if (/^M\d+$/i.test(p)) {
          const n = parseIntNonNegative(p.slice(1), meta, "MARGIN");
          if (marginPx != null) throw new UxlParseError("OUT: M указан более одного раза.", meta);
          marginPx = n;
          continue;
        }
        const up = p.toUpperCase();
        if (isAlignToken(up)) {
          if (align) throw new UxlParseError("OUT: ALIGN указан более одного раза.", meta);
          align = up;
          continue;
        }
        throw new UxlParseError(`OUT: неизвестная часть "${p}". Ожидается OUT:<ALIGN>[:M<number>] или OUT:M<number>[:<ALIGN>].`, meta);
      }

      return { align, marginPx };
    }

    function parseInToken(raw) {
      const v = String(raw || "").trim();
      if (!/^IN:/i.test(v)) return null;
      const rest = v.slice(3);
      if (!rest) throw new UxlParseError('IN: ожидается IN:<ALIGN>[:M<number>][:H|V][:W|NW] или IN:M<number>[:<ALIGN>][:H|V][:W|NW].', meta);
      const parts = rest.split(":").map((p) => p.trim()).filter(Boolean);
      if (!parts.length) throw new UxlParseError('IN: ожидается IN:<ALIGN>[:M<number>][:H|V][:W|NW] или IN:M<number>[:<ALIGN>][:H|V][:W|NW].', meta);

      let align = "";
      let paddingPx = null;
      let flow = "";
      let wrap = ""; // W | NW

      for (const p of parts) {
        if (/^M\d+$/i.test(p)) {
          const n = parseIntNonNegative(p.slice(1), meta, "PADDING");
          if (paddingPx != null) throw new UxlParseError("IN: M (padding) указан более одного раза.", meta);
          paddingPx = n;
          continue;
        }
        if (/^(W|NW)$/i.test(p)) {
          const up = p.toUpperCase();
          if (wrap) throw new UxlParseError("IN: WRAP (W/NW) указан более одного раза.", meta);
          wrap = up;
          continue;
        }
        if (/^[HV]$/i.test(p)) {
          const up = p.toUpperCase();
          if (flow) throw new UxlParseError("IN: FLOW (H/V) указан более одного раза.", meta);
          flow = up; // H or V
          continue;
        }
        const up = p.toUpperCase();
        if (isAlignToken(up)) {
          if (align) throw new UxlParseError("IN: ALIGN указан более одного раза.", meta);
          align = up;
          continue;
        }
        throw new UxlParseError(`IN: неизвестная часть "${p}". Ожидается IN:<ALIGN>[:M<number>][:H|V][:W|NW] или IN:M<number>[:<ALIGN>][:H|V][:W|NW].`, meta);
      }

      if (!align && paddingPx == null && !flow && !wrap) {
        throw new UxlParseError('IN: ожидается IN:<ALIGN>[:M<number>][:H|V][:W|NW] или IN:M<number>[:<ALIGN>][:H|V][:W|NW].', meta);
      }
      return { align, paddingPx, flow, wrap };
    }

    function isActionToken(s) {
      const v = String(s || "").trim().toUpperCase();
      return v === "GOTOBACK" || v.startsWith("GOTO:") || v.startsWith("GOTO:P");
    }

    function isColsToken(s) {
      const v = String(s || "").trim().toUpperCase();
      return v.startsWith("COLS:");
    }

    function isIconToken(s) {
      const v = String(s || "").trim();
      return /^ICON:/i.test(v);
    }

    function isSrcToken(s) {
      const v = String(s || "").trim();
      return /^SRC:/i.test(v);
    }

    function isFitToken(s) {
      const v = String(s || "").trim().toUpperCase();
      // New syntax:
      // - FIT  => contain
      // - CROP => cover
      // Backward compatible:
      // - FIT:contain / FIT:cover
      return v === "FIT" || v === "CROP" || v.startsWith("FIT:");
    }

    function isBgToken(s) {
      const v = String(s || "").trim();
      return /^BG:/i.test(v);
    }

    function isColorToken(s) {
      const v = String(s || "").trim();
      return /^#[0-9a-fA-F]{6}$/.test(v);
    }

    function parseColorHex(raw, metaForErr) {
      const v = String(raw || "").trim();
      if (!/^#[0-9a-fA-F]{6}$/.test(v)) throw new UxlParseError('COLOR должен быть в формате "#RRGGBB" (например "#001122").', metaForErr);
      return `#${v.slice(1).toLowerCase()}`;
    }

    function parseIntNonNegative(raw, metaForErr, what) {
      const n = Number.parseInt(String(raw), 10);
      if (!Number.isFinite(n) || String(n) !== String(raw).trim()) {
        throw new UxlParseError(`${what} должно быть целым числом (например 8).`, metaForErr);
      }
      if (n < 0) throw new UxlParseError(`${what} должно быть >= 0.`, metaForErr);
      return n;
    }

    const BUILTIN_BUTTON_ICONS = Object.freeze([
      "ai",
      "arrow-left",
      "arrow-right",
      "back",
      "box",
      "check",
      "chevron-left",
      "chevron-right",
      "clock",
      "close",
      "codepen",
      "cpu",
      "edit",
      "grid",
      "grid1x1",
      "grid3x3",
      "grid4x4",
      "home",
      "loader",
      "menu",
      "microphone",
      "more-horizontal",
      "plus",
      "search",
      "sliders",
      "sun",
      "settings",
      "trash",
      "volume-2",
      "volume-x",
    ]);

    function isMarginToken(s) {
      const v = String(s || "").trim();
      return /^M\d+$/i.test(v);
    }

    function isPaddingToken(s) {
      const v = String(s || "").trim();
      return /^P\d+$/i.test(v);
    }

    function isRadiusToken(s) {
      const v = String(s || "").trim();
      return /^R\d+$/i.test(v);
    }

    function isGotoAfterToken(s) {
      const v = String(s || "").trim();
      return /^GOTOAFTER:(\d+(?:\.\d+)?)$/i.test(v);
    }

    function parseGotoAfterSeconds(token, metaForErr) {
      const m = /^GOTOAFTER:(\d+(?:\.\d+)?)$/i.exec(String(token || "").trim());
      if (!m) throw new UxlParseError(`Некорректный формат GOTOAFTER (ожидается "GOTOAFTER:3" или "GOTOAFTER:1.5").`, metaForErr);
      const sec = Number.parseFloat(m[1]);
      if (!Number.isFinite(sec)) throw new UxlParseError("GOTOAFTER должно быть числом секунд.", metaForErr);
      if (sec < 0) throw new UxlParseError("GOTOAFTER должно быть >= 0.", metaForErr);
      return sec;
    }

  function isFontToken(s) {
    const v = String(s || "").trim();
    return /^FONT:/i.test(v);
  }

  function parseFontToken(token, metaForErr) {
    const raw = String(token || "").trim();
    const m = /^FONT:(\d+)(?::([BI]{1,2}))?$/i.exec(raw);
    if (!m) throw new UxlParseError('FONT должен быть вида "FONT:24" или "FONT:24:BI" (B=bold, I=italic).', metaForErr);
    const sizePx = Number.parseInt(m[1], 10);
    if (!Number.isFinite(sizePx) || sizePx <= 0) throw new UxlParseError("FONT размер должен быть целым числом > 0 (px).", metaForErr);
    const flags = (m[2] || "").toUpperCase();
    const uniqueFlags = new Set(flags.split("").filter(Boolean));
    if ([...uniqueFlags].some((f) => f !== "B" && f !== "I")) {
      throw new UxlParseError('FONT флаги поддерживают только B (bold) и I (italic).', metaForErr);
    }
    return { sizePx, bold: uniqueFlags.has("B"), italic: uniqueFlags.has("I") };
  }

    function parseUnorderedFields(
      tokens,
      {
        allowSize = true,
        allowAlign = true,
        allowInAlign = false,
        allowAction = true,
        allowHint = true,
        allowCols = false,
        allowMargin = false,
        allowPadding = false,
        allowRadius = false,
        allowIcon = false,
        allowSrc = false,
        allowFit = false,
        allowBg = false,
        allowGotoAfter = false,
        allowColor = false,
      allowFont = false,
        allowWrap = false, // W | NW (text wrapping inside content tags)
        allowType = false, // TYPE:G (pages in map without edges, placed at bottom)
      } = {},
    ) {
      let sizeStr = "";
      let alignStr = "";
      let inAlignStr = "";
      let actionStr = "";
      let hint = "";
      let colsSpec = "";
      let marginPx = null;
      let paddingPx = null;
      let radiusPx = null;
      let iconName = "";
      let iconSizePx = null;
      let srcUrl = "";
      let fitMode = "";
      let bgUrl = "";
      let gotoAfterSec = null;
      let colorHex = "";
    let fontSpec = null;
      let wrapMode = ""; // "" (default=W) | "W" | "NW"
      let typeStr = ""; // "" | "G"
      let inFlow = "";
      let textAlignStr = "";

      const parsePrefixedUrl = (rawToken, prefix, kindForMsg) => {
        const raw = String(rawToken || "").trim();
        const rest = String(raw.slice(prefix.length)).trim();
        if (!rest) {
          throw formatError(tag, `${kindForMsg} должен быть вида "${prefix}\\"...\\"" (URL не может быть пустым).`);
        }
        if (rest.startsWith('"')) {
          const url = unescapeQuotedField(rest, meta);
          if (!url) throw formatError(tag, `${kindForMsg} должен быть вида "${prefix}\\"...\\"" (URL не может быть пустым).`);
          return url;
        }
        if (mode === "strict") {
          throw formatError(tag, `${kindForMsg} в strict-режиме должен быть в кавычках: "${prefix}\\"...\\"" (например ${prefix}"src/yarmap.PNG").`);
        }
        // permissive: allow legacy unquoted form
        return rest;
      };

      const setOnce = (kind, val) => {
        if (kind === "size") {
          if (sizeStr) throw formatError(tag, "SIZE указан более одного раза.");
          sizeStr = val;
          return;
        }
        if (kind === "align") {
          if (alignStr) throw formatError(tag, "ALIGN указан более одного раза.");
          alignStr = val;
          return;
        }
        if (kind === "inAlign") {
          if (inAlignStr) throw formatError(tag, "IN:ALIGN указан более одного раза.");
          inAlignStr = val;
          return;
        }
        if (kind === "inFlow") {
          if (inFlow) throw formatError(tag, "IN:FLOW (H/V) указан более одного раза.");
          inFlow = val;
          return;
        }
        if (kind === "textAlign") {
          if (textAlignStr) throw formatError(tag, "IN:L/C/R указан более одного раза.");
          textAlignStr = val;
          return;
        }
        if (kind === "action") {
          if (actionStr) throw formatError(tag, "ACTION указан более одного раза.");
          actionStr = val;
          return;
        }
        if (kind === "cols") {
          if (colsSpec) throw formatError(tag, "COLS указан более одного раза.");
          colsSpec = val;
          return;
        }
        if (kind === "hint") {
          if (hint) throw formatError(tag, "HINT указан более одного раза.");
          hint = val;
          return;
        }
        if (kind === "margin") {
          if (marginPx != null) throw formatError(tag, "MARGIN указан более одного раза.");
          marginPx = val;
          return;
        }
        if (kind === "padding") {
          if (paddingPx != null) throw formatError(tag, "PADDING указан более одного раза.");
          paddingPx = val;
          return;
        }
        if (kind === "radius") {
          if (radiusPx != null) throw formatError(tag, "RADIUS указан более одного раза.");
          radiusPx = val;
          return;
        }
        if (kind === "icon") {
          if (iconName) throw formatError(tag, "ICON указан более одного раза.");
          iconName = val;
          return;
        }
        if (kind === "iconSize") {
          if (iconSizePx != null) throw formatError(tag, "ICON size указан более одного раза.");
          iconSizePx = val;
          return;
        }
        if (kind === "bg") {
          if (bgUrl) throw formatError(tag, "BG указан более одного раза.");
          bgUrl = val;
          return;
        }
        if (kind === "src") {
          if (srcUrl) throw formatError(tag, "SRC указан более одного раза.");
          srcUrl = val;
          return;
        }
        if (kind === "fit") {
          if (fitMode) throw formatError(tag, "FIT указан более одного раза.");
          fitMode = val;
          return;
        }
        if (kind === "gotoAfter") {
          if (gotoAfterSec != null) throw formatError(tag, "GOTOAFTER указан более одного раза.");
          gotoAfterSec = val;
          return;
        }
        if (kind === "color") {
          if (colorHex) throw formatError(tag, "COLOR указан более одного раза.");
          colorHex = val;
          return;
        }
      if (kind === "font") {
        if (fontSpec) throw formatError(tag, "FONT указан более одного раза.");
        fontSpec = val;
        return;
      }
        if (kind === "wrap") {
          if (wrapMode) throw formatError(tag, "WRAP (W/NW) указан более одного раза.");
          wrapMode = val;
          return;
        }
        if (kind === "type") {
          if (typeStr) throw formatError(tag, "TYPE указан более одного раза.");
          typeStr = val;
          return;
        }
      };

      for (const raw of tokens) {
        const v = String(raw ?? "").trim();
        if (!v) continue;
        if (isMarginToken(v)) {
          throw formatError(tag, `Поле "${v}" (margin) запрещено. Используйте OUT:<ALIGN>:${v} или OUT:${v}.`);
        }
        if (isPaddingToken(v)) {
          throw formatError(tag, `Поле "${v}" (padding) запрещено. Используйте IN:M<number> (например IN:M8).`);
        }
        if (isRadiusToken(v) && !allowRadius) {
          throw formatError(tag, `Поле "${v}" (radius) не поддерживается для этого тега.`);
        }
        if (isIconToken(v) && !allowIcon) {
          throw formatError(tag, `Поле "${v}" (icon) не поддерживается для этого тега.`);
        }
        if (isSrcToken(v) && !allowSrc) {
          throw formatError(tag, `Поле "${v}" (src) не поддерживается для этого тега.`);
        }
        if (isFitToken(v) && !allowFit) {
          throw formatError(tag, `Поле "${v}" (fit) не поддерживается для этого тега.`);
        }
        if (isBgToken(v) && !allowBg) {
          throw formatError(tag, `Поле "${v}" (bg) не поддерживается для этого тега.`);
        }
        if (isColorToken(v) && !allowColor) {
          throw formatError(tag, `Поле "${v}" (color) не поддерживается для этого тега.`);
        }
      if (isFontToken(v) && !allowFont) {
        throw formatError(tag, `Поле "${v}" (font) не поддерживается для этого тега.`);
      }
        if ((/^W$/i.test(v) || /^NW$/i.test(v)) && !allowWrap) {
          throw formatError(tag, `Поле "${v}" (wrap) не поддерживается для этого тега.`);
        }
        if (isGotoAfterToken(v) && !allowGotoAfter) {
          throw formatError(tag, `Поле "${v}" (GOTOAFTER) не поддерживается для этого тега.`);
        }
        if (/^TYPE:/i.test(v) && !allowType) {
          throw formatError(tag, `Поле "${v}" (type) не поддерживается для этого тега.`);
        }
        if (allowRadius && isRadiusToken(v)) {
          const n = parseIntNonNegative(v.slice(1), meta, "RADIUS");
          setOnce("radius", n);
          continue;
        }
        if (allowIcon && isIconToken(v)) {
          const raw = String(v.slice("ICON:".length)).trim();
          if (!raw) throw formatError(tag, `ICON должен быть вида "ICON:NAME" или "ICON:NAME:16", например "ICON:search:18".`);
          const parts = raw.split(":").map((s) => s.trim()).filter(Boolean);
          const name = String(parts[0] || "").toLowerCase();
          const sizeRaw = parts[1] ?? "";
          if (!name) throw formatError(tag, `ICON должен быть вида "ICON:NAME" или "ICON:NAME:16", например "ICON:search:18".`);
          if (!BUILTIN_BUTTON_ICONS.includes(name)) {
            throw formatError(
              tag,
              `Неизвестная иконка "${name}". Разрешены: ${BUILTIN_BUTTON_ICONS.join(", ")}.`,
            );
          }
          setOnce("icon", name);
          if (sizeRaw !== "") {
            const n = parseIntNonNegative(sizeRaw, meta, "ICON size");
            // Guard rails:
            // - Buttons: keep it compact.
            // - Images/icons (I): allow larger sizes for grid-like UIs.
            const min = 8;
            const max = tag === "I" ? 256 : 48;
            if (n < min || n > max) throw formatError(tag, `ICON size должен быть в диапазоне ${min}..${max} px.`);
            setOnce("iconSize", n);
          }
          continue;
        }
        if (allowBg && isBgToken(v)) {
          const url = parsePrefixedUrl(v, "BG:", "BG");
          setOnce("bg", url);
          continue;
        }
        if (allowSrc && isSrcToken(v)) {
          const url = parsePrefixedUrl(v, "SRC:", "SRC");
          setOnce("src", url);
          continue;
        }
        if (allowFit && isFitToken(v)) {
          const up = String(v).trim().toUpperCase();
          if (up === "FIT") {
            setOnce("fit", "contain");
            continue;
          }
          if (up === "CROP") {
            setOnce("fit", "cover");
            continue;
          }
          const raw = String(v.slice("FIT:".length)).trim().toLowerCase();
          if (raw !== "contain" && raw !== "cover") {
            throw formatError(tag, 'FIT должен быть "FIT" или "CROP" (или legacy "FIT:contain"/"FIT:cover").');
          }
          setOnce("fit", raw);
          continue;
        }
        if (allowColor && isColorToken(v)) {
          const c = parseColorHex(v, meta);
          setOnce("color", c);
          continue;
        }
      if (allowFont && isFontToken(v)) {
        const spec = parseFontToken(v, meta);
        setOnce("font", spec);
        continue;
      }
        if (allowWrap && (/^W$/i.test(v) || /^NW$/i.test(v))) {
          const up = String(v).trim().toUpperCase();
          setOnce("wrap", up === "NW" ? "NW" : "W");
          continue;
        }
        if (allowGotoAfter && isGotoAfterToken(v)) {
          const sec = parseGotoAfterSeconds(v, meta);
          setOnce("gotoAfter", sec);
          continue;
        }
        if (allowType && /^TYPE:/i.test(v)) {
          const m = /^TYPE:(.+)$/i.exec(v);
          const t = String(m?.[1] || "").trim().toUpperCase();
          if (t !== "G") throw formatError(tag, 'TYPE пока поддерживает только "TYPE:G".');
          setOnce("type", "G");
          continue;
        }
        if (allowCols && isColsToken(v)) {
          setOnce("cols", v);
          continue;
        }
        if (allowAction && isActionToken(v)) {
          setOnce("action", v);
          continue;
        }
        if (allowSize && isSizeToken(v)) {
          setOnce("size", v);
          continue;
        }
        const inTok = parseInToken(v);
        if (inTok) {
          if (!allowInAlign) throw formatError(tag, `Поле "${v}" (IN) не поддерживается для этого тега.`);
          if (inTok.align) {
            const a = String(inTok.align || "").trim().toUpperCase();
            if (tag === "P" || tag === "F") {
              setOnce("inAlign", a);
            } else if (tag === "B" || tag === "C" || tag === "T") {
              // On non-containers, IN:<ALIGN> is repurposed for content/text alignment.
              // Supported: horizontal only (L/C/R). Vertical anchors (T/B/M) are not applicable here.
              if (a !== "L" && a !== "C" && a !== "R") {
                throw formatError(tag, `Поле "${v}" (IN align) для этого тега допускает только L/C/R (выравнивание контента внутри).`);
              }
              setOnce("textAlign", a);
            } else {
              throw formatError(tag, `Поле "${v}" (IN align) не поддерживается для этого тега.`);
            }
          }
          if (inTok.paddingPx != null) setOnce("padding", inTok.paddingPx);
          if (inTok.wrap) {
            if (!allowWrap) throw formatError(tag, `Поле "${v}" (IN wrap W/NW) не поддерживается для этого тега.`);
            setOnce("wrap", inTok.wrap === "NW" ? "NW" : "W");
          }
          if (inTok.flow) {
            // Flow makes sense only for containers.
            if (tag !== "P" && tag !== "F") throw formatError(tag, `Поле "${v}" (IN flow) не поддерживается для этого тега.`);
            setOnce("inFlow", inTok.flow);
          }
          continue;
        }
        if (/^IN:/i.test(v)) {
          throw formatError(tag, `Поле "${v}" не распознано. Ожидается IN:<ALIGN>[:M<number>][:H|V] или IN:M<number>[:<ALIGN>][:H|V].`);
        }
        const out = parseOutToken(v);
        if (out) {
          if (out.align) {
            if (!allowAlign) throw formatError(tag, `Поле "${v}" (out align) не поддерживается для этого тега.`);
            setOnce("align", out.align);
          }
          if (out.marginPx != null) {
            if (!allowMargin) throw formatError(tag, `Поле "${v}" (out margin) не поддерживается для этого тега.`);
            setOnce("margin", out.marginPx);
          }
          continue;
        }
        if (allowAlign && isAlignToken(v)) {
          setOnce("align", v);
          continue;
        }
        if (allowHint) {
          setOnce("hint", v);
          continue;
        }
        throw formatError(tag, `Не удалось распознать поле "${v}".`);
      }
      return {
        sizeStr,
        alignStr,
        inAlignStr,
        inFlow,
        textAlignStr,
        actionStr,
        hint,
        colsSpec,
        marginPx,
        paddingPx,
        radiusPx,
        iconName,
        iconSizePx,
        srcUrl,
        fitMode,
        bgUrl,
        gotoAfterSec,
        colorHex,
      fontSpec,
        wrapMode,
        typeStr,
      };
    }

    if (tag === "P") {
      // P supports both forms:
      // - P\CAPTION[\...поля...]
      // - P\ID\CAPTION[\...поля...]  (ID must match [A-Za-z0-9_-]+)
      // Additional fields are unordered; supported: IN:M10 (padding), IN:<ALIGN> (default child align), GOTOAFTER:<sec>, HINT.
      let id = "";
      let caption = "";
      const idRe = /^[A-Za-z0-9_-]+$/;

      let restTokens = [];
      const f1 = get(1);
      const f2 = get(2);
      const f3 = get(3);
      if (fields.length >= 3 && idRe.test(String(f1).trim())) {
        id = f1;
        // Support a permissive variant: P\ID\TYPE:G\CAPTION[\...]
        // (TYPE is still an unordered field; this just makes authoring less error-prone.)
        if (/^TYPE:/i.test(String(f2 || "").trim()) && String(f3 || "").trim()) {
          caption = f3;
          restTokens = [f2, ...fields.slice(4)];
        } else {
          caption = f2;
          restTokens = fields.slice(3);
        }
      } else {
        // Support permissive variant: P\TYPE:G\CAPTION[\...]
        if (/^TYPE:/i.test(String(f1 || "").trim()) && String(f2 || "").trim()) {
          caption = f2;
          restTokens = [f1, ...fields.slice(3)];
        } else {
          caption = f1;
          restTokens = fields.slice(2);
        }
      }

      const rest = parseUnorderedFields(restTokens, {
        allowSize: false,
        allowAlign: false,
        allowInAlign: true,
        allowAction: false,
        allowHint: true,
        allowCols: false,
        allowMargin: false,
        allowGotoAfter: true,
        allowType: true,
      });
      const hint = rest.hint || "";
      const padding = rest.paddingPx ?? 0;
      const gotoAfterSec = rest.gotoAfterSec;
      const inAlign = rest.inAlignStr ? parseAlign(rest.inAlignStr, meta) : null;
      const inFlow = rest.inFlow || "";
      const type = rest.typeStr || "";
      return { indent, node: { tag, id, caption, type, padding, inAlign, inFlow, gotoAfterSec, size: null, align: null, action: null, hint, rawLineNo: lineNo } };
    }

    if (tag === "TH" || tag === "TD") {
      // TH/TD: TH\cell\cell...\[W|NW]\[IN:...]
      const rawCells = fields.slice(1);
      if (rawCells.length === 0) throw formatError(tag, "Должна быть хотя бы одна ячейка.");
      let wrap = "";
      let cellPadding = null;

      // Optional tail IN:... (for wrap + optional per-row cell padding)
      const lastRaw = String(rawCells[rawCells.length - 1] ?? "").trim();
      const inTok = /^IN:/i.test(lastRaw) ? parseInToken(lastRaw) : null;
      if (inTok) {
        if (inTok.align) throw formatError(tag, `Поле "${lastRaw}" (IN align) не поддерживается для ${tag}.`);
        if (inTok.flow) throw formatError(tag, `Поле "${lastRaw}" (IN flow) не поддерживается для ${tag}.`);
        if (inTok.wrap) wrap = inTok.wrap === "NW" ? "NW" : "W";
        if (inTok.paddingPx != null) cellPadding = inTok.paddingPx;
        rawCells.pop();
        if (rawCells.length === 0) throw formatError(tag, "Должна быть хотя бы одна ячейка.");
      }

      // Legacy tail W|NW (kept for backward compatibility)
      const last = String(rawCells[rawCells.length - 1] ?? "").trim().toUpperCase();
      if ((last === "W" || last === "NW") && !wrap) {
        wrap = last;
        rawCells.pop();
        if (rawCells.length === 0) throw formatError(tag, "Должна быть хотя бы одна ячейка.");
      }

      const cells = rawCells;
      return { indent, node: { tag, cells, wrap, cellPadding, rawLineNo: lineNo } };
    }

    // Per-tag formats (ID is not used anywhere except P):
    // S: S\ID\VALUE\OPT\OPT...[\...fields...]
    // B: B\CAPTION[\SIZE][\ALIGN][\ACTION][\HINT]
    // C: C\CAPTION[\SIZE][\ALIGN][\HINT]  (ACTION not used, but accepted/ignored in permissive via parseAction)
    // F: F[\SIZE][\ALIGN][\HINT]
    // T: T[\SIZE][\ALIGN][\HINT] (ACTION is not supported; handled by structure validation)

    if (tag === "B") {
      // B supports two forms:
      // - B\CAPTION[\...fields...]
      // - B\ICON:...[\...fields...]   (icon-only button; caption is empty)
      let caption = get(1);
      let restTokens = fields.slice(2);
      if (isIconToken(caption)) {
        caption = "";
        restTokens = fields.slice(1); // include ICON:... token itself
      }
      if (!String(caption).trim() && restTokens.length === 0) {
        throw formatError("B", 'Нужен CAPTION или ICON:... (например "B\\Кнопка" или "B\\ICON:home").');
      }
      const rest = parseUnorderedFields(restTokens, {
        allowSize: true,
        allowAlign: true,
        allowInAlign: true,
        allowAction: true,
        allowHint: true,
        allowMargin: true,
        allowRadius: true,
        allowIcon: true,
        allowColor: true,
        allowWrap: true,
      });
      if (!String(caption).trim() && !String(rest.iconName || "").trim()) {
        throw formatError("B", 'Нужен CAPTION или ICON:... (например "B\\Кнопка" или "B\\ICON:home").');
      }
      const sizeStr = rest.sizeStr;
      const alignStr = rest.alignStr;
      const actionStr = rest.actionStr;
      const hint = rest.hint;
      const common = parseCommon({ caption, sizeStr, alignStr, actionStr, hint });
      return {
        indent,
        node: {
          tag,
          id: "",
          padding: rest.paddingPx ?? 5,
          margin: rest.marginPx ?? 3,
          radius: rest.radiusPx ?? 6,
          icon: rest.iconName || "",
          iconSize: rest.iconSizePx ?? null,
          textAlign: rest.textAlignStr || "",
          color: rest.colorHex || "",
          wrap: rest.wrapMode || "",
          ...common,
          rawLineNo: lineNo,
        },
      };
    }

    if (tag === "C") {
      const caption = get(1);
      if (!String(caption).trim()) throw formatError("C", "CAPTION обязателен.");
      const rest = parseUnorderedFields(fields.slice(2), {
        allowSize: true,
        allowAlign: true,
        allowInAlign: true,
        allowAction: true,
        allowHint: true,
        allowMargin: true,
        allowColor: true,
        allowFont: true,
        allowWrap: true,
      });
      const sizeStr = rest.sizeStr;
      const alignStr = rest.alignStr;
      const actionStr = rest.actionStr;
      const hint = rest.hint;
      const common = parseCommon({ caption, sizeStr, alignStr, actionStr, hint });
      // C ACTION is not meaningful; strict/permissive behavior is enforced in parseAction.
      return {
        indent,
        node: {
          tag,
          id: "",
          padding: rest.paddingPx ?? 5,
          margin: rest.marginPx ?? 3,
          textAlign: rest.textAlignStr || "",
          color: rest.colorHex || "",
          font: rest.fontSpec ? { ...rest.fontSpec } : null,
          wrap: rest.wrapMode || "",
          ...common,
          rawLineNo: lineNo,
        },
      };
    }

    if (tag === "F") {
      const rest = parseUnorderedFields(fields.slice(1), {
        allowSize: true,
        allowAlign: true,
        allowInAlign: true,
        allowAction: false,
        allowHint: true,
        allowMargin: true,
        allowSrc: false,
        allowFit: false,
        allowBg: true,
        allowColor: true,
      });
      const sizeStr = rest.sizeStr;
      const alignStr = rest.alignStr;
      const hint = rest.hint;
      const bg = rest.bgUrl || "";
      const bgColor = rest.colorHex || "";
      const common = parseCommon({ caption: "", sizeStr, alignStr, actionStr: "", hint });
      const inAlign = rest.inAlignStr ? parseAlign(rest.inAlignStr, meta) : null;
      const inFlow = rest.inFlow || "";
      return {
        indent,
        node: {
          tag,
          id: "",
          padding: rest.paddingPx ?? 0,
          margin: rest.marginPx ?? 0,
          inAlign,
          inFlow,
          bg,
          bgColor,
          ...common,
          rawLineNo: lineNo,
        },
      };
    }

    if (tag === "S") {
      const valueRaw = String(get(1) || "").trim();
      if (!valueRaw) throw formatError("S", "VALUE обязателен (индекс 0..N-1).");
      const value = parseIntNonNegative(valueRaw, meta, "S VALUE");

      const restTokensAll = fields.slice(2);
      // Options go first, then optional unordered fields. Split at first token that looks like a field.
      const isFieldToken = (t) => {
        const v = String(t || "").trim();
        if (!v) return false; // empty is a valid OPT
        if (isSizeToken(v)) return true;
        if (parseOutToken(v)) return true;
        if (/^IN:/i.test(v)) return true;
        if (isColorToken(v)) return true;
        if (isBgToken(v) || isSrcToken(v) || isFitToken(v) || isColsToken(v)) return true;
        if (isActionToken(v) || isGotoAfterToken(v)) return true;
        if (isRadiusToken(v)) return true;
        return false;
      };
      let splitAt = restTokensAll.length;
      for (let i = 0; i < restTokensAll.length; i++) {
        if (isFieldToken(restTokensAll[i])) {
          splitAt = i;
          break;
        }
      }
      const optTokens = restTokensAll.slice(0, splitAt);
      const restTokens = restTokensAll.slice(splitAt);

      if (optTokens.length < 2) throw formatError("S", "Нужно минимум 2 варианта (OPT).");

      const options = optTokens.map((raw) => {
        const v = String(raw ?? "");
        if (v === "") return { kind: "empty" };
        if (isIconToken(v)) {
          const raw2 = String(v.slice("ICON:".length)).trim();
          if (!raw2) throw formatError("S", `ICON в варианте должен быть вида "ICON:NAME" или "ICON:NAME:16".`);
          const parts = raw2.split(":").map((s) => s.trim()).filter(Boolean);
          const name = String(parts[0] || "").toLowerCase();
          const sizeRaw = parts[1] ?? "";
          if (!name) throw formatError("S", `ICON в варианте должен быть вида "ICON:NAME" или "ICON:NAME:16".`);
          if (!BUILTIN_BUTTON_ICONS.includes(name)) {
            throw formatError("S", `Неизвестная иконка "${name}". Разрешены: ${BUILTIN_BUTTON_ICONS.join(", ")}.`);
          }
          let sizePx = null;
          if (sizeRaw !== "") {
            const n = parseIntNonNegative(sizeRaw, meta, "ICON size");
            const min = 8;
            const max = 48;
            if (n < min || n > max) throw formatError("S", `ICON size должен быть в диапазоне ${min}..${max} px.`);
            sizePx = n;
          }
          return { kind: "icon", name, sizePx };
        }
        return { kind: "text", text: v };
      });

      if (value >= options.length) throw formatError("S", `VALUE=${value} вне диапазона 0..${Math.max(0, options.length - 1)}.`);

      for (const t of restTokens) {
        if (isActionToken(t)) throw formatError("S", `ACTION запрещён (пока просто переключатель без действий).`);
      }

      const rest = parseUnorderedFields(restTokens, {
        allowSize: true,
        allowAlign: true,
        allowInAlign: true,
        allowAction: false,
        allowHint: true,
        allowCols: false,
        allowMargin: true,
        allowColor: true,
        allowWrap: true,
      });
      const sizeStr = rest.sizeStr;
      const alignStr = rest.alignStr;
      const hint = rest.hint;
      const common = parseCommon({ caption: "", sizeStr, alignStr, actionStr: "", hint });
      return {
        indent,
        node: {
          tag,
          value,
          options,
          padding: rest.paddingPx ?? 2,
          margin: rest.marginPx ?? 3,
          color: rest.colorHex || "",
          wrap: rest.wrapMode || "",
          ...common,
          rawLineNo: lineNo,
        },
      };
    }

    if (tag === "I") {
      // I supports:
      // - I\SRC:"<url>" ...   (strict; permissive also accepts legacy SRC:<url>)
      // - I\<iconName> ... (shorthand for built-in SVG icon)
      // - I\SRC:<iconName> ... (if SRC value looks like a bare icon name)
      let tokens = fields.slice(1);
      const first = String(get(1) || "").trim();
      if (
        first &&
        !isSrcToken(first) &&
        !isIconToken(first) &&
        !isSizeToken(first) &&
        !isAlignToken(first) &&
        !parseOutToken(first) &&
        !isMarginToken(first) &&
        !isPaddingToken(first) &&
        !isRadiusToken(first) &&
        !isFitToken(first) &&
        !isBgToken(first) &&
        !isActionToken(first)
      ) {
        const nm = first.toLowerCase();
        if (BUILTIN_BUTTON_ICONS.includes(nm)) {
          tokens = [...tokens];
          tokens[0] = `ICON:${nm}`;
        }
      }

      const rest = parseUnorderedFields(tokens, {
        allowSize: true,
        allowAlign: true,
        allowAction: true,
        allowHint: true,
        allowCols: false,
        allowMargin: true,
        allowPadding: false,
        allowRadius: true,
        allowIcon: true,
        allowSrc: true,
        allowFit: true,
        allowBg: false,
        allowColor: true,
      });
      let src = String(rest.srcUrl || "").trim();
      let icon = String(rest.iconName || "").trim().toLowerCase();
      const iconSize = rest.iconSizePx ?? null;

      // If SRC looks like a bare icon name, treat it as icon (for convenience).
      if (src && !icon) {
        const nm = src.toLowerCase();
        const looksBare = /^[a-z0-9_-]+$/i.test(src) && !src.includes("/") && !src.includes(".") && !src.includes(":");
        if (looksBare && BUILTIN_BUTTON_ICONS.includes(nm)) {
          icon = nm;
          src = "";
        }
      }

      if (!src && !icon) {
        throw formatError("I", 'Нужен SRC:"<url>" или имя встроенной иконки (например "I\\SRC:\\"src/yarmap.PNG\\"" или "I\\home").');
      }
      const sizeStr = rest.sizeStr;
      const alignStr = rest.alignStr;
      const hint = rest.hint;
      const actionStr = rest.actionStr;
      const common = parseCommon({ caption: "", sizeStr, alignStr, actionStr, hint });
    return {
      indent,
      node: {
        tag,
          id: "",
          src,
          icon,
          iconSize,
          fit: rest.fitMode || "none",
          margin: rest.marginPx ?? 0,
          radius: rest.radiusPx ?? 0,
          color: rest.colorHex || "",
          ...common,
        rawLineNo: lineNo,
      },
    };
    }

    if (tag === "T") {
      const rest = parseUnorderedFields(fields.slice(1), {
        allowSize: true,
        allowAlign: true,
        allowAction: true,
        allowHint: true,
        allowCols: true,
        allowMargin: true,
        allowInAlign: true,
        allowColor: true,
        allowWrap: true,
      });
      const sizeStr = rest.sizeStr;
      const alignStr = rest.alignStr;
      const hint = rest.hint;
      const common = parseCommon({ caption: "", sizeStr, alignStr, actionStr: rest.actionStr, hint });
    return {
      indent,
      node: {
        tag,
          id: "",
          colsSpec: rest.colsSpec || "",
          margin: rest.marginPx ?? 0,
          cellPadding: rest.paddingPx ?? 5,
          textAlign: rest.textAlignStr || "",
          color: rest.colorHex || "",
          wrap: rest.wrapMode || "",
          ...common,
        rawLineNo: lineNo,
      },
    };
    }

    throw new UxlParseError(
      `Неизвестный тег: "${tag}". Разрешены: P, F, I, B, C, S, T, TH, TD. См. UXL.md для форматов.`,
      meta,
    );
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

  function parseColsSpec(colsSpecRaw, meta) {
    const raw = String(colsSpecRaw || "").trim();
    if (!raw) throw new UxlParseError("Для таблицы T обязателен COLS:... (описание колонок).", meta);
    const m = /^COLS:(.+)$/i.exec(raw);
    if (!m) throw new UxlParseError('Некорректный формат COLS (ожидается "COLS:20R,80L").', meta);
    const body = m[1].trim();
    if (!body) throw new UxlParseError('Пустой COLS (ожидается "COLS:20R,80L").', meta);
    const parts = body.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) throw new UxlParseError('COLS должен содержать хотя бы одну колонку (например "COLS:100").', meta);
    return parts;
  }

  function parseUxl(uxlText, { mode = "permissive", sourceName = "UXL" } = {}) {
    const lines = String(uxlText).replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
    const { version: uxlVersionRaw, nextIndex: afterVersion } = parseUxlVersionIfPresent(lines, 0, sourceName);
    if (uxlVersionRaw && uxlVersionRaw !== SUPPORTED_UXL_VERSION) {
      throw new UxlParseError(
        `Неподдерживаемая версия UXL: "${uxlVersionRaw}". Поддерживается: "${SUPPORTED_UXL_VERSION}".`,
        { line: null, col: null, sourceName, lineText: null },
      );
    }
    const uxlVersion = uxlVersionRaw || SUPPORTED_UXL_VERSION;
    const { size: windowSize, nextIndex } = parseWindowSizeIfPresent(lines, afterVersion, sourceName, mode);

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
        throw new UxlParseError(
          "В корне UXL-блока разрешены только теги P (после опциональной строки версии UXL:1.0 и размера окна вида 600x600).",
          {
          line: r.rawLineNo,
          col: 1,
          sourceName,
          lineText: lines[r.rawLineNo - 1],
          },
        );
      }
    }

    // ID uniqueness only matters for P (used by GOTO).
    const pageIds = new Set(); // lowerId

    const pages = [];
    const pagesById = new Map(); // lower -> page

    function walk(node, parent) {
      node.parent = parent || null;
      node.children = node.children || [];

      // Validate ID charset for nodes that have ID provided
      if (node.tag === "P") {
        if (node.id) {
        if (!/^[A-Za-z0-9_-]+$/.test(node.id)) {
          throw new UxlParseError("Некорректный ID у P (разрешены латиница/цифры/_/-).", {
            line: node.rawLineNo,
            col: 1,
            sourceName,
            lineText: lines[node.rawLineNo - 1],
          });
        }
        const key = normalizeId(node.id);
          if (pageIds.has(key)) {
            throw new UxlParseError(`Дублирующийся ID страницы "${node.id}" (case-insensitive).`, {
            line: node.rawLineNo,
            col: 1,
            sourceName,
            lineText: lines[node.rawLineNo - 1],
          });
        }
          pageIds.add(key);
        pagesById.set(key, node);
        }
        pages.push(node);
      }

      for (const ch of node.children) walk(ch, node);
    }
    for (const r of roots) walk(r, null);

    // structure validation
    function validateNode(node) {
      const tag = node.tag;
      const kids = node.children || [];

      if (tag !== "P" && node.parent == null) {
        throw new UxlParseError("В корне разрешены только P (после опциональной строки версии UXL:1.0 и размера окна вида 600x600).", {
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
          if (!["F", "B", "C", "S", "T", "I"].includes(ch.tag)) {
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
          if (!["F", "B", "C", "S", "T", "I"].includes(ch.tag)) {
            throw new UxlParseError(`Недопустимый дочерний тег "${ch.tag}" внутри F.`, {
              line: ch.rawLineNo,
              col: 1,
              sourceName,
              lineText: lines[ch.rawLineNo - 1],
            });
          }
        }
      } else if (tag === "I" || tag === "B" || tag === "C" || tag === "S") {
        if (kids.length) {
          throw new UxlParseError(`${tag} не может иметь дочерних элементов.`, {
            line: node.rawLineNo,
            col: 1,
            sourceName,
            lineText: lines[node.rawLineNo - 1],
          });
        }
      } else if (tag === "T") {
        for (const ch of kids) {
          if (!["TH", "TD"].includes(ch.tag)) {
            throw new UxlParseError(`Недопустимый дочерний тег "${ch.tag}" внутри T.`, {
              line: ch.rawLineNo,
              col: 1,
              sourceName,
              lineText: lines[ch.rawLineNo - 1],
            });
          }
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
      } else if (["B", "C", "TH", "TD"].includes(tag)) {
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

      for (const ch of kids) validateNode(ch);
    }
    for (const p of pages) validateNode(p);

    // Validate tables cell counts + normalize TC
    function validateTables(node) {
      if (node.tag === "T") {
        const kids = node.children || [];
        const meta = { line: node.rawLineNo, col: 1, sourceName, lineText: lines[node.rawLineNo - 1] };
        const colsRaw = parseColsSpec(node.colsSpec, meta);
        const cols = validateTcFormat({ cols: colsRaw }, meta);
        node._tcCols = cols;
        const colCount = cols.length;
        const th = kids.find((k) => k.tag === "TH");
        if (th && th.cells.length !== colCount) {
          throw new UxlParseError(`Количество ячеек в TH (${th.cells.length}) не равно количеству колонок (${colCount}).`, {
            line: th.rawLineNo,
            col: 1,
            sourceName,
            lineText: lines[th.rawLineNo - 1],
          });
        }
        for (const td of kids.filter((k) => k.tag === "TD")) {
          if (td.cells.length !== colCount) {
            throw new UxlParseError(`Количество ячеек в TD (${td.cells.length}) не равно количеству колонок (${colCount}).`, {
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

    // Validate P.GOTOAFTER (auto-navigation): it navigates to the *next* page in source order.
    // If page is the last one, strict: error; permissive: ignore.
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      if (p?.tag !== "P") continue;
      if (p.gotoAfterSec == null) continue;
      const next = pages[i + 1] || null;
      if (!next) {
        const meta = { line: p.rawLineNo, col: 1, sourceName, lineText: lines[p.rawLineNo - 1] };
        if (mode === "strict") {
          throw new UxlParseError("GOTOAFTER у последней страницы не имеет цели (нет следующей страницы).", meta);
        }
        p.gotoAfterSec = null;
      }
    }

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

    // Also include auto-navigation edges in the map (only if both pages have IDs).
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const next = pages[i + 1] || null;
      if (!p || p.tag !== "P" || p.gotoAfterSec == null) continue;
      if (!next || next.tag !== "P") continue;
      if (!p.id || !next.id) continue;
      const fromKey = normalizeId(p.id);
      const toKey = normalizeId(next.id);
      if (!fromKey || !toKey) continue;
      const key = `${fromKey}=>${toKey}`;
      edges.set(key, { fromId: p.id, toId: next.id });
    }

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

    // Build uid -> node map (useful for wiring events in renderer)
    const nodeByUid = new Map();
    function indexByUid(node) {
      nodeByUid.set(node.uid, node);
      for (const ch of node.children || []) indexByUid(ch);
    }
    for (const p of pages) indexByUid(p);

    return {
      kind: "UXL",
      mode,
      sourceName,
      uxlVersion,
      window: windowSize,
      pages,
      edges: Array.from(edges.values()),
      pageIdToUid: (() => {
        const m = Object.create(null);
        for (const [k, p] of pagesById.entries()) m[k] = p.uid;
        return m;
      })(),
      nodeByUid,
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

  function splitMarkdownByUxlFences(mdText) {
    // Returns ordered segments: {kind:"html", html} or {kind:"uxl", uxlText}
    const text = String(mdText).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    const segs = [];
    const re = /```UXL[^\n]*\n([\s\S]*?)```/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      const before = text.slice(last, m.index);
      if (before) segs.push({ kind: "html", html: before });
      segs.push({ kind: "uxl", uxlText: m[1] });
      last = m.index + m[0].length;
    }
    const tail = text.slice(last);
    if (tail) segs.push({ kind: "html", html: tail });
    return segs;
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

  function renderRawHtml(html) {
    const wrap = el("div", { class: "uxl-raw-html" });
    // Intentionally treat as raw HTML, per request.
    wrap.innerHTML = String(html ?? "");
    return wrap;
  }

  const BUILTIN_SVG_ICONS = Object.freeze({
    // Icon set source: Feather Icons (https://feathericons.com/) with minor adaptations:
    // - converted to inherit `currentColor`
    // - kept as inline SVG specs
    // Note: `ai` icon has its own source below.
    ai: {
      // Source: ./ai.svg (24x24 stroke icon; converted to inherit currentColor)
      viewBox: "0 0 24 24",
      els: [
        { tag: "rect", attrs: { x: "4", y: "4", width: "16", height: "16", rx: "2", ry: "2" } },
        { tag: "line", attrs: { x1: "9", y1: "1", x2: "9", y2: "4" } },
        { tag: "line", attrs: { x1: "15", y1: "1", x2: "15", y2: "4" } },
        { tag: "line", attrs: { x1: "9", y1: "20", x2: "9", y2: "23" } },
        { tag: "line", attrs: { x1: "15", y1: "20", x2: "15", y2: "23" } },
        { tag: "line", attrs: { x1: "20", y1: "9", x2: "23", y2: "9" } },
        { tag: "line", attrs: { x1: "20", y1: "14", x2: "23", y2: "14" } },
        { tag: "line", attrs: { x1: "1", y1: "9", x2: "4", y2: "9" } },
        { tag: "line", attrs: { x1: "1", y1: "14", x2: "4", y2: "14" } },
        { tag: "polyline", attrs: { points: "6.7 9.28 6.7 13.87 10.53 9.28 10.53 13.87" } },
        { tag: "polyline", attrs: { points: "13.5 9.28 13.5 13.87 17.33 9.28 17.33 13.87" } },
      ],
    },
    back: { viewBox: "0 0 24 24", d: ["M15 18l-6-6 6-6", "M9 12h12"] },
    "arrow-left": {
      viewBox: "0 0 24 24",
      els: [
        { tag: "line", attrs: { x1: "19", y1: "12", x2: "5", y2: "12" } },
        { tag: "polyline", attrs: { points: "12 19 5 12 12 5" } },
      ],
    },
    "arrow-right": {
      viewBox: "0 0 24 24",
      els: [
        { tag: "line", attrs: { x1: "5", y1: "12", x2: "19", y2: "12" } },
        { tag: "polyline", attrs: { points: "12 5 19 12 12 19" } },
      ],
    },
    "chevron-left": { viewBox: "0 0 24 24", d: ["M15 18l-6-6 6-6"] },
    "chevron-right": { viewBox: "0 0 24 24", d: ["M9 6l6 6-6 6"] },
    close: { viewBox: "0 0 24 24", d: ["M6 6l12 12", "M18 6l-12 12"] },
    box: {
      viewBox: "0 0 24 24",
      els: [
        { tag: "path", attrs: { d: "M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" } },
        { tag: "polyline", attrs: { points: "3.27 6.96 12 12.01 20.73 6.96" } },
        { tag: "line", attrs: { x1: "12", y1: "22.08", x2: "12", y2: "12" } },
      ],
    },
    check: { viewBox: "0 0 24 24", d: ["M20 6L9 17l-5-5"] },
    clock: {
      viewBox: "0 0 24 24",
      els: [
        { tag: "circle", attrs: { cx: "12", cy: "12", r: "10" } },
        { tag: "polyline", attrs: { points: "12 6 12 12 16 14" } },
      ],
    },
    codepen: {
      viewBox: "0 0 24 24",
      els: [
        { tag: "polygon", attrs: { points: "12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2" } },
        { tag: "line", attrs: { x1: "12", y1: "22", x2: "12", y2: "15.5" } },
        { tag: "polyline", attrs: { points: "22 8.5 12 15.5 2 8.5" } },
        { tag: "polyline", attrs: { points: "2 15.5 12 8.5 22 15.5" } },
        { tag: "line", attrs: { x1: "12", y1: "2", x2: "12", y2: "8.5" } },
      ],
    },
    cpu: {
      viewBox: "0 0 24 24",
      els: [
        { tag: "rect", attrs: { x: "4", y: "4", width: "16", height: "16", rx: "2", ry: "2" } },
        { tag: "rect", attrs: { x: "9", y: "9", width: "6", height: "6" } },
        { tag: "line", attrs: { x1: "9", y1: "1", x2: "9", y2: "4" } },
        { tag: "line", attrs: { x1: "15", y1: "1", x2: "15", y2: "4" } },
        { tag: "line", attrs: { x1: "9", y1: "20", x2: "9", y2: "23" } },
        { tag: "line", attrs: { x1: "15", y1: "20", x2: "15", y2: "23" } },
        { tag: "line", attrs: { x1: "20", y1: "9", x2: "23", y2: "9" } },
        { tag: "line", attrs: { x1: "20", y1: "14", x2: "23", y2: "14" } },
        { tag: "line", attrs: { x1: "1", y1: "9", x2: "4", y2: "9" } },
        { tag: "line", attrs: { x1: "1", y1: "14", x2: "4", y2: "14" } },
      ],
    },
    edit: {
      viewBox: "0 0 24 24",
      els: [
        { tag: "path", attrs: { d: "M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" } },
        { tag: "path", attrs: { d: "M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" } },
      ],
    },
    grid: {
      viewBox: "0 0 24 24",
      els: [
        { tag: "rect", attrs: { x: "3", y: "3", width: "7", height: "7" } },
        { tag: "rect", attrs: { x: "14", y: "3", width: "7", height: "7" } },
        { tag: "rect", attrs: { x: "14", y: "14", width: "7", height: "7" } },
        { tag: "rect", attrs: { x: "3", y: "14", width: "7", height: "7" } },
      ],
    },
    grid1x1: {
      viewBox: "0 0 24 24",
      mode: "fill",
      els: [{ tag: "circle", attrs: { cx: "12", cy: "12", r: "2" } }],
    },
    grid3x3: {
      viewBox: "0 0 24 24",
      mode: "fill",
      els: [
        // 3x3 dot grid: 9 points
        { tag: "circle", attrs: { cx: "6", cy: "6", r: "1.6" } },
        { tag: "circle", attrs: { cx: "12", cy: "6", r: "1.6" } },
        { tag: "circle", attrs: { cx: "18", cy: "6", r: "1.6" } },
        { tag: "circle", attrs: { cx: "6", cy: "12", r: "1.6" } },
        { tag: "circle", attrs: { cx: "12", cy: "12", r: "1.6" } },
        { tag: "circle", attrs: { cx: "18", cy: "12", r: "1.6" } },
        { tag: "circle", attrs: { cx: "6", cy: "18", r: "1.6" } },
        { tag: "circle", attrs: { cx: "12", cy: "18", r: "1.6" } },
        { tag: "circle", attrs: { cx: "18", cy: "18", r: "1.6" } },
      ],
    },
    grid4x4: {
      viewBox: "0 0 24 24",
      mode: "fill",
      els: [
        // 4x4 dot grid: 16 points
        { tag: "circle", attrs: { cx: "4.5", cy: "4.5", r: "1.2" } },
        { tag: "circle", attrs: { cx: "9.5", cy: "4.5", r: "1.2" } },
        { tag: "circle", attrs: { cx: "14.5", cy: "4.5", r: "1.2" } },
        { tag: "circle", attrs: { cx: "19.5", cy: "4.5", r: "1.2" } },
        { tag: "circle", attrs: { cx: "4.5", cy: "9.5", r: "1.2" } },
        { tag: "circle", attrs: { cx: "9.5", cy: "9.5", r: "1.2" } },
        { tag: "circle", attrs: { cx: "14.5", cy: "9.5", r: "1.2" } },
        { tag: "circle", attrs: { cx: "19.5", cy: "9.5", r: "1.2" } },
        { tag: "circle", attrs: { cx: "4.5", cy: "14.5", r: "1.2" } },
        { tag: "circle", attrs: { cx: "9.5", cy: "14.5", r: "1.2" } },
        { tag: "circle", attrs: { cx: "14.5", cy: "14.5", r: "1.2" } },
        { tag: "circle", attrs: { cx: "19.5", cy: "14.5", r: "1.2" } },
        { tag: "circle", attrs: { cx: "4.5", cy: "19.5", r: "1.2" } },
        { tag: "circle", attrs: { cx: "9.5", cy: "19.5", r: "1.2" } },
        { tag: "circle", attrs: { cx: "14.5", cy: "19.5", r: "1.2" } },
        { tag: "circle", attrs: { cx: "19.5", cy: "19.5", r: "1.2" } },
      ],
    },
    home: { viewBox: "0 0 24 24", d: ["M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"] },
    loader: {
      viewBox: "0 0 24 24",
      els: [{ tag: "path", attrs: { d: "M21 12a9 9 0 1 1-6.219-8.56" } }],
    },
    menu: {
      viewBox: "0 0 24 24",
      els: [
        { tag: "line", attrs: { x1: "3", y1: "12", x2: "21", y2: "12" } },
        { tag: "line", attrs: { x1: "3", y1: "6", x2: "21", y2: "6" } },
        { tag: "line", attrs: { x1: "3", y1: "18", x2: "21", y2: "18" } },
      ],
    },
    microphone: {
      viewBox: "0 0 24 24",
      d: [
        "M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3z",
        "M19 11a7 7 0 0 1-14 0",
        "M12 18v3",
        "M8 21h8",
      ],
    },
    "more-horizontal": {
      viewBox: "0 0 24 24",
      mode: "fill",
      els: [
        { tag: "circle", attrs: { cx: "12", cy: "12", r: "2" } },
        { tag: "circle", attrs: { cx: "19", cy: "12", r: "2" } },
        { tag: "circle", attrs: { cx: "5", cy: "12", r: "2" } },
      ],
    },
    plus: { viewBox: "0 0 24 24", d: ["M12 5v14", "M5 12h14"] },
    search: { viewBox: "0 0 24 24", d: ["M10.5 18a7.5 7.5 0 1 1 0-15a7.5 7.5 0 0 1 0 15z", "M16.5 16.5 21 21"] },
    sliders: {
      viewBox: "0 0 24 24",
      els: [
        // Feather "sliders"
        { tag: "line", attrs: { x1: "4", y1: "21", x2: "4", y2: "14" } },
        { tag: "line", attrs: { x1: "4", y1: "10", x2: "4", y2: "3" } },
        { tag: "line", attrs: { x1: "12", y1: "21", x2: "12", y2: "12" } },
        { tag: "line", attrs: { x1: "12", y1: "8", x2: "12", y2: "3" } },
        { tag: "line", attrs: { x1: "20", y1: "21", x2: "20", y2: "16" } },
        { tag: "line", attrs: { x1: "20", y1: "12", x2: "20", y2: "3" } },
        { tag: "line", attrs: { x1: "1", y1: "14", x2: "7", y2: "14" } },
        { tag: "line", attrs: { x1: "9", y1: "8", x2: "15", y2: "8" } },
        { tag: "line", attrs: { x1: "17", y1: "16", x2: "23", y2: "16" } },
      ],
    },
    sun: {
      viewBox: "0 0 24 24",
      els: [
        { tag: "circle", attrs: { cx: "12", cy: "12", r: "5" } },
        { tag: "line", attrs: { x1: "12", y1: "1", x2: "12", y2: "3" } },
        { tag: "line", attrs: { x1: "12", y1: "21", x2: "12", y2: "23" } },
        { tag: "line", attrs: { x1: "4.22", y1: "4.22", x2: "5.64", y2: "5.64" } },
        { tag: "line", attrs: { x1: "18.36", y1: "18.36", x2: "19.78", y2: "19.78" } },
        { tag: "line", attrs: { x1: "1", y1: "12", x2: "3", y2: "12" } },
        { tag: "line", attrs: { x1: "21", y1: "12", x2: "23", y2: "12" } },
        { tag: "line", attrs: { x1: "4.22", y1: "19.78", x2: "5.64", y2: "18.36" } },
        { tag: "line", attrs: { x1: "18.36", y1: "5.64", x2: "19.78", y2: "4.22" } },
      ],
    },
    settings: {
      viewBox: "0 0 24 24",
      els: [
        { tag: "circle", attrs: { cx: "12", cy: "12", r: "3" } },
        {
          tag: "path",
          attrs: {
            d: "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z",
          },
        },
      ],
    },
    trash: {
      viewBox: "0 0 24 24",
      els: [
        { tag: "polyline", attrs: { points: "3 6 5 6 21 6" } },
        { tag: "path", attrs: { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" } },
      ],
    },
    "volume-2": {
      viewBox: "0 0 24 24",
      els: [
        { tag: "polygon", attrs: { points: "11 5 6 9 2 9 2 15 6 15 11 19 11 5" } },
        { tag: "path", attrs: { d: "M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" } },
      ],
    },
    "volume-x": {
      viewBox: "0 0 24 24",
      els: [
        // Feather "volume-x"
        { tag: "polygon", attrs: { points: "11 5 6 9 2 9 2 15 6 15 11 19 11 5" } },
        { tag: "line", attrs: { x1: "23", y1: "9", x2: "17", y2: "15" } },
        { tag: "line", attrs: { x1: "17", y1: "9", x2: "23", y2: "15" } },
      ],
    },
  });

  function svgIcon(name, { className = "", title = "" } = {}) {
    const spec = BUILTIN_SVG_ICONS[String(name || "").trim().toLowerCase()];
    if (!spec) return null;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", spec.viewBox || "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const mode = String(spec.mode || "stroke").toLowerCase();
    if (mode === "fill") {
      svg.setAttribute("fill", "currentColor");
      svg.setAttribute("stroke", "none");
    } else {
      svg.setAttribute("fill", "none");
      svg.setAttribute("stroke", "currentColor");
      svg.setAttribute("stroke-width", "2");
      svg.setAttribute("stroke-linecap", "round");
      svg.setAttribute("stroke-linejoin", "round");
    }
    if (className) svg.setAttribute("class", className);
    if (title) {
      const t = document.createElementNS("http://www.w3.org/2000/svg", "title");
      t.textContent = title;
      svg.append(t);
    }
    if (Array.isArray(spec.els)) {
      for (const elSpec of spec.els) {
        if (!elSpec || !elSpec.tag) continue;
        const n = document.createElementNS("http://www.w3.org/2000/svg", String(elSpec.tag));
        for (const [k, v] of Object.entries(elSpec.attrs || {})) {
          if (v == null) continue;
          n.setAttribute(k, String(v));
        }
        svg.append(n);
      }
    } else if (Array.isArray(spec.paths)) {
      for (const pp of spec.paths) {
        if (!pp || !pp.d) continue;
        const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
        p.setAttribute("d", pp.d);
        if (pp.transform) p.setAttribute("transform", pp.transform);
        if (pp.fillRule) p.setAttribute("fill-rule", pp.fillRule);
        if (pp.clipRule) p.setAttribute("clip-rule", pp.clipRule);
        if (pp.opacity != null) p.setAttribute("opacity", String(pp.opacity));
        svg.append(p);
      }
    } else {
      for (const d of spec.d || []) {
        const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
        p.setAttribute("d", d);
        svg.append(p);
      }
    }
    return svg;
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

  function pageLabel(pageNode) {
    const cap = String(pageNode.caption || "").trim();
    if (cap) return cap;
    const id = String(pageNode.id || "").trim();
    if (id) return `P ${id}`;
    return "P";
  }

  function renderError(err) {
    const root = el("div", { class: "uxl-root" });
    const head = el("div", { class: "uxl-error__head", text: "UXL error" });
    const metaParts = [];
    if (err.sourceName) metaParts.push(err.sourceName);
    if (err.line != null) metaParts.push(`line ${err.line}`);
    if (err.col != null) metaParts.push(`col ${err.col}`);
    const where = metaParts.join(": ");
    const name = String(err?.name || "Error");
    const msg = String(err?.message || "");
    const ver = `renderer ${RENDERER_VERSION} / uxl ${SUPPORTED_UXL_VERSION}`;
    const meta = el("div", { class: "uxl-error__meta", text: `${where}\n${ver}\n${name}: ${msg}` });
    const box = el("div", { class: "uxl-error" }, [head, meta]);
    if (err.lineText) {
      box.append(el("div", { class: "uxl-error__line", text: err.lineText }));
    }
    const stack = String(err?.stack || "").trim();
    if (stack) {
      box.append(el("pre", { class: "uxl-error__details", text: stack }));
    }
    root.append(box);
    return root;
  }

  function resolveDim(dim, parentPx, { marginPx = 0 } = {}) {
    if (!dim) return null;
    if (dim.unit === "px") return dim.value;
    if (dim.unit === "%") {
      const raw = Math.round((dim.value / 100) * parentPx);
      // Percent sizes are treated as the OUTER box target (like CSS width:100%).
      // Since we also add margin around elements, subtract it from the border-box
      // so that (border-box + margins) fits into the parent.
      const m = Number.isFinite(marginPx) ? marginPx : 0;
      return Math.max(0, raw - m * 2);
    }
    return null;
  }

  function layoutTree(containerEl, rootNode, windowSize) {
    // rootNode is P; containerEl is .uxl-canvas
    // IMPORTANT: layout relies on measuring intrinsic sizes, so it must run after the subtree is attached to DOM.
    const domByUid = new Map();

    function renderNode(node, parentEl) {
      const tag = node.tag;
      let nodeEl;
      const applyWrap = (elOrNull, wrapModeRaw) => {
        const el = elOrNull;
        if (!el) return;
        const w = String(wrapModeRaw || "").trim().toUpperCase();
        const eff = w === "NW" ? "NW" : "W"; // default=W
        if (eff === "NW") {
          el.style.whiteSpace = "nowrap";
          el.style.overflow = "hidden";
          el.style.textOverflow = "ellipsis";
          // For flex children (e.g. button label), allow shrinking:
          el.style.minWidth = "0";
        } else {
          el.style.whiteSpace = "normal";
          // W: wrap only on natural break opportunities (spaces/punctuation), no forced word breaking.
          el.style.overflowWrap = "normal";
          el.style.wordBreak = "normal";
        }
      };

      if (tag === "F") {
        // F is invisible visually, but it must exist as a DOM container to support crop/scroll.
        nodeEl = el("div", { class: "uxl-node uxl-F", "data-uxl-uid": node.uid });
        if (node.hint) nodeEl.title = node.hint;
        if (Number.isFinite(node.padding)) nodeEl.style.padding = `${node.padding}px`;
        const bgColor = String(node.bgColor || "").trim();
        if (bgColor) nodeEl.style.backgroundColor = bgColor;
        const bg = String(node.bg || "").trim();
        if (bg) {
          // Allow relative URLs like "src/yarmap.PNG". Avoid breaking CSS string with quotes.
          const safe = bg.replaceAll('"', "%22");
          nodeEl.style.backgroundImage = `url("${safe}")`;
          nodeEl.style.backgroundRepeat = "no-repeat";
          nodeEl.style.backgroundPosition = "center";
          nodeEl.style.backgroundSize = "cover";
        }
        domByUid.set(node.uid, nodeEl);
        parentEl.append(nodeEl);
        for (const ch of node.children || []) renderNode(ch, nodeEl);
        return nodeEl;
      }

      if (tag === "C") {
        nodeEl = el("div", { class: "uxl-node uxl-C", "data-uxl-uid": node.uid, text: node.caption || "" });
        applyWrap(nodeEl, node.wrap);
        const a = String(node.textAlign || "").trim().toUpperCase();
        if (a === "L") nodeEl.style.textAlign = "left";
        else if (a === "C") nodeEl.style.textAlign = "center";
        else if (a === "R") nodeEl.style.textAlign = "right";
      }
      else if (tag === "B") {
        nodeEl = el("button", { class: "uxl-node uxl-B", type: "button", "data-uxl-uid": node.uid });
        const a = String(node.textAlign || "").trim().toUpperCase();
        if (a === "L") {
          nodeEl.style.justifyContent = "flex-start";
          nodeEl.style.textAlign = "left";
        } else if (a === "C") {
          nodeEl.style.justifyContent = "center";
          nodeEl.style.textAlign = "center";
        } else if (a === "R") {
          nodeEl.style.justifyContent = "flex-end";
          nodeEl.style.textAlign = "right";
        }
        const iconName = String(node.icon || "").trim();
        if (iconName) {
          const ico = svgIcon(iconName, { className: "uxl-B__icon" });
          if (ico) nodeEl.append(ico);
        }
        if (Number.isFinite(node.iconSize)) nodeEl.style.setProperty("--uxl-icon-size", `${node.iconSize}px`);
        const cap = String(node.caption || "");
        if (cap.trim()) {
          const lab = el("span", { class: "uxl-B__label", text: cap });
          applyWrap(lab, node.wrap);
          nodeEl.append(lab);
        }
        applyWrap(nodeEl, node.wrap);
        const r = Number.isFinite(node.radius) ? node.radius : 6;
        nodeEl.style.borderRadius = `${r}px`;
      } else if (tag === "S") {
        nodeEl = el("button", { class: "uxl-node uxl-S", type: "button", "data-uxl-uid": node.uid });
        if (node.hint) nodeEl.title = node.hint;
        if (Number.isFinite(node.padding)) nodeEl.style.padding = `${node.padding}px`;

        const opts = Array.isArray(node.options) ? node.options : [];
        const n = opts.length;
        let cur = Number.isFinite(node.value) ? node.value : 0;
        if (n > 0) cur = Math.max(0, Math.min(n - 1, cur));

        const segEls = [];
        for (let i = 0; i < n; i++) {
          const opt = opts[i] || {};
          const seg = el("div", { class: "uxl-S__seg" });
          if (opt.kind === "icon" && opt.name) {
            const svg = svgIcon(opt.name, { className: "uxl-S__icon" });
            if (svg) {
              const s = Number.isFinite(opt.sizePx) ? opt.sizePx : null;
              if (s != null) {
                svg.style.width = `${s}px`;
                svg.style.height = `${s}px`;
              }
              seg.append(svg);
            }
          } else if (opt.kind === "text") {
            const txt = el("span", { class: "uxl-S__text", text: String(opt.text ?? "") });
            applyWrap(txt, node.wrap);
            seg.append(txt);
          } else {
            // empty
          }
          nodeEl.append(seg);
          segEls.push(seg);
        }

        const applyActive = () => {
          for (let i = 0; i < segEls.length; i++) {
            segEls[i].classList.toggle("uxl-S__seg--active", i === cur);
          }
        };
        applyActive();
        applyWrap(nodeEl, node.wrap);

        nodeEl.addEventListener("click", () => {
          if (segEls.length < 2) return;
          cur = (cur + 1) % segEls.length;
          applyActive();
        });
      } else if (tag === "I") {
        const hasAction = !!(node.action && node.action.type === "GOTO");
        nodeEl = el(hasAction ? "button" : "div", {
          class: hasAction ? "uxl-node uxl-I uxl-I--action" : "uxl-node uxl-I",
          ...(hasAction ? { type: "button" } : {}),
          "data-uxl-uid": node.uid,
        });
        const iconName = String(node.icon || "").trim();
        const fit = String(node.fit || "").trim().toLowerCase();
        if (!iconName && (fit === "contain" || fit === "cover")) nodeEl.style.setProperty("--uxl-img-fit", fit);
        if (Number.isFinite(node.radius) && node.radius > 0) nodeEl.style.borderRadius = `${node.radius}px`;
        if (iconName) {
          const ico = svgIcon(iconName, { className: "uxl-I__icon" });
          if (ico) nodeEl.append(ico);
          if (Number.isFinite(node.iconSize)) nodeEl.style.setProperty("--uxl-icon-size", `${node.iconSize}px`);
        } else {
          const img = document.createElement("img");
          img.className = "uxl-I__img";
          img.alt = "";
          img.decoding = "async";
          img.loading = "eager";
          img.src = String(node.src || "");
          const broken = el("div", { class: "uxl-I__broken", text: "image not found" });
          img.addEventListener("error", () => {
            nodeEl.classList.add("uxl-I--broken");
          });
          nodeEl.append(img, broken);
        }
      } else if (tag === "T") {
        nodeEl = el("div", { class: "uxl-node uxl-T", "data-uxl-uid": node.uid });
        nodeEl.style.setProperty("--uxl-table-cell-pad", `${Number.isFinite(node.cellPadding) ? node.cellPadding : 0}px`);
        const table = el("table");
        const colgroup = el("colgroup");
        for (const col of node._tcCols || []) {
          colgroup.append(el("col", { style: `width:${col.w}%;` }));
        }
        table.append(colgroup);
        const thead = el("thead");
        const tbody = el("tbody");
        const defaultAlign = (() => {
          const a = String(node.textAlign || "").trim().toUpperCase();
          return a === "L" ? "left" : a === "R" ? "right" : "center";
        })();
        const thNode = (node.children || []).find((k) => k.tag === "TH");
        if (thNode) {
          const tr = el("tr");
          const wrapTh = String(thNode.wrap || "").trim().toUpperCase() || String(node.wrap || "").trim().toUpperCase();
          thNode.cells.forEach((cell, idx) => {
            const colAlign = (node._tcCols?.[idx]?.align || "").toUpperCase();
            const align = colAlign === "L" ? "left" : colAlign === "R" ? "right" : defaultAlign;
            const c = String(node.color || "").trim();
            const style = `text-align:${align};${c ? `color:${c};` : ""}`;
            const th = el("th", { style, text: cell });
            applyWrap(th, wrapTh);
            if (thNode.cellPadding != null) th.style.padding = `${thNode.cellPadding}px`;
            tr.append(th);
          });
          thead.append(tr);
        }
        const tdNodes = (node.children || []).filter((k) => k.tag === "TD");
        for (const td of tdNodes) {
          const tr = el("tr");
          const wrapTd = String(td.wrap || "").trim().toUpperCase() || String(node.wrap || "").trim().toUpperCase();
          td.cells.forEach((cell, idx) => {
            const colAlign = (node._tcCols?.[idx]?.align || "").toUpperCase();
            const align = colAlign === "L" ? "left" : colAlign === "R" ? "right" : defaultAlign;
            const c = String(node.color || "").trim();
            const style = `text-align:${align};${c ? `color:${c};` : ""}`;
            const tdd = el("td", { style, text: cell });
            applyWrap(tdd, wrapTd);
            if (td.cellPadding != null) tdd.style.padding = `${td.cellPadding}px`;
            tr.append(tdd);
          });
          tbody.append(tr);
        }
        if (thead.childNodes.length) table.append(thead);
        table.append(tbody);
        nodeEl.append(table);
      } else {
        nodeEl = el("div", { class: "uxl-node", "data-uxl-uid": node.uid });
      }

      // Element base color (affects text and SVG icons via currentColor)
      const nodeColor = String(node.color || "").trim();
      if (nodeColor) nodeEl.style.color = nodeColor;

      if (tag === "C" && node.font) {
        if (Number.isFinite(node.font.sizePx)) nodeEl.style.fontSize = `${node.font.sizePx}px`;
        if (node.font.bold) nodeEl.style.fontWeight = "700";
        if (node.font.italic) nodeEl.style.fontStyle = "italic";
      }

      if (node.hint) nodeEl.title = node.hint;
      if ((tag === "C" || tag === "B") && Number.isFinite(node.padding)) nodeEl.style.padding = `${node.padding}px`;
      domByUid.set(node.uid, nodeEl);
      parentEl.append(nodeEl);

      // No nested rendering needed: T children are structural; F is handled above.
      return nodeEl;
    }

    // Render children of P
    for (const ch of rootNode.children || []) renderNode(ch, containerEl);

    function setOverflowStyles(nodeEl, dimW, dimH) {
      const ox = dimW?.overflow || null;
      const oy = dimH?.overflow || null;
      if (ox === "crop") nodeEl.style.overflowX = "hidden";
      else if (ox === "scroll") nodeEl.style.overflowX = "auto";
      else nodeEl.style.overflowX = "";
      if (oy === "crop") nodeEl.style.overflowY = "hidden";
      else if (oy === "scroll") nodeEl.style.overflowY = "auto";
      else nodeEl.style.overflowY = "";
    }

    function measureIntrinsic(node) {
      const nodeEl = domByUid.get(node.uid);
      if (!nodeEl) return { w: 0, h: 0 };
      if (node.tag === "I") {
        const svg = nodeEl.querySelector("svg.uxl-I__icon");
        if (svg) {
          const r = svg.getBoundingClientRect();
          const w = Math.ceil(r.width);
          const h = Math.ceil(r.height);
          if (w > 0 && h > 0) return { w, h };
          const s = Number.isFinite(node.iconSize) ? node.iconSize : 24;
          return { w: s, h: s };
        }
        const img = nodeEl.querySelector("img");
        const broken = nodeEl.classList.contains("uxl-I--broken");
        if (img && img.naturalWidth > 0 && img.naturalHeight > 0) return { w: img.naturalWidth, h: img.naturalHeight };
        if (broken) return { w: 64, h: 64 };
        return { w: 0, h: 0 };
      }
      // Measure current rendered box (without forcing). This is our intrinsic size baseline.
      const r = nodeEl.getBoundingClientRect();
      return { w: Math.ceil(r.width), h: Math.ceil(r.height) };
    }

    function resolveBaseSize(node, parentW, parentH) {
      const m = Number.isFinite(node.margin) ? node.margin : 0;
      const w = node.size?.w ? resolveDim(node.size.w, parentW, { marginPx: m }) : null;
      const h = node.size?.h ? resolveDim(node.size.h, parentH, { marginPx: m }) : null;
      return { w, h };
    }

    function alignToXY({ hAlign, vAlign, parentW, parentH, w, h }) {
      const x = hAlign === "L" ? 0 : hAlign === "R" ? Math.max(0, parentW - w) : Math.max(0, Math.round((parentW - w) / 2));
      const y = vAlign === "T" ? 0 : vAlign === "B" ? Math.max(0, parentH - h) : Math.max(0, Math.round((parentH - h) / 2));
      return { x, y };
    }

    function isContainerTag(tag) {
      return tag === "P" || tag === "F";
    }

    function layoutContainer(node, containerDomEl, parentW, parentH, { root = false, baseOverride = null } = {}) {
      const pad = (node.tag === "P" || node.tag === "F") && Number.isFinite(node.padding) ? node.padding : 0;
      const inFlow = String(node.inFlow || "").trim().toUpperCase(); // "" | "H" | "V"
      // Determine current container base size (as minimum) from its SIZE, otherwise from provided (root) or from children.
      const baseRaw = root ? { w: parentW, h: parentH } : resolveBaseSize(node, parentW, parentH);
      const base = {
        w: baseOverride && baseOverride.w != null ? baseOverride.w : baseRaw.w,
        h: baseOverride && baseOverride.h != null ? baseOverride.h : baseRaw.h,
      };
      let cw = base.w ?? 0;
      let ch = base.h ?? 0;
      if (containerDomEl) containerDomEl.style.padding = `${pad}px`;

      // Prepare overflow styles (crop/scroll) for this container element.
      if (root) {
        // For root canvas (P), if content exceeds bounds it must scroll by default.
        // Suffixes on window size can override: C=crop, S=scroll.
        const wDim = { overflow: windowSize.overflowW || "scroll" };
        const hDim = { overflow: windowSize.overflowH || "scroll" };
        setOverflowStyles(containerDomEl, wDim, hDim);
      } else {
        setOverflowStyles(containerDomEl, node.size?.w || null, node.size?.h || null);
      }

      const kids = node.children || [];
      if (kids.length === 0) {
        // If no children, size is either explicit, or intrinsic from DOM (rare for F), else 0.
        const intrinsic = root ? { w: cw, h: ch } : measureIntrinsic(node);
        const ow = node.size?.w?.overflow || null;
        const oh = node.size?.h?.overflow || null;
        const wFinal = node.size?.w ? (ow ? cw : Math.max(cw, intrinsic.w)) : intrinsic.w;
        const hFinal = node.size?.h ? (oh ? ch : Math.max(ch, intrinsic.h)) : intrinsic.h;
        return { w: wFinal, h: hFinal };
      }

      // Split children into vertical bands by vAlign: T / (center) / B
      const top = [];
      const mid = [];
      const bottom = [];
      const inAlign = node.inAlign || null; // default align for children inside this container
      const effAlign = (ch) => {
        const base = ch?.align || { h: null, v: null };
        if (!inAlign) return base;
        // If child doesn't specify alignment (center on both axes), use container IN as default.
        const h = base.h == null && base.v == null ? inAlign.h : base.h;
        const v = base.h == null && base.v == null ? inAlign.v : base.v;
        // Merge per-axis: if axis is still null, inherit from container.
        return { h: h ?? inAlign.h, v: v ?? inAlign.v };
      };
      for (const chNode of kids) {
        const v = effAlign(chNode).v || null;
        if (v === "T") top.push(chNode);
        else if (v === "B") bottom.push(chNode);
        else mid.push(chNode);
      }

      function computeChildSize(chNode, curW, curH, overrides = null) {
        const tag = chNode.tag;
        const baseResolved = resolveBaseSize(chNode, curW, curH);
        const ov = overrides ? overrides.get(chNode.uid) : null;
        const baseSz = {
          w: ov && ov.w != null ? ov.w : baseResolved.w,
          h: ov && ov.h != null ? ov.h : baseResolved.h,
        };
        let intrinsic;

        const chEl = domByUid.get(chNode.uid);
        if (tag === "I") {
          intrinsic = measureIntrinsic(chNode);
          let w = baseSz.w;
          let h = baseSz.h;

          // If one axis is missing, compute it from the image aspect ratio.
          const nw = intrinsic.w || 0;
          const nh = intrinsic.h || 0;
          if (w == null && h == null) {
            w = nw;
            h = nh;
          } else if (w != null && h == null) {
            h = nw > 0 ? Math.round((w * nh) / nw) : nh;
          } else if (h != null && w == null) {
            w = nh > 0 ? Math.round((h * nw) / nh) : nw;
          }
          if (w == null) w = nw;
          if (h == null) h = nh;

          const m = Number.isFinite(chNode.margin) ? chNode.margin : 0;
          return { w: (w ?? 0) + m * 2, h: (h ?? 0) + m * 2, innerW: w ?? 0, innerH: h ?? 0, m };
        }
        if (isContainerTag(tag)) {
          // Container child (F) size depends on its own kids, so recurse.
          intrinsic = layoutContainer(chNode, chEl, curW, curH, { root: false, baseOverride: baseSz });
        } else {
          const isPercentW = chNode.size?.w?.unit === "%";
          const isPercentH = chNode.size?.h?.unit === "%";

          // Apply fixed-size constraints (crop/scroll) BEFORE measuring intrinsic.
          // This is critical for cases like width=100C with long caption: height must be measured after wrapping.
          const wOverflow = chNode.size?.w?.overflow || null;
          const hOverflow = chNode.size?.h?.overflow || null;
          // Percent sizes behave like "fill": constrain the box to the computed size so content can wrap/shrink.
          const constrainW = !!wOverflow || isPercentW;
          const constrainH = !!hOverflow || isPercentH;
          if (chEl) {
            if (constrainW && baseSz.w != null) chEl.style.width = `${baseSz.w}px`;
            else chEl.style.width = "";
            if (constrainH && baseSz.h != null) chEl.style.height = `${baseSz.h}px`;
            else chEl.style.height = "";
          }
          intrinsic = measureIntrinsic(chNode);
        }

        const ow = chNode.size?.w?.overflow || null;
        const oh = chNode.size?.h?.overflow || null;
        const isPercentW = chNode.size?.w?.unit === "%";
        const isPercentH = chNode.size?.h?.unit === "%";

        // Apply overflow styles to element itself (affects its content).
        if (chEl) setOverflowStyles(chEl, chNode.size?.w || null, chNode.size?.h || null);

        // Default behavior: if content doesn't fit explicit size, element expands (unless C/S).
        // NOTE: Percent sizes are treated as "fill" (fixed), not as a minimum. This prevents 100%+margin overflow.
        const wFinal = chNode.size?.w
          ? ow || isPercentW
            ? baseSz.w ?? 0
            : Math.max(baseSz.w ?? 0, intrinsic.w)
          : intrinsic.w;
        const hFinal = chNode.size?.h
          ? oh || isPercentH
            ? baseSz.h ?? 0
            : Math.max(baseSz.h ?? 0, intrinsic.h)
          : intrinsic.h;

        const m = Number.isFinite(chNode.margin) ? chNode.margin : 0;
        return { w: wFinal + m * 2, h: hFinal + m * 2, innerW: wFinal, innerH: hFinal, m };
      }

      function buildPercentOverridesAndSizes(refW, refH) {
        const overrides = new Map(); // uid -> {w,h} in px (border-box, without margins)

        // Initialize: percent sizes are ignored until we resolve them from "free space".
        for (const n of kids) {
          const pw = n.size?.w?.unit === "%";
          const ph = n.size?.h?.unit === "%";
          if (!pw && !ph) continue;
          overrides.set(n.uid, { w: pw ? 0 : null, h: ph ? 0 : null });
        }

        const computeAll = () => {
          const childSize = new Map();
          for (const chNode of kids) {
            childSize.set(chNode.uid, computeChildSize(chNode, (refW ?? parentW ?? 0), (refH ?? parentH ?? 0), overrides));
          }
          return childSize;
        };

        const groupKey = (n) => {
          const v = n.align?.v || null;
          return v === "T" ? "top" : v === "B" ? "bottom" : "mid";
        };

        const allocAxis = (axis, availPx) => {
          const percentNodesByGroup = new Map(); // group -> n[]
          for (const n of kids) {
            if (n.size?.[axis]?.unit !== "%") continue;
            const g = groupKey(n);
            const arr = percentNodesByGroup.get(g) || [];
            arr.push(n);
            percentNodesByGroup.set(g, arr);
          }
          if (percentNodesByGroup.size === 0) return;

          // 1) Sizes for fixed nodes (percent nodes treated as 0 on this axis).
          const sz1 = computeAll();

          const fixedByGroup = { top: 0, mid: 0, bottom: 0 };
          for (const n of kids) {
            const g = groupKey(n);
            if (n.size?.[axis]?.unit === "%") continue;
            fixedByGroup[g] += sz1.get(n.uid)?.[axis] || 0;
          }

          // Determine if elements on this axis are stacked (share space) or independent.
          // Default: vertical stacking -> width independent, height shared.
          // IN:H: horizontal stacking -> width shared, height independent.
          const isSharedAxis = (inFlow === "H") ? (axis === "w") : (axis === "h");

          for (const [g, percentNodes] of percentNodesByGroup.entries()) {
            let availForGroup = availPx ?? 0;
            if (axis === "h") {
              // Height % is based on free space within the vertical band:
              // - top: everything except bottom band
              // - bottom: everything except top band
              // - mid: space between top and bottom bands
              if (g === "top") availForGroup = Math.max(0, availForGroup - fixedByGroup.bottom);
              else if (g === "bottom") availForGroup = Math.max(0, availForGroup - fixedByGroup.top);
              else availForGroup = Math.max(0, availForGroup - fixedByGroup.top - fixedByGroup.bottom);
            }
            const fixedSum = kids.reduce((acc, n) => {
              if (groupKey(n) !== g) return acc;
              if (n.size?.[axis]?.unit === "%") return acc;
              return acc + (sz1.get(n.uid)?.[axis] || 0);
            }, 0);
            const remaining = Math.max(0, availForGroup - fixedSum);

            if (!isSharedAxis) {
              // Independent: each element gets its own percent of the available space.
              for (const n of percentNodes) {
                const pct = Math.max(0, Math.min(100, Number(n.size?.[axis]?.value || 0)));
                const outer = Math.round((remaining * pct) / 100);
                const m = Number.isFinite(n.margin) ? n.margin : 0;
                const borderBox = Math.max(0, outer - m * 2);
                const prev = overrides.get(n.uid) || { w: null, h: null };
                overrides.set(n.uid, { ...prev, [axis]: borderBox });
              }
              continue;
            }

            // Shared: distribute remaining space proportionally among all percent elements.
            const weights = percentNodes.map((n) => Math.max(0, Number(n.size?.[axis]?.value || 0)));
            const totalW = weights.reduce((a, b) => a + b, 0);
            if (totalW <= 0) continue;

            // Deterministic fair rounding: floor + distribute remainder by largest fractional parts.
            const shares = weights.map((w) => (remaining * w) / totalW);
            const base = shares.map((s) => Math.floor(s));
            let rem = remaining - base.reduce((a, b) => a + b, 0);
            const order = shares
              .map((s, i) => ({ i, frac: s - Math.floor(s) }))
              .sort((a, b) => (b.frac - a.frac) || (a.i - b.i));
            for (let k = 0; k < order.length && rem > 0; k++, rem--) {
              base[order[k].i] += 1;
            }

            for (let i = 0; i < percentNodes.length; i++) {
              const n = percentNodes[i];
              const outer = base[i] || 0;
              const m = Number.isFinite(n.margin) ? n.margin : 0;
              const borderBox = Math.max(0, outer - m * 2);
              const prev = overrides.get(n.uid) || { w: null, h: null };
              overrides.set(n.uid, { ...prev, [axis]: borderBox });
            }
          }
        };

        // Resolve percent widths first (affects text wrapping => intrinsic heights).
        allocAxis("w", refW ?? 0);
        // After width allocation, compute again to get correct fixed heights.
        computeAll();
        // Resolve percent heights (now that widths are known).
        allocAxis("h", refH ?? 0);

        // Final pass with resolved % sizes.
        const childSizeFinal = computeAll();
        return { overrides, childSize: childSizeFinal };
      }

      // Inner content box size (percent sizes are based on it; children are positioned relative to padding edge).
      // NOTE: percent sizes are based on "free space" inside this inner box, per UXL spec.
      let innerW = Math.max(0, cw - pad * 2);
      let innerH = Math.max(0, ch - pad * 2);

      // 1) Size children based on current cw/ch
      let pack = buildPercentOverridesAndSizes(innerW, innerH);
      let childSize = pack?.childSize || new Map();

      // Compute required width/height for the container based on stacking rules (no overlaps).
      // Horizontal stacking within mid band: L-group, Center-group, R-group (each keeps UXL order)
      const midL = [];
      const midC = [];
      const midR = [];
      for (const n of mid) {
        const hA = effAlign(n).h || null;
        if (hA === "L") midL.push(n);
        else if (hA === "R") midR.push(n);
        else midC.push(n);
      }
      const sumW = (arr) => arr.reduce((a, n) => a + (childSize.get(n.uid)?.w || 0), 0);
      const sumH = (arr) => arr.reduce((a, n) => a + (childSize.get(n.uid)?.h || 0), 0);
      const maxH = (arr) => arr.reduce((a, n) => Math.max(a, childSize.get(n.uid)?.h || 0), 0);
      const maxW = (arr) => arr.reduce((a, n) => Math.max(a, childSize.get(n.uid)?.w || 0), 0);

      // IN flow affects "same-anchor stacking" and therefore required band sizes.
      // Default: vertical stacking within each V-band (same V = stack vertically).
      // IN:H overrides to horizontal stacking within bands.
      const topH = inFlow === "H" ? maxH(top) : sumH(top);
      const bottomH = inFlow === "H" ? maxH(bottom) : sumH(bottom);
      // Mid band: default is vertical stacking (same V = center → stack vertically).
      const midH = inFlow === "H" ? maxH(mid) : Math.max(sumH(midL), sumH(midC), sumH(midR));
      const neededH = topH + midH + bottomH;

      // Width: for vertical stacking, need max width across H-groups; for horizontal, need sum.
      const midNeededW = inFlow === "H" ? sumW(midL) + sumW(midC) + sumW(midR) : maxW(midL) + maxW(midC) + maxW(midR);
      const bandNeededW = inFlow === "H" ? Math.max(sumW(top), sumW(bottom)) : 0;
      const neededW = Math.max(maxW(kids), midNeededW, bandNeededW);

      // Apply container growth by default (unless crop/scroll is set on that axis, in which case size is fixed to base).
      // Root (P) scrolls by default, so its size does not auto-grow.
      const contOw = node.size?.w?.overflow || (root ? windowSize.overflowW || "scroll" : null) || null;
      const contOh = node.size?.h?.overflow || (root ? windowSize.overflowH || "scroll" : null) || null;
      const fixedW = node.size?.w?.unit === "%";
      const fixedH = node.size?.h?.unit === "%";
      if (!contOw && !fixedW) cw = Math.max(cw, neededW + pad * 2);
      if (!contOh && !fixedH) ch = Math.max(ch, neededH + pad * 2);

      // If cw/ch changed due to growth, recompute % allocations against the final inner box.
      const nextInnerW = Math.max(0, cw - pad * 2);
      const nextInnerH = Math.max(0, ch - pad * 2);
      if (nextInnerW !== innerW || nextInnerH !== innerH) {
        innerW = nextInnerW;
        innerH = nextInnerH;
        pack = buildPercentOverridesAndSizes(innerW, innerH);
        childSize = pack?.childSize || childSize;
      }

      // Now place children.
      const placeW = Math.max(0, cw - pad * 2);
      const placeH = Math.max(0, ch - pad * 2);

      function applyBoxStyles(uid, x, y) {
        const eln = domByUid.get(uid);
        const sz = childSize.get(uid) || { w: 0, h: 0, innerW: 0, innerH: 0, m: 0 };
        if (!eln) return;
        const m = sz.m || 0;
        const iw = sz.innerW != null ? sz.innerW : Math.max(0, sz.w - m * 2);
        const ih = sz.innerH != null ? sz.innerH : Math.max(0, sz.h - m * 2);
        eln.style.left = `${x + m}px`;
        eln.style.top = `${y + m}px`;
        eln.style.width = `${iw}px`;
        eln.style.height = `${ih}px`;
      }

      function splitByHAlign(nodes) {
        const L = [];
        const C = [];
        const R = [];
        for (const n of nodes) {
          const hA = effAlign(n).h || null;
          if (hA === "L") L.push(n);
          else if (hA === "R") R.push(n);
          else C.push(n);
        }
        return { L, C, R };
      }

      function placeBandByFlow(nodes, { vAlign }) {
        if (inFlow !== "H" && inFlow !== "V") return null;
        const { L, C, R } = splitByHAlign(nodes);
        const placed = [];

        if (inFlow === "H") {
          // Pack 3 blocks without overlaps: L (left->right), C (center), R (right->left)
          const leftW = sumW(L);
          const rightW = sumW(R);
          const centerW = sumW(C);
          const rem = Math.max(0, placeW - leftW - rightW);
          const xC = leftW + Math.max(0, Math.round((rem - centerW) / 2));

          // L block
          let x = 0;
          for (const n of L) {
            const sz = childSize.get(n.uid) || { w: 0, h: 0 };
            const y = vAlign === "T" ? 0 : Math.max(0, placeH - sz.h);
            applyBoxStyles(n.uid, x, y);
            placed.push({ uid: n.uid, x, y, w: sz.w, h: sz.h });
            x += sz.w;
          }
          // C block
          x = xC;
          for (const n of C) {
            const sz = childSize.get(n.uid) || { w: 0, h: 0 };
            const y = vAlign === "T" ? 0 : Math.max(0, placeH - sz.h);
            applyBoxStyles(n.uid, x, y);
            placed.push({ uid: n.uid, x, y, w: sz.w, h: sz.h });
            x += sz.w;
          }
          // R block (right->left)
          x = placeW;
          for (let i = R.length - 1; i >= 0; i--) {
            const n = R[i];
            const sz = childSize.get(n.uid) || { w: 0, h: 0 };
            x -= sz.w;
            const y = vAlign === "T" ? 0 : Math.max(0, placeH - sz.h);
            applyBoxStyles(n.uid, x, y);
            placed.push({ uid: n.uid, x, y, w: sz.w, h: sz.h });
          }
          return placed;
        }

        // inFlow === "V": stack per h-group.
        const stackDown = (arr) => {
          let y = 0;
          for (const n of arr) {
            const sz = childSize.get(n.uid) || { w: 0, h: 0 };
            const hA = effAlign(n).h || null;
            const pref = alignToXY({ hAlign: hA, vAlign, parentW: placeW, parentH: placeH, w: sz.w, h: sz.h });
            const x = pref.x;
            applyBoxStyles(n.uid, x, y);
            placed.push({ uid: n.uid, x, y, w: sz.w, h: sz.h });
            y += sz.h;
          }
        };
        const stackUp = (arr) => {
          let y = placeH;
          for (const n of arr) {
            const sz = childSize.get(n.uid) || { w: 0, h: 0 };
            const hA = effAlign(n).h || null;
            const pref = alignToXY({ hAlign: hA, vAlign, parentW: placeW, parentH: placeH, w: sz.w, h: sz.h });
            const x = pref.x;
            y -= sz.h;
            applyBoxStyles(n.uid, x, y);
            placed.push({ uid: n.uid, x, y, w: sz.w, h: sz.h });
          }
        };
        if (vAlign === "T") {
          stackDown(L);
          stackDown(C);
          stackDown(R);
        } else {
          stackUp(L);
          stackUp(C);
          stackUp(R);
        }
        return placed;
      }

      function placeBandVerticalStack(nodes, { vAlign }) {
        // Stack elements vertically within the band. First in code = higher (smaller Y).
        // H alignment determines X position. Band is anchored to its V edge.
        const placed = []; // {uid,x,y,w,h}
        const totalH = sumH(nodes);
        // Band start Y: T=0, B=parentH-totalH
        const bandY = vAlign === "T" ? 0 : Math.max(0, placeH - totalH);
        let y = bandY;
        for (const n of nodes) {
          const sz = childSize.get(n.uid) || { w: 0, h: 0 };
          const hA = effAlign(n).h || null;
          const x = hA === "L" ? 0 : hA === "R" ? Math.max(0, placeW - sz.w) : Math.max(0, Math.round((placeW - sz.w) / 2));
          applyBoxStyles(n.uid, x, y);
          placed.push({ uid: n.uid, x, y, w: sz.w, h: sz.h });
          y += sz.h;
        }
        return placed;
      }

      // 1) Top band: vertical stacking, first = top (higher).
      //    IN:H/V overrides via placeBandByFlow.
      const placedTop = placeBandByFlow(top, { vAlign: "T" }) || placeBandVerticalStack(top, { vAlign: "T" });
      const topExtent = placedTop.reduce((m, r) => Math.max(m, r.y + r.h), 0);

      // 2) Bottom band: vertical stacking, first = higher (closer to center).
      //    Band as a whole is anchored to the bottom edge.
      const placedBottom = placeBandByFlow(bottom, { vAlign: "B" }) || placeBandVerticalStack(bottom, { vAlign: "B" });
      const bottomStart = placedBottom.length ? placedBottom.reduce((m, r) => Math.min(m, r.y), placeH) : placeH;

      // 3) Middle band: vertical stacking by default (same V = center → stack vertically).
      //    IN:H overrides to horizontal stacking.
      const midAreaY = topExtent;
      const midAreaH = Math.max(0, bottomStart - topExtent);
      const midY = midAreaY + Math.max(0, Math.round((midAreaH - midH) / 2));

      // Width calculation: vertical stacking uses max width; horizontal uses sum.
      const leftW = inFlow === "H" ? sumW(midL) : maxW(midL);
      const rightW = inFlow === "H" ? sumW(midR) : maxW(midR);
      const centerW = inFlow === "H" ? sumW(midC) : maxW(midC);
      const contentW = leftW + centerW + rightW;
      // cw already accounts for neededW (which includes contentW) above.

      if (inFlow === "H") {
        // IN:H: horizontal stacking (rows)
        // L group: left to right
        let xL = 0;
        for (const n of midL) {
          const sz = childSize.get(n.uid) || { w: 0, h: 0 };
          const y = midY + Math.max(0, Math.round((midH - sz.h) / 2));
          applyBoxStyles(n.uid, xL, y);
          xL += sz.w;
        }

        // R group: right to left
        let xR = placeW;
        for (let i = midR.length - 1; i >= 0; i--) {
          const n = midR[i];
          const sz = childSize.get(n.uid) || { w: 0, h: 0 };
          xR -= sz.w;
          const y = midY + Math.max(0, Math.round((midH - sz.h) / 2));
          applyBoxStyles(n.uid, xR, y);
        }

        // Center group: packed left-to-right, centered between L and R.
        const betweenL = xL;
        const betweenR = xR;
        const space = Math.max(0, betweenR - betweenL);
        const startC = betweenL + Math.max(0, Math.round((space - centerW) / 2));
        let xC = startC;
        for (const n of midC) {
          const sz = childSize.get(n.uid) || { w: 0, h: 0 };
          const y = midY + Math.max(0, Math.round((midH - sz.h) / 2));
          applyBoxStyles(n.uid, xC, y);
          xC += sz.w;
        }
      } else {
        // Default (and IN:V): vertical stacking (columns).
        // Elements with same V (center) stack vertically. H determines X position.
        // First in code = higher (smaller Y).
        const betweenL = leftW;
        const betweenR = Math.max(0, placeW - rightW);
        const space = Math.max(0, betweenR - betweenL);
        const startC = betweenL + Math.max(0, Math.round((space - centerW) / 2));

        // L column: stack top-to-bottom, left-aligned
        let y = midAreaY + Math.max(0, Math.round((midAreaH - sumH(midL)) / 2));
        for (const n of midL) {
          const sz = childSize.get(n.uid) || { w: 0, h: 0 };
          applyBoxStyles(n.uid, 0, y);
          y += sz.h;
        }

        // C column: stack top-to-bottom, center-aligned
        y = midAreaY + Math.max(0, Math.round((midAreaH - sumH(midC)) / 2));
        for (const n of midC) {
          const sz = childSize.get(n.uid) || { w: 0, h: 0 };
          const x = startC + Math.max(0, Math.round((centerW - sz.w) / 2));
          applyBoxStyles(n.uid, x, y);
          y += sz.h;
        }

        // R column: stack top-to-bottom, right-aligned
        y = midAreaY + Math.max(0, Math.round((midAreaH - sumH(midR)) / 2));
        const baseX = Math.max(0, placeW - rightW);
        for (const n of midR) {
          const sz = childSize.get(n.uid) || { w: 0, h: 0 };
          const x = baseX + Math.max(0, rightW - sz.w);
          applyBoxStyles(n.uid, x, y);
          y += sz.h;
        }
      }

      return { w: cw, h: ch };
    }

    function relayout() {
      const cs = getComputedStyle(containerEl);
      const borderX = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
      const borderY = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);

      // Working area for P is the window size (WxH). Scrollbars must not reduce this area.
      const targetInnerW = Math.max(0, windowSize.w);
      const targetInnerH = Math.max(0, windowSize.h);
      const sb = getScrollbarThicknessPx();

      // We may need 1-2 passes: scrollbars can cause cascaded overflow.
      let needV = false;
      let needH = false;
      for (let pass = 0; pass < 2; pass++) {
        // Set outer size so that client area (excluding borders and scrollbars) equals targetInner.
        const extraW = needV ? sb.w : 0;
        const extraH = needH ? sb.h : 0;
        containerEl.style.width = `${targetInnerW + borderX + extraW}px`;
        containerEl.style.height = `${targetInnerH + borderY + extraH}px`;

        // Layout uses the working area, not the reduced client size.
        layoutContainer(rootNode, containerEl, targetInnerW, targetInnerH, { root: true });

        // Re-evaluate overflow needs against the working area (not against clientWidth which may be reduced).
        const sw = containerEl.scrollWidth;
        const sh = containerEl.scrollHeight;
        const nextNeedH = sw > targetInnerW + 1; // +1 for rounding noise
        const nextNeedV = sh > targetInnerH + 1;
        if (nextNeedH === needH && nextNeedV === needV) break;
        needH = nextNeedH;
        needV = nextNeedV;
      }
    }

    // Defer first layout until the page subtree is attached to DOM, otherwise intrinsic measurements are 0.
    function waitForImagesBeforeLayout() {
      const pending = [];
      function walk(node) {
        if (!node) return;
        if (node.tag === "I") {
          const needIntrinsic = !node.size || !node.size.w || !node.size.h;
          if (needIntrinsic) {
            const eln = domByUid.get(node.uid);
            const img = eln ? eln.querySelector("img") : null;
            if (img && !(img.complete && img.naturalWidth > 0)) {
              pending.push(
                new Promise((resolve) => {
                  const done = () => resolve();
                  img.addEventListener("load", done, { once: true });
                  img.addEventListener("error", done, { once: true });
                  if (typeof img.decode === "function") {
                    img.decode().then(done).catch(done);
                  }
                }),
              );
            }
          }
        }
        for (const ch of node.children || []) walk(ch);
      }
      walk(rootNode);
      if (!pending.length) return Promise.resolve();
      // Safety: don't block forever on slow/broken images.
      return Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, 1500))]);
    }

    requestAnimationFrame(() => {
      waitForImagesBeforeLayout().then(() => relayout());
    });

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

  function ensureArrowMarker(svg, id = "uxl-arrow") {
    // Create marker once per SVG.
    const existing = svg.querySelector(`marker#${CSS.escape(id)}`);
    if (existing) return id;
    let defs = svg.querySelector("defs");
    if (!defs) {
      defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
      svg.prepend(defs);
    }
    const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
    marker.setAttribute("id", id);
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "6");
    marker.setAttribute("markerHeight", "6");
    // Use auto-start-reverse so marker-start points "into" the start node (opposite path direction),
    // which is what we want for bidirectional links (arrows on both ends).
    marker.setAttribute("orient", "auto-start-reverse");
    marker.setAttribute("markerUnits", "strokeWidth");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    path.setAttribute("fill", "currentColor");
    marker.append(path);
    defs.append(marker);
    return id;
  }

  function drawOrthogonalRounded(svg, start, end, opts = {}) {
    const { endCircle = true, circleRadius = 4, arrowMarkerId = null, arrowStartMarkerId = null, points = null } = opts;
    const pts =
      points ??
      (() => {
        const midX = Math.round((start.x + end.x) / 2);
        return [
          { x: Math.round(start.x), y: Math.round(start.y) },
          { x: midX, y: Math.round(start.y) },
          { x: midX, y: Math.round(end.y) },
          { x: Math.round(end.x), y: Math.round(end.y) },
        ];
      })();
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", pointsToRoundedPath(pts, 10));
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("stroke-linecap", "round");
    if (arrowMarkerId) path.setAttribute("marker-end", `url(#${arrowMarkerId})`);
    if (arrowStartMarkerId) path.setAttribute("marker-start", `url(#${arrowStartMarkerId})`);
    svg.append(path);

    if (endCircle) {
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", String(Math.round(end.x)));
      circle.setAttribute("cy", String(Math.round(end.y)));
      circle.setAttribute("r", String(circleRadius));
      // Filled circle for hints; fill controlled via CSS (stroke is also via CSS).
      circle.setAttribute("fill", "currentColor");
      svg.append(circle);
    }
  }

  function renderMap(ast) {
    const map = el("div", { class: "uxl-map" });
    const mapWrap = el("div", { class: "uxl-map-wrap" });
    const mapScale = el("div", { class: "uxl-map-scale" });
    const grid = el("div", { class: "uxl-map__grid" });
    const overlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    overlay.classList.add("uxl-overlay", "uxl-overlay--map");
    overlay.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const arrowId = "uxl-arrow";

    const pageEls = new Map(); // pageUid -> el
    for (const p of ast.pages) {
      const pageKey = p.uid;
      const pageEl = el("div", { class: "uxl-map__page", "data-page-uid": pageKey });
      // Use controlled <br> wrapping for long captions (more than 3 words).
      pageEl.innerHTML = formatMapCaption(pageLabel(p));
      pageEl.style.cursor = "pointer";
      pageEl.title = "Перейти к странице";
      pageEl.addEventListener("click", (ev) => {
        ev.preventDefault();
        const pageUid = pageKey;
        const pageBlock = document.querySelector(`.uxl-page[data-page-uid="${CSS.escape(pageUid)}"]`);
        const headEl = pageBlock?.querySelector(".uxl-page__head") || pageBlock;
        if (!headEl) return;
        headEl.scrollIntoView({ block: "start", inline: "nearest", behavior: "smooth" });
        // Highlight the target page (same as GOTO)
        pageBlock.classList.remove("uxl-page--goto");
        void pageBlock.offsetWidth;
        pageBlock.classList.add("uxl-page--goto");
        window.setTimeout(() => pageBlock.classList.remove("uxl-page--goto"), 2400);
      });
      pageEls.set(pageKey, pageEl);
      grid.append(pageEl);
    }

    const globalUids = new Set(ast.pages.filter((p) => String(p.type || "").trim().toUpperCase() === "G").map((p) => p.uid));

    // Put overlay inside the grid so it shares the same coordinate space and size (like hint callouts).
    grid.append(overlay);
    mapScale.append(grid);
    mapWrap.append(mapScale);
    map.append(mapWrap);

    function clearSvgKeepDefs(svg) {
      const defs = svg.querySelector("defs");
      // Remove all children except defs
      const children = Array.from(svg.childNodes);
      for (const ch of children) {
        if (ch === defs) continue;
        svg.removeChild(ch);
      }
      if (!svg.querySelector("defs")) {
        const d = document.createElementNS("http://www.w3.org/2000/svg", "defs");
        svg.prepend(d);
      }
    }

    function layoutAsTree() {
      const pagesInOrder = ast.pages.map((p) => p.uid);
      const pagesGlobal = pagesInOrder.filter((uid) => globalUids.has(uid));
      const pagesNormal = pagesInOrder.filter((uid) => !globalUids.has(uid));

      // Root: first NON-global page in the block (fallback: first page)
      const rootUid = pagesNormal[0] || pagesInOrder[0] || null;
      const level = new Map(); // pageUid -> number
      if (rootUid) level.set(rootUid, 0);

      const outgoing = new Map(); // fromUid -> Set(toUid)
      for (const e of ast.edges) {
        const fKey = normalizeId(e.fromId);
        const tKey = normalizeId(e.toId);
        const fromUid = ast.pageIdToUid?.[fKey] || null;
        const toUid = ast.pageIdToUid?.[tKey] || null;
        if (!fromUid || !toUid) continue;
        if (globalUids.has(fromUid) || globalUids.has(toUid)) continue; // TYPE:G pages have no edges on map
        if (!outgoing.has(fromUid)) outgoing.set(fromUid, new Set());
        outgoing.get(fromUid).add(toUid);
      }

      // BFS-like relax
      const q = [];
      if (rootUid) q.push(rootUid);
      while (q.length) {
        const cur = q.shift();
        const curLvl = level.get(cur) ?? 0;
        for (const nxt of outgoing.get(cur) || []) {
          const nextLvl = curLvl + 1;
          const prev = level.get(nxt);
          if (prev == null || nextLvl < prev) {
            level.set(nxt, nextLvl);
            q.push(nxt);
          }
        }
      }

      // Unreachable pages: place at level 0 after root, stacked below (normal pages only)
      for (const uid of pagesNormal) {
        if (!level.has(uid)) level.set(uid, 0);
      }

      // Group by level; preserve original order within each level
      const groups = new Map(); // lvl -> [pageUid]
      for (const uid of pagesNormal) {
        const lvl = level.get(uid) ?? 0;
        if (!groups.has(lvl)) groups.set(lvl, []);
        groups.get(lvl).push(uid);
      }
      const levels = Array.from(groups.keys()).sort((a, b) => a - b);

      // Measure node sizes
      const sizes = new Map(); // uid -> {w,h}
      for (const uid of pagesInOrder) {
        const elp = pageEls.get(uid);
        if (!elp) continue;
        // Use offset sizes to ignore any CSS transforms (mobile scaling).
        sizes.set(uid, { w: Math.ceil(elp.offsetWidth), h: Math.ceil(elp.offsetHeight) });
      }

      const colGap = 80;
      const rowGap = 26;

      const colWidths = new Map();
      for (const lvl of levels) {
        let maxW = 0;
        for (const uid of groups.get(lvl)) {
          const s = sizes.get(uid) || { w: 160, h: 48 };
          maxW = Math.max(maxW, s.w);
        }
        colWidths.set(lvl, maxW);
      }

      // X offsets
      const xOffset = new Map();
      let x = 0;
      for (const lvl of levels) {
        xOffset.set(lvl, x);
        x += (colWidths.get(lvl) || 160) + colGap;
      }

      // Place nodes
      let totalH = 0;
      for (const lvl of levels) {
        let y = 0;
        for (const uid of groups.get(lvl)) {
          const elp = pageEls.get(uid);
          if (!elp) continue;
          const s = sizes.get(uid) || { w: 160, h: 48 };
          elp.style.left = `${xOffset.get(lvl)}px`;
          elp.style.top = `${y}px`;
          elp.style.width = `${s.w}px`;
          elp.style.height = `${s.h}px`;
          y += s.h + rowGap;
        }
        totalH = Math.max(totalH, y);
      }

      // Place TYPE:G pages as a separate "bottom list" with no edges.
      let bottomY = Math.max(0, totalH - rowGap);
      if (pagesGlobal.length) bottomY += rowGap * 2;
      let gMaxW = 0;
      let yG = bottomY;
      for (const uid of pagesGlobal) {
        const elp = pageEls.get(uid);
        if (!elp) continue;
        const s = sizes.get(uid) || { w: 160, h: 48 };
        gMaxW = Math.max(gMaxW, s.w);
        elp.style.left = `0px`;
        elp.style.top = `${yG}px`;
        elp.style.width = `${s.w}px`;
        elp.style.height = `${s.h}px`;
        yG += s.h + rowGap;
      }

      const normalW = Math.max(0, x - colGap);
      const finalW = Math.max(normalW, gMaxW);
      const finalH = pagesGlobal.length ? Math.max(0, yG - rowGap) : Math.max(0, totalH - rowGap);
      grid.style.width = `${finalW}px`;
      grid.style.height = `${finalH}px`;
    }

    function redraw() {
      // clear but keep defs/markers
      clearSvgKeepDefs(overlay);
      ensureArrowMarker(overlay, arrowId);

      // IMPORTANT: Use untransformed sizes/coords so arrows remain correct under CSS scaling.
      const baseW = Math.round(grid.offsetWidth);
      const baseH = Math.round(grid.offsetHeight);
      overlay.setAttribute("viewBox", `0 0 ${baseW} ${baseH}`);
      overlay.setAttribute("width", String(baseW));
      overlay.setAttribute("height", String(baseH));

      // Merge bidirectional transitions: A<->B is drawn as a single connection with arrows on both ends.
      // Also dedupe multiple A->B (already deduped in ast.edges).
      const byPair = new Map(); // pairKey -> {aKey,bKey,aUid,bUid,ab:boolean,ba:boolean}
      for (const e of ast.edges) {
        const aKey = normalizeId(e.fromId);
        const bKey = normalizeId(e.toId);
        if (!aKey || !bKey) continue;
        const aUid0 = ast.pageIdToUid?.[aKey] || null;
        const bUid0 = ast.pageIdToUid?.[bKey] || null;
        if (!aUid0 || !bUid0) continue;
        if (globalUids.has(aUid0) || globalUids.has(bUid0)) continue; // TYPE:G pages have no edges on map
        const lo = aKey < bKey ? aKey : bKey;
        const hi = aKey < bKey ? bKey : aKey;
        const pairKey = `${lo}<=>${hi}`;
        const ent = byPair.get(pairKey) || {
          lo,
          hi,
          loUid: ast.pageIdToUid?.[lo] || null,
          hiUid: ast.pageIdToUid?.[hi] || null,
          loToHi: false,
          hiToLo: false,
        };
        if (aKey === lo && bKey === hi) ent.loToHi = true;
        if (aKey === hi && bKey === lo) ent.hiToLo = true;
        byPair.set(pairKey, ent);
      }

      function rectRel(el) {
        // Pages are positioned absolutely inside `grid`, so offsetLeft/Top are in the same coord space.
        const left = el.offsetLeft;
        const top = el.offsetTop;
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        return {
          left,
          top,
          right: left + w,
          bottom: top + h,
          midX: left + w / 2,
          midY: top + h / 2,
          w,
          h,
        };
      }

      for (const ent of byPair.values()) {
        const loUid = ent.loUid;
        const hiUid = ent.hiUid;
        const loEl = loUid ? pageEls.get(loUid) : null;
        const hiEl = hiUid ? pageEls.get(hiUid) : null;
        if (!loEl || !hiEl) continue;

        const loRect = rectRel(loEl);
        const hiRect = rectRel(hiEl);

        const bidir = ent.loToHi && ent.hiToLo;

        // Determine logical direction for single-direction links.
        // For bidirectional, direction is irrelevant; we route left-to-right in screen space.
        let fromRect = loRect;
        let toRect = hiRect;
        if (!bidir) {
          if (ent.loToHi) {
            fromRect = loRect;
            toRect = hiRect;
          } else if (ent.hiToLo) {
            fromRect = hiRect;
            toRect = loRect;
          } else {
            continue;
          }
        } else {
          // Screen-space left-to-right so the polyline is stable.
          if (loRect.midX <= hiRect.midX) {
            fromRect = loRect;
            toRect = hiRect;
          } else {
            fromRect = hiRect;
            toRect = loRect;
          }
        }

        const pad = 2;
        const toRight = toRect.midX >= fromRect.midX;
        const startX = toRight ? fromRect.right + pad : fromRect.left - pad;
        const endX = toRight ? toRect.left - pad : toRect.right + pad;
        const startY = fromRect.midY;
        const endY = toRect.midY;

        const midX = Math.round((startX + endX) / 2);
        const pts = [
          { x: Math.round(startX), y: Math.round(startY) },
          { x: midX, y: Math.round(startY) },
          { x: midX, y: Math.round(endY) },
          { x: Math.round(endX), y: Math.round(endY) },
        ];

        drawOrthogonalRounded(overlay, { x: startX, y: startY }, { x: endX, y: endY }, {
          endCircle: false,
          arrowMarkerId: arrowId,
          arrowStartMarkerId: bidir ? arrowId : null,
          points: pts,
        });
      }
    }

    function relayoutAndRedraw() {
      // Wait for layout measurement after DOM insertion.
      requestAnimationFrame(() => {
        layoutAsTree();
        redraw();
        applyMapScaleToFitWidth();
      });
    }

    function applyMapScaleToFitWidth() {
      const vv = window.visualViewport;
      const vw = vv ? vv.width : window.innerWidth;
      const mobile = vw <= 900;

      if (!mobile) {
        mapScale.style.transform = "";
        mapScale.style.transformOrigin = "";
        mapScale.style.width = "";
        mapScale.style.height = "";
        return;
      }

      // Scale down only (never upscale) so the map fits the available width.
      const availW = mapWrap.clientWidth || map.getBoundingClientRect().width || vw;
      const baseW = grid.offsetWidth || 1; // offsetWidth ignores transform; good for baseline
      const baseH = grid.offsetHeight || 1;
      const pad = 8;
      const scale = Math.max(0.1, Math.min(1, (availW - pad * 2) / baseW));

      mapScale.style.transformOrigin = "top left";
      mapScale.style.transform = `scale(${scale})`;
      // Make the wrapper's layout size match the transformed size to avoid extra overflow/blank space.
      mapScale.style.width = `${Math.round(baseW * scale)}px`;
      mapScale.style.height = `${Math.round(baseH * scale)}px`;
    }

    relayoutAndRedraw();
    window.addEventListener("resize", () => relayoutAndRedraw());
    if (window.visualViewport) window.visualViewport.addEventListener("resize", () => relayoutAndRedraw());

    return map;
  }

  function renderPageSection(ast, pageNode, { windowOverride = null } = {}) {
    const page = el("div", { class: "uxl-page", "data-page-uid": pageNode.uid });
    const headText = pageLabel(pageNode);
    const head = el("div", { class: "uxl-page__head", text: headText });
    const body = el("div", { class: "uxl-page__body" });
    const canvasWrap = el("div", { class: "uxl-canvas-wrap" });
    const canvasScale = el("div", { class: "uxl-canvas-scale" });
    const canvas = el("div", { class: "uxl-canvas" });
    const win = windowOverride || ast.window;
    canvas.style.width = `${win.w}px`;
    canvas.style.height = `${win.h}px`;
    canvasScale.append(canvas);
    canvasWrap.append(canvasScale);

    const hints = el("div", { class: "uxl-hints" });
    const list = el("ul", { class: "uxl-hints__list" });
    hints.append(list);

    const overlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    overlay.classList.add("uxl-overlay", "uxl-overlay--hints");
    overlay.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    body.append(canvasWrap, hints, overlay);
    page.append(head, body);

    // Render nodes; layout will run on next animation frame (after DOM insertion).
    const domByUid = layoutTree(canvas, pageNode, win);

    function applyResponsiveScale() {
      // Only scale down on small screens to fit width; desktop keeps 1:1.
      const vw = window.visualViewport ? window.visualViewport.width : window.innerWidth;
      const mobile = vw <= 900;
      if (!mobile) {
        canvasScale.style.transform = "";
        canvasScale.style.transformOrigin = "";
        canvasScale.style.width = "";
        canvasScale.style.height = "";
        return;
      }

      // Available width is the page body width (single-column on mobile via CSS).
      const bodyRect = body.getBoundingClientRect();
      const pad = 8;
      const availW = Math.max(0, bodyRect.width - pad * 2);
      const scale = Math.max(0.1, Math.min(1, availW / win.w));
      canvasScale.style.transformOrigin = "top left";
      canvasScale.style.transform = `scale(${scale})`;
      // Ensure the scaled wrapper contributes correct layout size (prevents horizontal scroll).
      canvasScale.style.width = `${Math.round(win.w * scale)}px`;
      canvasScale.style.height = `${Math.round(win.h * scale)}px`;
    }

    requestAnimationFrame(() => applyResponsiveScale());
    window.addEventListener("resize", () => requestAnimationFrame(() => applyResponsiveScale()));
    if (window.visualViewport) window.visualViewport.addEventListener("resize", () => requestAnimationFrame(() => applyResponsiveScale()));

    function scrollToPageUid(pageUid) {
      const root = page.closest(".uxl-root") || document;
      const pageEl = root.querySelector(`.uxl-page[data-page-uid="${CSS.escape(pageUid)}"]`);
      const headEl = pageEl?.querySelector(".uxl-page__head") || pageEl;
      if (!headEl) return false;
      headEl.scrollIntoView({ block: "start", inline: "nearest", behavior: "smooth" });
      if (pageEl) {
        pageEl.classList.remove("uxl-page--goto");
        void pageEl.offsetWidth;
        pageEl.classList.add("uxl-page--goto");
        window.setTimeout(() => pageEl.classList.remove("uxl-page--goto"), 2400);
      }
      return true;
    }

    // Wire ACTION clicks to navigate between pages (scroll the browser page).
    function wireActionClicks() {
      const navRoot = page.closest(".uxl-root") || document;
      if (!navRoot.__uxlNavState) navRoot.__uxlNavState = { stack: [] };
      const nav = navRoot.__uxlNavState;

      const nearestPageUidFromNode = (n) => {
        let cur = n;
        while (cur && cur.tag !== "P") cur = cur.parent;
        return cur ? cur.uid : null;
      };

      const ensureTopIs = (uid) => {
        if (!uid) return;
        const last = nav.stack[nav.stack.length - 1] || null;
        if (!last) {
          nav.stack.push(uid);
          return;
        }
        if (last !== uid) nav.stack.push(uid);
      };

      const clickable = Array.from(canvas.querySelectorAll('[data-uxl-uid]'));
      for (const elx of clickable) {
        const uid = elx.getAttribute("data-uxl-uid");
        if (!uid) continue;
        const node = ast.nodeByUid?.get(uid) || null;
        if (!node || !node.action || (node.action.type !== "GOTO" && node.action.type !== "GOTOBACK")) continue;
        elx.style.cursor = "pointer";
        elx.addEventListener("click", (ev) => {
          ev.preventDefault();

          // Maintain a simple navigation stack per rendered root.
          const fromUid = nearestPageUidFromNode(node);
          ensureTopIs(fromUid);

          if (node.action.type === "GOTOBACK") {
            if (nav.stack.length <= 1) return;
            nav.stack.pop(); // drop current
            const backUid = nav.stack[nav.stack.length - 1] || null;
            if (backUid) scrollToPageUid(backUid);
            return;
          }

          const targetId = String(node.action.target || "").trim();
          const targetKey = normalizeId(targetId);
          const pageUid = ast.pageIdToUid?.[targetKey] || null;
          if (!pageUid) {
            // Target page must have an ID to be addressable.
            alert(`UXL: страница для GOTO не найдена: "${targetId}"`);
            return;
          }
          ensureTopIs(pageUid);
          if (!scrollToPageUid(pageUid)) alert(`UXL: не удалось перейти к странице "${targetId}" (DOM не найден).`);
        });
      }
    }
    // Defer wiring until DOM is in place (after renderAll replacement).
    queueMicrotask(() => wireActionClicks());

    // Collect hints (only nodes with non-empty hint)
    const hintItems = [];
    function collectHints(node) {
      if (node.hint && String(node.hint).trim() !== "") {
        hintItems.push(node);
      }
      for (const ch of node.children || []) collectHints(ch);
    }
    // Include page itself if it has hint.
    collectHints(pageNode);

    const elementHints = hintItems.filter((n) => n.uid !== pageNode.uid);
    const numByUid = new Map(); // uid -> 1-based number for element hints
    for (let i = 0; i < elementHints.length; i++) {
      numByUid.set(elementHints[i].uid, i + 1);
    }

    for (const n of hintItems) {
      const text = el("span", { class: "uxl-hint-text", text: n.hint });
      const isPageHint = n.uid === pageNode.uid;
      const num = numByUid.get(n.uid) || null;
      const children = isPageHint
        ? [text]
        : [
            el("span", { class: "uxl-hint-dot", "data-uxl-dot": "1" }),
            el("span", { class: "uxl-hint-badge uxl-hint-badge--list", text: String(num ?? "") }),
            text,
          ];
      const li = el(
        "li",
        { class: isPageHint ? "uxl-hints__item uxl-hints__item--page" : "uxl-hints__item", "data-uxl-uid": n.uid },
        children,
      );
      list.append(li);
    }

    // Mobile mode: show numbered badges on elements (instead of hint lines).
    const badgeLayer = el("div", { class: "uxl-hint-badges", "aria-hidden": "true" });
    canvas.append(badgeLayer);
    const badgeByUid = new Map(); // uid -> badgeEl

    function updateMobileHintBadges() {
      const vw = window.visualViewport ? window.visualViewport.width : window.innerWidth;
      const mobile = vw <= 900;
      // Mobile request: hide element hint badges entirely (keep only page hint text in the list).
      badgeLayer.style.display = "none";
      if (mobile) return;

      const canvasRect = canvas.getBoundingClientRect();
      const baseW = win?.w || canvas.offsetWidth || 1;
      const scale = Math.max(0.0001, canvasRect.width / baseW);

      const badgeR = 9; // px (half of 18px badge)
      for (let idx = 0; idx < elementHints.length; idx++) {
        const n = elementHints[idx];
        const target = domByUid.get(n.uid);
        const num = numByUid.get(n.uid);
        if (!target || !num) continue;

        const tRect = target.getBoundingClientRect();
        // Anchor near the right edge (where desktop callout circle lands), with small deterministic vertical spread.
        const spread = (idx - (elementHints.length - 1) / 2) * 8;
        const x = (tRect.right - canvasRect.left) / scale - badgeR;
        const y = (tRect.top + tRect.height / 2 - canvasRect.top) / scale + spread;

        let badge = badgeByUid.get(n.uid) || null;
        if (!badge) {
          badge = el("div", { class: "uxl-hint-badge uxl-hint-badge--on-element" });
          badgeByUid.set(n.uid, badge);
          badgeLayer.append(badge);
        }
        badge.textContent = String(num);
        badge.style.left = `${Math.round(x)}px`;
        badge.style.top = `${Math.round(y)}px`;
      }
    }

    function redrawHintLines() {
      while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
      const bodyRect = body.getBoundingClientRect();
      overlay.setAttribute("viewBox", `0 0 ${Math.round(bodyRect.width)} ${Math.round(bodyRect.height)}`);
      overlay.setAttribute("width", String(Math.round(bodyRect.width)));
      overlay.setAttribute("height", String(Math.round(bodyRect.height)));

      const hintWithLines = hintItems.filter((n) => n.uid !== pageNode.uid);
      // Build segments first so we can assign "lanes" (different midX) to reduce overlaps.
      const segs = [];
      for (let idx = 0; idx < hintWithLines.length; idx++) {
        const n = hintWithLines[idx];
        const li = list.querySelector(`li[data-uxl-uid="${CSS.escape(n.uid)}"]`);
        const target = domByUid.get(n.uid);
        if (!li || !target) continue;
        const dot = li.querySelector('[data-uxl-dot="1"]');
        if (!dot) continue;
        const dotRect = dot.getBoundingClientRect();
        const tRect = target.getBoundingClientRect();

        const start = { x: dotRect.left + dotRect.width / 2 - bodyRect.left, y: dotRect.top + dotRect.height / 2 - bodyRect.top };
        // End point should land on the edge facing the hints list (right edge).
        // Keep a deterministic vertical spread so multiple callouts don't collapse into a single horizontal line.
        const baseEnd = { x: tRect.right - bodyRect.left, y: tRect.top + tRect.height / 2 - bodyRect.top };
        const spread = (idx - (hintWithLines.length - 1) / 2) * 8;
        const end = { x: baseEnd.x, y: baseEnd.y + spread };

        const y1 = Math.min(start.y, end.y);
        const y2 = Math.max(start.y, end.y);
        segs.push({ start, end, y1, y2 });
      }

      // Assign lane index to reduce overlapping vertical segments.
      // Each lane corresponds to a different midX (channel) in the corridor between canvas and hints list.
      const laneGap = 14; // px
      const lanePad = 10; // y-padding for overlap checks
      const lanes = []; // laneIdx -> [{y1,y2}]
      function rangesOverlap(a1, a2, b1, b2) {
        return a1 <= b2 + lanePad && a2 >= b1 - lanePad;
      }
      function pickLane(y1, y2) {
        for (let li = 0; li < lanes.length; li++) {
          const used = lanes[li] || [];
          let ok = true;
          for (const r of used) {
            if (rangesOverlap(y1, y2, r.y1, r.y2)) {
              ok = false;
              break;
            }
          }
          if (ok) return li;
        }
        lanes.push([]);
        return lanes.length - 1;
      }

      for (const s of segs) {
        const lane = pickLane(s.y1, s.y2);
        lanes[lane].push({ y1: s.y1, y2: s.y2 });

        // Place midX near the canvas edge and fan out to the right by lane index.
        const minX = Math.min(s.start.x, s.end.x);
        const maxX = Math.max(s.start.x, s.end.x);
        let midX = Math.round((s.end.x + 18) + lane * laneGap);
        // Clamp to stay within the corridor between target and hint dot.
        midX = Math.max(Math.round(minX + 12), Math.min(Math.round(maxX - 12), midX));

        const pts = [
          { x: Math.round(s.start.x), y: Math.round(s.start.y) },
          { x: midX, y: Math.round(s.start.y) },
          { x: midX, y: Math.round(s.end.y) },
          { x: Math.round(s.end.x), y: Math.round(s.end.y) },
        ];

        drawOrthogonalRounded(overlay, s.start, s.end, { endCircle: true, circleRadius: 4, arrowMarkerId: null, points: pts });
      }
    }

    // Wait a frame so layout has a chance to run before drawing hint lines.
    requestAnimationFrame(() => redrawHintLines());
    window.addEventListener("resize", () => requestAnimationFrame(() => redrawHintLines()));
    canvas.addEventListener("scroll", () => requestAnimationFrame(() => redrawHintLines()));

    // Mobile badges: keep in sync with layout/scroll.
    requestAnimationFrame(() => updateMobileHintBadges());
    window.addEventListener("resize", () => requestAnimationFrame(() => updateMobileHintBadges()));
    if (window.visualViewport) window.visualViewport.addEventListener("resize", () => requestAnimationFrame(() => updateMobileHintBadges()));
    // Capture scroll events from any scrollable descendant (scroll doesn't bubble, but it does capture).
    body.addEventListener(
      "scroll",
      () => {
        requestAnimationFrame(() => updateMobileHintBadges());
      },
      true,
    );

    return page;
  }

  function openPrototypeForText(uxlText, { mode = "permissive", view = "1:1" } = {}) {
    const key = `uxl-proto:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    const lastKey = "uxl-proto:last";
    const payload = { uxlText: String(uxlText || ""), mode, view: view === "fullscreen" ? "fullscreen" : "1:1" };
    // Store one-shot key (for backwards compatibility) + "last" (main path).
    localStorage.setItem(key, JSON.stringify(payload));
    // Store "last" so prototype can open a stable URL and still render the latest content.
    localStorage.setItem(lastKey, JSON.stringify(payload));

    function getBaseHref() {
      // Directory of current document, with trailing slash.
      const url = new URL(window.location.href);
      url.hash = "";
      url.search = "";
      url.pathname = url.pathname.replace(/[^/]*$/, "");
      return url.toString();
    }

    // Open prototype in a new tab WITHOUT requiring a separate prototype.html file.
    const w = window.open("", "_blank");
    if (!w) {
      alert("Не удалось открыть новую вкладку (возможно, заблокировано браузером). Разрешите pop-up и попробуйте снова.");
      return;
    }

    const base = getBaseHref();
    const doc = w.document;
    doc.open();
    doc.write(`<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>UXL prototype</title>
    <base href="${base}">
    <link rel="stylesheet" href="./uxl.css" />
    <style>
      body {
        margin: 0;
        background: #2b2b2b;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        width: 100vw;
        height: 100dvh;
      }
    </style>
  </head>
  <body>
    <script src="./uxl.js"></script>
    <script>
      // Render latest prototype from localStorage ("uxl-proto:last")
      window.UXL.renderPrototypeFromStorageKeyOrLast(null);
    </script>
  </body>
</html>`);
    doc.close();
  }

  function renderPrototypeFromStorageKeyOrLast(key) {
    const lastKey = "uxl-proto:last";
    const effectiveKey = key || lastKey;
    const raw = localStorage.getItem(effectiveKey);
    if (!raw) {
      document.body.textContent = "UXL prototype: нет сохранённого прототипа (откройте «Открыть прототип» в основном рендере).";
      return;
    }
    // one-shot only for explicit keys; keep "last"
    if (key) localStorage.removeItem(key);

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { uxlText: raw, mode: "permissive" };
    }
    const uxlText = String(payload.uxlText || "");
    const mode = payload.mode === "strict" ? "strict" : "permissive";
    const view = payload.view === "fullscreen" ? "fullscreen" : "1:1";

    let ast;
    try {
      ast = parseUxl(uxlText, { mode, sourceName: "UXL prototype" });
    } catch (e) {
      document.body.replaceChildren(renderError(e instanceof UxlParseError ? e : new UxlParseError(String(e), { sourceName: "UXL prototype" })));
      return;
    }

    // Prototype page styles
    document.body.style.background = view === "fullscreen" ? "#e2e2e2" : "#2b2b2b";
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";
    document.body.style.width = "100vw";
    document.body.style.height = "100dvh";
    // Override inline styles in prototype*.html (they set body as a flex container).
    document.body.style.display = view === "fullscreen" ? "block" : "flex";
    document.body.style.alignItems = view === "fullscreen" ? "" : "center";
    document.body.style.justifyContent = view === "fullscreen" ? "" : "center";

    const root = el("div", {
      class: view === "fullscreen" ? "uxl-root uxl-proto-root uxl-proto-root--fullscreen" : "uxl-root uxl-proto-root",
    });
    const frame = el("div", { class: "uxl-proto-frame" });
    const canvas = el("div", { class: "uxl-canvas" });
    let win = view === "fullscreen" ? getViewportWindowSize({ pad: 0 }) : ast.window;
    canvas.style.width = `${win.w}px`;
    canvas.style.height = `${win.h}px`;
    frame.append(canvas);
    root.append(frame);
    document.body.replaceChildren(root);

    const pageByUid = new Map(ast.pages.map((p) => [p.uid, p]));
    let currentUid = ast.pages[0]?.uid || null;
    const navStack = currentUid ? [currentUid] : [];
    let lastWinW = win.w;
    let lastWinH = win.h;
    let gotoAfterTimerId = null;

    function navigateTo(uid, { pushHistory = true } = {}) {
      if (!uid) return;
      if (pushHistory) {
        const last = navStack[navStack.length - 1] || null;
        if (!last) navStack.push(uid);
        else if (last !== uid) navStack.push(uid);
      }
      currentUid = uid;
      renderCurrent();
    }

    function refreshFullscreenWindowIfNeeded() {
      if (view !== "fullscreen") return;
      const next = getViewportWindowSize({ pad: 0 });
      if (next.w === lastWinW && next.h === lastWinH) return;
      win = next;
      lastWinW = next.w;
      lastWinH = next.h;
      canvas.style.width = `${win.w}px`;
      canvas.style.height = `${win.h}px`;
      renderCurrent();
    }

    function renderCurrent() {
      const pageNode = currentUid ? pageByUid.get(currentUid) : null;
      if (!pageNode) return;
      document.title = pageLabel(pageNode);

      canvas.replaceChildren();
      layoutTree(canvas, pageNode, win);

      // Auto navigation: P\...\GOTOAFTER:<seconds> (prototype-only)
      if (gotoAfterTimerId != null) {
        window.clearTimeout(gotoAfterTimerId);
        gotoAfterTimerId = null;
      }
      const sec = pageNode.gotoAfterSec;
      if (sec != null && Number.isFinite(sec) && sec >= 0) {
        const idx = ast.pages.findIndex((p) => p.uid === pageNode.uid);
        const next = idx >= 0 ? ast.pages[idx + 1] : null;
        if (next) {
          gotoAfterTimerId = window.setTimeout(() => {
            gotoAfterTimerId = null;
            navigateTo(next.uid, { pushHistory: true });
          }, Math.round(sec * 1000));
        }
      }

      // wire actions: switch pages inside prototype
      const clickable = Array.from(canvas.querySelectorAll('[data-uxl-uid]'));
      for (const elx of clickable) {
        const uid = elx.getAttribute("data-uxl-uid");
        if (!uid) continue;
        const node = ast.nodeByUid?.get(uid) || null;
        if (!node || !node.action || (node.action.type !== "GOTO" && node.action.type !== "GOTOBACK")) continue;
        elx.style.cursor = "pointer";
        elx.addEventListener("click", (ev) => {
          ev.preventDefault();

          if (node.action.type === "GOTOBACK") {
            if (navStack.length <= 1) return;
            navStack.pop(); // drop current
            const backUid = navStack[navStack.length - 1] || null;
            navigateTo(backUid, { pushHistory: false });
            return;
          }

          const targetId = String(node.action.target || "").trim();
          const targetKey = normalizeId(targetId);
          const targetUid = ast.pageIdToUid?.[targetKey] || null;
          if (!targetUid) {
            alert(`UXL: страница для GOTO не найдена: "${targetId}"`);
            return;
          }
          navigateTo(targetUid, { pushHistory: true });
        });
      }

      // GOTOBACK is supported via ACTION (uses navStack).
    }

    function applyScaleToFit() {
      if (view === "fullscreen") {
        // No scaling/padding in fullscreen: canvas already matches the viewport size.
        frame.style.transformOrigin = "";
        frame.style.transform = "";
        return;
      }
      // Scale the whole "window" to fit viewport without overflowing.
      const vv = window.visualViewport;
      const vw = vv ? vv.width : window.innerWidth;
      const vh = vv ? vv.height : window.innerHeight;

      // Leave tiny breathing room + room for the back link above the canvas.
      const pad = 8;
      const availW = Math.max(0, vw - pad * 2);
      const availH = Math.max(0, vh - pad * 2);
      const baseW = win.w;
      const baseH = win.h;
      // For Full Screen mode we never upscale (canvas already matches viewport).
      // For 1:1 we allow upscaling on mobile only; on desktop keep scale <= 1 to avoid scrollbars.
      const isMobileLike =
        ("ontouchstart" in window || (navigator.maxTouchPoints || 0) > 0) &&
        Math.min(vw, vh) <= 900;
      const maxScale = view === "fullscreen" ? 1 : isMobileLike ? 4 : 1;
      const scale = Math.max(0.1, Math.min(maxScale, availW / baseW, availH / baseH));

      frame.style.transformOrigin = "center center";
      frame.style.transform = `scale(${scale})`;
    }

    // Recompute scale on viewport changes (Android address bar/orientation).
    applyScaleToFit();
    window.addEventListener("resize", () => {
      refreshFullscreenWindowIfNeeded();
      applyScaleToFit();
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", () => {
        refreshFullscreenWindowIfNeeded();
        applyScaleToFit();
      });
    }

    renderCurrent();
  }

  function getViewportWindowSize({ pad = 16 } = {}) {
    const vv = window.visualViewport;
    const vw = vv ? vv.width : window.innerWidth;
    const vh = vv ? vv.height : window.innerHeight;
    return {
      w: Math.max(240, Math.floor(vw - pad)),
      h: Math.max(240, Math.floor(vh - pad)),
    };
  }

  function renderAst(ast, { uxlText = "", mode = "permissive", pageInterleaves = null } = {}) {
    const root = el("div", { class: "uxl-root" });
    const proto = el("div", { class: "uxl-proto-preview" });
    proto.append(el("div", { class: "uxl-map__title", text: "Превью прототипа" }));
    const toolbar = el("div", { class: "uxl-toolbar" });
    const protoBtn11 = el("button", { class: "uxl-toolbar__btn", type: "button", text: "1:1" });
    protoBtn11.addEventListener("click", () => openPrototypeForText(uxlText, { mode, view: "1:1" }));
    const protoBtnFs = el("button", { class: "uxl-toolbar__btn", type: "button", text: "Full Screen" });
    protoBtnFs.addEventListener("click", () => openPrototypeForText(uxlText, { mode, view: "fullscreen" }));
    toolbar.append(protoBtn11, protoBtnFs);
    proto.append(toolbar);
    root.append(proto);
    root.append(el("div", { class: "uxl-map__title", text: "Карта интерфейса" }));
    root.append(renderMap(ast));
    const pagesWrap = el("div", { class: "uxl-pages" });
    const inter = Array.isArray(pageInterleaves) ? pageInterleaves : null;
    if (!inter || inter.length === 0) {
      for (const p of ast.pages) pagesWrap.append(renderPageSection(ast, p));
    } else {
      const byIndex = new Map(); // idx -> [html]
      for (const it of inter) {
        const idx = Number.isFinite(it?.index) ? it.index : null;
        if (idx == null) continue;
        if (!byIndex.has(idx)) byIndex.set(idx, []);
        byIndex.get(idx).push(String(it.html ?? ""));
      }
      for (let i = 0; i <= ast.pages.length; i++) {
        for (const html of byIndex.get(i) || []) pagesWrap.append(renderRawHtml(html));
        if (i < ast.pages.length) pagesWrap.append(renderPageSection(ast, ast.pages[i]));
      }
    }
    root.append(pagesWrap);

    const footer = el("div", { class: "uxl-footer" });
    const ver = el("div", { class: "uxl-footer__ver", text: `UXL ${ast.uxlVersion || SUPPORTED_UXL_VERSION} / renderer ${RENDERER_VERSION}` });
    footer.append(ver);
    root.append(footer);
    return root;
  }

  function splitInlineHtmlFromUxlText(uxlText) {
    // Allows interleaving raw HTML lines inside a UXL block *for main page only*.
    // Those HTML lines are removed from parsing (replaced with comments), but we keep them to render
    // before/between/after pages based on line numbers.
    const lines = String(uxlText).replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
    const masked = [...lines];
    const htmlSegs = []; // {startLineNo,endLineNo,html}

      const TAG_RE = /^\s*(P|F|I|B|C|S|T|TH|TD)(\\|$)/i;
    const WINDOW_RE = /^\s*\d+\s*x\s*\d+\s*([CS]\s*)?([CS]\s*)?$/i;
    const VERSION_RE = /^\s*UXL\s*:\s*/i;

    let cur = null; // {start,end,parts:[]}
    const flush = () => {
      if (!cur) return;
      htmlSegs.push({ startLineNo: cur.start, endLineNo: cur.end, html: cur.parts.join("\n") });
      cur = null;
    };

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const lineNo = i + 1;
      const trimmed = raw.trim();
      const isBlank = !trimmed;
      const afterIndent = raw.replace(/^\s+/, "");
      const isComment = afterIndent.startsWith("#");
      const isTag = TAG_RE.test(raw);
      const isWindow = WINDOW_RE.test(raw);
      const isVersion = VERSION_RE.test(raw);
      const isUxl = isBlank || isComment || isTag || isWindow || isVersion;

      if (isUxl) {
        flush();
        continue;
      }

      // Treat as raw HTML line.
      masked[i] = `${raw.match(/^\s*/)?.[0] || ""}#__HTML__`;
      if (!cur) cur = { start: lineNo, end: lineNo, parts: [raw] };
      else {
        cur.end = lineNo;
        cur.parts.push(raw);
      }
    }
    flush();

    return { maskedUxlText: masked.join("\n"), htmlSegs };
  }

  function renderUxlTextMain(uxlText, opts = {}) {
    // Main page renderer: supports raw HTML lines inside the UXL block.
    // Prototype views (1:1 / fullscreen) must NOT be affected => we pass maskedUxlText into toolbar actions.
    try {
      const { maskedUxlText, htmlSegs } = splitInlineHtmlFromUxlText(uxlText);
      const ast = parseUxl(maskedUxlText, opts);

      // Place HTML segments before/between/after pages based on original line numbers.
      const interleaves = [];
      for (const seg of htmlSegs) {
        const idx = ast.pages.findIndex((p) => (p?.rawLineNo || 0) > seg.startLineNo);
        interleaves.push({ index: idx === -1 ? ast.pages.length : idx, html: seg.html });
      }
      return renderAst(ast, { uxlText: maskedUxlText, mode: opts.mode || "permissive", pageInterleaves: interleaves });
    } catch (e) {
      if (e instanceof UxlParseError) return renderError(e);
      const err = new UxlParseError(e?.message || String(e), { sourceName: opts.sourceName || "UXL" });
      return renderError(err);
    }
  }

  function renderUxlText(uxlText, opts = {}) {
    try {
      const ast = parseUxl(uxlText, opts);
      return renderAst(ast, { uxlText, mode: opts.mode || "permissive" });
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
      const segs = splitMarkdownByUxlFences(raw);
      const wrapper = el("div");
      let uxlIdx = 0;
      for (const s of segs) {
        if (s.kind === "html") {
          // Render any text around UXL fences as raw HTML (main page only).
          wrapper.append(renderRawHtml(s.html));
          continue;
        }
        if (s.kind === "uxl") {
          uxlIdx += 1;
          wrapper.append(renderUxlTextMain(s.uxlText, { mode, sourceName: `UXL block ${uxlIdx}` }));
        }
      }
      node.replaceWith(wrapper);
    }
  }

  window.UXL = {
    UxlParseError,
    VERSION: RENDERER_VERSION,
    SUPPORTED_UXL_VERSION,
    parse: parseUxl,
    renderUxlText,
    renderAll,
    extractUxlBlocksFromMarkdown,
    openPrototypeForText,
    renderPrototypeFromStorageKeyOrLast,
    // Built-in icons (kept in sync with renderer; useful for external icon galleries like icons.html)
    getBuiltinIconNames: () => Object.keys(BUILTIN_SVG_ICONS || {}).map((s) => String(s)),
    createBuiltinIconSvg: (name, { className = "", title = "", size = null } = {}) => {
      const svg = svgIcon(name, { className, title });
      if (!svg) return null;
      const s = Number.isFinite(size) ? size : null;
      if (s != null) {
        svg.style.width = `${s}px`;
        svg.style.height = `${s}px`;
      }
      return svg;
    },
  };
})();




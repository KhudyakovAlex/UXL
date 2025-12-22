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
    if (!/^[LRTB]+$/.test(s)) throw new UxlParseError("ALIGN может содержать только символы L, R, T, B.", meta);
    const hasL = s.includes("L");
    const hasR = s.includes("R");
    const hasT = s.includes("T");
    const hasB = s.includes("B");
    if (hasL && hasR) throw new UxlParseError("ALIGN: комбинация LR запрещена.", meta);
    if (hasT && hasB) throw new UxlParseError("ALIGN: комбинация TB запрещена.", meta);
    return { h: hasL ? "L" : hasR ? "R" : null, v: hasT ? "T" : hasB ? "B" : null };
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

    const get = (idx) => (fields[idx] == null ? "" : fields[idx]);

    function tagFormatHelp(t) {
      switch (t) {
        case "P":
          return {
            format: "P\\CAPTION[\\...поля...] или P\\ID\\CAPTION[\\...поля...] (поля в любом порядке: P10=padding, HINT)",
            example: "P\\users\\Пользователи\\P12\\Подсказка страницы",
          };
        case "F":
          return { format: "F\\[SIZE/ALIGN/P10/HINT...] (поля в любом порядке)", example: "F\\100%x\\T\\P12\\Контейнер" };
        case "I":
          return {
            format: "I\\SRC:<url>\\[SIZE/ALIGN/FIT|CROP/M10/R6/HINT...] (поля в любом порядке; без PADDING)",
            example: "I\\SRC:src/yarmap.PNG\\200x\\LT\\M6\\R12\\FIT\\Подсказка картинки",
          };
        case "B":
          return {
            format: "B\\CAPTION|ICON:NAME[:SIZE]\\[SIZE/ALIGN/ACTION/ICON:NAME[:SIZE]/M10/P10/R6/HINT...] (поля в любом порядке)",
            example: "B\\ICON:search:18\\100x\\RB\\P8\\M6\\R8\\GOTO:users\\Поиск",
          };
        case "C":
          return { format: "C\\CAPTION\\[SIZE/ALIGN/M10/P10/HINT...] (поля в любом порядке)", example: "C\\Текст\\x20\\LT\\P6\\M4\\Подсказка" };
        case "T":
          return {
            format: "T\\COLS:...\\[SIZE/ALIGN/M10/P10/HINT...] (поля в любом порядке; P10 задаёт padding ячеек TH/TD)",
            example: "T\\COLS:20R,80L\\100%x100%\\T\\M10\\P6\\Таблица",
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
      const align = alignStr ? parseAlign(alignStr, meta) : null;
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
      if (!/^[LRTB]+$/.test(v)) return false;
      // LR and TB are forbidden
      if (v.includes("L") && v.includes("R")) return false;
      if (v.includes("T") && v.includes("B")) return false;
      return true;
    }

    function isActionToken(s) {
      const v = String(s || "").trim().toUpperCase();
      return v.startsWith("GOTO:") || v.startsWith("GOTO:P");
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

    function parseIntNonNegative(raw, metaForErr, what) {
      const n = Number.parseInt(String(raw), 10);
      if (!Number.isFinite(n) || String(n) !== String(raw).trim()) {
        throw new UxlParseError(`${what} должно быть целым числом (например ${what === "PADDING" ? "P10" : "M10"}).`, metaForErr);
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
      "chevron-left",
      "chevron-right",
      "close",
      "codepen",
      "cpu",
      "edit",
      "grid",
      "home",
      "microphone",
      "plus",
      "search",
      "sun",
      "settings",
      "trash",
      "volume-2",
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

    function parseUnorderedFields(
      tokens,
      {
        allowSize = true,
        allowAlign = true,
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
      } = {},
    ) {
      let sizeStr = "";
      let alignStr = "";
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
      };

      for (const raw of tokens) {
        const v = String(raw ?? "").trim();
        if (!v) continue;
        if (isMarginToken(v) && !allowMargin) {
          throw formatError(tag, `Поле "${v}" (margin) не поддерживается для этого тега.`);
        }
        if (isPaddingToken(v) && !allowPadding) {
          throw formatError(tag, `Поле "${v}" (padding) не поддерживается для этого тега.`);
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
        if (allowMargin && isMarginToken(v)) {
          const n = parseIntNonNegative(v.slice(1), meta, "MARGIN");
          setOnce("margin", n);
          continue;
        }
        if (allowPadding && isPaddingToken(v)) {
          const n = parseIntNonNegative(v.slice(1), meta, "PADDING");
          setOnce("padding", n);
          continue;
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
            // Guard rails: keep it reasonable for buttons.
            if (n < 8 || n > 48) throw formatError(tag, "ICON size должен быть в диапазоне 8..48 px.");
            setOnce("iconSize", n);
          }
          continue;
        }
        if (allowBg && isBgToken(v)) {
          const url = String(v.slice("BG:".length)).trim();
          if (!url) throw formatError(tag, `BG должен быть вида "BG:https://..." (URL не может быть пустым).`);
          setOnce("bg", url);
          continue;
        }
        if (allowSrc && isSrcToken(v)) {
          const url = String(v.slice("SRC:".length)).trim();
          if (!url) throw formatError(tag, `SRC должен быть вида "SRC:src/yarmap.PNG" (URL не может быть пустым).`);
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
      };
    }

    if (tag === "P") {
      // P supports both forms:
      // - P\CAPTION[\...поля...]
      // - P\ID\CAPTION[\...поля...]  (ID must match [A-Za-z0-9_-]+)
      // Additional fields are unordered; supported: P10 (padding), HINT.
      let id = "";
      let caption = "";
      const idRe = /^[A-Za-z0-9_-]+$/;

      let restTokens = [];
      const f1 = get(1);
      const f2 = get(2);
      if (fields.length >= 3 && idRe.test(String(f1).trim())) {
        id = f1;
        caption = f2;
        restTokens = fields.slice(3);
      } else {
        caption = f1;
        restTokens = fields.slice(2);
      }

      const rest = parseUnorderedFields(restTokens, {
        allowSize: false,
        allowAlign: false,
        allowAction: false,
        allowHint: true,
        allowCols: false,
        allowMargin: false,
        allowPadding: true,
      });
      const hint = rest.hint || "";
      const padding = rest.paddingPx ?? 0;
      return { indent, node: { tag, id, caption, padding, size: null, align: null, action: null, hint, rawLineNo: lineNo } };
    }

    if (tag === "TH" || tag === "TD") {
      const cells = fields.slice(1);
      if (cells.length === 0) throw formatError(tag, "Должна быть хотя бы одна ячейка.");
      return { indent, node: { tag, cells, rawLineNo: lineNo } };
    }

    // Per-tag formats (ID is not used anywhere except P):
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
        allowAction: true,
        allowHint: true,
        allowMargin: true,
        allowPadding: true,
        allowRadius: true,
        allowIcon: true,
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
        allowAction: true,
        allowHint: true,
        allowMargin: true,
        allowPadding: true,
      });
      const sizeStr = rest.sizeStr;
      const alignStr = rest.alignStr;
      const actionStr = rest.actionStr;
      const hint = rest.hint;
      const common = parseCommon({ caption, sizeStr, alignStr, actionStr, hint });
      // C ACTION is not meaningful; strict/permissive behavior is enforced in parseAction.
      return {
        indent,
        node: { tag, id: "", padding: rest.paddingPx ?? 5, margin: rest.marginPx ?? 3, ...common, rawLineNo: lineNo },
      };
    }

    if (tag === "F") {
      const rest = parseUnorderedFields(fields.slice(1), {
        allowSize: true,
        allowAlign: true,
        allowAction: false,
        allowHint: true,
        allowMargin: false,
        allowPadding: true,
        allowSrc: false,
        allowFit: false,
        allowBg: true,
      });
      const sizeStr = rest.sizeStr;
      const alignStr = rest.alignStr;
      const hint = rest.hint;
      const bg = rest.bgUrl || "";
      const common = parseCommon({ caption: "", sizeStr, alignStr, actionStr: "", hint });
      return { indent, node: { tag, id: "", padding: rest.paddingPx ?? 0, bg, ...common, rawLineNo: lineNo } };
    }

    if (tag === "I") {
      const rest = parseUnorderedFields(fields.slice(1), {
        allowSize: true,
        allowAlign: true,
        allowAction: false,
        allowHint: true,
        allowCols: false,
        allowMargin: true,
        allowPadding: false,
        allowRadius: true,
        allowIcon: false,
        allowSrc: true,
        allowFit: true,
        allowBg: false,
      });
      const src = String(rest.srcUrl || "").trim();
      if (!src) throw formatError("I", 'SRC обязателен (например "I\\SRC:src/yarmap.PNG").');
      const sizeStr = rest.sizeStr;
      const alignStr = rest.alignStr;
      const hint = rest.hint;
      const common = parseCommon({ caption: "", sizeStr, alignStr, actionStr: "", hint });
    return {
      indent,
      node: {
        tag,
          id: "",
          src,
          fit: rest.fitMode || "none",
          margin: rest.marginPx ?? 0,
          radius: rest.radiusPx ?? 0,
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
        allowPadding: true,
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
          ...common,
        rawLineNo: lineNo,
      },
    };
    }

    throw new UxlParseError(
      `Неизвестный тег: "${tag}". Разрешены: P, F, I, B, C, T, TH, TD. См. UXL.md для форматов.`,
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
          if (!["F", "B", "C", "T", "I"].includes(ch.tag)) {
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
          if (!["F", "B", "C", "T", "I"].includes(ch.tag)) {
            throw new UxlParseError(`Недопустимый дочерний тег "${ch.tag}" внутри F.`, {
              line: ch.rawLineNo,
              col: 1,
              sourceName,
              lineText: lines[ch.rawLineNo - 1],
            });
          }
        }
      } else if (tag === "I" || tag === "B" || tag === "C") {
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

  const BUILTIN_SVG_ICONS = Object.freeze({
    // Source: IHAVA.svg (converted to inherit currentColor; kept original path transforms)
    ai: {
      viewBox: "0 0 137.04 128.194",
      mode: "fill",
      paths: [
        { d: "M25.0923 0C24.3575 0.754547 23.1565 1.23846 21.8123 1.23846L5.84302 1.23846C4.49878 1.23846 3.29773 0.758148 2.58081 0.00535583L0 2.4877C1.41589 3.96637 3.56677 4.82309 5.84302 4.82309L21.8123 4.82309C24.1064 4.82309 26.2572 3.96277 27.6731 2.47699L25.0923 0L25.0923 0Z", transform: "matrix(1 0 0 1 54.7747 55.8648)" },
        {
          d: "M1.88208 0C2.92163 0 3.76379 0.842407 3.76379 1.8819L3.76379 8.87195C3.76379 9.9115 2.92163 10.7538 1.88208 10.7538C0.842407 10.7538 0 9.9115 0 8.87195L0 1.8819C0 0.842407 0.842407 0 1.88208 0L1.88208 0ZM1.88208 3.58463C2.81396 3.58463 3.58459 2.82289 3.58459 1.8819L3.58459 8.87195C3.58459 7.93103 2.81396 7.16924 1.88208 7.16924C0.949951 7.16924 0.179199 7.93103 0.179199 8.87195L0.179199 1.8819C0.179199 2.82289 0.949951 3.58463 1.88208 3.58463L1.88208 3.58463Z",
          transform: "matrix(1 0 0 1 73.9882 40.9735)",
        },
        {
          d: "M1.88208 0C2.92151 0 3.76379 0.842407 3.76379 1.8819L3.76379 8.87195C3.76379 9.9115 2.92151 10.7538 1.88208 10.7538C0.842407 10.7538 0 9.9115 0 8.87195L0 1.8819C0 0.842407 0.842407 0 1.88208 0L1.88208 0ZM1.88208 3.58463C2.81396 3.58463 3.58459 2.82289 3.58459 1.8819L3.58459 8.87195C3.58459 7.93103 2.81396 7.16924 1.88208 7.16924C0.949951 7.16924 0.179199 7.93103 0.179199 8.87195L0.179199 1.8819C0.179199 2.82289 0.949951 3.58463 1.88208 3.58463L1.88208 3.58463Z",
          transform: "matrix(1 0 0 1 59.6497 40.9735)",
        },
        {
          d: "M77.2993 17.027L74.5052 19.8208C85.808 35.1257 84.5288 56.8051 70.667 70.6665C57.8584 83.475 38.3755 85.5408 23.4142 76.864C23.4469 76.6656 23.463 76.4616 23.463 76.2546C23.463 74.095 21.7123 72.3439 19.5525 72.3439C17.3928 72.3439 15.642 74.095 15.642 76.2546C15.642 78.4142 17.3928 80.1653 19.5525 80.1653C20.0282 80.1653 20.484 80.08 20.9055 79.9247C37.4316 89.8429 59.1853 87.6785 73.4319 73.4319C88.8236 58.0402 90.1125 33.8863 77.2993 17.027L77.2993 17.027ZM12.5989 12.5989C-2.79272 27.9905 -4.08179 52.1444 8.73157 69.0038L11.5255 66.2104C0.222778 50.905 1.50232 29.2258 15.3641 15.364C28.1725 2.55571 47.6554 0.489883 62.6168 9.16656C62.5839 9.3653 62.5681 9.56891 62.5681 9.77621C62.5681 11.9359 64.3185 13.6867 66.4781 13.6867C68.6383 13.6867 70.3888 11.9359 70.3888 9.77621C70.3888 7.6165 68.6383 5.86572 66.4781 5.86572C66.0026 5.86572 65.5472 5.95061 65.1252 6.10611C48.5992 -3.81197 26.8456 -1.64767 12.5989 12.5989L12.5989 12.5989Z",
          transform: "matrix(1 0 0 1 25.5958 6.9194)",
        },
        {
          d: "M50.1846 0C53.16 0 55.5613 2.40704 55.5613 5.37689L55.5613 10.7538L57.3538 10.7538C59.3252 10.7538 60.9387 12.3579 60.9387 14.3385L60.9387 25.0923C60.9387 27.0728 59.3252 28.6769 57.3538 28.6769L55.5613 28.6769L55.5613 34.0538C55.5613 37.0237 53.16 39.4308 50.1846 39.4308L10.7539 39.4308C7.77869 39.4308 5.37695 37.0237 5.37695 34.0538L5.37695 28.6769L3.58459 28.6769C1.61304 28.6769 0 27.0728 0 25.0923L0 14.3385C0 12.3579 1.61304 10.7538 3.58459 10.7538L5.37695 10.7538L5.37695 5.37689C5.37695 2.40704 7.77869 0 10.7539 0L50.1846 0L50.1846 0ZM50.1846 3.58461L10.7539 3.58461C9.76807 3.58461 8.96155 4.38757 8.96155 5.37689L8.96155 34.0538C8.96155 35.0432 9.76807 35.8462 10.7539 35.8462L50.1846 35.8462C51.1703 35.8462 51.9769 35.0432 51.9769 34.0538L51.9769 5.37689C51.9769 4.38757 51.1703 3.58461 50.1846 3.58461L50.1846 3.58461ZM5.37695 14.3385L3.58459 14.3385L3.58459 25.0923L5.37695 25.0923L5.37695 14.3385L5.37695 14.3385ZM57.3538 14.3385L55.5613 14.3385L55.5613 25.0923L57.3538 25.0923L57.3538 14.3385L57.3538 14.3385Z",
          transform: "matrix(1 0 0 1 38.142 30.2193)",
        },
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
    home: { viewBox: "0 0 24 24", d: ["M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"] },
    microphone: {
      viewBox: "0 0 24 24",
      d: [
        "M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3z",
        "M19 11a7 7 0 0 1-14 0",
        "M12 18v3",
        "M8 21h8",
      ],
    },
    plus: { viewBox: "0 0 24 24", d: ["M12 5v14", "M5 12h14"] },
    search: { viewBox: "0 0 24 24", d: ["M10.5 18a7.5 7.5 0 1 1 0-15a7.5 7.5 0 0 1 0 15z", "M16.5 16.5 21 21"] },
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
    const meta = el("div", { class: "uxl-error__meta", text: `${metaParts.join(": ")}\n${err.message}` });
    const box = el("div", { class: "uxl-error" }, [head, meta]);
    if (err.lineText) {
      box.append(el("div", { class: "uxl-error__line", text: err.lineText }));
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

      if (tag === "F") {
        // F is invisible visually, but it must exist as a DOM container to support crop/scroll.
        nodeEl = el("div", { class: "uxl-node uxl-F", "data-uxl-uid": node.uid });
        if (node.hint) nodeEl.title = node.hint;
        if (Number.isFinite(node.padding)) nodeEl.style.padding = `${node.padding}px`;
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

      if (tag === "C") nodeEl = el("div", { class: "uxl-node uxl-C", "data-uxl-uid": node.uid, text: node.caption || "" });
      else if (tag === "B") {
        nodeEl = el("button", { class: "uxl-node uxl-B", type: "button", "data-uxl-uid": node.uid });
        const iconName = String(node.icon || "").trim();
        if (iconName) {
          const ico = svgIcon(iconName, { className: "uxl-B__icon" });
          if (ico) nodeEl.append(ico);
        }
        if (Number.isFinite(node.iconSize)) nodeEl.style.setProperty("--uxl-icon-size", `${node.iconSize}px`);
        const cap = String(node.caption || "");
        if (cap.trim()) nodeEl.append(el("span", { class: "uxl-B__label", text: cap }));
        const r = Number.isFinite(node.radius) ? node.radius : 6;
        nodeEl.style.borderRadius = `${r}px`;
      } else if (tag === "I") {
        nodeEl = el("div", { class: "uxl-node uxl-I", "data-uxl-uid": node.uid });
        const fit = String(node.fit || "").trim().toLowerCase();
        if (fit === "contain" || fit === "cover") nodeEl.style.setProperty("--uxl-img-fit", fit);
        if (Number.isFinite(node.radius) && node.radius > 0) nodeEl.style.borderRadius = `${node.radius}px`;
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

    function layoutContainer(node, containerDomEl, parentW, parentH, { root = false } = {}) {
      const pad = (node.tag === "P" || node.tag === "F") && Number.isFinite(node.padding) ? node.padding : 0;
      // Determine current container base size (as minimum) from its SIZE, otherwise from provided (root) or from children.
      const base = root ? { w: parentW, h: parentH } : resolveBaseSize(node, parentW, parentH);
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
      for (const chNode of kids) {
        const v = chNode.align?.v || null;
        if (v === "T") top.push(chNode);
        else if (v === "B") bottom.push(chNode);
        else mid.push(chNode);
      }

      // Inner content box size (percent sizes are based on it; children are positioned relative to padding edge).
      const innerW = Math.max(0, cw - pad * 2);
      const innerH = Math.max(0, ch - pad * 2);

      // First, compute children sizes (recursively) with current container inner size as reference (for %).
      const childSize = new Map(); // uid -> {w,h}
      function computeChildSize(chNode, curW, curH) {
        const tag = chNode.tag;
        const baseSz = resolveBaseSize(chNode, curW, curH);
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
          intrinsic = layoutContainer(chNode, chEl, curW, curH, { root: false });
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

      // Iteration is handled by the outer loop; here we use cw/ch as the current container size.
      for (const chNode of kids) {
        childSize.set(chNode.uid, computeChildSize(chNode, innerW || parentW || 0, innerH || parentH || 0));
      }

      // Compute required width/height for the container based on stacking rules (no overlaps).
      // Horizontal stacking within mid band: L-group, Center-group, R-group (each keeps UXL order)
      const midL = [];
      const midC = [];
      const midR = [];
      for (const n of mid) {
        const hA = n.align?.h || null;
        if (hA === "L") midL.push(n);
        else if (hA === "R") midR.push(n);
        else midC.push(n);
      }
      const sumW = (arr) => arr.reduce((a, n) => a + (childSize.get(n.uid)?.w || 0), 0);
      const sumH = (arr) => arr.reduce((a, n) => a + (childSize.get(n.uid)?.h || 0), 0);
      const maxH = (arr) => arr.reduce((a, n) => Math.max(a, childSize.get(n.uid)?.h || 0), 0);
      const maxW = (arr) => arr.reduce((a, n) => Math.max(a, childSize.get(n.uid)?.w || 0), 0);

      const topH = sumH(top);
      const bottomH = sumH(bottom);
      const midH = maxH(mid);
      const neededH = topH + midH + bottomH;

      const neededW = Math.max(
        maxW(kids),
        sumW(midL) + sumW(midC) + sumW(midR),
      );

      // Apply container growth by default (unless crop/scroll is set on that axis, in which case size is fixed to base).
      // Root (P) scrolls by default, so its size does not auto-grow.
      const contOw = node.size?.w?.overflow || (root ? windowSize.overflowW || "scroll" : null) || null;
      const contOh = node.size?.h?.overflow || (root ? windowSize.overflowH || "scroll" : null) || null;
      if (!contOw) cw = Math.max(cw, neededW + pad * 2);
      if (!contOh) ch = Math.max(ch, neededH + pad * 2);

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

      function rectsOverlap(a, b) {
        return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
      }

      function placeBand(nodes, { vAlign, pushDown }) {
        // vAlign is "T" or "B". If overlaps occur, move along Y away from the edge:
        // - top band: push down
        // - bottom band: push up
        const placed = []; // {uid,x,y,w,h}
        for (const n of nodes) {
          const sz = childSize.get(n.uid) || { w: 0, h: 0 };
          const hA = n.align?.h || null;
          const pref = alignToXY({ hAlign: hA, vAlign, parentW: placeW, parentH: placeH, w: sz.w, h: sz.h });
          let x = pref.x;
          let y = pref.y;

          // Resolve overlaps against already placed nodes in this band.
          // Deterministic: scan in UXL order; when overlap found, jump past the blocking rect edge.
          let changed = true;
          let guard = 0;
          while (changed && guard++ < 50) {
            changed = false;
            for (const p of placed) {
              const cur = { x, y, w: sz.w, h: sz.h };
              if (!rectsOverlap(cur, p)) continue;
              if (pushDown) {
                y = Math.max(y, p.y + p.h);
              } else {
                y = Math.min(y, p.y - sz.h);
              }
              changed = true;
            }
          }

          applyBoxStyles(n.uid, x, y);
          placed.push({ uid: n.uid, x, y, w: sz.w, h: sz.h });
        }
        return placed;
      }

      // 1) Top band: prefer y=0; on overlap push down (keep RT in the corner unless it intersects)
      const placedTop = placeBand(top, { vAlign: "T", pushDown: true });
      const topExtent = placedTop.reduce((m, r) => Math.max(m, r.y + r.h), 0);

      // 2) Bottom band: prefer bottom; on overlap push up
      const placedBottom = placeBand(bottom, { vAlign: "B", pushDown: false });
      const bottomStart = placedBottom.length ? placedBottom.reduce((m, r) => Math.min(m, r.y), placeH) : placeH;

      // 3) Middle band: horizontal packing between top and bottom, centered vertically in the remaining space.
      const midAreaY = topExtent;
      const midAreaH = Math.max(0, bottomStart - topExtent);
      const midY = midAreaY + Math.max(0, Math.round((midAreaH - midH) / 2));

      const leftW = sumW(midL);
      const rightW = sumW(midR);
      const centerW = sumW(midC);
      const contentW = leftW + centerW + rightW;
      // cw already accounts for neededW (which includes contentW) above.

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

      // Center group: packed left-to-right, but centered between L and R if possible.
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
      // Root: first page in the block
      const pagesInOrder = ast.pages.map((p) => p.uid);
      const rootUid = pagesInOrder[0] || null;
      const level = new Map(); // pageUid -> number
      if (rootUid) level.set(rootUid, 0);

      const outgoing = new Map(); // fromUid -> Set(toUid)
      for (const e of ast.edges) {
        const fKey = normalizeId(e.fromId);
        const tKey = normalizeId(e.toId);
        const fromUid = ast.pageIdToUid?.[fKey] || null;
        const toUid = ast.pageIdToUid?.[tKey] || null;
        if (!fromUid || !toUid) continue;
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

      // Unreachable pages: place at level 0 after root, stacked below
      for (const uid of pagesInOrder) {
        if (!level.has(uid)) level.set(uid, 0);
      }

      // Group by level; preserve original order within each level
      const groups = new Map(); // lvl -> [pageUid]
      for (const uid of pagesInOrder) {
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

      grid.style.width = `${Math.max(0, x - colGap)}px`;
      grid.style.height = `${Math.max(0, totalH - rowGap)}px`;
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

    // Wire button clicks (GOTO) to navigate between pages (scroll the browser page).
    function wireGotoClicks() {
      const buttons = Array.from(canvas.querySelectorAll('button.uxl-B[data-uxl-uid]'));
      for (const btn of buttons) {
        const uid = btn.getAttribute("data-uxl-uid");
        if (!uid) continue;
        const node = ast.nodeByUid?.get(uid) || null;
        if (!node || !node.action || node.action.type !== "GOTO") continue;
        btn.addEventListener("click", (ev) => {
          ev.preventDefault();
          const targetId = String(node.action.target || "").trim();
          const targetKey = normalizeId(targetId);
          const pageUid = ast.pageIdToUid?.[targetKey] || null;
          if (!pageUid) {
            // Target page must have an ID to be addressable.
            alert(`UXL: страница для GOTO не найдена: "${targetId}"`);
            return;
          }
          const pageEl = document.querySelector(`.uxl-page[data-page-uid="${CSS.escape(pageUid)}"]`);
          const headEl = pageEl?.querySelector(".uxl-page__head") || pageEl;
          if (!headEl) {
            alert(`UXL: не удалось перейти к странице "${targetId}" (DOM не найден).`);
            return;
          }
          headEl.scrollIntoView({ block: "start", inline: "nearest", behavior: "smooth" });

          // Highlight target page: title + canvas border animate red like hints.
          if (pageEl) {
            pageEl.classList.remove("uxl-page--goto");
            // force reflow to restart animation
            void pageEl.offsetWidth;
            pageEl.classList.add("uxl-page--goto");
            window.setTimeout(() => pageEl.classList.remove("uxl-page--goto"), 2400);
          }
        });
      }
    }
    // Defer wiring until DOM is in place (after renderAll replacement).
    queueMicrotask(() => wireGotoClicks());

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
      for (let idx = 0; idx < hintWithLines.length; idx++) {
        const n = hintWithLines[idx];
        // Page hint is listed, but it must not have a callout line.
        const li = list.querySelector(`li[data-uxl-uid="${CSS.escape(n.uid)}"]`);
        const target = n.uid === pageNode.uid ? canvas : domByUid.get(n.uid);
        if (!li || !target) continue;
        const dot = li.querySelector('[data-uxl-dot="1"]');
        if (!dot) continue;
        const liRect = li.getBoundingClientRect();
        const dotRect = dot.getBoundingClientRect();
        const tRect = target.getBoundingClientRect();

        const start = { x: dotRect.left + dotRect.width / 2 - bodyRect.left, y: dotRect.top + dotRect.height / 2 - bodyRect.top };
        // End point should land on the edge facing the hints list (right edge).
        // Add deterministic vertical spread so multiple callouts don't collapse into a single horizontal line.
        const baseEnd = { x: tRect.right - bodyRect.left, y: tRect.top + tRect.height / 2 - bodyRect.top };
        const spread = (idx - (hintWithLines.length - 1) / 2) * 8;
        const end = { x: baseEnd.x, y: baseEnd.y + spread };

        // Route is orthogonal (as before).
        const midX = Math.round((start.x + end.x) / 2);
        const pts = [
          { x: Math.round(start.x), y: Math.round(start.y) },
          { x: midX, y: Math.round(start.y) },
          { x: midX, y: Math.round(end.y) },
          { x: Math.round(end.x), y: Math.round(end.y) },
        ];

        drawOrthogonalRounded(overlay, start, end, { endCircle: true, circleRadius: 4, arrowMarkerId: null, points: pts });
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
    let lastWinW = win.w;
    let lastWinH = win.h;

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

      // wire goto: switch pages inside prototype
      const buttons = Array.from(canvas.querySelectorAll('button.uxl-B[data-uxl-uid]'));
      for (const btn of buttons) {
        const uid = btn.getAttribute("data-uxl-uid");
        if (!uid) continue;
        const node = ast.nodeByUid?.get(uid) || null;
        if (!node || !node.action || node.action.type !== "GOTO") continue;
        btn.addEventListener("click", (ev) => {
          ev.preventDefault();
          const targetId = String(node.action.target || "").trim();
          const targetKey = normalizeId(targetId);
          const targetUid = ast.pageIdToUid?.[targetKey] || null;
          if (!targetUid) {
            alert(`UXL: страница для GOTO не найдена: "${targetId}"`);
            return;
          }
          currentUid = targetUid;
          renderCurrent();
        });
      }

      // No explicit back button in prototype; use browser back if needed.
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

  function renderAst(ast, { uxlText = "", mode = "permissive" } = {}) {
    const root = el("div", { class: "uxl-root" });
    root.append(el("div", { class: "uxl-map__title", text: "Превью прототипа" }));
    const toolbar = el("div", { class: "uxl-toolbar" });
    const protoBtn11 = el("button", { class: "uxl-toolbar__btn", type: "button", text: "1:1" });
    protoBtn11.addEventListener("click", () => openPrototypeForText(uxlText, { mode, view: "1:1" }));
    const protoBtnFs = el("button", { class: "uxl-toolbar__btn", type: "button", text: "Full Screen" });
    protoBtnFs.addEventListener("click", () => openPrototypeForText(uxlText, { mode, view: "fullscreen" }));
    toolbar.append(protoBtn11, protoBtnFs);
    root.append(toolbar);
    root.append(el("div", { class: "uxl-map__title", text: "Карта интерфейса" }));
    root.append(renderMap(ast));
    const pagesWrap = el("div", { class: "uxl-pages" });
    for (const p of ast.pages) pagesWrap.append(renderPageSection(ast, p));
    root.append(pagesWrap);

    const footer = el("div", { class: "uxl-footer" });
    const ver = el("div", { class: "uxl-footer__ver", text: `UXL ${ast.uxlVersion || SUPPORTED_UXL_VERSION} / renderer ${RENDERER_VERSION}` });
    footer.append(ver);
    root.append(footer);
    return root;
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
      const wrapper = el("div");
      for (const [idx, b] of blocks.entries()) {
        wrapper.append(renderUxlText(b, { mode, sourceName: `UXL block ${idx + 1}` }));
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
  };
})();




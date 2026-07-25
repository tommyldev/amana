/**
 * Render a terminal frame (ANSI text) into a standalone SVG that looks like a
 * macOS terminal window. Public entry: {@link frameToSvg}.
 *
 * Positioning is per-cell and absolute: every non-space glyph is placed at the
 * exact column/row it occupies, so box-drawing and block glyphs stay aligned
 * regardless of the viewer's monospace font metrics.
 */

export interface CellStyle {
  fg?: string;
  bold?: boolean;
  dim?: boolean;
  underline?: boolean;
}

export interface SvgOptions {
  title?: string;
  cols?: number;
  rows?: number;
}

const ESC = "\x1b";

const BASIC_FG: Record<string, string> = {
  "30": "#000000", "31": "#ff5c57", "32": "#5af78e", "33": "#f3f99d",
  "34": "#57c7ff", "35": "#ff6ac1", "36": "#9aedfe", "37": "#e6e6e6",
  "90": "#7d7d7d", "91": "#ff7b6b", "92": "#7ef7a0", "93": "#ffe08a",
  "94": "#82c1ff", "95": "#ff9ad1", "96": "#b6efff", "97": "#ffffff",
};

const DEFAULT_FG = "#d7d7d7";
const BG = "#0d1117";
const TITLEBAR_BG = "#161b22";
 const BORDER = "#30363d";
const CELL_W = 8.4;
const CELL_H = 17;
const FONT_SIZE = 14;
const PAD = 14;
const TITLE_H = 28;

function cubeChannel(v: number): number {
  return v === 0 ? 0 : 55 + v * 40;
}

function color256(n: number): string {
  if (n < 16) {
    const key = String(n < 8 ? 30 + n : 90 + (n - 8));
    return BASIC_FG[key] ?? DEFAULT_FG;
  }
  if (n < 232) {
    const i = n - 16;
    return `rgb(${cubeChannel((i / 36) | 0)},${cubeChannel(((i / 6) | 0) % 6)},${cubeChannel(i % 6)})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

interface ParseState {
  fg?: string;
  bold: boolean;
  dim: boolean;
  underline: boolean;
}

function applySgr(state: ParseState, params: number[]): void {
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    switch (p) {
      case 0:
        state.fg = undefined; state.bold = false; state.dim = false; state.underline = false; break;
      case 1: state.bold = true; break;
      case 2: state.dim = true; break;
      case 4: state.underline = true; break;
      case 22: state.bold = false; state.dim = false; break;
      case 24: state.underline = false; break;
      case 39: state.fg = undefined; break;
      case 38: {
        const mode = params[i + 1];
        if (mode === 5) { state.fg = color256(params[i + 2] ?? 0); i += 2; }
        else if (mode === 2) {
          state.fg = `rgb(${params[i + 2] ?? 0},${params[i + 3] ?? 0},${params[i + 4] ?? 0})`;
          i += 4;
        }
        break;
      }
      default:
        if (BASIC_FG[String(p)]) state.fg = BASIC_FG[String(p)];
    }
  }
}

interface Cell {
  ch: string;
  style: CellStyle;
}

export function parseFrame(frame: string): Cell[][] {
  const rows: Cell[][] = [[]];
  let state: ParseState = { bold: false, dim: false, underline: false };
  let i = 0;
  while (i < frame.length) {
    const ch = frame[i]!;
    if (ch === ESC && frame[i + 1] === "[") {
      let j = i + 2;
      let digits = "";
      while (j < frame.length && frame[j] !== "m" && frame[j] !== ESC) {
        digits += frame[j];
        j++;
      }
      const params = digits.split(";").filter(Boolean).map(Number);
      applySgr(state, params);
      i = j + 1;
      continue;
    }
    if (ch === "\n") {
      rows.push([]);
      i++;
      continue;
    }
    if (ch === "\r") { i++; continue; }
    if (ch !== " " && ch !== "\t") {
      rows[rows.length - 1]!.push({
        ch,
        style: { fg: state.fg, bold: state.bold, dim: state.dim, underline: state.underline },
      });
    }
    i++;
  }
  return rows;
}


function styleAttrs(style: CellStyle): string {
  const fill = style.dim && !style.fg ? "#6e7681" : (style.fg ?? DEFAULT_FG);
  const opacity = style.dim && style.fg ? "0.55" : "1";
  const weight = style.bold ? ` font-weight="700"` : "";
  const deco = style.underline ? ` text-decoration="underline"` : "";
  return `fill="${fill}" opacity="${opacity}"${weight}${deco}`;
}

function trafficLights(x: number, y: number): string {
  const colors = ["#ff5f56", "#febc2e", "#28c840"];
  return colors
    .map((c, idx) => `<circle cx="${x + idx * 20}" cy="${y}" r="6" fill="${c}"/>`)
    .join("");
}

export function frameToSvg(frame: string, opts: SvgOptions = {}): string {
  const rows = parseFrame(frame);
  const rowCount = opts.rows ?? Math.max(rows.length, 1);
  const colCount = opts.cols ?? Math.max(rows.reduce((m, r) => Math.max(m, r.reduce((mx, c) => Math.max(mx, c.ch.length), 0)), 0), 1);

  const width = PAD * 2 + colCount * CELL_W + 2;
  const height = TITLE_H + PAD * 2 + rowCount * CELL_H + 2;
  const textX = PAD + 1;
  const textY0 = TITLE_H + PAD + 1;

  let body = "";
  for (let r = 0; r < rows.length; r++) {
    const y = textY0 + r * CELL_H;
    let col = 0;
    for (const cell of rows[r]!) {
      const x = textX + col * CELL_W;
      body += `<tspan x="${x.toFixed(2)}" y="${y.toFixed(2)}" ${styleAttrs(cell.style)}>${cell.ch.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</tspan>`;
      col += cell.ch.length;
    }
  }

  const title = opts.title ?? "amana";
  const titleW = title.length * 7.2;
  const titleX = (width - titleW) / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace" font-size="${FONT_SIZE}">
<defs>
  <filter id="shadow" x="-5%" y="-5%" width="110%" height="115%">
    <feDropShadow dx="0" dy="4" stdDeviation="8" flood-color="#000000" flood-opacity="0.35"/>
  </filter>
</defs>
<rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="10" fill="${BG}" stroke="${BORDER}" stroke-width="1" filter="url(#shadow)"/>
<path d="M1 11 a10 10 0 0 1 10 -10 h${width - 22} a10 10 0 0 1 10 10 v${TITLE_H - 11} h${-(width - 2)} z" fill="${TITLEBAR_BG}"/>
${trafficLights(18, TITLE_H / 2 + 1)}
<text x="${titleX.toFixed(2)}" y="${(TITLE_H / 2 + 5).toFixed(2)}" fill="#8b949e" font-size="12" font-family="-apple-system, system-ui, sans-serif">${title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</text>
<text xml:space="preserve">${body}</text>
</svg>`;
}

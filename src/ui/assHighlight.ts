/**
 * ASS 文本语法高亮分词（对齐 Aegisub SyntaxHighlighter 的样式语义）。
 * 颜色取自 Aegisub default_config.json 的 Colour/Subtitle/Syntax。
 */

export type AssSyntaxType =
  | 'NORMAL'
  | 'OVERRIDE'
  | 'TAG'
  | 'PARAMETER'
  | 'LINE_BREAK'
  | 'PUNCTUATION'
  | 'ERROR'
  | 'KARAOKE';

export interface AssHighlightSegment {
  text: string;
  type: AssSyntaxType;
}

/** Aegisub Colour/Subtitle/Syntax 配色 */
export const ASS_SYNTAX_COLORS: Record<AssSyntaxType, { color: string; bold?: boolean }> = {
  NORMAL: { color: '#000000' },
  OVERRIDE: { color: '#1432ff' },
  TAG: { color: '#5a5a5a', bold: true },
  PARAMETER: { color: '#285a28' },
  LINE_BREAK: { color: '#a0a0a0', bold: true },
  PUNCTUATION: { color: '#1432ff' },
  ERROR: { color: '#c80000' },
  KARAOKE: { color: '#8000c0', bold: true },
};

const KARAOKE_TEMPLATE = /^\[(?:k|K)(?:f|F|o|O)?\d*(?:\s*\d+)?\s*\]/;

/** 把 ASS 文本分成带样式类型的片段 */
export function tokenizeAss(text: string): AssHighlightSegment[] {
  const segments: AssHighlightSegment[] = [];
  const push = (value: string, type: AssSyntaxType) => {
    if (value) segments.push({ text: value, type });
  };

  let i = 0;
  while (i < text.length) {
    const c = text[i];

    // 反斜杠：标签或换行符
    if (c === '\\') {
      const next = text[i + 1];
      if (next === 'N' || next === 'n' || next === 'h') {
        push(text.slice(i, i + 2), 'LINE_BREAK');
        i += 2;
        continue;
      }
      // 标签名（可能含 _ 与数字后缀，如 \1c 中的 1）
      let j = i + 1;
      while (j < text.length && /[a-zA-Z0-9_]/.test(text[j]) && j - i < 6) j++;
      const name = text.slice(i, j);
      // 卡拉 OK 模板 $k 等
      if (/^\$[a-zA-Z]/.test(text.slice(i))) {
        let k = i;
        while (k < text.length && /[\w\d]/.test(text[k])) k++;
        push(text.slice(i, k), 'KARAOKE');
        i = k;
        continue;
      }
      push(name, 'TAG');
      i = j;

      // 参数：=值 或 (括号参数)
      if (text[i] === '=') {
        let k = i + 1;
        while (k < text.length && text[k] !== ',' && text[k] !== ')' && text[k] !== '{' && text[k] !== '\\') k++;
        push(text.slice(i, k), 'PARAMETER');
        i = k;
      } else if (text[i] === '(') {
        let depth = 0;
        let k = i;
        while (k < text.length) {
          if (text[k] === '(') depth++;
          else if (text[k] === ')') {
            depth--;
            if (depth === 0) {
              k++;
              break;
            }
          }
          k++;
        }
        push(text.slice(i, k), 'PARAMETER');
        i = k;
      }
      continue;
    }

    if (c === '{') {
      push('{', 'OVERRIDE');
      i++;
      continue;
    }
    if (c === '}') {
      push('}', 'OVERRIDE');
      i++;
      continue;
    }
    if (c === ',' || c === '(' || c === ')') {
      push(c, 'PUNCTUATION');
      i++;
      continue;
    }

    // 普通文本段（含卡拉 OK 模板标记如 {\k20} 已由上面处理；这里是块外文本）
    let j = i;
    while (j < text.length && text[j] !== '\\' && text[j] !== '{' && text[j] !== '}' && text[j] !== ',') j++;
    const run = text.slice(i, j);
    // 块外以 [k...] 开头的卡拉 OK 模板
    if (KARAOKE_TEMPLATE.test(run)) push(run, 'KARAOKE');
    else push(run, 'NORMAL');
    i = j;
  }
  return segments;
}

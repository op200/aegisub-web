export interface AssVisualOverrides {
  pos?: { x: number; y: number };
  scaleX: number;
  scaleY: number;
  rotationZ: number;
  rotationX: number;
  rotationY: number;
  clip?: { inverse: boolean; x1: number; y1: number; x2: number; y2: number };
}

function lastMatch(text: string, expression: RegExp): RegExpMatchArray | null {
  let result: RegExpMatchArray | null = null;
  for (const block of text.matchAll(/\{[^}]*}/g)) {
    const match = block[0].match(expression);
    if (match) result = match;
  }
  return result;
}

export function readVisualOverrides(text: string): AssVisualOverrides {
  const pos = lastMatch(text, /\\pos\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/i);
  const scaleX = lastMatch(text, /\\fscx(-?[\d.]+)/i);
  const scaleY = lastMatch(text, /\\fscy(-?[\d.]+)/i);
  const rotationZ = lastMatch(text, /\\(?:frz|fr)(-?[\d.]+)/i);
  const rotationX = lastMatch(text, /\\frx(-?[\d.]+)/i);
  const rotationY = lastMatch(text, /\\fry(-?[\d.]+)/i);
  const clip = lastMatch(text, /\\(i?clip)\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/i);
  return {
    pos: pos ? { x: Number(pos[1]), y: Number(pos[2]) } : undefined,
    scaleX: scaleX ? Number(scaleX[1]) : 100,
    scaleY: scaleY ? Number(scaleY[1]) : 100,
    rotationZ: rotationZ ? Number(rotationZ[1]) : 0,
    rotationX: rotationX ? Number(rotationX[1]) : 0,
    rotationY: rotationY ? Number(rotationY[1]) : 0,
    clip: clip
      ? {
          inverse: clip[1].toLowerCase() === 'iclip',
          x1: Number(clip[2]),
          y1: Number(clip[3]),
          x2: Number(clip[4]),
          y2: Number(clip[5]),
        }
      : undefined,
  };
}

export function setOverride(text: string, tag: string, value: string): string {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = new RegExp(`\\\\${escaped}(?:\\([^)]*\\)|-?[\\d.]+)`, 'gi');
  let replaced = false;
  const blocks = text.replace(/\{([^}]*)}/g, (whole, content: string) => {
    if (!expression.test(content)) return whole;
    replaced = true;
    expression.lastIndex = 0;
    return `{${content.replace(expression, `\\${tag}${value}`)}}`;
  });
  if (replaced) return blocks;
  if (blocks.startsWith('{')) return blocks.replace('{', `{\\${tag}${value}`);
  return `{\\${tag}${value}}${blocks}`;
}

export function setPosition(text: string, x: number, y: number): string {
  return setOverride(text.replace(/\\move\([^)]*\)/gi, ''), 'pos', `(${Math.round(x)},${Math.round(y)})`);
}

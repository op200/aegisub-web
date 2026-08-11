export function assColorToCss(value: string, fallback = '#ffffff'): string {
  const hex = value
    .replace(/[^0-9a-f]/gi, '')
    .padStart(8, '0')
    .slice(-8);
  if (!hex) return fallback;
  const alpha = 1 - Number.parseInt(hex.slice(0, 2), 16) / 255;
  const blue = Number.parseInt(hex.slice(2, 4), 16);
  const green = Number.parseInt(hex.slice(4, 6), 16);
  const red = Number.parseInt(hex.slice(6, 8), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha.toFixed(3)})`;
}

export function assColorToHex(value: string): string {
  const hex = value
    .replace(/[^0-9a-f]/gi, '')
    .padStart(8, '0')
    .slice(-8);
  return `#${hex.slice(6, 8)}${hex.slice(4, 6)}${hex.slice(2, 4)}`;
}

export function hexToAssColor(value: string, previous = '&H00FFFFFF'): string {
  const rgb = value.replace('#', '').padStart(6, '0');
  const alpha = previous
    .replace(/[^0-9a-f]/gi, '')
    .padStart(8, '0')
    .slice(-8, -6)
    .toUpperCase();
  return `&H${alpha}${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}`.toUpperCase();
}

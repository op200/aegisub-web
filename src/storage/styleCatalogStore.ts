import type { SubtitleStyle } from '../core/types';
import { createDefaultStyle } from '../core/defaults';

const KEY = 'aegisub-style-catalogs-v1';

export interface StyleCatalog {
  name: string;
  styles: SubtitleStyle[];
}

function cloneStyles(styles: SubtitleStyle[]) {
  return structuredClone(styles);
}

function defaults(): StyleCatalog[] {
  return [{ name: 'Default', styles: [createDefaultStyle()] }];
}

export function loadStyleCatalogs(): StyleCatalog[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '') as StyleCatalog[];
    return parsed.length ? parsed : defaults();
  } catch {
    return defaults();
  }
}

export function saveStyleCatalogs(catalogs: StyleCatalog[]): void {
  localStorage.setItem(KEY, JSON.stringify(catalogs));
}

export function uniqueStyleName(base: string, styles: SubtitleStyle[]): string {
  const used = new Set(styles.map((style) => style.name.toLocaleLowerCase()));
  if (!used.has(base.toLocaleLowerCase())) return base;
  let index = 2;
  while (used.has(`${base} (${index})`.toLocaleLowerCase())) index += 1;
  return `${base} (${index})`;
}

export function copyStyle(
  style: SubtitleStyle,
  styles: SubtitleStyle[],
  suffix = `${style.name} - Copy`,
): SubtitleStyle {
  return {
    ...cloneStyles([style])[0],
    id: `style-${crypto.randomUUID()}`,
    name: uniqueStyleName(suffix, styles),
  };
}

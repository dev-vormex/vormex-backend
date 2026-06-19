export const PROFILE_THEME_DEFAULT = 'default';
export const PROFILE_THEME_GAME_RETRO = 'game_retro';

export const PROFILE_THEME_KEYS = [
  PROFILE_THEME_DEFAULT,
  PROFILE_THEME_GAME_RETRO,
] as const;

export type ProfileThemeKey = (typeof PROFILE_THEME_KEYS)[number];

export function isProfileThemeKey(value: string): value is ProfileThemeKey {
  return (PROFILE_THEME_KEYS as readonly string[]).includes(value);
}

export function serializeProfileTheme(value: string | null | undefined): ProfileThemeKey {
  return value === PROFILE_THEME_GAME_RETRO ? PROFILE_THEME_GAME_RETRO : PROFILE_THEME_DEFAULT;
}

export function normalizeProfileThemeForStorage(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;

  const trimmed = value.trim();
  if (!trimmed || trimmed === PROFILE_THEME_DEFAULT) return null;
  if (!isProfileThemeKey(trimmed)) {
    throw new Error(`Unsupported profile theme: ${trimmed}`);
  }
  return trimmed;
}

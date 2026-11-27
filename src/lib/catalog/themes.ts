import { z } from 'zod';
import rawCatalog from '@/content/themes.json';
import {
  ArtStyleSchema,
  MAX_CHILD_AGE,
  MIN_CHILD_AGE,
  StoryMoodSchema,
  type ArtStyle,
  type StoryMood,
} from '@/lib/types/story';

// =============================================================================
// Data-Driven Seasonal & Evergreen Theme Catalog (100% browser-safe)
// =============================================================================

export const THEME_SEASONS = [
  'evergreen',
  'christmas',
  'grandparents-day',
  'easter',
  'childrens-day',
  'summer',
  'autumn',
  'winter',
  'spring',
  'custom',
] as const;

export const THEME_LIFECYCLE_STATUSES = [
  'draft',
  'review',
  'active',
  'archived',
] as const;

export const ThemeSeasonSchema = z.enum(THEME_SEASONS);
export const ThemeLifecycleStatusSchema = z.enum(THEME_LIFECYCLE_STATUSES);
export type ThemeSeason = z.infer<typeof ThemeSeasonSchema>;
export type ThemeLifecycleStatus = z.infer<typeof ThemeLifecycleStatusSchema>;

const MONTH_DAY_REGEX = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const MAX_DAYS_IN_MONTH: Readonly<Record<number, number>> = {
  1: 31,
  2: 29,
  3: 31,
  4: 30,
  5: 31,
  6: 30,
  7: 31,
  8: 31,
  9: 30,
  10: 31,
  11: 30,
  12: 31,
};

export function isValidMonthDay(mmdd: string): boolean {
  if (!MONTH_DAY_REGEX.test(mmdd)) return false;
  const [mStr, dStr] = mmdd.split('-');
  const month = Number.parseInt(mStr, 10);
  const day = Number.parseInt(dStr, 10);
  const maxDay = MAX_DAYS_IN_MONTH[month];
  return maxDay !== undefined && day >= 1 && day <= maxDay;
}

const ValidMonthDaySchema = z
  .string()
  .regex(MONTH_DAY_REGEX, 'Wymagany format MM-DD (np. 11-15).')
  .refine(isValidMonthDay, 'Nieistniejąca data kalendarzowa w formacie MM-DD.');

export const ActiveDateWindowSchema = z.object({
  startMonthDay: ValidMonthDaySchema,
  endMonthDay: ValidMonthDaySchema,
});

export type ActiveDateWindow = z.infer<typeof ActiveDateWindowSchema>;

export const ThemeAgeRangeSchema = z
  .object({
    min: z.number().int().min(MIN_CHILD_AGE).max(MAX_CHILD_AGE),
    max: z.number().int().min(MIN_CHILD_AGE).max(MAX_CHILD_AGE),
  })
  .refine((range) => range.min <= range.max, {
    message: 'Minimalny wiek w ageRange nie może być większy niż maksymalny.',
  });

export type ThemeAgeRange = z.infer<typeof ThemeAgeRangeSchema>;

export const ThemePromptHintsSchema = z.object({
  wardrobeHint: z.string().trim().min(2).max(200).optional(),
  seasonalMotifs: z.array(z.string().trim().min(2).max(100)).max(8).optional(),
  lightingOverride: z.string().trim().min(2).max(200).optional(),
  avoidMotifs: z.array(z.string().trim().min(2).max(100)).max(8).optional(),
});

export type ThemePromptHints = z.infer<typeof ThemePromptHintsSchema>;

export const ThemeCatalogItemSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,63}$/, 'Nieprawidłowy identyfikator motywu.'),
  label: z.string().trim().min(2).max(80),
  theme: z.string().trim().min(5).max(400),
  suggestedMood: StoryMoodSchema,
  suggestedArtStyle: ArtStyleSchema.optional(),
  season: ThemeSeasonSchema.default('evergreen'),
  lifecycleStatus: ThemeLifecycleStatusSchema.default('active'),
  badge: z.string().trim().min(1).max(40).optional(),
  priority: z.number().int().min(0).max(1000).default(100),
  activeWindow: ActiveDateWindowSchema.optional(),
  ageRange: ThemeAgeRangeSchema.optional(),
  promptHints: ThemePromptHintsSchema.optional(),
  orderCutoffLeadDays: z.number().int().min(1).max(60).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
});

export const ThemeCatalogSchema = z.object({
  version: z.number().int().min(1),
  themes: z
    .array(ThemeCatalogItemSchema)
    .min(1)
    .refine(
      (items) => new Set(items.map((item) => item.id)).size === items.length,
      'Identyfikatory motywów w katalogu muszą być unikalne.',
    ),
});

export interface ThemeCatalogItem {
  readonly id: string;
  readonly label: string;
  readonly theme: string;
  readonly suggestedMood: StoryMood;
  readonly suggestedArtStyle?: ArtStyle;
  readonly season: ThemeSeason;
  readonly lifecycleStatus?: ThemeLifecycleStatus;
  readonly badge?: string;
  readonly priority: number;
  readonly activeWindow?: ActiveDateWindow;
  readonly ageRange?: ThemeAgeRange;
  readonly promptHints?: ThemePromptHints;
  readonly orderCutoffLeadDays?: number;
  readonly tags: readonly string[];
}

export interface ThemeCatalogDocument {
  readonly version: number;
  readonly themes: readonly ThemeCatalogItem[];
}

const validatedCatalog: ThemeCatalogDocument = ThemeCatalogSchema.parse(rawCatalog);

// Month lengths in a non-leap canonical 365-day year (Feb 29 clamps to Feb 28).
const DAYS_BEFORE_MONTH = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334] as const;

function monthDayToDayOfYear(month: number, day: number): number {
  const clampedMonth = Math.min(12, Math.max(1, month));
  const maxDayInMonth =
    clampedMonth === 2
      ? 28
      : [4, 6, 9, 11].includes(clampedMonth)
        ? 30
        : 31;
  const clampedDay = Math.min(maxDayInMonth, Math.max(1, day));
  return DAYS_BEFORE_MONTH[clampedMonth - 1] + clampedDay;
}

function parseMonthDay(mmdd: string): number {
  const [mStr, dStr] = mmdd.split('-');
  return monthDayToDayOfYear(Number.parseInt(mStr, 10), Number.parseInt(dStr, 10));
}

/**
 * Extracts YYYY, MM, DD in Europe/Warsaw timezone for Polish seasonal scheduling.
 */
export function getWarsawDateParts(date: Date = new Date()): {
  year: number;
  month: number;
  day: number;
  isoDate: string;
} {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Warsaw',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const year = Number.parseInt(parts.find((p) => p.type === 'year')?.value ?? '', 10);
    const month = Number.parseInt(parts.find((p) => p.type === 'month')?.value ?? '', 10);
    const day = Number.parseInt(parts.find((p) => p.type === 'day')?.value ?? '', 10);
    if (Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)) {
      const isoDate = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return { year, month, day, isoDate };
    }
  } catch {
    // Fallback to UTC if Intl timezone data is unavailable
  }
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  return {
    year,
    month,
    day,
    isoDate: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

function dateToDayOfYear(date: Date): number {
  const { month, day } = getWarsawDateParts(date);
  return monthDayToDayOfYear(month, day);
}

/**
 * Checks whether a theme catalog item is active on the given calendar date
 * (evaluated in Europe/Warsaw timezone).
 */
export function isThemeActiveOnDate(
  item: ThemeCatalogItem,
  date: Date = new Date(),
): boolean {
  if (item.lifecycleStatus && item.lifecycleStatus !== 'active') {
    return false;
  }
  if (!item.activeWindow) {
    return true;
  }

  const targetDay = dateToDayOfYear(date);
  const startDay = parseMonthDay(item.activeWindow.startMonthDay);
  const endDay = parseMonthDay(item.activeWindow.endMonthDay);

  if (startDay <= endDay) {
    return targetDay >= startDay && targetDay <= endDay;
  }

  // Year-wrapping window (e.g. Nov 15 -> Jan 6)
  return targetDay >= startDay || targetDay <= endDay;
}

export function isThemeSuitableForAge(item: ThemeCatalogItem, age: number): boolean {
  if (!item.ageRange) return true;
  return age >= item.ageRange.min && age <= item.ageRange.max;
}

export function filterThemesByAge(
  themes: readonly ThemeCatalogItem[],
  age: number,
): ThemeCatalogItem[] {
  return themes.filter((item) => isThemeSuitableForAge(item, age));
}

/**
 * Returns the number of calendar days until a seasonal theme's window starts
 * (0 if already active or evergreen).
 */
export function daysUntilThemeStart(
  item: ThemeCatalogItem,
  date: Date = new Date(),
): number {
  if (!item.activeWindow || isThemeActiveOnDate(item, date)) {
    return 0;
  }

  const targetDay = dateToDayOfYear(date);
  const startDay = parseMonthDay(item.activeWindow.startMonthDay);
  const diff = startDay - targetDay;
  return diff >= 0 ? diff : 365 + diff;
}

export function getAllThemes(): readonly ThemeCatalogItem[] {
  return validatedCatalog.themes;
}

export function getEvergreenThemes(): readonly ThemeCatalogItem[] {
  return validatedCatalog.themes
    .filter(
      (item) =>
        item.season === 'evergreen' &&
        (!item.lifecycleStatus || item.lifecycleStatus === 'active'),
    )
    .sort((a, b) => a.priority - b.priority);
}

/**
 * Returns themes active on `date`, ordered by priority (seasonal highlights first,
 * followed by evergreen classics).
 */
export function getActiveThemes(
  date: Date = new Date(),
  catalog: readonly ThemeCatalogItem[] = validatedCatalog.themes,
): ThemeCatalogItem[] {
  return catalog
    .filter((item) => isThemeActiveOnDate(item, date))
    .sort((a, b) => a.priority - b.priority);
}

/**
 * Lists upcoming seasonal themes starting within `withinDays` days from `date`
 * (useful for seasonal content planning agents).
 */
export function getUpcomingSeasonalThemes(
  date: Date = new Date(),
  withinDays = 45,
  catalog: readonly ThemeCatalogItem[] = validatedCatalog.themes,
): Array<{ theme: ThemeCatalogItem; startsInDays: number }> {
  const safeDays = Math.max(1, Math.min(365, Math.floor(withinDays)));
  return catalog
    .filter(
      (item) =>
        Boolean(item.activeWindow) &&
        (!item.lifecycleStatus || item.lifecycleStatus === 'active') &&
        !isThemeActiveOnDate(item, date),
    )
    .map((theme) => ({
      theme,
      startsInDays: daysUntilThemeStart(theme, date),
    }))
    .filter((entry) => entry.startsInDays > 0 && entry.startsInDays <= safeDays)
    .sort((a, b) => a.startsInDays - b.startsInDays);
}

export function getThemeById(
  id: string,
  catalog: readonly ThemeCatalogItem[] = validatedCatalog.themes,
): ThemeCatalogItem | undefined {
  return catalog.find((item) => item.id === id);
}

export function parseCatalogDateParam(raw: string | null): Date | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return null;
  }
  const parsed = new Date(`${trimmed}T12:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  // Reject overflowed calendar dates like 2026-02-31
  const roundTripped = parsed.toISOString().slice(0, 10);
  return roundTripped === trimmed ? parsed : null;
}

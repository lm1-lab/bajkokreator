import { NextResponse } from 'next/server';
import {
  errorResponse,
  getOrCreateRequestId,
  handleApiError,
  jsonResponse,
} from '@/lib/api-helpers';
import {
  filterThemesByAge,
  getActiveThemes,
  getAllThemes,
  getUpcomingSeasonalThemes,
  getWarsawDateParts,
  parseCatalogDateParam,
} from '@/lib/catalog/themes';
import { MAX_CHILD_AGE, MIN_CHILD_AGE } from '@/lib/types/story';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STRICT_INT_REGEX = /^\d+$/;

export async function GET(request: Request): Promise<NextResponse> {
  const requestId = getOrCreateRequestId(request);
  try {
    const url = new URL(request.url);
    const dateParam = url.searchParams.get('date');
    const includeInactive = url.searchParams.get('includeInactive') === 'true';
    const rawUpcomingDays = url.searchParams.get('upcomingDays');
    const rawAge = url.searchParams.get('age');

    let referenceDate = new Date();
    let referenceDateIso = getWarsawDateParts(referenceDate).isoDate;
    if (dateParam !== null) {
      const parsed = parseCatalogDateParam(dateParam);
      if (!parsed) {
        return errorResponse({
          error: 'Nieprawidłowa data katalogu. Użyj poprawnej daty w formacie YYYY-MM-DD.',
          code: 'INVALID_DATE',
          status: 400,
          requestId,
        });
      }
      referenceDate = parsed;
      referenceDateIso = dateParam.trim();
    }

    let upcomingDays = 45;
    if (rawUpcomingDays !== null) {
      const trimmed = rawUpcomingDays.trim();
      if (!STRICT_INT_REGEX.test(trimmed)) {
        return errorResponse({
          error: 'Parametr upcomingDays musi być dodatnią liczbą całkowitą (1–365).',
          code: 'INVALID_UPCOMING_DAYS',
          status: 400,
          requestId,
        });
      }
      const parsedDays = Number.parseInt(trimmed, 10);
      if (parsedDays < 1 || parsedDays > 365) {
        return errorResponse({
          error: 'Parametr upcomingDays musi być liczbą całkowitą z zakresu 1–365.',
          code: 'INVALID_UPCOMING_DAYS',
          status: 400,
          requestId,
        });
      }
      upcomingDays = parsedDays;
    }

    let filterAge: number | null = null;
    if (rawAge !== null) {
      const trimmedAge = rawAge.trim();
      if (!STRICT_INT_REGEX.test(trimmedAge)) {
        return errorResponse({
          error: `Parametr age musi być liczbą całkowitą z zakresu ${MIN_CHILD_AGE}–${MAX_CHILD_AGE}.`,
          code: 'INVALID_AGE',
          status: 400,
          requestId,
        });
      }
      const parsedAge = Number.parseInt(trimmedAge, 10);
      if (parsedAge < MIN_CHILD_AGE || parsedAge > MAX_CHILD_AGE) {
        return errorResponse({
          error: `Parametr age musi mieścić się w zakresie ${MIN_CHILD_AGE}–${MAX_CHILD_AGE}.`,
          code: 'INVALID_AGE',
          status: 400,
          requestId,
        });
      }
      filterAge = parsedAge;
    }

    const baseActiveThemes = getActiveThemes(referenceDate);
    const activeThemes =
      filterAge !== null ? filterThemesByAge(baseActiveThemes, filterAge) : baseActiveThemes;
    const allThemes =
      filterAge !== null ? filterThemesByAge(getAllThemes(), filterAge) : [...getAllThemes()];

    const upcoming = getUpcomingSeasonalThemes(referenceDate, upcomingDays).map((entry) => ({
      id: entry.theme.id,
      label: entry.theme.label,
      season: entry.theme.season,
      ...(entry.theme.badge ? { badge: entry.theme.badge } : {}),
      ...(entry.theme.activeWindow ? { activeWindow: entry.theme.activeWindow } : {}),
      startsInDays: entry.startsInDays,
      theme: entry.theme,
    }));

    return jsonResponse(
      {
        referenceDate: referenceDateIso,
        themes: includeInactive ? allThemes : activeThemes,
        activeCount: activeThemes.length,
        upcomingSeasonal: upcoming,
      },
      { status: 200, requestId },
    );
  } catch (err) {
    return handleApiError(err, requestId);
  }
}

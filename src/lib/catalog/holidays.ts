// =============================================================================
// Polish Movable & Fixed Holiday Calendar Helper (100% browser-safe)
// Uses the Anonymous Gregorian Computus algorithm for Easter-derived dates.
// =============================================================================

export interface PolishHoliday {
  readonly id: string;
  readonly name: string;
  readonly dateIso: string; // YYYY-MM-DD
  readonly monthDay: string; // MM-DD
  readonly movable: boolean;
  readonly suggestedCampaignLeadDays: number;
}

function formatUtcIsoDate(date: Date): { dateIso: string; monthDay: string } {
  const y = String(date.getUTCFullYear()).padStart(4, '0');
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return { dateIso: `${y}-${m}-${d}`, monthDay: `${m}-${d}` };
}

function addDaysUtc(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * Computes Gregorian Easter Sunday using the Meeus/Jones/Butcher algorithm.
 */
export function computeEasterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3=March, 4=April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

export function getPolishHolidaysForYear(year: number): PolishHoliday[] {
  const easter = computeEasterSunday(year);
  const fatThursday = addDaysUtc(easter, -52);
  const ashWednesday = addDaysUtc(easter, -46);
  const easterMonday = addDaysUtc(easter, 1);
  const corpusChristi = addDaysUtc(easter, 60);

  const movableEntry = (
    id: string,
    name: string,
    date: Date,
    leadDays: number,
  ): PolishHoliday => ({
    id,
    name,
    ...formatUtcIsoDate(date),
    movable: true,
    suggestedCampaignLeadDays: leadDays,
  });

  const fixedEntry = (
    id: string,
    name: string,
    month: number,
    day: number,
    leadDays: number,
  ): PolishHoliday => {
    const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    return {
      id,
      name,
      ...formatUtcIsoDate(date),
      movable: false,
      suggestedCampaignLeadDays: leadDays,
    };
  };

  return [
    fixedEntry('epiphany', 'Trzech Króli', 1, 6, 14),
    fixedEntry('grandmothers-day', 'Dzień Babci', 1, 21, 14),
    fixedEntry('grandfathers-day', 'Dzień Dziadka', 1, 22, 14),
    movableEntry('fat-thursday', 'Tłusty Czwartek', fatThursday, 7),
    movableEntry('ash-wednesday', 'Środa Popielcowa', ashWednesday, 7),
    movableEntry('easter-sunday', 'Wielkanoc', easter, 21),
    movableEntry('easter-monday', 'Poniedziałek Wielkanocny', easterMonday, 21),
    fixedEntry('mothers-day', 'Dzień Matki', 5, 26, 14),
    fixedEntry('childrens-day', 'Dzień Dziecka', 6, 1, 18),
    movableEntry('corpus-christi', 'Boże Ciało', corpusChristi, 10),
    fixedEntry('fathers-day', 'Dzień Ojca', 6, 23, 14),
    fixedEntry('school-start', 'Rozpoczęcie Roku Szkolnego', 9, 1, 14),
    fixedEntry('st-nicholas', 'Mikołajki', 12, 6, 21),
    fixedEntry('christmas-eve', 'Wigilia Bożego Narodzenia', 12, 24, 28),
  ].sort((a, b) => a.dateIso.localeCompare(b.dateIso));
}

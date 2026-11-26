import { describe, expect, it } from 'vitest';
import {
  declinePolishName,
  formatAgeAdjective,
  formatAgeYears,
  formatCompanionSentence,
  g,
  getPolishForms,
  normalizeCompanion,
} from '@/lib/polish/inflection';
import {
  ART_STYLE_META,
  PRINT_SAFETY_CLAUSE,
  STORY_MOOD_META,
  buildCharacterBible,
  buildCoverPrompt,
  buildGeminiBlueprintSystemInstruction,
  buildGeminiBlueprintUserPrompt,
  buildGeminiImagePrompt,
  buildPagePrompt,
} from '@/lib/polish/prompts';
import {
  BEAT_SELECTION_BY_PAGE_COUNT,
  THEME_INSPIRATIONS,
  buildPolishStoryDraft,
  resolveDemoAssetPath,
} from '@/lib/polish/templates';
import {
  ART_STYLES,
  DEMO_ASSET_PATH_REGEX,
  STORY_MOODS,
  StoryBlueprintSchema,
  type StoryInput,
} from '@/lib/types/story';

const BASE_GIRL_INPUT: StoryInput = {
  childName: 'Zosia',
  childAge: 5,
  gender: 'girl',
  companion: 'rudy kotek Mruczek',
  theme: 'wyprawa do zaczarowanego lasu złotych latarni',
  artStyle: 'watercolor',
  mood: 'magical-adventure',
  pageCount: 10,
  dedicationFrom: 'Mama i Tata',
};

const BASE_BOY_INPUT: StoryInput = {
  childName: 'Antoś',
  childAge: 4,
  gender: 'boy',
  companion: 'mała smoczyca Iskierka',
  theme: 'tajemnicza podróż balonem ponad chmurami',
  artStyle: 'storybook-gouache',
  mood: 'warm-cozy',
  pageCount: 10,
  dedicationFrom: 'Babcia Basia',
};

describe('Polish gender morphology (inflection.ts)', () => {
  it('provides accurate girl vs boy nouns, pronouns (including genPrep), adjectives, and irregular verbs', () => {
    const girl = getPolishForms('girl');
    const boy = getPolishForms('boy');

    expect(g('girl', 'odważna', 'odważny')).toBe('odważna');
    expect(g('boy', 'odważna', 'odważny')).toBe('odważny');
    expect(girl.g('mała', 'mały')).toBe('mała');
    expect(boy.g('mała', 'mały')).toBe('mały');

    // Nouns
    expect(girl.nouns.child).toBe('dziewczynka');
    expect(boy.nouns.child).toBe('chłopiec');
    expect(girl.nouns.hero).toBe('bohaterka');
    expect(boy.nouns.hero).toBe('bohater');
    expect(girl.nouns.explorer).toBe('odkrywczyni');
    expect(boy.nouns.explorer).toBe('odkrywca');
    expect(girl.nouns.traveler).toBe('podróżniczka');
    expect(boy.nouns.traveler).toBe('podróżnik');

    // Pronouns including critical genPrep distinction ("obok niej" / "obok niego")
    expect(girl.pronouns).toMatchObject({
      subj: 'ona',
      poss: 'jej',
      dat: 'jej',
      acc: 'ją',
      ins: 'nią',
      loc: 'niej',
      genPrep: 'niej',
      self: 'sama',
    });
    expect(boy.pronouns).toMatchObject({
      subj: 'on',
      poss: 'jego',
      dat: 'mu',
      acc: 'go',
      ins: 'nim',
      loc: 'nim',
      genPrep: 'niego',
      self: 'sam',
    });

    // Irregular past tense alternations (-szła/-szedł, -ęła/-ął, o/ó)
    const irregularChecks: Array<[keyof typeof girl.verbs, string, string]> = [
      ['went', 'poszła', 'poszedł'],
      ['walked', 'szła', 'szedł'],
      ['entered', 'weszła', 'wszedł'],
      ['exited', 'wyszła', 'wyszedł'],
      ['approached', 'podeszła', 'podszedł'],
      ['found', 'znalazła', 'znalazł'],
      ['took', 'wzięła', 'wziął'],
      ['smiled', 'uśmiechnęła się', 'uśmiechnął się'],
      ['reached', 'sięgnęła', 'sięgnął'],
      ['fellAsleep', 'zasnęła', 'zasnął'],
      ['whispered', 'szepnęła', 'szepnął'],
      ['could', 'mogła', 'mógł'],
      ['carried', 'niosła', 'niósł'],
      ['brought', 'przyniosła', 'przyniósł'],
      ['wanted', 'chciała', 'chciał'],
    ];

    for (const [key, expectedGirl, expectedBoy] of irregularChecks) {
      expect(girl.verbs[key]).toBe(expectedGirl);
      expect(boy.verbs[key]).toBe(expectedBoy);
    }
  });

  it('implements 3-way Slavic age pluralization and safe invalid-input clamping', () => {
    const cases: Array<[number, string]> = [
      [0, '0 lat'],
      [1, '1 rok'],
      [2, '2 lata'],
      [3, '3 lata'],
      [4, '4 lata'],
      [5, '5 lat'],
      [11, '11 lat'],
      [12, '12 lat'],
      [13, '13 lat'],
      [14, '14 lat'],
      [21, '21 lat'],
      [22, '22 lata'],
      [23, '23 lata'],
      [24, '24 lata'],
      [25, '25 lat'],
      [112, '112 lat'],
      [-1, '0 lat'],
      [5.9, '5 lat'],
      [Number.NaN, '0 lat'],
      [Number.POSITIVE_INFINITY, '0 lat'],
    ];

    for (const [age, expected] of cases) {
      expect(formatAgeYears(age)).toBe(expected);
    }
  });

  it('formats gendered Polish age adjectives cleanly including 0 and 1', () => {
    expect(formatAgeAdjective(0, 'girl')).toBe('maleńka');
    expect(formatAgeAdjective(0, 'boy')).toBe('maleńki');
    expect(formatAgeAdjective(1, 'girl')).toBe('roczna');
    expect(formatAgeAdjective(1, 'boy')).toBe('roczny');
    expect(formatAgeAdjective(2, 'girl')).toBe('2-letnia');
    expect(formatAgeAdjective(2, 'boy')).toBe('2-letni');
    expect(formatAgeAdjective(5, 'girl')).toBe('5-letnia');
    expect(formatAgeAdjective(12, 'boy')).toBe('12-letni');
  });
});

describe('Polish name declension (declinePolishName)', () => {
  it('declines curated Polish female and male names accurately', () => {
    expect(declinePolishName('Zosia', 'girl')).toEqual({
      nominative: 'Zosia',
      vocative: 'Zosiu',
      genitive: 'Zosi',
    });
    expect(declinePolishName('Maja', 'girl')).toEqual({
      nominative: 'Maja',
      vocative: 'Maju',
      genitive: 'Mai',
    });
    expect(declinePolishName('Oliwia', 'girl')).toEqual({
      nominative: 'Oliwia',
      vocative: 'Oliwio',
      genitive: 'Oliwii',
    });
    expect(declinePolishName('Kuba', 'boy')).toEqual({
      nominative: 'Kuba',
      vocative: 'Kubo',
      genitive: 'Kuby',
    });
    expect(declinePolishName('Antoni', 'boy')).toEqual({
      nominative: 'Antoni',
      vocative: 'Antoni',
      genitive: 'Antoniego',
    });
    expect(declinePolishName('Ignacy', 'boy')).toEqual({
      nominative: 'Ignacy',
      vocative: 'Ignacy',
      genitive: 'Ignacego',
    });
    expect(declinePolishName('Maciek', 'boy')).toEqual({
      nominative: 'Maciek',
      vocative: 'Maćku',
      genitive: 'Maćka',
    });
    expect(declinePolishName('Paweł', 'boy')).toEqual({
      nominative: 'Paweł',
      vocative: 'Pawle',
      genitive: 'Pawła',
    });
    expect(declinePolishName('Kacper', 'boy')).toEqual({
      nominative: 'Kacper',
      vocative: 'Kacprze',
      genitive: 'Kacpra',
    });
  });

  it('preserves casing, NFC Unicode normalization, and compound/double-barreled names', () => {
    expect(declinePolishName('zosia', 'girl')).toEqual({
      nominative: 'zosia',
      vocative: 'zosiu',
      genitive: 'zosi',
    });
    expect(declinePolishName('ZOSIA', 'girl')).toEqual({
      nominative: 'ZOSIA',
      vocative: 'ZOSIU',
      genitive: 'ZOSI',
    });

    // NFD decomposed "Zosia" / "Łucja" / "Antoś" -> NFC normalized
    const nfdAntos = 'Antos\u0301';
    expect(declinePolishName(nfdAntos, 'boy')).toEqual({
      nominative: 'Antoś',
      vocative: 'Antosiu',
      genitive: 'Antosia',
    });

    expect(declinePolishName('Anna-Maria', 'girl')).toEqual({
      nominative: 'Anna-Maria',
      vocative: 'Anno-Mario',
      genitive: 'Anny-Marii',
    });
    expect(declinePolishName('Jan-Krzysztof', 'boy')).toEqual({
      nominative: 'Jan-Krzysztof',
      vocative: 'Janie-Krzysztofie',
      genitive: 'Jana-Krzysztofa',
    });
    expect(declinePolishName('Jan Paweł', 'boy')).toEqual({
      nominative: 'Jan Paweł',
      vocative: 'Janie Pawle',
      genitive: 'Jana Pawła',
    });
  });

  it('handles morphological fallback for unlisted Polish names and never mangles foreign names', () => {
    expect(declinePolishName('Monika', 'girl')).toEqual({
      nominative: 'Monika',
      vocative: 'Moniko',
      genitive: 'Moniki',
    });
    expect(declinePolishName('Dariusz', 'boy')).toEqual({
      nominative: 'Dariusz',
      vocative: 'Dariuszu',
      genitive: 'Dariusza',
    });

    const foreignNames: Array<[string, 'girl' | 'boy']> = [
      ['Noemi', 'girl'],
      ['Mia', 'girl'],
      ['Ines', 'girl'],
      ['Kaya', 'girl'],
      ['Leo', 'boy'],
      ['Bruno', 'boy'],
      ['Hugo', 'boy'],
      ['Alex', 'boy'],
      ['Liam', 'boy'],
    ];

    for (const [foreignName, gender] of foreignNames) {
      expect(declinePolishName(foreignName, gender)).toEqual({
        nominative: foreignName,
        vocative: foreignName,
        genitive: foreignName,
      });
    }
  });
});

describe('Case-safe, gender-neutral companion apposition', () => {
  it('normalizes companions and renders grammatically neutral Polish sentences without dangling punctuation', () => {
    expect(normalizeCompanion(undefined)).toBeNull();
    expect(normalizeCompanion('   ')).toBeNull();
    expect(normalizeCompanion('rudy kotek Mruczek...')).toBe('rudy kotek Mruczek');

    expect(formatCompanionSentence(undefined, 'girl', 'path')).toBe('');
    expect(formatCompanionSentence('   ', 'boy', 'circle')).toBe('');

    const mascGirl = formatCompanionSentence('rudy kotek Mruczek', 'girl', 'path');
    const femBoy = formatCompanionSentence('mała smoczyca Iskierka', 'boy', 'circle');
    expect(mascGirl).toContain('jej rudy kotek Mruczek');
    expect(femBoy).toContain('obok niego jest mała smoczyca Iskierka');
    expect(femBoy).not.toContain('obok nim');
  });
});

describe('Polish story templates, beat selection, and prompts', () => {
  it('exports 6 theme inspirations and metadata for all canonical ArtStyle and StoryMood keys', () => {
    expect(THEME_INSPIRATIONS).toHaveLength(6);
    for (const style of ART_STYLES) {
      expect(ART_STYLE_META[style].label.length).toBeGreaterThan(0);
      expect(ART_STYLE_META[style].promptLock.length).toBeGreaterThan(10);
    }
    for (const mood of STORY_MOODS) {
      expect(STORY_MOOD_META[mood].label.length).toBeGreaterThan(0);
      expect(STORY_MOOD_META[mood].lightingHint.length).toBeGreaterThan(10);
    }
  });

  it('builds valid Polish StoryBlueprints for ALL pageCounts 4..12 and both genders with zero gender leakage', () => {
    const girlOnlyMarkers = [
      /\bdziewczynki\b/i,
      /\bbohaterka\b/i,
      /\bbohaterki\b/i,
      /\bstanęła\b/i,
      /\bwzięła\b/i,
      /\bweszła\b/i,
      /\bzasnęła\b/i,
      /\bKochana\b/,
      /\bmała podróżniczko\b/i,
    ];
    const boyOnlyMarkers = [
      /\bchłopca\b/i,
      /\bbohater\b/i,
      /\bbohatera\b/i,
      /\bstanął\b/i,
      /\bwziął\b/i,
      /\bwszedł\b/i,
      /\bzasnął\b/i,
      /\bKochany\b/,
      /\bmały podróżniku\b/i,
    ];

    for (let pageCount = 4; pageCount <= 12; pageCount += 1) {
      expect(BEAT_SELECTION_BY_PAGE_COUNT[pageCount]).toHaveLength(pageCount);

      for (const base of [BASE_GIRL_INPUT, BASE_BOY_INPUT]) {
        const blueprint = buildPolishStoryDraft({ ...base, pageCount });
        const validated = StoryBlueprintSchema.parse(blueprint);
        expect(validated.pages).toHaveLength(pageCount);
        expect(validated.pages.map((p) => p.pageNumber)).toEqual(
          Array.from({ length: pageCount }, (_, i) => i + 1),
        );

        // Unique chapter titles across the book
        const titles = new Set(validated.pages.map((p) => p.chapterTitle));
        expect(titles.size).toBe(pageCount);

        // Dedication signature preserved
        expect(validated.dedicationText).toContain(base.dedicationFrom!);

        // Check zero gender leakage across entire Polish text
        const fullPolishText = [
          validated.title,
          validated.subtitle,
          validated.dedicationText,
          validated.backCoverBlurb,
          ...validated.pages.map((p) => `${p.chapterTitle} ${p.text}`),
        ].join('\n');

        const forbidden = base.gender === 'girl' ? boyOnlyMarkers : girlOnlyMarkers;
        for (const regex of forbidden) {
          expect(fullPolishText).not.toMatch(regex);
        }

        // Verify valid demo asset paths for every page 1..pageCount
        for (let page = 1; page <= pageCount; page += 1) {
          const path = resolveDemoAssetPath(page, pageCount);
          expect(path).toMatch(DEMO_ASSET_PATH_REGEX);
          expect(path).toMatch(/^\/demo-art\/page-(?:0[1-9]|10)\.jpg$/);
        }
      }
    }
  });

  it('handles maximum-length valid inputs and absent companions without failing StoryBlueprintSchema', () => {
    const extremeInput: StoryInput = {
      childName: 'Aleksandra-Katarzyna-Magdalena-Zuzanna-Wiktoria-Helena',
      childAge: 12,
      gender: 'girl',
      theme: 'niezwykła podniebna wyprawa '.repeat(14).trim().slice(0, 400),
      artStyle: 'vintage-etching',
      mood: 'bedtime-calm',
      pageCount: 12,
      dedicationFrom: 'Kochający Dziadkowie z całego serca i z najlepszymi życzeniami',
    };

    const blueprint = buildPolishStoryDraft(extremeInput);
    const parsed = StoryBlueprintSchema.parse(blueprint);

    expect(parsed.title.length).toBeLessThanOrEqual(160);
    expect(parsed.subtitle.length).toBeLessThanOrEqual(240);
    expect(parsed.dedicationText.length).toBeLessThanOrEqual(1200);
    expect(parsed.backCoverBlurb.length).toBeLessThanOrEqual(1200);
    expect(parsed.characterBible.length).toBeLessThanOrEqual(4000);
    expect(parsed.coverPrompt.length).toBeLessThanOrEqual(4000);
    expect(parsed.dedicationText).not.toContain('()');
    expect(parsed.pages.every((p) => !p.text.includes('()'))).toBe(true);
  });

  it('builds structured English Character Bible, cover/page prompts, and Gemini prompt builders with PRINT_SAFETY_CLAUSE', () => {
    const bible = buildCharacterBible(BASE_GIRL_INPUT);
    expect(bible).toContain('Zosia');
    expect(bible).toContain('5-year-old girl');
    expect(bible).toContain('rudy kotek Mruczek');

    const coverPrompt = buildCoverPrompt(BASE_GIRL_INPUT, bible, 'Zosia w lesie');
    expect(coverPrompt).toContain('[STYLE LOCK]');
    expect(coverPrompt).toContain('[CHARACTER BIBLE]');
    expect(coverPrompt).toContain('[SCENE COMPOSITION]');
    expect(coverPrompt).toContain('[LIGHTING & MOOD]');
    expect(coverPrompt).toContain('[PRINT SAFETY]');
    expect(coverPrompt).toContain(PRINT_SAFETY_CLAUSE);

    const pagePrompt = buildPagePrompt({
      input: BASE_GIRL_INPUT,
      characterBible: bible,
      pageNumber: 3,
      totalPages: 10,
      chapterTitle: 'Dolina świetlistych lampionów',
      sceneDescription: 'Zosia looking at warm glowing paper lanterns',
    });
    expect(pagePrompt).toContain('[STYLE LOCK]');
    expect(pagePrompt).toContain('[CHARACTER BIBLE]');
    expect(pagePrompt).toContain(PRINT_SAFETY_CLAUSE);

    const sysInstruction = buildGeminiBlueprintSystemInstruction(BASE_BOY_INPUT);
    expect(sysInstruction).toContain('chłopiec (rodzaj męski)');
    expect(sysInstruction).toContain('Antosiu');
    expect(sysInstruction).toContain('EXACTLY 10 pages');
    expect(sysInstruction).toContain(PRINT_SAFETY_CLAUSE);

    const userPrompt = buildGeminiBlueprintUserPrompt(BASE_BOY_INPUT, 2);
    expect(userPrompt).toContain('Attached child reference photos: 2');
    expect(userPrompt).toContain('mała smoczyca Iskierka');

    const imgPrompt = buildGeminiImagePrompt({
      slot: 4,
      prompt: 'Magical woodland bridge scene',
      characterBible: bible,
      artStyle: 'watercolor',
      bookFormat: 'a4-landscape',
      hasReferencePhotos: true,
      hasCoverStyleAnchor: true,
    });
    expect(imgPrompt).toContain('PAGE 4');
    expect(imgPrompt).toContain('COVER STYLE ANCHOR');
    expect(imgPrompt).toContain(PRINT_SAFETY_CLAUSE);
  });
});

import {
  DEFAULT_PAGE_COUNT,
  MAX_PAGE_COUNT,
  MIN_PAGE_COUNT,
  StoryBlueprintSchema,
  type StoryBlueprint,
  type StoryInput,
  type StoryMood,
} from '@/lib/types/story';
import {
  declinePolishName,
  formatAgeAdjective,
  formatAgeYears,
  formatCompanionSentence,
  getPolishForms,
  normalizeCompanion,
} from '@/lib/polish/inflection';
import {
  ART_STYLE_META,
  STORY_MOOD_META,
  buildCharacterBible,
  buildCoverPrompt,
  buildPagePrompt,
} from '@/lib/polish/prompts';

export { ART_STYLE_META, STORY_MOOD_META };

// =============================================================================
// Theme Inspirations (6 Polish Story Ideas Mapped to Canonical StoryMood)
// 100% browser-safe (zero node:* imports)
// =============================================================================

export interface ThemeInspiration {
  readonly id: string;
  readonly label: string;
  readonly theme: string;
  readonly suggestedMood: StoryMood;
}

export const THEME_INSPIRATIONS: ReadonlyArray<ThemeInspiration> = [
  {
    id: 'lantern-forest',
    label: 'Las Złotych Latarni',
    theme: 'wyprawa do zaczarowanego lasu złotych latarni i poszukiwanie zagubionego klucza do krainy bajek',
    suggestedMood: 'magical-adventure',
  },
  {
    id: 'cloud-balloon',
    label: 'Balon ponad chmurami',
    theme: 'podróż kolorowym balonem ponad miękkimi chmurami w poszukiwaniu tęczowej wyspy marzeń',
    suggestedMood: 'funny-playful',
  },
  {
    id: 'secret-bakery',
    label: 'Cukiernia Leśnych Skrzatów',
    theme: 'odkrycie ukrytej cukierni leśnych skrzatów i upieczenie ciasta o smaku śmiechu i przyjaźni',
    suggestedMood: 'warm-cozy',
  },
  {
    id: 'starlight-train',
    label: 'Pociąg do Krainy Snów',
    theme: 'nocna podróż cichym pociągiem wśród srebrnych gwiazd ku spokojnej przystani dobrych snów',
    suggestedMood: 'bedtime-calm',
  },
  {
    id: 'coral-lighthouse',
    label: 'Tajemnica Latarni Morskiej',
    theme: 'wielka morska przygoda w starej latarni i odnalezienie zaginionej mapy śpiewających muszelek',
    suggestedMood: 'magical-adventure',
  },
  {
    id: 'clockwork-garden',
    label: 'Ogród Motyli z Papieru',
    theme: 'spacer po tajemniczym ogrodzie, w którym origami budzi się do życia i uczy odwagi oraz dobroci',
    suggestedMood: 'warm-cozy',
  },
];

// =============================================================================
// 12-Beat Narrative Architecture & Arc-Aware Demo Plate Mapping (1..12 Pages)
// =============================================================================

export type NarrativeBeatId =
  | 'opening'
  | 'threshold'
  | 'wonder'
  | 'guide'
  | 'riddle'
  | 'courage'
  | 'teamwork'
  | 'hiddenClearing'
  | 'climax'
  | 'celebration'
  | 'homewardPath'
  | 'bedtime';

const BEAT_DEMO_PLATE: Readonly<Record<NarrativeBeatId, number>> = {
  opening: 1,
  threshold: 2,
  wonder: 3,
  guide: 4,
  riddle: 5,
  courage: 6,
  teamwork: 7,
  hiddenClearing: 6,
  climax: 8,
  celebration: 9,
  homewardPath: 3,
  bedtime: 10,
};

export const BEAT_SELECTION_BY_PAGE_COUNT: Readonly<
  Record<number, ReadonlyArray<NarrativeBeatId>>
> = {
  4: ['opening', 'threshold', 'climax', 'bedtime'],
  5: ['opening', 'threshold', 'riddle', 'climax', 'bedtime'],
  6: ['opening', 'threshold', 'guide', 'courage', 'climax', 'bedtime'],
  7: ['opening', 'threshold', 'wonder', 'guide', 'courage', 'climax', 'bedtime'],
  8: ['opening', 'threshold', 'wonder', 'guide', 'riddle', 'courage', 'climax', 'bedtime'],
  9: [
    'opening',
    'threshold',
    'wonder',
    'guide',
    'riddle',
    'courage',
    'climax',
    'celebration',
    'bedtime',
  ],
  10: [
    'opening',
    'threshold',
    'wonder',
    'guide',
    'riddle',
    'courage',
    'teamwork',
    'climax',
    'celebration',
    'bedtime',
  ],
  11: [
    'opening',
    'threshold',
    'wonder',
    'guide',
    'riddle',
    'courage',
    'teamwork',
    'hiddenClearing',
    'climax',
    'celebration',
    'bedtime',
  ],
  12: [
    'opening',
    'threshold',
    'wonder',
    'guide',
    'riddle',
    'courage',
    'teamwork',
    'hiddenClearing',
    'climax',
    'celebration',
    'homewardPath',
    'bedtime',
  ],
};

function clampPageCount(raw: number): number {
  if (!Number.isFinite(raw)) {
    return DEFAULT_PAGE_COUNT;
  }
  return Math.min(MAX_PAGE_COUNT, Math.max(MIN_PAGE_COUNT, Math.floor(raw)));
}

/**
 * Resolves a demo art asset path strictly matching DEMO_ASSET_PATH_REGEX
 * and pointing exclusively to the 11 canonical M2 plates (`cover.jpg`, `page-01..10.jpg`).
 */
export function resolveDemoAssetPath(
  slot: 'cover' | number,
  totalPages?: number,
): string {
  if (slot === 'cover') {
    return '/demo-art/cover.jpg';
  }

  const pageNum = Math.max(1, Math.floor(slot));
  if (
    totalPages !== undefined &&
    Number.isInteger(totalPages) &&
    totalPages >= MIN_PAGE_COUNT &&
    totalPages <= MAX_PAGE_COUNT
  ) {
    const beats = BEAT_SELECTION_BY_PAGE_COUNT[totalPages];
    const beat = beats?.[pageNum - 1];
    if (beat) {
      const plate = BEAT_DEMO_PLATE[beat];
      return `/demo-art/page-${String(plate).padStart(2, '0')}.jpg`;
    }
  }

  const wrappedPlate = ((pageNum - 1) % 10) + 1;
  return `/demo-art/page-${String(wrappedPlate).padStart(2, '0')}.jpg`;
}

// =============================================================================
// Literary Polish Story Craft Engine
// =============================================================================

function capitalizeFirst(text: string): string {
  const chars = Array.from(text);
  if (chars.length === 0) {
    return text;
  }
  return chars[0].toLocaleUpperCase('pl-PL') + chars.slice(1).join('');
}

function truncateClean(value: string, maxLen: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLen) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxLen - 1)).trimEnd()}…`;
}

function truncatePreservingParagraphs(value: string, maxLen: number): string {
  const normalized = value
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter((paragraph) => paragraph.length > 0)
    .join('\n\n');
  if (normalized.length <= maxLen) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxLen - 1)).trimEnd()}…`;
}

function cleanThemeForProse(theme: string): string {
  return theme
    .replace(/\p{Cf}/gu, '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/g, '')
    .normalize('NFC');
}

function appendOptionalSentence(base: string, extra: string): string {
  return extra.length > 0 ? `${base} ${extra}` : base;
}

interface BeatContent {
  chapterTitle: string;
  text: string;
  sceneDescription: string;
}

interface MoodAtmosphere {
  openingCue: string;
  climaxGlow: string;
  closingWhisper: string;
  subtitleTag: string;
}

const MOOD_ATMOSPHERE: Readonly<Record<StoryMood, MoodAtmosphere>> = {
  'warm-cozy': {
    openingCue: 'ciepłym blaskiem popołudniowego słońca pachnącego cynamonem i papierem starych książek',
    climaxGlow: 'bursztynowe światło rozlało się łagodnie po całej polanie, jakby ktoś zapalił sto domowych lampek',
    closingWhisper: 'Ciepło tej opowieści otulało pokój niczym najmiększy wełniany koc',
    subtitleTag: 'Ciepła baśń pełna blasku i przyjaźni',
  },
  'magical-adventure': {
    openingCue: 'srebrzystym powiewem wiatru, który niósł ze sobą obietnicę nieznanych krain',
    climaxGlow: 'tysiąc złotych iskier zatańczyło w powietrzu, układając się w świetlistą koronę nad drzewami',
    closingWhisper: 'Za oknem gwiazdy mrugały porozumiewawczo, pamiętając każdy krok tej niezwykłej wyprawy',
    subtitleTag: 'Magiczna opowieść o odwadze i odkrywaniu świata',
  },
  'funny-playful': {
    openingCue: 'wesołym promykiem słońca, który łaskotał w nos i zapraszał do psotnej przygody',
    climaxGlow: 'powietrze wypełnił śmiech tak dźwięczny, że nawet stare drzewa zaszumiały z rozbawieniem',
    closingWhisper: 'W kącikach oczu wciąż tańczyły wesołe iskierki po dniu pełnym radosnych niespodzianek',
    subtitleTag: 'Pogodna, pełna śmiechu przygoda',
  },
  'bedtime-calm': {
    openingCue: 'cichym zmierzchem, w którym pierwsze gwiazdy zapalały na niebie delikatne lampiony',
    climaxGlow: 'aksamitna poświata księżyca otuliła cały świat kojącą melodią kołysanki',
    closingWhisper: 'Srebrny księżyc czuwał nad cichym pokojem, strzegąc najpiękniejszych snów aż do rana',
    subtitleTag: 'Spokojna opowieść na dobranoc pod gwiazdami',
  },
};

function buildBeatContent(
  beat: NarrativeBeatId,
  input: StoryInput,
  themeShort: string,
  themeMedium: string,
): BeatContent {
  const f = getPolishForms(input.gender);
  const name = declinePolishName(input.childName, input.gender);
  const ageYears = formatAgeYears(input.childAge);
  const ageAdj = formatAgeAdjective(input.childAge, input.gender);
  const mood = MOOD_ATMOSPHERE[input.mood];
  const companion = normalizeCompanion(input.companion);
  const compPath = formatCompanionSentence(companion, input.gender, 'path');
  const compWarmth = formatCompanionSentence(companion, input.gender, 'warmth');
  const compCircle = formatCompanionSentence(companion, input.gender, 'circle');
  const childWord = input.gender === 'girl' ? 'girl' : 'boy';
  const compScene = companion ? ` accompanied closely by ${truncateClean(companion, 70)}` : '';

  switch (beat) {
    case 'opening': {
      const demoGen = f.g('tej', 'tego');
      const base = `Pewnego dnia, kiedy pokój wypełniał się ${mood.openingCue}, ${name.nominative} ${f.verbs.paused} przy oknie i ${f.verbs.looked} na horyzont. Choć ${f.verbs.had} dopiero ${ageYears}, w sercu ${demoGen} ${f.adjectives.curiousGen} ${f.nouns.childGen} mieszkała wielka wyobraźnia. Właśnie wtedy ${f.verbs.noticed} na parapecie zwiniętą mapę z papieru czerpanego, na której widniał napis zapraszający w niezwykłą drogę: „${themeMedium}”.`;
      return {
        chapterTitle: 'Szept papierowej mapy',
        text: appendOptionalSentence(base, compWarmth),
        sceneDescription: `${name.nominative}, a ${input.childAge}-year-old ${childWord}${compScene}, standing by a sunlit wooden bedroom window holding an unfolded hand-drawn parchment map with tiny golden stars, cozy bookshelf and curtains fluttering softly.`,
      };
    }

    case 'threshold': {
      const base = `${name.nominative} ${f.verbs.took} mały plecak, ${f.verbs.opened} ogrodową furtkę i z bijącym sercem ${f.verbs.exited} prosto na ścieżkę usłaną złotymi liśćmi. Chłodny powiew musnął ${f.pronouns.poss} policzki, a tuż za zakrętem ukazała się brama spleciona z kwitnących gałęzi. ${capitalizeFirst(f.verbs.decided)} bez wahania zrobić pierwszy krok, bo ${f.verbs.knew}, że najpiękniejsze historie zaczynają się tuż za progiem.`;
      return {
        chapterTitle: 'Brama z kwitnących gałęzi',
        text: appendOptionalSentence(base, compPath),
        sceneDescription: `${name.nominative}${compScene} stepping gracefully through an archway woven from blooming branches and warm glowing vines onto a cobblestone woodland path leading into a wondrous realm themed around "${themeShort}".`,
      };
    }

    case 'wonder': {
      const enchanted = f.g('oczarowana', 'oczarowany');
      const base = `Gdy ${name.nominative} ${f.verbs.entered} głębiej w baśniową krainę, ${f.verbs.stopped} ${enchanted} światem jak z najpiękniejszego obrazu. Nad ścieżką kołysały się świetliste lampiony, a w krystalicznym strumieniu odbijały się chmury w kolorze miodu. ${capitalizeFirst(f.verbs.lookedAround)} z zachwytem i ${f.verbs.whispered}, że właśnie tak ${f.verbs.wanted} wyobrażać sobie przygodę: „${themeShort}”.`;
      return {
        chapterTitle: 'Dolina świetlistych lampionów',
        text: base,
        sceneDescription: `${name.nominative}${compScene} gazing in awe at a lush storybook valley filled with warm floating paper lanterns, a sparkling arched stone bridge over a clear brook, and painterly botanical details reflecting "${themeShort}".`,
      };
    }

    case 'guide': {
      const base = `Na omszałym kamieniu siedziała stara sowa w okularach z mosiądzu i bacznie przyglądała się ${f.nouns.childDat}. „Witaj, ${name.vocative}!” — odezwała się miękkim głosem. „Aby dotrzeć do serca tej krainy, potrzeba nie tylko szybkich nóg, ale i uważnego serca”. ${name.nominative} ${f.verbs.nodded} poważnie i ${f.verbs.listened} w każdą wskazówkę mądrej przewodniczki.`;
      return {
        chapterTitle: 'Spotkanie z mądrą sową',
        text: base,
        sceneDescription: `${name.nominative}${compScene} conversing warmly with a gentle barn owl wearing tiny brass spectacles perched on a mossy tree root, holding a folded parchment scroll amidst golden dappled light.`,
      };
    }

    case 'riddle': {
      const base = `Po chwili wędrówki droga rozdzieliła się na trzy kręte dróżki, a na rozstaju stał drogowskaz z zagadką wypisaną srebrną kredą. ${name.nominative} ${f.verbs.satDown} na chwilę na trawie, ${f.verbs.thought} spokojnie i ${f.verbs.noticed}, że na środkowej ścieżce świecą drobne ślady rosy ułożone w kształt uśmiechu. ${capitalizeFirst(f.verbs.smiled)} szeroko, bo ${f.verbs.understood}, że zagadkę rozwiązuje życzliwość i spostrzegawczość.`;
      return {
        chapterTitle: 'Zagadka na rozstaju dróg',
        text: appendOptionalSentence(base, compWarmth),
        sceneDescription: `${name.nominative}${compScene} pausing thoughtfully beside a whimsical wooden signpost at a forest crossroads where shimmering dewdrops softly illuminate the middle cobblestone trail.`,
      };
    }

    case 'courage': {
      const aheadPhrase = companion ? 'Przed nimi' : `Przed ${f.pronouns.ins}`;
      const recalled = f.g('przypomniała', 'przypomniał');
      const base = `${aheadPhrase} rozciągał się wiszący mostek nad mglistym wąwozem, w którym wiatr nucił głęboką pieśń. Przez ułamek sekundy ${name.nominative} ${f.verbs.felt} lekkie drżenie, lecz ${f.verbs.breathed} głęboko i ${recalled} sobie, jak ${f.adjectives.valiant} potrafi być. Krok za krokiem ${f.verbs.walked} pewnie naprzód, aż mgła ustąpiła przed ciepłym blaskiem drugiej strony.`;
      return {
        chapterTitle: 'Mostek małej odwagi',
        text: base,
        sceneDescription: `${name.nominative}${compScene} walking bravely across a charming wooden rope-and-plank footbridge draped in ivy over a soft misty gorge, warm golden sunbeams breaking through ahead.`,
      };
    }

    case 'teamwork': {
      const base = `Na polanie za mostkiem małe leśne stworzonka próbowały zebrać rozsypane świetliki z powrotem do szklanej latarni, ale światło uciekało im między łapkami. ${name.nominative} ${f.verbs.approached} cicho, ${f.verbs.laughed} serdecznie i ${f.verbs.brought} z plecaka kawałek miękkiej wstążki, aby wspólnie ustawić bezpieczną ścieżkę dla iskier. W grupie wszystko okazało się prostsze, a w powietrzu zapanowała prawdziwa radość.`;
      return {
        chapterTitle: 'Pomocna dłoń na polanie',
        text: appendOptionalSentence(base, compPath),
        sceneDescription: `${name.nominative}${compScene} happily helping friendly small woodland creatures (a hedgehog and a squirrel) gather glowing golden fireflies into a warm brass lantern in a sunlit meadow.`,
      };
    }

    case 'hiddenClearing': {
      const base = `Za kurtyną ze srebrnych wierzb ${name.nominative} ${f.verbs.discovered} ukrytą polanę, na której rosło drzewo o liściach przypominających małe kartki z pamiętnika. ${capitalizeFirst(f.verbs.touched)} delikatnie jednego z nich, a liść zadrżał jak struna harfy, wyświetlając w powietrzu obrazki z dotychczasowej podróży. ${capitalizeFirst(f.adjectives.amazed)} i ${f.adjectives.happy}, ${name.nominative} ${f.verbs.knew}, że jest już o krok od celu.`;
      return {
        chapterTitle: 'Drzewo szeptanych wspomnień',
        text: base,
        sceneDescription: `${name.nominative}${compScene} standing beneath an ancient willow tree in a hidden clearing whose translucent golden leaves shimmer softly like storybook pages in the gentle breeze.`,
      };
    }

    case 'climax': {
      const base = `W samym sercu krainy czekała tajemnicza szkatułka z rzeźbionego drewna, strzegąca skarbu całej opowieści: „${themeShort}”. ${name.nominative} ${f.verbs.reached} po nią pewnie, ${f.verbs.opened} wieko i ${f.verbs.saw}, jak ${mood.climaxGlow}. W tej niezwykłej chwili ${ageAdj} ${f.nouns.hero} ${f.verbs.understood}, że największą magią jest odwaga połączona z dobrym sercem.`;
      return {
        chapterTitle: 'Skarb złotego światła',
        text: appendOptionalSentence(base, compCircle),
        sceneDescription: `Climactic magical scene: ${name.nominative}${compScene} opening an intricately carved wooden keepsake box in an enchanted clearing as a radiant swirl of golden stardust and warm light rises into the sky, evoking "${themeShort}".`,
      };
    }

    case 'celebration': {
      const base = `Mieszkańcy całej krainy zebrali się na łące przy długim stole oświetlonym girlandami ciepłych światełek, by podziękować za dobroć i odwagę. ${name.nominative} ${f.verbs.was} ${f.adjectives.proud} i ${f.adjectives.smiling}, gdy wznoszono kubeczki z ciepłą herbatą malinową na cześć ${f.adjectives.braveGen} ${f.nouns.heroGen}. ${capitalizeFirst(f.verbs.thanked)} wszystkim serdecznie i ${f.verbs.hid} do kieszeni mały, świetlisty kamyk na pamiątkę tego dnia.`;
      return {
        chapterTitle: 'Święto pod girlandą gwiazd',
        text: appendOptionalSentence(base, compCircle),
        sceneDescription: `Joyful evening storybook celebration in a blooming meadow under warm string lanterns: ${name.nominative}${compScene} smiling warmly at a wooden picnic table with friendly woodland friends, holding a steaming mug of berry tea.`,
      };
    }

    case 'homewardPath': {
      const base = `Kiedy wieczorny wiatr zaczął kołysać trawami, ${name.nominative} ${f.verbs.waved} na pożegnanie swoim nowym przyjaciołom i ${f.verbs.setOff} łagodną ścieżką powrotną ku domowym światłom. W kieszeni wciąż delikatnie grzał świetlisty kamyk, przypominając o każdej pokonanej przeszkodzie. ${capitalizeFirst(f.verbs.promised)} sobie po cichu, że jeszcze nie raz powróci do krainy wyobraźni.`;
      return {
        chapterTitle: 'Ścieżka powrotna o zmierzchu',
        text: appendOptionalSentence(base, compPath),
        sceneDescription: `${name.nominative}${compScene} strolling peacefully along a softly lit twilight path lined with lavender and fireflies toward a warm glowing cottage window in the distance.`,
      };
    }

    case 'bedtime': {
      const base = `Gdy ${name.nominative} ${f.verbs.returned} do swojego przytulnego pokoju, ${f.verbs.placed} papierową mapę na stoliku nocnym i ${f.verbs.hugged} miękką poduszkę. ${mood.closingWhisper}. ${capitalizeFirst(f.adjectives.calm)} i ${f.adjectives.sleepy}, ${name.nominative} ${f.verbs.closed} oczy i z lekkim uśmiechem ${f.verbs.fellAsleep}, bo ${f.verbs.knew}, że jutro czeka kolejna piękna historia.`;
      return {
        chapterTitle: `Dobranoc, ${f.g('mała podróżniczko', 'mały podróżniku')}`,
        text: base,
        sceneDescription: `Peaceful moonlit bedroom ending scene: ${name.nominative}${compScene} tucked warmly under a quilted blanket asleep with a serene smile, the folded storybook map and a faintly glowing keepsake pebble resting on the bedside table under soft silver moonlight.`,
      };
    }
  }
}

export function buildPolishStoryDraft(input: StoryInput): StoryBlueprint {
  const pageCount = clampPageCount(input.pageCount);
  const normalizedInput: StoryInput = { ...input, pageCount };
  const f = getPolishForms(input.gender);
  const name = declinePolishName(input.childName, input.gender);
  const ageYears = formatAgeYears(input.childAge);
  const ageAdj = formatAgeAdjective(input.childAge, input.gender);
  const cleanedTheme = cleanThemeForProse(input.theme);
  const themeTitleSnippet = truncateClean(cleanedTheme, 72);
  const themeMediumSnippet = truncateClean(cleanedTheme, 150);
  const moodAtmo = MOOD_ATMOSPHERE[input.mood];
  const companion = normalizeCompanion(input.companion);

  const title = truncateClean(
    `${name.nominative} i tajemnica: ${themeTitleSnippet}`,
    160,
  );
  const subtitle = truncateClean(
    `${moodAtmo.subtitleTag} dla ${f.adjectives.braveGen} ${f.nouns.heroGen} (${ageYears})`,
    240,
  );

  const dedicationCore = [
    `${f.g('Kochana', 'Kochany')} ${name.vocative}!`,
    `Ta książka powstała specjalnie dla Ciebie — aby przypominała Ci, jak ${f.adjectives.brave}, ${f.adjectives.curious} i ${f.g('wspaniała', 'wspaniały')} jesteś każdego dnia.`,
    formatCompanionSentence(companion, input.gender, 'dedication'),
    'Niech ta historia zawsze przynosi Ci ciepło, zachwyt i piękne sny.',
  ]
    .filter((line) => line.length > 0)
    .join(' ');

  const dedicationFromClean = input.dedicationFrom?.replace(/\p{Cf}/gu, '').trim();
  const dedicationText = truncatePreservingParagraphs(
    dedicationFromClean
      ? `${dedicationCore}\n\nZ całą miłością — ${truncateClean(dedicationFromClean, 100)}`
      : dedicationCore,
    1200,
  );

  const companionBlurb = companion
    ? ` U boku ${name.genitive} nie zabraknie ważnej obecności (${truncateClean(companion, 80)}).`
    : '';
  const backCoverBlurb = truncateClean(
    `Kiedy ${ageAdj} ${name.nominative} odnajduje na parapecie tajemniczą mapę, zaczyna się niezapomniana podróż: ${themeMediumSnippet}.${companionBlurb} To ciepła, bogato ilustrowana książka o odwadze, dobroci i sile dziecięcej wyobraźni, stworzona z myślą o wspólnym czytaniu wieczorami.`,
    1200,
  );

  const characterBible = buildCharacterBible(normalizedInput);
  const coverPrompt = buildCoverPrompt(normalizedInput, characterBible, title);

  const beatIds = BEAT_SELECTION_BY_PAGE_COUNT[pageCount] ?? BEAT_SELECTION_BY_PAGE_COUNT[10];
  const pages = beatIds.map((beatId, index) => {
    const pageNumber = index + 1;
    const beat = buildBeatContent(
      beatId,
      normalizedInput,
      themeTitleSnippet,
      themeMediumSnippet,
    );
    const imagePrompt = buildPagePrompt({
      input: normalizedInput,
      characterBible,
      pageNumber,
      totalPages: pageCount,
      chapterTitle: beat.chapterTitle,
      sceneDescription: beat.sceneDescription,
    });

    return {
      pageNumber,
      chapterTitle: truncateClean(beat.chapterTitle, 160),
      text: truncateClean(beat.text, 2000),
      imagePrompt,
    };
  });

  return StoryBlueprintSchema.parse({
    title,
    subtitle,
    dedicationText,
    backCoverBlurb,
    characterBible,
    coverPrompt,
    pages,
  });
}

import type { ChildGender } from '@/lib/types/story';

// =============================================================================
// Polish Gender Inflection, Age Pluralization, Name Declension & Companion Utils
// 100% browser-safe (zero node:* imports)
// =============================================================================

export interface PolishNouns {
  child: string;
  childGen: string;
  childDat: string;
  childAcc: string;
  childIns: string;
  hero: string;
  heroGen: string;
  heroIns: string;
  explorer: string;
  traveler: string;
  dreamer: string;
  friend: string;
  guardian: string;
}

export interface PolishPronouns {
  subj: string;
  poss: string;
  dat: string;
  acc: string;
  ins: string;
  loc: string;
  /** Genitive pronoun after prepositions such as "obok", "dla", "do", "u" ("obok niej" / "obok niego"). */
  genPrep: string;
  self: string;
}

export interface PolishAdjectives {
  little: string;
  brave: string;
  curious: string;
  valiant: string;
  wise: string;
  smiling: string;
  delighted: string;
  amazed: string;
  ready: string;
  happy: string;
  proud: string;
  calm: string;
  kind: string;
  attentive: string;
  cheerful: string;
  sleepy: string;
  gentle: string;
  littleGen: string;
  braveGen: string;
  curiousGen: string;
}

export interface PolishPastVerbs {
  went: string;
  walked: string;
  entered: string;
  exited: string;
  approached: string;
  found: string;
  took: string;
  smiled: string;
  reached: string;
  fellAsleep: string;
  whispered: string;
  closed: string;
  touched: string;
  nodded: string;
  breathed: string;
  began: string;
  paused: string;
  could: string;
  carried: string;
  brought: string;
  was: string;
  had: string;
  wanted: string;
  knew: string;
  saw: string;
  heard: string;
  discovered: string;
  thought: string;
  said: string;
  asked: string;
  looked: string;
  opened: string;
  setOff: string;
  felt: string;
  noticed: string;
  decided: string;
  stopped: string;
  lookedAround: string;
  understood: string;
  returned: string;
  hugged: string;
  laughed: string;
  waved: string;
  satDown: string;
  thanked: string;
  listened: string;
  promised: string;
  placed: string;
  hid: string;
}

export interface PolishGenderForms {
  readonly gender: ChildGender;
  readonly g: <T = string>(girlForm: T, boyForm: T) => T;
  readonly nouns: Readonly<PolishNouns>;
  readonly pronouns: Readonly<PolishPronouns>;
  readonly adjectives: Readonly<PolishAdjectives>;
  readonly verbs: Readonly<PolishPastVerbs>;
}

export interface DeclinedPolishName {
  nominative: string;
  vocative: string;
  genitive: string;
}

export function g<T = string>(gender: ChildGender, girlForm: T, boyForm: T): T {
  return gender === 'girl' ? girlForm : boyForm;
}

const GIRL_FORMS: PolishGenderForms = {
  gender: 'girl',
  g: <T = string>(girlForm: T, _boyForm: T): T => {
    void _boyForm;
    return girlForm;
  },
  nouns: {
    child: 'dziewczynka',
    childGen: 'dziewczynki',
    childDat: 'dziewczynce',
    childAcc: 'dziewczynkę',
    childIns: 'dziewczynką',
    hero: 'bohaterka',
    heroGen: 'bohaterki',
    heroIns: 'bohaterką',
    explorer: 'odkrywczyni',
    traveler: 'podróżniczka',
    dreamer: 'marzycielka',
    friend: 'przyjaciółka',
    guardian: 'opiekunka',
  },
  pronouns: {
    subj: 'ona',
    poss: 'jej',
    dat: 'jej',
    acc: 'ją',
    ins: 'nią',
    loc: 'niej',
    genPrep: 'niej',
    self: 'sama',
  },
  adjectives: {
    little: 'mała',
    brave: 'odważna',
    curious: 'ciekawa',
    valiant: 'dzielna',
    wise: 'mądra',
    smiling: 'uśmiechnięta',
    delighted: 'zachwycona',
    amazed: 'zdziwiona',
    ready: 'gotowa',
    happy: 'szczęśliwa',
    proud: 'dumna',
    calm: 'spokojna',
    kind: 'dobra',
    attentive: 'uważna',
    cheerful: 'wesoła',
    sleepy: 'senna',
    gentle: 'łagodna',
    littleGen: 'małej',
    braveGen: 'odważnej',
    curiousGen: 'ciekawej',
  },
  verbs: {
    went: 'poszła',
    walked: 'szła',
    entered: 'weszła',
    exited: 'wyszła',
    approached: 'podeszła',
    found: 'znalazła',
    took: 'wzięła',
    smiled: 'uśmiechnęła się',
    reached: 'sięgnęła',
    fellAsleep: 'zasnęła',
    whispered: 'szepnęła',
    closed: 'zamknęła',
    touched: 'dotknęła',
    nodded: 'skinęła',
    breathed: 'odetchnęła',
    began: 'zaczęła',
    paused: 'stanęła',
    could: 'mogła',
    carried: 'niosła',
    brought: 'przyniosła',
    was: 'była',
    had: 'miała',
    wanted: 'chciała',
    knew: 'wiedziała',
    saw: 'zobaczyła',
    heard: 'usłyszała',
    discovered: 'odkryła',
    thought: 'pomyślała',
    said: 'powiedziała',
    asked: 'zapytała',
    looked: 'spojrzała',
    opened: 'otworzyła',
    setOff: 'ruszyła',
    felt: 'poczuła',
    noticed: 'zauważyła',
    decided: 'postanowiła',
    stopped: 'zatrzymała się',
    lookedAround: 'rozejrzała się',
    understood: 'zrozumiała',
    returned: 'wróciła',
    hugged: 'przytuliła',
    laughed: 'zaśmiała się',
    waved: 'pomachała',
    satDown: 'usiadła',
    thanked: 'podziękowała',
    listened: 'wsłuchała się',
    promised: 'obiecała',
    placed: 'położyła',
    hid: 'schowała',
  },
};

const BOY_FORMS: PolishGenderForms = {
  gender: 'boy',
  g: <T = string>(_girlForm: T, boyForm: T): T => {
    void _girlForm;
    return boyForm;
  },
  nouns: {
    child: 'chłopiec',
    childGen: 'chłopca',
    childDat: 'chłopcu',
    childAcc: 'chłopca',
    childIns: 'chłopcem',
    hero: 'bohater',
    heroGen: 'bohatera',
    heroIns: 'bohaterem',
    explorer: 'odkrywca',
    traveler: 'podróżnik',
    dreamer: 'marzyciel',
    friend: 'przyjaciel',
    guardian: 'opiekun',
  },
  pronouns: {
    subj: 'on',
    poss: 'jego',
    dat: 'mu',
    acc: 'go',
    ins: 'nim',
    loc: 'nim',
    genPrep: 'niego',
    self: 'sam',
  },
  adjectives: {
    little: 'mały',
    brave: 'odważny',
    curious: 'ciekawy',
    valiant: 'dzielny',
    wise: 'mądry',
    smiling: 'uśmiechnięty',
    delighted: 'zachwycony',
    amazed: 'zdziwiony',
    ready: 'gotowy',
    happy: 'szczęśliwy',
    proud: 'dumny',
    calm: 'spokojny',
    kind: 'dobry',
    attentive: 'uważny',
    cheerful: 'wesoły',
    sleepy: 'senny',
    gentle: 'łagodny',
    littleGen: 'małego',
    braveGen: 'odważnego',
    curiousGen: 'ciekawego',
  },
  verbs: {
    went: 'poszedł',
    walked: 'szedł',
    entered: 'wszedł',
    exited: 'wyszedł',
    approached: 'podszedł',
    found: 'znalazł',
    took: 'wziął',
    smiled: 'uśmiechnął się',
    reached: 'sięgnął',
    fellAsleep: 'zasnął',
    whispered: 'szepnął',
    closed: 'zamknął',
    touched: 'dotknął',
    nodded: 'skinął',
    breathed: 'odetchnął',
    began: 'zaczął',
    paused: 'stanął',
    could: 'mógł',
    carried: 'niósł',
    brought: 'przyniósł',
    was: 'był',
    had: 'miał',
    wanted: 'chciał',
    knew: 'wiedział',
    saw: 'zobaczył',
    heard: 'usłyszał',
    discovered: 'odkrył',
    thought: 'pomyślał',
    said: 'powiedział',
    asked: 'zapytał',
    looked: 'spojrzał',
    opened: 'otworzył',
    setOff: 'ruszył',
    felt: 'poczuł',
    noticed: 'zauważył',
    decided: 'postanowił',
    stopped: 'zatrzymał się',
    lookedAround: 'rozejrzał się',
    understood: 'zrozumiał',
    returned: 'wrócił',
    hugged: 'przytulił',
    laughed: 'zaśmiał się',
    waved: 'pomachał',
    satDown: 'usiadł',
    thanked: 'podziękował',
    listened: 'wsłuchał się',
    promised: 'obiecał',
    placed: 'położył',
    hid: 'schował',
  },
};

export function getPolishForms(gender: ChildGender): PolishGenderForms {
  return gender === 'girl' ? GIRL_FORMS : BOY_FORMS;
}

// =============================================================================
// 3-Way Slavic Age Pluralization
// =============================================================================

function normalizeAgeInt(age: number): number {
  return Number.isFinite(age) ? Math.max(0, Math.floor(age)) : 0;
}

export function formatAgeYears(age: number): string {
  const n = normalizeAgeInt(age);
  if (n === 1) {
    return '1 rok';
  }
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) {
    return `${n} lata`;
  }
  return `${n} lat`;
}

export function formatAgeAdjective(age: number, gender: ChildGender): string {
  const n = normalizeAgeInt(age);
  if (n === 0) {
    return g(gender, 'maleńka', 'maleńki');
  }
  if (n === 1) {
    return g(gender, 'roczna', 'roczny');
  }
  return `${n}-${g(gender, 'letnia', 'letni')}`;
}

// =============================================================================
// Curated Polish Name Declension (Vocative + Genitive) + Safe Fallback
// =============================================================================

type DeclensionPair = readonly [vocative: string, genitive: string];

const FEMALE_NAMES: Readonly<Record<string, DeclensionPair>> = {
  zosia: ['Zosiu', 'Zosi'],
  zofia: ['Zofio', 'Zofii'],
  maja: ['Maju', 'Mai'],
  hania: ['Haniu', 'Hani'],
  hanna: ['Hanno', 'Hanny'],
  zuzia: ['Zuziu', 'Zuzi'],
  zuzanna: ['Zuzanno', 'Zuzanny'],
  lena: ['Leno', 'Leny'],
  lenka: ['Lenko', 'Lenki'],
  pola: ['Polu', 'Poli'],
  oliwia: ['Oliwio', 'Oliwii'],
  alicja: ['Alicjo', 'Alicji'],
  ala: ['Alu', 'Ali'],
  klara: ['Klaro', 'Klary'],
  julia: ['Julio', 'Julii'],
  julka: ['Julko', 'Julki'],
  laura: ['Lauro', 'Laury'],
  maria: ['Mario', 'Marii'],
  marysia: ['Marysiu', 'Marysi'],
  anna: ['Anno', 'Anny'],
  ania: ['Aniu', 'Ani'],
  amelia: ['Amelio', 'Amelii'],
  amelka: ['Amelko', 'Amelki'],
  emilia: ['Emilio', 'Emilii'],
  emilka: ['Emilko', 'Emilki'],
  gabrysia: ['Gabrysiu', 'Gabrysi'],
  gabriela: ['Gabrielo', 'Gabrieli'],
  helena: ['Heleno', 'Heleny'],
  helenka: ['Helenko', 'Helenki'],
  iga: ['Igo', 'Igi'],
  antonina: ['Antonino', 'Antoniny'],
  tosia: ['Tosiu', 'Tosi'],
  nina: ['Nino', 'Niny'],
  kasia: ['Kasiu', 'Kasi'],
  katarzyna: ['Katarzyno', 'Katarzyny'],
  basia: ['Basiu', 'Basi'],
  barbara: ['Barbaro', 'Barbary'],
  marta: ['Marto', 'Marty'],
  natalia: ['Natalio', 'Natalii'],
  natalka: ['Natalko', 'Natalki'],
  wiktoria: ['Wiktorio', 'Wiktorii'],
  kornelia: ['Kornelio', 'Kornelii'],
  łucja: ['Łucjo', 'Łucji'],
  róża: ['Różo', 'Róży'],
  liliana: ['Liliano', 'Liliany'],
  lila: ['Lilu', 'Lili'],
  lilka: ['Lilko', 'Lilki'],
  michalina: ['Michalino', 'Michaliny'],
  misia: ['Misiu', 'Misi'],
  ola: ['Olu', 'Oli'],
  aleksandra: ['Aleksandro', 'Aleksandry'],
  karolina: ['Karolino', 'Karoliny'],
  jagoda: ['Jagodo', 'Jagody'],
  blanka: ['Blanko', 'Blanki'],
  weronika: ['Weroniko', 'Weroniki'],
  martyna: ['Martyno', 'Martyny'],
  kalina: ['Kalino', 'Kaliny'],
  kaja: ['Kaju', 'Kai'],
  matylda: ['Matyldo', 'Matyldy'],
  milena: ['Mileno', 'Mileny'],
  ewa: ['Ewo', 'Ewy'],
  ada: ['Ado', 'Ady'],
  ida: ['Ido', 'Idy'],
  ula: ['Ulu', 'Uli'],
  urszula: ['Urszulo', 'Urszuli'],
  magda: ['Magdo', 'Magdy'],
  magdalena: ['Magdaleno', 'Magdaleny'],
  paulina: ['Paulino', 'Pauliny'],
  kinga: ['Kingo', 'Kingi'],
  nela: ['Nelu', 'Neli'],
  rozalia: ['Rozalio', 'Rozalii'],
  sara: ['Saro', 'Sary'],
};

const MALE_NAMES: Readonly<Record<string, DeclensionPair>> = {
  antoś: ['Antosiu', 'Antosia'],
  antek: ['Antku', 'Antka'],
  antoni: ['Antoni', 'Antoniego'],
  jaś: ['Jasiu', 'Jasia'],
  janek: ['Janku', 'Janka'],
  jan: ['Janie', 'Jana'],
  franek: ['Franku', 'Franka'],
  franiu: ['Franiu', 'Frania'],
  franciszek: ['Franciszku', 'Franciszka'],
  leon: ['Leonie', 'Leona'],
  leoś: ['Leosiu', 'Leosia'],
  mikołaj: ['Mikołaju', 'Mikołaja'],
  kuba: ['Kubo', 'Kuby'],
  kubuś: ['Kubusiu', 'Kubusia'],
  jakub: ['Jakubie', 'Jakuba'],
  staś: ['Stasiu', 'Stasia'],
  stanisław: ['Stanisławie', 'Stanisława'],
  szymon: ['Szymonie', 'Szymona'],
  szymek: ['Szymku', 'Szymka'],
  tymek: ['Tymku', 'Tymka'],
  tymon: ['Tymonie', 'Tymona'],
  tymoteusz: ['Tymoteuszu', 'Tymoteusza'],
  wojtek: ['Wojtku', 'Wojtka'],
  wojciech: ['Wojciechu', 'Wojciecha'],
  adam: ['Adamie', 'Adama'],
  adaś: ['Adasiu', 'Adasia'],
  filip: ['Filipie', 'Filipa'],
  kacper: ['Kacprze', 'Kacpra'],
  michał: ['Michale', 'Michała'],
  aleksander: ['Aleksandrze', 'Aleksandra'],
  olek: ['Olku', 'Olka'],
  nikodem: ['Nikodemie', 'Nikodema'],
  oliwier: ['Oliwierze', 'Oliwiera'],
  ignacy: ['Ignacy', 'Ignacego'],
  igor: ['Igorze', 'Igora'],
  maksymilian: ['Maksymilianie', 'Maksymiliana'],
  maks: ['Maksie', 'Maksa'],
  marcel: ['Marcelu', 'Marcela'],
  oskar: ['Oskarze', 'Oskara'],
  wiktor: ['Wiktorze', 'Wiktora'],
  miłosz: ['Miłoszu', 'Miłosza'],
  piotr: ['Piotrze', 'Piotra'],
  piotruś: ['Piotrusiu', 'Piotrusia'],
  paweł: ['Pawle', 'Pawła'],
  mateusz: ['Mateuszu', 'Mateusza'],
  bartek: ['Bartku', 'Bartka'],
  bartosz: ['Bartoszu', 'Bartosza'],
  tomek: ['Tomku', 'Tomka'],
  tomasz: ['Tomaszu', 'Tomasza'],
  krzyś: ['Krzysiu', 'Krzysia'],
  krzysztof: ['Krzysztofie', 'Krzysztofa'],
  julian: ['Julianie', 'Juliana'],
  julek: ['Julku', 'Julka'],
  henio: ['Heniu', 'Henia'],
  henryk: ['Henryku', 'Henryka'],
  borys: ['Borysie', 'Borysa'],
  dawid: ['Dawidzie', 'Dawida'],
  alan: ['Alanie', 'Alana'],
  karol: ['Karolu', 'Karola'],
  kamil: ['Kamilu', 'Kamila'],
  maciek: ['Maćku', 'Maćka'],
  maciej: ['Macieju', 'Macieja'],
  grześ: ['Grzesiu', 'Grzesia'],
  grzegorz: ['Grzegorzu', 'Grzegorza'],
  hubert: ['Hubercie', 'Huberta'],
  krystian: ['Krystianie', 'Krystiana'],
  dominik: ['Dominiku', 'Dominika'],
  patryk: ['Patryku', 'Patryka'],
  eryk: ['Eryku', 'Eryka'],
  robert: ['Robercie', 'Roberta'],
  konrad: ['Konradzie', 'Konrada'],
  sebastian: ['Sebastianie', 'Sebastiana'],
  natan: ['Natanie', 'Natana'],
  gabriel: ['Gabrielu', 'Gabriela'],
  daniel: ['Danielu', 'Daniela'],
  olaf: ['Olafie', 'Olafa'],
  milan: ['Milanie', 'Milana'],
  kornel: ['Kornelu', 'Kornela'],
  cezary: ['Cezary', 'Cezarego'],
  ksawery: ['Ksawery', 'Ksawerego'],
  barnaba: ['Barnabo', 'Barnaby'],
};

const UNICODE_FORMAT_CHARS_REGEX = /\p{Cf}/gu;
const FOREIGN_CHARS_REGEX = /[qvx'’]/i;
const INDECLINABLE_ENDING_REGEX = /(?:[iyeou]|ya|ea|ua|oa)$/i;

function applyCasing(declined: string, original: string): string {
  const lowerOriginal = original.toLocaleLowerCase('pl-PL');
  const upperOriginal = original.toLocaleUpperCase('pl-PL');

  if (original === upperOriginal && original !== lowerOriginal) {
    return declined.toLocaleUpperCase('pl-PL');
  }
  if (original === lowerOriginal && original !== upperOriginal) {
    return declined.toLocaleLowerCase('pl-PL');
  }

  const chars = Array.from(declined);
  if (chars.length === 0) {
    return declined;
  }
  const origFirst = Array.from(original)[0] ?? '';
  const firstIsUpper =
    origFirst === origFirst.toLocaleUpperCase('pl-PL') &&
    origFirst !== origFirst.toLocaleLowerCase('pl-PL');

  const first = firstIsUpper
    ? chars[0].toLocaleUpperCase('pl-PL')
    : chars[0].toLocaleLowerCase('pl-PL');
  return first + chars.slice(1).join('').toLocaleLowerCase('pl-PL');
}

function declineSingleToken(token: string, gender: ChildGender): DeclinedPolishName {
  const lower = token.toLocaleLowerCase('pl-PL');
  const dict = gender === 'girl' ? FEMALE_NAMES : MALE_NAMES;
  const match = dict[lower];
  if (match) {
    return {
      nominative: token,
      vocative: applyCasing(match[0], token),
      genitive: applyCasing(match[1], token),
    };
  }

  // Foreign / indeclinable guard: preserve original unchanged rather than mangling.
  if (
    lower.length <= 3 ||
    FOREIGN_CHARS_REGEX.test(lower) ||
    INDECLINABLE_ENDING_REGEX.test(lower)
  ) {
    return { nominative: token, vocative: token, genitive: token };
  }

  if (gender === 'girl') {
    if (!lower.endsWith('a')) {
      return { nominative: token, vocative: token, genitive: token };
    }
    const stem = lower.slice(0, -1);

    // Soft diminutives -(s|z|c|n|dz)ia -> -iu / -i (e.g., Gosia -> Gosiu / Gosi)
    if (/(?:dz|[szcn])ia$/.test(lower)) {
      return {
        nominative: token,
        vocative: applyCasing(`${stem}u`, token),
        genitive: applyCasing(stem, token),
      };
    }

    // -ka / -ga -> -ko / -ki, -go / -gi
    if (lower.endsWith('ka') || lower.endsWith('ga')) {
      return {
        nominative: token,
        vocative: applyCasing(`${stem}o`, token),
        genitive: applyCasing(`${stem}i`, token),
      };
    }

    // -ia (after other consonant, e.g., Daria, Klaudia) -> -io / -ii
    if (lower.endsWith('ia')) {
      return {
        nominative: token,
        vocative: applyCasing(`${stem}o`, token),
        genitive: applyCasing(`${stem}i`, token),
      };
    }

    // -ja (e.g., Patrycja) -> -jo / -ji
    if (lower.endsWith('ja')) {
      return {
        nominative: token,
        vocative: applyCasing(`${stem}o`, token),
        genitive: applyCasing(`${stem}i`, token),
      };
    }

    // -la (e.g., Kamila, Izabela) -> -lo / -li
    if (lower.endsWith('la')) {
      return {
        nominative: token,
        vocative: applyCasing(`${stem}o`, token),
        genitive: applyCasing(`${stem}i`, token),
      };
    }

    // Regular hard-stem -a (e.g., Paulina, Dorota) -> -o / -y
    return {
      nominative: token,
      vocative: applyCasing(`${stem}o`, token),
      genitive: applyCasing(`${stem}y`, token),
    };
  }

  // Unlisted male names (length >= 4)
  const softMap: Readonly<Record<string, string>> = {
    ś: 'si',
    ź: 'zi',
    ć: 'ci',
    ń: 'ni',
  };
  const lastChar = lower.slice(-1);
  if (lastChar in softMap) {
    const softenedStem = lower.slice(0, -1) + softMap[lastChar];
    return {
      nominative: token,
      vocative: applyCasing(`${softenedStem}u`, token),
      genitive: applyCasing(`${softenedStem}a`, token),
    };
  }

  // -ek (not -iek) -> -ku / -ka (e.g., Marek -> Marku / Marka, Radek -> Radku / Radka)
  if (lower.endsWith('ek') && !lower.endsWith('iek') && lower.length >= 5) {
    const stem = lower.slice(0, -2);
    return {
      nominative: token,
      vocative: applyCasing(`${stem}ku`, token),
      genitive: applyCasing(`${stem}ka`, token),
    };
  }

  // Velar / soft-final consonants -> +u / +a (e.g., Dariusz, Błażej, Andrzej)
  if (/(?:sz|cz|rz|ch|[żjlkg])$/.test(lower)) {
    return {
      nominative: token,
      vocative: applyCasing(`${lower}u`, token),
      genitive: applyCasing(`${lower}a`, token),
    };
  }

  // Unfamiliar foreign endings (Liam, Ethan, Noah, etc.) -> preserve unchanged
  return { nominative: token, vocative: token, genitive: token };
}

export function declinePolishName(name: string, gender: ChildGender): DeclinedPolishName {
  const clean = name
    .replace(UNICODE_FORMAT_CHARS_REGEX, '')
    .trim()
    .replace(/\s+/g, ' ')
    .normalize('NFC');

  if (clean.length === 0) {
    return {
      nominative: g(gender, 'Bohaterka', 'Bohater'),
      vocative: g(gender, 'Bohaterko', 'Bohaterze'),
      genitive: g(gender, 'Bohaterki', 'Bohatera'),
    };
  }

  // Multi-word given names (e.g., "Jan Paweł")
  if (clean.includes(' ')) {
    const parts = clean.split(' ').map((part) => declinePolishName(part, gender));
    return {
      nominative: parts.map((p) => p.nominative).join(' '),
      vocative: parts.map((p) => p.vocative).join(' '),
      genitive: parts.map((p) => p.genitive).join(' '),
    };
  }

  // Hyphenated double-barreled names (e.g., "Anna-Maria", "Jan-Krzysztof")
  if (clean.includes('-')) {
    const parts = clean
      .split('-')
      .filter((segment) => segment.length > 0)
      .map((segment) => declineSingleToken(segment, gender));
    if (parts.length > 0) {
      return {
        nominative: parts.map((p) => p.nominative).join('-'),
        vocative: parts.map((p) => p.vocative).join('-'),
        genitive: parts.map((p) => p.genitive).join('-'),
      };
    }
  }

  return declineSingleToken(clean, gender);
}

// =============================================================================
// Case-Safe, Gender-Neutral Companion Apposition Helpers
// =============================================================================

export function normalizeCompanion(companion?: string): string | null {
  if (typeof companion !== 'string') {
    return null;
  }
  const cleaned = companion
    .replace(UNICODE_FORMAT_CHARS_REGEX, '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.,!;—–-]+$/g, '')
    .trim()
    .normalize('NFC');

  return cleaned.length > 0 ? cleaned : null;
}

export type CompanionAppositionVariant = 'path' | 'warmth' | 'circle' | 'dedication';

/**
 * Generates a natural Polish sentence weaving in the companion via Nominative apposition
 * and present-tense / gender-neutral framing so masculine ("rudy kotek Mruczek"),
 * feminine ("mała smoczyca Iskierka"), neuter, or plural phrases are always 100% grammatical.
 */
export function formatCompanionSentence(
  companion: string | undefined | null,
  gender: ChildGender,
  variant: CompanionAppositionVariant = 'path',
): string {
  const clean = normalizeCompanion(companion ?? undefined);
  if (!clean) {
    return '';
  }
  const f = getPolishForms(gender);

  switch (variant) {
    case 'path':
      return `Na ścieżce towarzyszy ${f.pronouns.dat} ${clean}, dodając otuchy w każdej chwili.`;
    case 'warmth':
      return `Obecność kogoś bliskiego (${clean}) dodała tej chwili jeszcze więcej ciepła.`;
    case 'circle':
      return `W kręgu złotego światła znalazło się honorowe miejsce dla kogoś ważnego — tuż obok ${f.pronouns.genPrep} jest ${clean}.`;
    case 'dedication':
      return `Niech w każdej przygodzie towarzyszy Ci uśmiech, odwaga oraz ${clean}.`;
  }
}

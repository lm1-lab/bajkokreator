import type { ArtStyle, BookFormat, StoryInput, StoryMood } from '@/lib/types/story';
import { getThemeById } from '@/lib/catalog/themes';
import {
  declinePolishName,
  formatAgeAdjective,
  formatAgeYears,
  getPolishForms,
  normalizeCompanion,
} from '@/lib/polish/inflection';

// =============================================================================
// Shared Style & Mood Metadata + English Character Bible & Prompt Builders
// 100% browser-safe (zero node:* imports)
// =============================================================================

export interface ArtStyleMeta {
  readonly label: string;
  readonly description: string;
  readonly promptLock: string;
}

export interface StoryMoodMeta {
  readonly label: string;
  readonly description: string;
  readonly lightingHint: string;
}

export const ART_STYLE_META: Readonly<Record<ArtStyle, ArtStyleMeta>> = {
  watercolor: {
    label: 'Klasyczna akwarela',
    description: 'Delikatne, ręcznie malowane plamy akwareli na ciepłym papierze bawełnianym z miękkim konturem piórka.',
    promptLock:
      'traditional European picture-book watercolor on warm textured cotton paper, delicate sepia ink outlines, soft pigment blooms, hand-painted gouache highlights, rich editorial warmth',
  },
  'storybook-gouache': {
    label: 'Gwasz książkowy',
    description: 'Nasycone, aksamitne pociągnięcia pędzla w stylu klasycznych albumów dla dzieci z głębokim światłocieniem.',
    promptLock:
      'lush hand-painted matte storybook gouache illustration, visible soft brush texture, deep botanical greens and honey golds, cozy classic European children-book illustration craft',
  },
  'vintage-etching': {
    label: 'Rycina i kredki',
    description: 'Szlachetny rysunek kredką i delikatnym kreskowaniem jak w dawnych baśniach wydawanych w płóciennej oprawie.',
    promptLock:
      'vintage heirloom storybook illustration combining fine cross-hatched colored pencil, warm ink linework, and translucent ochre-and-indigo washes on cream archival paper',
  },
  'paper-cutout': {
    label: 'Papierowa wycinanka',
    description: 'Warstwowe kolaże z ręcznie wycinanego papieru czerpanego z miękkim cieniem rzucanym między planami.',
    promptLock:
      'tactile layered handmade paper-cutout diorama illustration, deckle-edge textured craft papers, subtle natural drop shadows between depth layers, warm storybook palette',
  },
};

export const STORY_MOOD_META: Readonly<Record<StoryMood, StoryMoodMeta>> = {
  'warm-cozy': {
    label: 'Ciepły i przytulny',
    description: 'Złote światło lampki, miękkie koce, bezpieczna atmosfera i czułe odkrycia.',
    lightingHint:
      'warm golden-hour sunlight, amber lantern glow, honeyed cream highlights, soft comforting shadows',
  },
  'magical-adventure': {
    label: 'Magiczna przygoda',
    description: 'Świetliste ścieżki, tajemnicze bramy i radosne poczucie wielkiego odkrycia.',
    lightingHint:
      'luminous twilight sky with floating golden fireflies, emerald and sapphire depth, enchanted rim lighting',
  },
  'funny-playful': {
    label: 'Wesoły i figlarny',
    description: 'Pełen śmiechu, zabawnych zwrotów akcji i pogodnych kolorów słonecznego dnia.',
    lightingHint:
      'bright cheerful morning sunlight, playful warm coral and sky-blue accents, lively airy atmosphere',
  },
  'bedtime-calm': {
    label: 'Spokojny na dobranoc',
    description: 'Wyciszający rytm wieczornej opowieści pod księżycem i srebrzystymi gwiazdami.',
    lightingHint:
      'serene moonlit indigo and soft lavender dusk, warm bedside candlelit glow, gentle dreamy stillness',
  },
};

export const PRINT_SAFETY_CLAUSE =
  'full-bleed storybook illustration, no text, no letters, no watermarks, no borders';

const MAX_PROMPT_LENGTH = 3900;

function clampSnippet(text: string, maxLen: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLen) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxLen - 1)).trimEnd()}…`;
}

function finalizePrompt(sections: readonly string[]): string {
  const joined = sections.filter((section) => section.trim().length > 0).join('\n');
  if (joined.length <= MAX_PROMPT_LENGTH) {
    return joined;
  }

  const safetyTag = `[PRINT SAFETY] ${PRINT_SAFETY_CLAUSE}`;
  const budget = MAX_PROMPT_LENGTH - safetyTag.length - 4;
  const trimmedBody = joined.slice(0, Math.max(1, budget)).trimEnd();
  return `${trimmedBody}…\n${safetyTag}`;
}

export function buildCharacterBible(input: StoryInput): string {
  const style = ART_STYLE_META[input.artStyle];
  const mood = STORY_MOOD_META[input.mood];
  const genderWord = input.gender === 'girl' ? 'girl' : 'boy';
  const wardrobe =
    input.gender === 'girl'
      ? 'warm terracotta knitted cardigan over a cream linen dress, soft mustard scarf, brown leather ankle boots, small canvas satchel'
      : 'warm forest-green knitted sweater over a cream cotton shirt, soft ochre scarf, rolled corduroy trousers, sturdy brown boots, small canvas satchel';
  const companion = normalizeCompanion(input.companion);
  const companionLine = companion
    ? `Faithful storybook companion present across key scenes: "${clampSnippet(companion, 80)}", depicted with friendly expressive eyes and consistent proportions.`
    : 'No sidekick creature required unless the scene naturally includes gentle woodland wildlife in the background.';

  const parts = [
    `Protagonist: ${clampSnippet(input.childName, 60)}, a ${input.childAge}-year-old ${genderWord}.`,
    'Likeness lock: preserve exact facial proportions, eyes, nose, hair color, hairstyle, and warm natural smile from the uploaded child reference photo(s); adapt only into the storybook medium without copying the original photograph background.',
    `Invariant wardrobe across cover and every page: ${wardrobe}.`,
    companionLine,
    `Visual medium lock: ${style.promptLock}.`,
    `Palette and lighting lock: ${mood.lightingHint}.`,
  ];

  return clampSnippet(parts.join(' '), MAX_PROMPT_LENGTH);
}

export function buildCoverPrompt(
  input: StoryInput,
  characterBible: string,
  storyTitle?: string,
): string {
  const style = ART_STYLE_META[input.artStyle];
  const mood = STORY_MOOD_META[input.mood];
  const safeTheme = clampSnippet(input.theme, 240);
  const titleHint = storyTitle ? ` Inspired by the story "${clampSnippet(storyTitle, 120)}".` : '';
  const companion = normalizeCompanion(input.companion);
  const companionCue = companion
    ? ` Beside the child sits their companion (${clampSnippet(companion, 80)}).`
    : '';
  const catalogTheme = input.themeId ? getThemeById(input.themeId) : undefined;
  const hints = catalogTheme?.promptHints;
  const motifCue =
    hints?.seasonalMotifs && hints.seasonalMotifs.length > 0
      ? ` Subtle seasonal details: ${hints.seasonalMotifs.join(', ')}.`
      : '';
  const wardrobeCue = hints?.wardrobeHint
    ? ` Child seasonal attire: ${clampSnippet(hints.wardrobeHint, 160)}.`
    : '';
  const avoidCue =
    hints?.avoidMotifs && hints.avoidMotifs.length > 0
      ? ` Avoid visual elements: ${hints.avoidMotifs.join(', ')}.`
      : '';
  const lighting = hints?.lightingOverride
    ? `${hints.lightingOverride}; ${mood.lightingHint}`
    : mood.lightingHint;

  return finalizePrompt([
    `[STYLE LOCK] ${style.promptLock}.`,
    `[CHARACTER BIBLE] ${clampSnippet(characterBible, 1500)}`,
    `[SCENE COMPOSITION] Enchanting front-cover key illustration featuring ${clampSnippet(input.childName, 60)} centered in the lower-middle foreground, looking forward with wonder toward the world of "${safeTheme}".${companionCue}${wardrobeCue}${motifCue}${titleHint}${avoidCue} Leave open, softly painted atmospheric sky or quiet painterly foliage in the upper third and gentle foreground margin at the bottom for print layout breathing room — do not render any letters or title text in the image.`,
    `[LIGHTING & MOOD] ${lighting}.`,
    `[PRINT SAFETY] ${PRINT_SAFETY_CLAUSE}.`,
  ]);
}

export interface BuildPagePromptOptions {
  input: StoryInput;
  characterBible: string;
  pageNumber: number;
  totalPages: number;
  chapterTitle: string;
  sceneDescription: string;
}

export function buildPagePrompt(opts: BuildPagePromptOptions): string {
  const { input, characterBible, pageNumber, totalPages, chapterTitle, sceneDescription } = opts;
  const style = ART_STYLE_META[input.artStyle];
  const mood = STORY_MOOD_META[input.mood];
  const catalogTheme = input.themeId ? getThemeById(input.themeId) : undefined;
  const hints = catalogTheme?.promptHints;
  const motifCue =
    hints?.seasonalMotifs && hints.seasonalMotifs.length > 0
      ? ` Seasonal atmosphere cues: ${hints.seasonalMotifs.join(', ')}.`
      : '';
  const lighting = hints?.lightingOverride
    ? `${hints.lightingOverride}; ${mood.lightingHint}`
    : mood.lightingHint;

  return finalizePrompt([
    `[STYLE LOCK] ${style.promptLock}. Maintain strict visual, brushwork, color-palette, and character continuity with the front cover illustration and uploaded reference photos.`,
    `[CHARACTER BIBLE] ${clampSnippet(characterBible, 1400)}`,
    `[SCENE COMPOSITION] Storybook page ${pageNumber} of ${totalPages} ("${clampSnippet(chapterTitle, 120)}"): ${clampSnippet(sceneDescription, 700)}${motifCue}`,
    `[LIGHTING & MOOD] ${lighting}.`,
    `[PRINT SAFETY] ${PRINT_SAFETY_CLAUSE}.`,
  ]);
}

// =============================================================================
// DRY Prompt Builders for Gemini API & Google Subscription Adapters
// =============================================================================

export function buildGeminiBlueprintSystemInstruction(input: StoryInput): string {
  const f = getPolishForms(input.gender);
  const declined = declinePolishName(input.childName, input.gender);
  const ageYears = formatAgeYears(input.childAge);
  const ageAdj = formatAgeAdjective(input.childAge, input.gender);
  const genderLabelPl = input.gender === 'girl' ? 'dziewczynka (rodzaj żeński)' : 'chłopiec (rodzaj męski)';

  return [
    'You are an acclaimed Polish children-book author and art director crafting a print-ready personalized picture book for BajkoKreator.',
    'Return ONLY valid JSON conforming strictly to the provided JSON Schema (no markdown fences, no commentary).',
    `Write title, subtitle, dedicationText, backCoverBlurb, and every page chapterTitle & text in warm, lyrical, natural literary Polish.`,
    `GRAMMATICAL GENDER LOCK (${genderLabelPl}): Every verb, adjective, noun, and pronoun referring to the child MUST strictly agree with ${genderLabelPl}.`,
    `Mandatory Polish forms for this child: noun="${f.nouns.child}" (Gen: "${f.nouns.childGen}"), hero="${f.nouns.hero}", pronouns="${f.pronouns.subj}/${f.pronouns.poss}/${f.pronouns.dat}/${f.pronouns.genPrep}", adjectives="${f.adjectives.little}, ${f.adjectives.brave}, ${f.adjectives.curious}", past verbs="${f.verbs.went}, ${f.verbs.entered}, ${f.verbs.took}, ${f.verbs.smiled}, ${f.verbs.could}, ${f.verbs.fellAsleep}".`,
    `Child name declension: Nominative="${declined.nominative}", Vocative="${declined.vocative}", Genitive="${declined.genitive}". Age expressions: "${ageYears}", "${ageAdj}".`,
    `Generate EXACTLY ${input.pageCount} pages numbered sequentially from 1 to ${input.pageCount} with a cohesive 4-act narrative arc ending in a warm, reassuring conclusion.`,
    'Write characterBible, coverPrompt, and every page imagePrompt in rich descriptive ENGLISH.',
    `Every coverPrompt and page imagePrompt MUST include the tags [STYLE LOCK], [CHARACTER BIBLE], [SCENE COMPOSITION], [LIGHTING & MOOD], and end with [PRINT SAFETY] containing the exact clause: "${PRINT_SAFETY_CLAUSE}".`,
    'Keep all field lengths strictly within limits (title <= 160, subtitle <= 240, chapterTitle <= 160, text <= 2000, prompts <= 3900).',
  ].join('\n');
}

export function buildGeminiBlueprintUserPrompt(
  input: StoryInput,
  referencePhotoCount: number,
): string {
  const style = ART_STYLE_META[input.artStyle];
  const mood = STORY_MOOD_META[input.mood];
  const companion = normalizeCompanion(input.companion);
  const dedicationFrom = input.dedicationFrom?.trim();
  const baselineBible = buildCharacterBible(input);

  const lines = [
    `Child name: ${input.childName}`,
    `Child age: ${input.childAge} (${formatAgeYears(input.childAge)})`,
    `Gender: ${input.gender}`,
    `Story theme: ${input.theme}`,
    `Art style: ${input.artStyle} (${style.label})`,
    `Mood: ${input.mood} (${mood.label})`,
    `Exact page count: ${input.pageCount}`,
    companion
      ? `Companion (keep case-safe and gender-neutral in Polish): ${companion}`
      : 'Companion: none specified',
    dedicationFrom
      ? `Dedication signature from: ${dedicationFrom}`
      : 'Dedication signature: warm universal dedication for the child',
    referencePhotoCount > 0
      ? `Attached child reference photos: ${referencePhotoCount}. Inspect them carefully to describe accurate hair color/style, eye color, and facial traits in characterBible while ignoring the photo backgrounds.`
      : 'Attached child reference photos: 0.',
    `Baseline Character Bible to preserve and enrich: ${baselineBible}`,
  ];

  return lines.join('\n');
}

export interface BuildGeminiImagePromptOptions {
  slot: 'cover' | number;
  prompt: string;
  characterBible: string;
  artStyle: ArtStyle;
  bookFormat: BookFormat;
  hasReferencePhotos: boolean;
  hasCoverStyleAnchor: boolean;
}

export function buildGeminiImagePrompt(opts: BuildGeminiImagePromptOptions): string {
  const {
    slot,
    prompt,
    characterBible,
    artStyle,
    bookFormat,
    hasReferencePhotos,
    hasCoverStyleAnchor,
  } = opts;
  const style = ART_STYLE_META[artStyle];
  const formatHint =
    bookFormat === 'a4-landscape'
      ? 'Wide horizontal landscape picture-book spread composition (A4 landscape aspect).'
      : 'Balanced square 1:1 picture-book plate composition.';

  const groundingLines: string[] = [
    slot === 'cover'
      ? 'Generate the FRONT COVER storybook illustration.'
      : `Generate the interior storybook illustration for PAGE ${slot}.`,
    formatHint,
  ];

  if (hasReferencePhotos) {
    groundingLines.push(
      'Use the attached child reference photo(s) strictly for facial likeness, hair, and age accuracy; render naturally in the storybook art medium.',
    );
  }
  if (slot !== 'cover' && hasCoverStyleAnchor) {
    groundingLines.push(
      'Use the attached COVER STYLE ANCHOR image to keep identical art medium, brush/paper texture, color harmony, lighting feel, and protagonist wardrobe continuity across pages.',
    );
  }

  const normalizedPrompt = prompt.trim();
  const hasStyleTag = normalizedPrompt.includes('[STYLE LOCK]');
  const hasBibleTag = normalizedPrompt.includes('[CHARACTER BIBLE]');
  const hasSafety = normalizedPrompt
    .toLowerCase()
    .includes(PRINT_SAFETY_CLAUSE.toLowerCase());

  const sections: string[] = [groundingLines.join(' ')];
  if (!hasStyleTag) {
    sections.push(`[STYLE LOCK] ${style.promptLock}.`);
  }
  if (!hasBibleTag && characterBible.trim().length > 0) {
    sections.push(`[CHARACTER BIBLE] ${clampSnippet(characterBible, 1400)}`);
  }
  sections.push(normalizedPrompt);
  if (!hasSafety) {
    sections.push(`[PRINT SAFETY] ${PRINT_SAFETY_CLAUSE}.`);
  }

  return finalizePrompt(sections);
}

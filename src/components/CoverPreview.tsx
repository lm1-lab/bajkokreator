'use client';

import { declinePolishName, formatAgeYears } from '@/lib/polish/inflection';
import { ART_STYLE_META, STORY_MOOD_META } from '@/lib/polish/prompts';
import type {
  ArtStyle,
  BookFormat,
  ChildGender,
  StoryMood,
} from '@/lib/types/story';

interface CoverPreviewProps {
  childName: string;
  childAge: number;
  gender: ChildGender;
  companion: string;
  theme: string;
  artStyle: ArtStyle;
  mood: StoryMood;
  pageCount: number;
  bookFormat: BookFormat;
  photoPreviewUrl: string | null;
}

function formatPageCountPl(count: number): string {
  if (count === 1) return '1 strona';
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) {
    return `${count} strony`;
  }
  return `${count} stron`;
}

export function CoverPreview({
  childName,
  childAge,
  gender,
  companion,
  theme,
  artStyle,
  mood,
  pageCount,
  bookFormat,
  photoPreviewUrl,
}: CoverPreviewProps) {
  const displayName = childName.trim() || (gender === 'girl' ? 'Zosia' : 'Staś');
  const declined = declinePolishName(displayName, gender);
  const styleMeta = ART_STYLE_META[artStyle];
  const moodMeta = STORY_MOOD_META[mood];
  const cleanTheme =
    theme.trim() || 'Wyprawa do zaczarowanego lasu złotych latarni';
  const shortTheme =
    cleanTheme.length > 72 ? `${cleanTheme.slice(0, 69).trimEnd()}…` : cleanTheme;

  return (
    <aside
      className="cover-mockup"
      data-testid="live-cover-preview"
      aria-label="Podgląd okładki na żywo"
    >
      <div className="cover-mockup-frame">
        <span className="cover-mockup-imprint">
          Pracownia BajkoKreator • Podgląd na żywo
        </span>

        <div className="cover-mockup-art">
          <img
            src="/demo-art/cover.jpg"
            alt={`Podgląd ilustracji okładkowej w stylu ${styleMeta.label}`}
          />
          {photoPreviewUrl && (
            <span
              className="cover-mockup-child-badge"
              title={`Zdjęcie dziecka: ${displayName}`}
            >
              <img src={photoPreviewUrl} alt={`Zdjęcie dziecka ${displayName}`} />
            </span>
          )}
        </div>

        <h2 className="cover-mockup-title">
          Wielka przygoda {declined.genitive}
        </h2>

        <p className="cover-mockup-sub">
          {shortTheme}
          {companion.trim() ? ` — razem z: ${companion.trim()}` : ''}
        </p>

        <div className="cover-mockup-meta">
          {displayName} ({formatAgeYears(childAge)}) • {formatPageCountPl(pageCount)} •{' '}
          {styleMeta.label} • {moodMeta.label} •{' '}
          {bookFormat === 'square' ? 'Kwadrat 21×21 cm' : 'A4 poziomy'}
        </div>
      </div>
    </aside>
  );
}

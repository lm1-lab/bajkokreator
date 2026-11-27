'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CoverPreview } from '@/components/CoverPreview';
import type { ProviderStatus } from '@/lib/ai/provider';
import { compressChildPhoto } from '@/lib/client-image';
import { estimateClientStoryCost } from '@/lib/cost-estimator';
import {
  getAllThemes,
  getEvergreenThemes,
  type ThemeCatalogItem,
} from '@/lib/catalog/themes';
import { ART_STYLE_META, STORY_MOOD_META } from '@/lib/polish/prompts';
import {
  ART_STYLES,
  DEFAULT_PAGE_COUNT,
  MAX_CHILD_AGE,
  MAX_PAGE_COUNT,
  MAX_REFERENCE_PHOTOS,
  MIN_CHILD_AGE,
  MIN_PAGE_COUNT,
  STORY_MOODS,
  type ArtStyle,
  type BookFormat,
  type ChildGender,
  type DailyQuotaStatus,
  type ProviderId,
  type RuntimeSettings,
  type StoryMood,
} from '@/lib/types/story';

interface PhotoItem {
  id: string;
  file: File;
  previewUrl: string;
}

interface CreatorStudioProps {
  initialSettings: RuntimeSettings;
  providers: ProviderStatus[];
  quota: DailyQuotaStatus;
  themeInspirations?: readonly ThemeCatalogItem[];
}

export function CreatorStudio({
  initialSettings,
  providers,
  quota,
  themeInspirations,
}: CreatorStudioProps) {
  const router = useRouter();
  const activeThemes =
    themeInspirations && themeInspirations.length > 0
      ? themeInspirations
      : getEvergreenThemes();
  const [showAllThemes, setShowAllThemes] = useState(false);
  const displayedThemes = useMemo(
    () => (showAllThemes ? getAllThemes() : activeThemes),
    [showAllThemes, activeThemes],
  );
  const initialThemeItem = activeThemes[0];

  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [childName, setChildName] = useState('');
  const [childAge, setChildAge] = useState<number>(5);
  const [gender, setGender] = useState<ChildGender>('girl');
  const [companion, setCompanion] = useState('');
  const [selectedThemeId, setSelectedThemeId] = useState<string | undefined>(
    initialThemeItem?.id,
  );
  const [theme, setTheme] = useState(initialThemeItem.theme);
  const [artStyle, setArtStyle] = useState<ArtStyle>(
    initialThemeItem.suggestedArtStyle ?? 'watercolor',
  );
  const [mood, setMood] = useState<StoryMood>(
    initialThemeItem.suggestedMood ?? 'warm-cozy',
  );
  const [pageCount, setPageCount] = useState<number>(DEFAULT_PAGE_COUNT);
  const [dedicationFrom, setDedicationFrom] = useState('');
  const [bookFormat, setBookFormat] = useState<BookFormat>(
    initialSettings.defaultBookFormat,
  );
  const [provider, setProvider] = useState<ProviderId>(
    initialSettings.activeProvider,
  );
  const [previewFirst, setPreviewFirst] = useState<boolean>(
    initialSettings.defaultPreviewFirst,
  );

  const [isCompressing, setIsCompressing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const previewUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    const urls = previewUrlsRef.current;
    return () => {
      for (const url of urls) {
        URL.revokeObjectURL(url);
      }
    };
  }, []);

  const costEstimate = useMemo(
    () =>
      estimateClientStoryCost({
        provider,
        pageCount,
        generationMode: previewFirst ? 'preview-first' : 'full',
        imageModel: initialSettings.imageModel,
      }),
    [provider, pageCount, previewFirst, initialSettings.imageModel],
  );

  const activeProviderStatus = useMemo(
    () => providers.find((p) => p.id === provider),
    [providers, provider],
  );

  async function handleIncomingFiles(fileList: FileList | File[]) {
    const incoming = Array.from(fileList);
    if (incoming.length === 0) return;

    setErrorMessage(null);
    setIsCompressing(true);

    try {
      if (incoming.length > MAX_REFERENCE_PHOTOS) {
        setErrorMessage(
          `Możesz dodać maksymalnie ${MAX_REFERENCE_PHOTOS} zdjęcia dziecka. Wybrano ${incoming.length} — zachowano pierwsze ${MAX_REFERENCE_PHOTOS}.`,
        );
      }

      const slice = incoming.slice(0, MAX_REFERENCE_PHOTOS);
      const compressed: PhotoItem[] = [];

      for (let i = 0; i < slice.length; i += 1) {
        const result = await compressChildPhoto(slice[i]);
        previewUrlsRef.current.push(result.previewUrl);
        compressed.push({
          id: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`,
          file: result.file,
          previewUrl: result.previewUrl,
        });
      }

      setPhotos(compressed);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Nie udało się przetworzyć wybranego pliku obrazu.';
      setErrorMessage(msg);
    } finally {
      setIsCompressing(false);
    }
  }

  function removePhoto(id: string) {
    setPhotos((prev) => prev.filter((item) => item.id !== id));
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrorMessage(null);

    if (photos.length === 0) {
      setErrorMessage('Dodaj co najmniej 1 zdjęcie dziecka (maksymalnie 4).');
      return;
    }

    const trimmedName = childName.trim();
    if (!trimmedName) {
      setErrorMessage('Podaj imię dziecka, aby spersonalizować bajkę.');
      return;
    }

    const trimmedTheme = theme.trim();
    if (trimmedTheme.length < 3) {
      setErrorMessage('Wpisz temat przygody (co najmniej 3 znaki) lub wybierz inspirację.');
      return;
    }

    setIsSubmitting(true);
    try {
      const payload = {
        childName: trimmedName,
        childAge: Number(childAge),
        gender,
        companion: companion.trim() || undefined,
        theme: trimmedTheme,
        ...(selectedThemeId ? { themeId: selectedThemeId } : {}),
        artStyle,
        mood,
        pageCount: Number(pageCount),
        dedicationFrom: dedicationFrom.trim() || undefined,
        provider,
        generationMode: previewFirst ? 'preview-first' : 'full',
        bookFormat,
      };

      const formData = new FormData();
      formData.append('payload', JSON.stringify(payload));
      for (const item of photos) {
        formData.append('photos', item.file, item.file.name);
      }

      const res = await fetch('/api/stories', {
        method: 'POST',
        body: formData,
      });

      const data = (await res.json()) as {
        story?: { id: string };
        error?: string;
        issues?: Array<{ message: string }>;
      };

      if (!res.ok || !data.story?.id) {
        const firstIssue = data.issues?.[0]?.message;
        setErrorMessage(
          firstIssue || data.error || 'Nie udało się wygenerować bajki.',
        );
        return;
      }

      router.push(`/story/${data.story.id}?slide=0`);
    } catch {
      setErrorMessage('Błąd połączenia z serwerem podczas tworzenia bajki.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div>
      <section className="page-intro">
        <span className="eyebrow">Pracownia ilustrowanych książek</span>
        <h1 className="page-title">Stwórz spersonalizowaną bajkę dla swojego dziecka</h1>
        <p className="page-lead">
          Wgraj 1–4 zdjęcia bohatera, wybierz nastrój oraz styl ilustracji. W kilka chwil
          otrzymasz 10-stronicową książeczkę po polsku z dedykacją i gotowym drukiem PDF
          (Kwadrat 21×21 cm lub A4 poziomy).
        </p>
      </section>

      <div className="studio-grid">
        <form className="studio-form" onSubmit={handleSubmit} noValidate>
          {/* 1. Zdjęcia dziecka */}
          <section className="paper-card">
            <h2 className="section-heading">1. Zdjęcia dziecka (1–4)</h2>
            <p className="section-note">
              Zdjęcia są kompresowane w Twojej przeglądarce przed wysłaniem. Pierwsze zdjęcie
              trafia w ozdobnej ramce na stronę z dedykacją oraz służy jako referencja twarzy
              w trybie Gemini API.
            </p>
            <p
              className="rodo-privacy-note"
              data-testid="rodo-privacy-notice"
            >
              <strong>Ochrona prywatności (RODO):</strong> zdjęcia dziecka służą wyłącznie do
              stworzenia tej książki i możesz je trwale usunąć jednym kliknięciem w podglądzie
              bajki po jej wygenerowaniu.
            </p>

            <div
              className={`dropzone${isDragging ? ' is-dragging' : ''}`}
              onDragOver={(ev) => {
                ev.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(ev) => {
                ev.preventDefault();
                setIsDragging(false);
                void handleIncomingFiles(ev.dataTransfer.files);
              }}
            >
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                className="dropzone-input"
                data-testid="photo-input"
                aria-label="Dodaj od 1 do 4 zdjęć dziecka"
                onChange={(ev) => {
                  if (ev.target.files) {
                    void handleIncomingFiles(ev.target.files);
                  }
                }}
              />
              <p className="dropzone-title">
                {isCompressing
                  ? 'Kompresowanie zdjęć…'
                  : 'Przeciągnij i upuść zdjęcia dziecka lub kliknij, aby wybrać'}
              </p>
              <p className="dropzone-sub">
                Obsługiwane formaty: JPG, PNG, WebP • Wybrano: {photos.length} /{' '}
                {MAX_REFERENCE_PHOTOS}
              </p>
            </div>

            {photos.length > 0 && (
              <div className="photo-thumbs">
                {photos.map((item, idx) => (
                  <div className="photo-thumb" key={item.id}>
                    { }
                    <img
                      src={item.previewUrl}
                      alt={`Zdjęcie referencyjne ${idx + 1}`}
                    />
                    <button
                      type="button"
                      className="photo-thumb-remove"
                      onClick={() => removePhoto(item.id)}
                      aria-label={`Usuń zdjęcie ${idx + 1}`}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* 2. Bohater i towarzysz */}
          <section className="paper-card">
            <h2 className="section-heading">2. Bohater opowieści</h2>
            <p className="section-note">
              Dobierzemy poprawną polską odmianę imienia, czasowników i przymiotników dla
              dziewczynki lub chłopca.
            </p>

            <div className="field-grid">
              <div className="field-group">
                <label className="field-label" htmlFor="childName">
                  Imię dziecka
                </label>
                <input
                  id="childName"
                  type="text"
                  className="field-input"
                  placeholder="np. Zosia, Antoś, Staś"
                  value={childName}
                  onChange={(e) => setChildName(e.target.value)}
                  data-testid="child-name-input"
                  maxLength={60}
                  required
                />
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="childAge">
                  Wiek (1–12 lat)
                </label>
                <input
                  id="childAge"
                  type="number"
                  min={MIN_CHILD_AGE}
                  max={MAX_CHILD_AGE}
                  className="field-input"
                  value={childAge}
                  onChange={(e) =>
                    setChildAge(
                      Number.parseInt(e.target.value || '5', 10) || MIN_CHILD_AGE,
                    )
                  }
                  data-testid="child-age-input"
                />
              </div>

              <div className="field-group">
                <span className="field-label">Płeć (odmiana w tekście)</span>
                <div className="segmented" role="group" aria-label="Płeć dziecka">
                  <button
                    type="button"
                    className={`segmented-btn${gender === 'girl' ? ' is-active' : ''}`}
                    aria-pressed={gender === 'girl'}
                    onClick={() => setGender('girl')}
                    data-testid="gender-girl"
                  >
                    Dziewczynka
                  </button>
                  <button
                    type="button"
                    className={`segmented-btn${gender === 'boy' ? ' is-active' : ''}`}
                    aria-pressed={gender === 'boy'}
                    onClick={() => setGender('boy')}
                    data-testid="gender-boy"
                  >
                    Chłopiec
                  </button>
                </div>
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="companion">
                  Opcjonalny towarzysz przygód
                </label>
                <input
                  id="companion"
                  type="text"
                  className="field-input"
                  placeholder="np. rudy kotek Mruczek, pluszowy miś"
                  value={companion}
                  onChange={(e) => setCompanion(e.target.value)}
                  data-testid="companion-input"
                  maxLength={80}
                />
              </div>

              <div className="field-group full-span">
                <label className="field-label" htmlFor="dedicationFrom">
                  Podpis pod dedykacją (opcjonalnie)
                </label>
                <input
                  id="dedicationFrom"
                  type="text"
                  className="field-input"
                  placeholder="np. Mama i Tata, Babcia Krysia"
                  value={dedicationFrom}
                  onChange={(e) => setDedicationFrom(e.target.value)}
                  maxLength={100}
                />
              </div>
            </div>
          </section>

          {/* 3. Temat, styl i nastrój */}
          <section className="paper-card">
            <h2 className="section-heading">3. Temat, styl graficzny i nastrój</h2>
            <p className="section-note">
              Wpisz własny pomysł albo kliknij jedną z gotowych inspiracji.
            </p>

            <div className="field-group" style={{ marginBottom: 16 }}>
              <label className="field-label" htmlFor="storyTheme">
                Temat bajki
              </label>
              <textarea
                id="storyTheme"
                className="field-textarea"
                value={theme}
                onChange={(e) => {
                  setTheme(e.target.value);
                  setSelectedThemeId(undefined);
                }}
                data-testid="theme-input"
                maxLength={400}
              />
              <div className="chips-wrap" aria-label="Gotowe inspiracje tematów">
                {displayedThemes.map((insp) => {
                  const isActiveChip = selectedThemeId === insp.id || theme === insp.theme;
                  return (
                    <button
                      key={insp.id}
                      type="button"
                      className={`chip${insp.badge ? ' chip--seasonal' : ''}${isActiveChip ? ' is-active' : ''}`}
                      aria-pressed={isActiveChip}
                      data-testid="inspiration-chip"
                      data-season={insp.season}
                      onClick={() => {
                        setSelectedThemeId(insp.id);
                        setTheme(insp.theme);
                        setMood(insp.suggestedMood);
                        if (insp.suggestedArtStyle) {
                          setArtStyle(insp.suggestedArtStyle);
                        }
                      }}
                    >
                      {insp.badge ? (
                        <span className="chip-badge">{insp.badge}</span>
                      ) : null}
                      <span>{insp.label}</span>
                    </button>
                  );
                })}
                <button
                  type="button"
                  className="chip chip--toggle"
                  data-testid="toggle-all-themes-btn"
                  aria-expanded={showAllThemes}
                  onClick={() => setShowAllThemes((prev) => !prev)}
                >
                  {showAllThemes
                    ? 'Pokaż tylko aktualne motywy'
                    : `Wszystkie sezony (${getAllThemes().length})`}
                </button>
              </div>
            </div>

            <div className="field-group" style={{ marginBottom: 16 }}>
              <span className="field-label">Styl ilustracji (4 pracownie)</span>
              <div className="style-grid">
                {ART_STYLES.map((styleId) => {
                  const meta = ART_STYLE_META[styleId];
                  return (
                    <button
                      key={styleId}
                      type="button"
                      className={`style-card${artStyle === styleId ? ' is-active' : ''}`}
                      aria-pressed={artStyle === styleId}
                      onClick={() => setArtStyle(styleId)}
                      data-testid={`style-card-${styleId}`}
                    >
                      <span className="style-card-title">{meta.label}</span>
                      <span className="style-card-desc">{meta.description}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="field-group" style={{ marginBottom: 16 }}>
              <span className="field-label">Nastrój opowieści</span>
              <div className="mood-pills">
                {STORY_MOODS.map((moodId) => {
                  const meta = STORY_MOOD_META[moodId];
                  return (
                    <button
                      key={moodId}
                      type="button"
                      className={`mood-pill${mood === moodId ? ' is-active' : ''}`}
                      aria-pressed={mood === moodId}
                      onClick={() => setMood(moodId)}
                      data-testid={`mood-pill-${moodId}`}
                    >
                      {meta.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="field-grid">
              <div className="field-group">
                <label className="field-label" htmlFor="pageCount">
                  Liczba stron bajki ({MIN_PAGE_COUNT}–{MAX_PAGE_COUNT}, domyślnie 10)
                </label>
                <input
                  id="pageCount"
                  type="number"
                  min={MIN_PAGE_COUNT}
                  max={MAX_PAGE_COUNT}
                  className="field-input"
                  value={pageCount}
                  onChange={(e) =>
                    setPageCount(
                      Number.parseInt(e.target.value || '10', 10) || DEFAULT_PAGE_COUNT,
                    )
                  }
                  data-testid="page-count-input"
                />
                <span className="field-hint">
                  W PDF zawsze dochodzi okładka, dedykacja ze zdjęciem i tylna okładka (+3
                  strony).
                </span>
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="bookFormat">
                  Domyślny format druku PDF
                </label>
                <select
                  id="bookFormat"
                  className="field-select"
                  value={bookFormat}
                  onChange={(e) => setBookFormat(e.target.value as BookFormat)}
                >
                  <option value="square">Kwadrat 21×21 cm (klasyczna książeczka)</option>
                  <option value="a4-landscape">A4 poziomy (rozkładówka 29,7×21 cm)</option>
                </select>
              </div>
            </div>
          </section>

          {/* 4. Tryb AI i bezpieczniki kosztowe */}
          <section className="paper-card">
            <h2 className="section-heading">4. Tryb generowania AI i bezpieczniki</h2>
            <p className="section-note">
              Domyślny Tryb Demo działa natychmiast bez klucza API. Tryb Ręczny generuje
              angielskie prompty z „Biblią Postaci” pod Gemini / Nano Banana.
            </p>

            <div className="field-group" style={{ marginBottom: 14 }}>
              <label className="field-label" htmlFor="providerSelect">
                Dostawca AI
              </label>
              <select
                id="providerSelect"
                className="field-select"
                value={provider}
                onChange={(e) => setProvider(e.target.value as ProviderId)}
                data-testid="provider-select"
              >
                <option value="demo">Tryb Demo — natychmiastowe akwarele (0 zł, bez klucza)</option>
                <option value="manual">
                  Tryb Ręczny — scenariusz + prompty pod Nano Banana (0 zł)
                </option>
                <option value="gemini-api">
                  Google Gemini API (gemini-3.8-flash + gemini-nano-banana-2.1)
                </option>
                <option value="google-subscription">
                  Subskrypcja Google AI Pro/Ultra (adapter ~2 grudnia 2026)
                </option>
              </select>
              {activeProviderStatus && !activeProviderStatus.available && (
                <span className="field-hint" style={{ color: 'var(--terracotta-dark)' }}>
                  Uwaga: {activeProviderStatus.description}
                </span>
              )}
            </div>

            <label className="toggle-row" style={{ marginBottom: 14 }}>
              <input
                type="checkbox"
                checked={previewFirst}
                onChange={(e) => setPreviewFirst(e.target.checked)}
                data-testid="preview-first-toggle"
              />
              <span>
                <strong>Najpierw okładka + 1. strona na próbę</strong>
                <br />
                <span className="field-hint">
                  Oszczędza limit API — najpierw sprawdzisz wygląd bohatera i styl, a dopiero
                  potem dogenerujesz strony 2–{pageCount}.
                </span>
              </span>
            </label>

            <div className="cost-box" data-testid="cost-estimate">
              <div className="cost-row">
                <span>
                  <strong>Szacowany koszt teraz</strong> (
                  {costEstimate.imagesNow === 1
                    ? '1 obraz'
                    : costEstimate.imagesNow % 10 >= 2 &&
                        costEstimate.imagesNow % 10 <= 4 &&
                        !(
                          costEstimate.imagesNow % 100 >= 12 &&
                          costEstimate.imagesNow % 100 <= 14
                        )
                      ? `${costEstimate.imagesNow} obrazy`
                      : `${costEstimate.imagesNow} obrazów`}
                  )
                </span>
                <span className="cost-amount">
                  {costEstimate.isFree
                    ? '0,00 zł (Darmowy)'
                    : `${costEstimate.formattedNowPln} (${costEstimate.formattedNowUsd})`}
                </span>
              </div>
              {!costEstimate.isFree && previewFirst && (
                <div className="cost-row" style={{ fontSize: '0.84rem' }}>
                  <span>
                    Pełna książka (
                    {costEstimate.totalImagesFullBook === 1
                      ? '1 obraz'
                      : costEstimate.totalImagesFullBook % 10 >= 2 &&
                          costEstimate.totalImagesFullBook % 10 <= 4 &&
                          !(
                            costEstimate.totalImagesFullBook % 100 >= 12 &&
                            costEstimate.totalImagesFullBook % 100 <= 14
                          )
                        ? `${costEstimate.totalImagesFullBook} obrazy`
                        : `${costEstimate.totalImagesFullBook} obrazów`}
                    )
                  </span>
                  <span>
                    {costEstimate.formattedFullBookPln} ({costEstimate.formattedFullBookUsd})
                  </span>
                </div>
              )}
              <p className="field-hint">{costEstimate.note}</p>
              <p className="field-hint">
                Dzienny bezpiecznik obrazów API: użyto {quota.used} z {quota.limit}{' '}
                (pozostało {quota.remaining}).
              </p>
            </div>
          </section>

          {errorMessage && (
            <div className="alert alert-error" role="alert">
              {errorMessage}
            </div>
          )}

          <button
            type="submit"
            className="btn btn-primary btn-lg"
            disabled={isSubmitting || isCompressing}
            data-testid="create-story-submit"
          >
            {isSubmitting
              ? 'Tworzenie bajki i przygotowywanie ilustracji…'
              : 'Stwórz bajkę'}
          </button>
        </form>

        <div className="studio-sidebar">
          <CoverPreview
            childName={childName}
            childAge={childAge}
            gender={gender}
            companion={companion}
            theme={theme}
            artStyle={artStyle}
            mood={mood}
            pageCount={pageCount}
            bookFormat={bookFormat}
            photoPreviewUrl={photos[0]?.previewUrl ?? null}
          />

          <div className="paper-card">
            <h3 className="section-heading" style={{ fontSize: '1.02rem' }}>
              Co znajdzie się w gotowej książce?
            </h3>
            <ul
              style={{
                margin: '10px 0 0',
                paddingLeft: 18,
                fontSize: '0.86rem',
                color: 'var(--ink-soft)',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              <li>Okładka z tytułem i ilustracją dopasowaną do stylu.</li>
              <li>Strona dedykacji z portretem dziecka w złotej ramce.</li>
              <li>
                {pageCount} stron bogato napisanej bajki z poprawną polską odmianą i edycją
                tekstu na miejscu.
              </li>
              <li>Tylna okładka oraz deterministyczny druk PDF z polskimi czcionkami TTF.</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

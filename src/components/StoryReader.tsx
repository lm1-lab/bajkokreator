'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { copyTextToClipboard, downloadStoryPdfBinary } from '@/lib/client-image';
import { formatAgeYears } from '@/lib/polish/inflection';
import { ART_STYLE_META, STORY_MOOD_META } from '@/lib/polish/prompts';
import type { BookFormat, StoryPage, StoryRecord } from '@/lib/types/story';

interface StoryReaderProps {
  initialStory: StoryRecord;
  initialSlide: number;
  initialViewAll: boolean;
}

function clampSlide(value: number, maxSlide: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(maxSlide, Math.max(0, Math.floor(value)));
}

function parseLocationState(
  search: string,
  maxSlide: number,
): { slide: number; viewAll: boolean } {
  const params = new URLSearchParams(search);
  const viewAll = params.get('view') === 'all';
  const rawSlide = params.get('slide');
  const parsed = rawSlide !== null ? Number.parseInt(rawSlide, 10) : 0;
  return {
    slide: clampSlide(Number.isNaN(parsed) ? 0 : parsed, maxSlide),
    viewAll,
  };
}

function resolveCoverSrc(story: StoryRecord): string | null {
  if (story.coverFilename) {
    return `/api/stories/${encodeURIComponent(story.id)}/assets/${encodeURIComponent(story.coverFilename)}`;
  }
  return story.demoCoverPath ?? null;
}

function resolvePageSrc(storyId: string, page: StoryPage): string | null {
  if (page.imageFilename) {
    return `/api/stories/${encodeURIComponent(storyId)}/assets/${encodeURIComponent(page.imageFilename)}`;
  }
  return page.demoAssetPath ?? null;
}

export function StoryReader({
  initialStory,
  initialSlide,
  initialViewAll,
}: StoryReaderProps) {
  const [story, setStory] = useState<StoryRecord>(initialStory);
  const maxSlide = story.pages.length + 2; // 0=cover, 1=dedication, 2..N+1=pages, N+2=backCover
  const [slide, setSlide] = useState<number>(() => clampSlide(initialSlide, maxSlide));
  const [viewAll, setViewAll] = useState<boolean>(initialViewAll);

  // Inline page editor state
  const [editingPageNum, setEditingPageNum] = useState<number | null>(null);
  const [draftText, setDraftText] = useState<string>('');
  const [draftTitle, setDraftTitle] = useState<string>('');
  const [isSavingText, setIsSavingText] = useState(false);

  // Feedback & async action states
  const [copiedNotice, setCopiedNotice] = useState<string | null>(null);
  const [isUploadingArt, setIsUploadingArt] = useState(false);
  const [isDownloadingPdf, setIsDownloadingPdf] = useState<BookFormat | null>(null);
  const [isContinuing, setIsContinuing] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const sortedPages = useMemo(
    () => [...story.pages].sort((a, b) => a.pageNumber - b.pageNumber),
    [story.pages],
  );

  const pendingPagesCount = useMemo(
    () =>
      sortedPages.filter(
        (p) => p.imageStatus === 'pending' || p.imageStatus === 'error',
      ).length,
    [sortedPages],
  );

  const pushRouteState = useCallback(
    (nextSlide: number, nextViewAll: boolean) => {
      const clamped = clampSlide(nextSlide, maxSlide);
      setSlide(clamped);
      setViewAll(nextViewAll);
      setEditingPageNum(null);
      setCopiedNotice(null);

      const url = nextViewAll
        ? `/story/${encodeURIComponent(story.id)}?view=all&slide=${clamped}`
        : `/story/${encodeURIComponent(story.id)}?slide=${clamped}`;
      if (typeof window !== 'undefined') {
        window.history.pushState({ slide: clamped, viewAll: nextViewAll }, '', url);
      }
    },
    [maxSlide, story.id],
  );

  useEffect(() => {
    const onPopState = () => {
      const next = parseLocationState(window.location.search, maxSlide);
      setSlide(next.slide);
      setViewAll(next.viewAll);
      setEditingPageNum(null);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [maxSlide]);

  const currentStoryPage: StoryPage | null =
    slide >= 2 && slide <= sortedPages.length + 1
      ? sortedPages[slide - 2] ?? null
      : null;

  const slideLabel = useMemo(() => {
    if (slide === 0) return `Okładka (1 / ${maxSlide + 1})`;
    if (slide === 1) return `Dedykacja (2 / ${maxSlide + 1})`;
    if (slide === maxSlide) return `Tylna okładka (${maxSlide + 1} / ${maxSlide + 1})`;
    return `Strona ${slide - 1} z ${sortedPages.length} (${slide + 1} / ${maxSlide + 1})`;
  }, [slide, maxSlide, sortedPages.length]);

  const activePromptText = useMemo(() => {
    if (slide === 0) {
      return `CHARACTER BIBLE:\n${story.characterBible}\n\nCOVER PROMPT:\n${story.coverPrompt}`;
    }
    if (currentStoryPage) {
      const alreadyHasBible = currentStoryPage.imagePrompt
        .toLowerCase()
        .includes('character bible');
      return alreadyHasBible
        ? currentStoryPage.imagePrompt
        : `CHARACTER BIBLE:\n${story.characterBible}\n\nSCENE PROMPT (Page ${currentStoryPage.pageNumber}):\n${currentStoryPage.imagePrompt}`;
    }
    return null;
  }, [slide, story.characterBible, story.coverPrompt, currentStoryPage]);

  async function handleCopyPrompt() {
    if (!activePromptText) return;
    setErrorMessage(null);
    try {
      await copyTextToClipboard(activePromptText);
      setCopiedNotice('Skopiowano angielski prompt z Biblią Postaci!');
      window.setTimeout(() => setCopiedNotice(null), 3500);
    } catch {
      setErrorMessage('Nie udało się skopiować promptu do schowka.');
    }
  }

  function startEditingPage(page: StoryPage) {
    setErrorMessage(null);
    setStatusMessage(null);
    setEditingPageNum(page.pageNumber);
    setDraftText(page.text);
    setDraftTitle(page.chapterTitle);
  }

  async function handleSavePageEdit(pageNumber: number) {
    const trimmedText = draftText.trim();
    const trimmedTitle = draftTitle.trim();
    if (!trimmedText) {
      setErrorMessage('Treść strony nie może być pusta.');
      return;
    }

    setIsSavingText(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const res = await fetch(
        `/api/stories/${encodeURIComponent(story.id)}/pages/${pageNumber}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: trimmedText,
            ...(trimmedTitle ? { chapterTitle: trimmedTitle } : {}),
          }),
        },
      );
      const data = (await res.json()) as {
        page?: StoryPage;
        updatedAt?: string;
        error?: string;
      };
      if (!res.ok || !data.page) {
        setErrorMessage(data.error || 'Nie udało się zapisać zmian tekstu.');
        return;
      }

      setStory((prev) => ({
        ...prev,
        updatedAt: data.updatedAt ?? prev.updatedAt,
        pages: prev.pages.map((p) =>
          p.pageNumber === pageNumber ? data.page! : p,
        ),
      }));
      setEditingPageNum(null);
      setStatusMessage(`Zapisano tekst strony ${pageNumber}.`);
    } catch {
      setErrorMessage('Błąd sieci podczas zapisywania tekstu.');
    } finally {
      setIsSavingText(false);
    }
  }

  async function handleReplaceIllustration(slot: 'cover' | number, file: File) {
    setIsUploadingArt(true);
    setErrorMessage(null);
    setStatusMessage(null);

    try {
      const form = new FormData();
      form.append('file', file, file.name);
      const res = await fetch(
        `/api/stories/${encodeURIComponent(story.id)}/illustrations/${encodeURIComponent(String(slot))}`,
        {
          method: 'POST',
          body: form,
        },
      );
      const data = (await res.json()) as {
        filename?: string;
        updatedAt?: string;
        error?: string;
      };
      if (!res.ok || !data.filename) {
        setErrorMessage(data.error || 'Nie udało się wgrać własnej ilustracji.');
        return;
      }

      setStory((prev) => {
        if (slot === 'cover') {
          return {
            ...prev,
            coverFilename: data.filename!,
            coverStatus: 'custom-uploaded',
            coverUpdatedAt: data.updatedAt,
            updatedAt: data.updatedAt ?? prev.updatedAt,
          };
        }
        return {
          ...prev,
          updatedAt: data.updatedAt ?? prev.updatedAt,
          pages: prev.pages.map((p) =>
            p.pageNumber === slot
              ? {
                  ...p,
                  imageFilename: data.filename!,
                  imageStatus: 'custom-uploaded',
                  imageUpdatedAt: data.updatedAt,
                }
              : p,
          ),
        };
      });

      setStatusMessage(
        slot === 'cover'
          ? 'Podmieniono ilustrację okładki.'
          : `Podmieniono ilustrację strony ${slot}.`,
      );
    } catch {
      setErrorMessage('Błąd sieci podczas wgrywania ilustracji.');
    } finally {
      setIsUploadingArt(false);
    }
  }

  async function handleDownloadPdf(format: BookFormat) {
    setIsDownloadingPdf(format);
    setErrorMessage(null);
    try {
      await downloadStoryPdfBinary(story.id, format, story.input.childName);
      setStatusMessage(
        format === 'square'
          ? 'Pobrano plik PDF (Kwadrat 21×21 cm).'
          : 'Pobrano plik PDF (A4 poziomy).',
      );
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Nie udało się pobrać pliku PDF.',
      );
    } finally {
      setIsDownloadingPdf(null);
    }
  }

  async function handleContinueGeneration() {
    setIsContinuing(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const res = await fetch(
        `/api/stories/${encodeURIComponent(story.id)}/continue`,
        { method: 'POST' },
      );
      const data = (await res.json()) as {
        story?: StoryRecord;
        generatedPages?: number[];
        error?: string;
      };
      if (!res.ok || !data.story) {
        setErrorMessage(data.error || 'Nie udało się dogenerować pozostałych stron.');
        return;
      }
      setStory(data.story);
      setStatusMessage(
        `Wygenerowano pozostałe strony (${data.generatedPages?.length ?? 0}). Książka jest kompletna!`,
      );
    } catch {
      setErrorMessage('Błąd sieci podczas dogenerowywania stron.');
    } finally {
      setIsContinuing(false);
    }
  }

  const coverSrc = resolveCoverSrc(story);
  const firstRefPhoto = story.referencePhotos[0]
    ? `/api/stories/${encodeURIComponent(story.id)}/assets/${encodeURIComponent(story.referencePhotos[0])}`
    : null;

  return (
    <div>
      <section className="page-intro" style={{ marginBottom: 18 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <span className="eyebrow">
              Podgląd książki • {story.input.childName} (
              {formatAgeYears(story.input.childAge)})
            </span>
            <h1 className="page-title" style={{ marginBottom: 4 }}>
              {story.title}
            </h1>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span className="badge badge-gold">
              {ART_STYLE_META[story.input.artStyle].label}
            </span>
            <span className="badge badge-sage">
              {STORY_MOOD_META[story.input.mood].label}
            </span>
            <span className="badge">Tryb: {story.provider}</span>
          </div>
        </div>
      </section>

      {/* Preview-First continuation banner */}
      {(story.generationStage === 'preview' || pendingPagesCount > 0) &&
        story.provider !== 'manual' && (
          <div
            className="alert alert-info"
            style={{
              marginBottom: 16,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            <span>
              <strong>Tryb próbny aktywny:</strong> wygenerowano okładkę i 1. stronę. Pozostało{' '}
              {pendingPagesCount} stron do wygenerowania z okładką jako kotwicą stylu.
            </span>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleContinueGeneration}
              disabled={isContinuing}
              data-testid="continue-generation-btn"
            >
              {isContinuing
                ? 'Generowanie pozostałych stron…'
                : `Dogeneruj strony 2–${story.pages.length}`}
            </button>
          </div>
        )}

      {/* Navigation & PDF Export Toolbar */}
      <div className="reader-toolbar">
        <div className="reader-toolbar-group">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={viewAll || slide <= 0}
            onClick={() => pushRouteState(slide - 1, false)}
            data-testid="slide-prev"
          >
            ← Poprzednia
          </button>

          <span className="slide-indicator" data-testid="slide-indicator">
            {viewAll ? `Wszystkie strony (${maxSlide + 1})` : slideLabel}
          </span>

          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={viewAll || slide >= maxSlide}
            onClick={() => pushRouteState(slide + 1, false)}
            data-testid="slide-next"
          >
            Następna →
          </button>

          <button
            type="button"
            className={`btn btn-sm ${viewAll ? 'btn-sage' : 'btn-secondary'}`}
            onClick={() => pushRouteState(slide, !viewAll)}
            data-testid="view-all-toggle"
          >
            {viewAll ? 'Widok pojedynczej strony' : 'Wszystkie strony'}
          </button>
        </div>

        <div className="reader-toolbar-group">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={isDownloadingPdf !== null}
            onClick={() => void handleDownloadPdf('square')}
            data-testid="download-pdf-square"
          >
            {isDownloadingPdf === 'square'
              ? 'Tworzenie PDF…'
              : 'Pobierz PDF Kwadrat 21×21'}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={isDownloadingPdf !== null}
            onClick={() => void handleDownloadPdf('a4-landscape')}
            data-testid="download-pdf-a4"
          >
            {isDownloadingPdf === 'a4-landscape'
              ? 'Tworzenie PDF…'
              : 'Pobierz PDF A4 poziomy'}
          </button>
          <Link href="/library" className="btn btn-secondary btn-sm">
            Biblioteka
          </Link>
        </div>
      </div>

      {errorMessage && (
        <div className="alert alert-error" role="alert" style={{ marginBottom: 14 }}>
          {errorMessage}
        </div>
      )}
      {statusMessage && (
        <div className="alert alert-success" role="status" style={{ marginBottom: 14 }}>
          {statusMessage}
        </div>
      )}

      {/* VIEW ALL GRID */}
      {viewAll ? (
        <section
          className="all-pages-grid"
          data-testid="all-pages-grid"
          aria-label="Wszystkie strony książki"
        >
          {/* Card 0: Cover */}
          <article className="all-pages-card">
            {coverSrc ? (
               
              <img src={coverSrc} alt="Okładka" className="all-pages-thumb" />
            ) : (
              <div className="all-pages-thumb" />
            )}
            <div className="all-pages-body">
              <span className="badge badge-terracotta">Okładka</span>
              <h3>{story.title}</h3>
              <p className="all-pages-excerpt">{story.subtitle}</p>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                style={{ marginTop: 'auto' }}
                onClick={() => pushRouteState(0, false)}
              >
                Otwórz okładkę
              </button>
            </div>
          </article>

          {/* Card 1: Dedication */}
          <article className="all-pages-card">
            {firstRefPhoto ? (
               
              <img
                src={firstRefPhoto}
                alt={`Portret ${story.input.childName}`}
                className="all-pages-thumb"
              />
            ) : (
              <div className="all-pages-thumb" />
            )}
            <div className="all-pages-body">
              <span className="badge badge-gold">Dedykacja</span>
              <h3>Dla {story.input.childName}</h3>
              <p className="all-pages-excerpt">{story.dedicationText}</p>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                style={{ marginTop: 'auto' }}
                onClick={() => pushRouteState(1, false)}
              >
                Otwórz dedykację
              </button>
            </div>
          </article>

          {/* Cards 2..N+1: Story pages */}
          {sortedPages.map((pg) => {
            const src = resolvePageSrc(story.id, pg);
            return (
              <article className="all-pages-card" key={pg.pageNumber}>
                {src ? (
                   
                  <img
                    src={src}
                    alt={pg.chapterTitle}
                    className="all-pages-thumb"
                  />
                ) : (
                  <div className="all-pages-thumb" />
                )}
                <div className="all-pages-body">
                  <span className="badge">Strona {pg.pageNumber}</span>
                  <h3>{pg.chapterTitle}</h3>
                  <p className="all-pages-excerpt">{pg.text}</p>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    style={{ marginTop: 'auto' }}
                    onClick={() => pushRouteState(pg.pageNumber + 1, false)}
                  >
                    Edytuj / podgląd strony {pg.pageNumber}
                  </button>
                </div>
              </article>
            );
          })}

          {/* Final card: Back Cover */}
          <article className="all-pages-card">
            <div className="all-pages-body">
              <span className="badge badge-sage">Tylna okładka</span>
              <h3>O tej książeczce</h3>
              <p className="all-pages-excerpt">{story.backCoverBlurb}</p>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                style={{ marginTop: 'auto' }}
                onClick={() => pushRouteState(maxSlide, false)}
              >
                Otwórz tylną okładkę
              </button>
            </div>
          </article>
        </section>
      ) : (
        /* SINGLE SLIDE BOOK STAGE */
        <section className="book-stage" data-testid="story-slide">
          {/* SLIDE 0: COVER */}
          {slide === 0 && (
            <div>
              <div className="book-spread">
                <div className="book-art-frame">
                  {coverSrc ? (
                     
                    <img
                      src={coverSrc}
                      alt={`Ilustracja okładkowa: ${story.title}`}
                    />
                  ) : (
                    <div className="book-art-empty">
                      <strong>Okładka czeka na ilustrację</strong>
                      <span>
                        Skopiuj poniżej angielski prompt pod Nano Banana i wgraj gotowy plik
                        ilustracji okładkowej.
                      </span>
                    </div>
                  )}
                </div>

                <div className="book-text-col">
                  <span className="eyebrow">Okładka książki</span>
                  <h2 className="book-chapter-title">{story.title}</h2>
                  <p
                    className="book-prose"
                    style={{ fontStyle: 'italic', color: 'var(--ink-soft)' }}
                  >
                    {story.subtitle}
                  </p>
                  <p className="field-hint">
                    Bohater: <strong>{story.input.childName}</strong> (
                    {formatAgeYears(story.input.childAge)})
                    {story.input.companion
                      ? ` • Towarzysz: ${story.input.companion}`
                      : ''}
                  </p>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
                    <label className="btn btn-secondary btn-sm upload-inline-label">
                      <span>
                        {isUploadingArt ? 'Wgrywanie…' : 'Podmień ilustrację okładki'}
                      </span>
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        className="upload-inline-input"
                        data-testid="replace-art-input"
                        disabled={isUploadingArt}
                        onChange={(ev) => {
                          const file = ev.target.files?.[0];
                          if (file) {
                            void handleReplaceIllustration('cover', file);
                          }
                          ev.target.value = '';
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => pushRouteState(1, false)}
                    >
                      Otwórz książkę (Dedykacja) →
                    </button>
                  </div>
                </div>
              </div>

              {activePromptText && (
                <div className="prompt-drawer">
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 10,
                      flexWrap: 'wrap',
                    }}
                  >
                    <strong>Prompt okładki + Biblia Postaci (Nano Banana / Gemini)</strong>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => void handleCopyPrompt()}
                      data-testid="copy-prompt-btn"
                    >
                      {copiedNotice ? 'Skopiowano!' : 'Kopiuj prompt pod Nano Banana'}
                    </button>
                  </div>
                  <pre className="prompt-code">{activePromptText}</pre>
                </div>
              )}
            </div>
          )}

          {/* SLIDE 1: DEDICATION */}
          {slide === 1 && (
            <div className="book-dedication-wrap">
              <span className="eyebrow">Strona z dedykacją</span>
              <div className="dedication-portrait-frame">
                {firstRefPhoto ? (
                   
                  <img
                    src={firstRefPhoto}
                    alt={`Zdjęcie dziecka: ${story.input.childName}`}
                    data-testid="dedication-photo"
                  />
                ) : (
                  <div className="book-art-empty" style={{ height: '100%' }}>
                    <span>Portret: {story.input.childName}</span>
                  </div>
                )}
              </div>
              <p className="dedication-text">{story.dedicationText}</p>
              <p className="badge badge-terracotta">
                {story.input.dedicationFrom
                  ? `Z miłością — ${story.input.dedicationFrom}`
                  : `Dla ${story.input.childName} (${formatAgeYears(story.input.childAge)})`}
              </p>
            </div>
          )}

          {/* SLIDES 2..N+1: STORY PAGES 1..N */}
          {currentStoryPage && (
            <div>
              <div className="book-spread">
                <div className="book-art-frame">
                  {resolvePageSrc(story.id, currentStoryPage) ? (
                     
                    <img
                      src={resolvePageSrc(story.id, currentStoryPage)!}
                      alt={`Ilustracja do strony ${currentStoryPage.pageNumber}: ${currentStoryPage.chapterTitle}`}
                    />
                  ) : (
                    <div className="book-art-empty">
                      <strong>
                        Strona {currentStoryPage.pageNumber} — oczekuje na ilustrację
                      </strong>
                      <span>
                        {story.provider === 'manual'
                          ? 'Skopiuj prompt poniżej, wygeneruj obraz w Gemini / Nano Banana i wgraj go tutaj.'
                          : 'Użyj przycisku „Dogeneruj pozostałe strony” lub wgraj własny plik obrazu.'}
                      </span>
                    </div>
                  )}
                </div>

                <div className="book-text-col">
                  <span className="eyebrow">
                    Strona {currentStoryPage.pageNumber} z {sortedPages.length}
                  </span>

                  {editingPageNum === currentStoryPage.pageNumber ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <div className="field-group">
                        <label className="field-label" htmlFor="editChapterTitle">
                          Tytuł rozdziału
                        </label>
                        <input
                          id="editChapterTitle"
                          type="text"
                          className="field-input"
                          value={draftTitle}
                          onChange={(e) => setDraftTitle(e.target.value)}
                          maxLength={160}
                        />
                      </div>
                      <div className="field-group">
                        <label className="field-label" htmlFor="editPageText">
                          Treść strony (z polskimi znakami)
                        </label>
                        <textarea
                          id="editPageText"
                          className="field-textarea"
                          style={{ minHeight: 170 }}
                          value={draftText}
                          onChange={(e) => setDraftText(e.target.value)}
                          data-testid="edit-text-area"
                          maxLength={2000}
                        />
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={isSavingText}
                          onClick={() =>
                            void handleSavePageEdit(currentStoryPage.pageNumber)
                          }
                          data-testid="save-text-btn"
                        >
                          {isSavingText ? 'Zapisywanie…' : 'Zapisz zmiany'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => setEditingPageNum(null)}
                        >
                          Anuluj
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <h2 className="book-chapter-title">
                        {currentStoryPage.chapterTitle}
                      </h2>
                      <p className="book-prose">{currentStoryPage.text}</p>

                      <div className="book-actions-bar">
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => startEditingPage(currentStoryPage)}
                          data-testid="edit-text-btn"
                        >
                          Edytuj tekst
                        </button>

                        <label className="btn btn-secondary btn-sm upload-inline-label">
                          <span>
                            {isUploadingArt ? 'Wgrywanie…' : 'Podmień ilustrację'}
                          </span>
                          <input
                            type="file"
                            accept="image/jpeg,image/png,image/webp"
                            className="upload-inline-input"
                            data-testid="replace-art-input"
                            disabled={isUploadingArt}
                            onChange={(ev) => {
                              const file = ev.target.files?.[0];
                              if (file) {
                                void handleReplaceIllustration(
                                  currentStoryPage.pageNumber,
                                  file,
                                );
                              }
                              ev.target.value = '';
                            }}
                          />
                        </label>
                      </div>
                    </>
                  )}
                </div>
              </div>

              {activePromptText && (
                <div className="prompt-drawer">
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 10,
                      flexWrap: 'wrap',
                    }}
                  >
                    <strong>
                      Prompt ilustracji strony {currentStoryPage.pageNumber} + Biblia Postaci
                    </strong>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => void handleCopyPrompt()}
                      data-testid="copy-prompt-btn"
                    >
                      {copiedNotice ? 'Skopiowano!' : 'Kopiuj prompt pod Nano Banana'}
                    </button>
                  </div>
                  <pre className="prompt-code">{activePromptText}</pre>
                </div>
              )}
            </div>
          )}

          {/* FINAL SLIDE: BACK COVER */}
          {slide === maxSlide && (
            <div className="back-cover-wrap">
              <span className="eyebrow">Tylna okładka</span>
              <h2 className="book-chapter-title">{story.title}</h2>
              <p className="book-prose" style={{ maxWidth: '54ch' }}>
                {story.backCoverBlurb}
              </p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                <span className="badge">
                  Bohater: {story.input.childName} ({formatAgeYears(story.input.childAge)})
                </span>
                <span className="badge">{story.pages.length} stron bajki</span>
                <span className="badge">
                  {ART_STYLE_META[story.input.artStyle].label}
                </span>
              </div>
              <p className="field-hint">Wydano w domowej pracowni BajkoKreator</p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

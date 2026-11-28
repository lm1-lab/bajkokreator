'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  copyTextToClipboard,
  downloadStoryPdfBinary,
  type PdfDownloadOptions,
} from '@/lib/client-image';
import { declinePolishName, formatAgeYears } from '@/lib/polish/inflection';
import { ART_STYLE_META, STORY_MOOD_META } from '@/lib/polish/prompts';
import type { BookFormat, StoryPage, StoryRecord } from '@/lib/types/story';

interface PreflightIssueItem {
  code: string;
  severity: 'error' | 'warning' | 'info';
  slot: 'book' | 'cover' | 'dedication' | 'back-cover' | number;
  message: string;
}

interface PreflightReportData {
  storyId: string;
  format: BookFormat;
  checkedAt: string;
  readyForPrint: boolean;
  score: number;
  summary: {
    errors: number;
    warnings: number;
    info: number;
  };
  metrics: {
    storyPages: number;
    totalPdfPages: number;
    paddingNeededForMultipleOf4: number;
    expectedArtworkSlots: number;
    readyArtworkSlots: number;
    minEffectiveDpi: number | null;
  };
  issues: PreflightIssueItem[];
}

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

function formatProviderLabelPl(provider: StoryRecord['provider']): string {
  switch (provider) {
    case 'demo':
      return 'Tryb Demo';
    case 'manual':
      return 'Tryb Ręczny';
    case 'gemini-api':
      return 'Gemini API';
    case 'google-subscription':
      return 'Subskrypcja Google AI';
  }
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
  const [isDownloadingPdf, setIsDownloadingPdf] = useState<string | null>(null);
  const [isContinuing, setIsContinuing] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Pre-flight & Print-Ready PDF drawer states
  const [preflight, setPreflight] = useState<PreflightReportData | null>(null);
  const [isLoadingPreflight, setIsLoadingPreflight] = useState(true);
  const [showPreflightPanel, setShowPreflightPanel] = useState(false);
  const [showPrintReadyPanel, setShowPrintReadyPanel] = useState(false);

  // RODO 2-step photo purge states
  const [confirmingRodoPurge, setConfirmingRodoPurge] = useState(false);
  const [isPurgingPhotos, setIsPurgingPhotos] = useState(false);

  // Order draft drawer states
  const [showOrderDrawer, setShowOrderDrawer] = useState(false);
  const [orderRecipientName, setOrderRecipientName] = useState('');
  const [orderLine1, setOrderLine1] = useState('');
  const [orderPostalCode, setOrderPostalCode] = useState('');
  const [orderCity, setOrderCity] = useState('');
  const [orderEmail, setOrderEmail] = useState('');
  const [orderPhone, setOrderPhone] = useState('');
  const [isSubmittingOrder, setIsSubmittingOrder] = useState(false);
  const [createdOrder, setCreatedOrder] = useState<{
    id: string;
    orderNumber: string;
  } | null>(null);
  const orderIdempotencyRef = useRef<{ fingerprint: string; key: string } | null>(null);

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

  const declinedChild = useMemo(
    () => declinePolishName(story.input.childName, story.input.gender),
    [story.input.childName, story.input.gender],
  );

  const fetchPreflight = useCallback(async () => {
    setIsLoadingPreflight(true);
    try {
      const res = await fetch(
        `/api/stories/${encodeURIComponent(story.id)}/preflight?format=${encodeURIComponent(story.bookFormat)}`,
        { cache: 'no-store' },
      );
      if (res.ok) {
        const data = (await res.json()) as { report?: PreflightReportData };
        if (data.report) {
          setPreflight(data.report);
        }
      }
    } catch {
      // Ignore transient preflight fetch failures
    } finally {
      setIsLoadingPreflight(false);
    }
  }, [story.id, story.bookFormat]);

  useEffect(() => {
    let cancelled = false;
    async function loadPreflight() {
      try {
        const res = await fetch(
          `/api/stories/${encodeURIComponent(story.id)}/preflight?format=${encodeURIComponent(story.bookFormat)}`,
          { cache: 'no-store' },
        );
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { report?: PreflightReportData };
        if (!cancelled && data.report) {
          setPreflight(data.report);
        }
      } catch {
        // Ignore transient preflight fetch failures
      } finally {
        if (!cancelled) {
          setIsLoadingPreflight(false);
        }
      }
    }
    void loadPreflight();
    return () => {
      cancelled = true;
    };
  }, [story.id, story.bookFormat, story.updatedAt, story.coverUpdatedAt, story.referencePhotos.length]);

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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (viewAll || editingPageNum !== null) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.key === 'ArrowLeft' && slide > 0) {
        event.preventDefault();
        pushRouteState(slide - 1, false);
      } else if (event.key === 'ArrowRight' && slide < maxSlide) {
        event.preventDefault();
        pushRouteState(slide + 1, false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [viewAll, editingPageNum, slide, maxSlide, pushRouteState]);

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

  async function handleDownloadPdf(
    format: BookFormat,
    printOptions?: PdfDownloadOptions,
  ) {
    const downloadKey = printOptions?.bleedMm ? `print-${format}` : format;
    setIsDownloadingPdf(downloadKey);
    setErrorMessage(null);
    try {
      await downloadStoryPdfBinary(
        story.id,
        format,
        story.input.childName,
        printOptions,
      );
      setStatusMessage(
        printOptions?.bleedMm
          ? `Pobrano PDF poligraficzny (${format === 'square' ? 'Kwadrat 21×21 cm' : 'A4 poziomy'}, spady ${printOptions.bleedMm} mm).`
          : format === 'square'
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

  async function handlePurgeReferencePhotos() {
    setIsPurgingPhotos(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const res = await fetch(
        `/api/stories/${encodeURIComponent(story.id)}/reference-photos`,
        { method: 'DELETE' },
      );
      const data = (await res.json()) as {
        purged?: boolean;
        purgedAt?: string;
        deletedFiles?: string[];
        error?: string;
      };
      if (!res.ok || !data.purged) {
        setErrorMessage(data.error || 'Nie udało się usunąć zdjęć referencyjnych.');
        return;
      }
      setStory((prev) => ({
        ...prev,
        referencePhotos: [],
        referencePhotosPurgedAt: data.purgedAt ?? new Date().toISOString(),
        updatedAt: data.purgedAt ?? new Date().toISOString(),
      }));
      setConfirmingRodoPurge(false);
      setStatusMessage(
        'Zdjęcia referencyjne dziecka zostały trwale usunięte (RODO). Bajka i ilustracje pozostały bez zmian.',
      );
    } catch {
      setErrorMessage('Błąd sieci podczas usuwania zdjęć referencyjnych.');
    } finally {
      setIsPurgingPhotos(false);
    }
  }

  async function handleCreateOrderDraft(event: React.FormEvent) {
    event.preventDefault();
    if (isSubmittingOrder) return;
    setIsSubmittingOrder(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const payload = {
        storyId: story.id,
        bookFormat: story.bookFormat,
        quantity: 1,
        shippingAddress: {
          recipientName: orderRecipientName.trim(),
          line1: orderLine1.trim(),
          postalCode: orderPostalCode.trim(),
          city: orderCity.trim(),
          countryCode: 'PL',
          email: orderEmail.trim(),
          ...(orderPhone.trim() ? { phone: orderPhone.trim() } : {}),
        },
      };
      const fingerprint = JSON.stringify(payload);
      if (orderIdempotencyRef.current?.fingerprint !== fingerprint) {
        const randomPart =
          typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        orderIdempotencyRef.current = {
          fingerprint,
          key: `ui-${story.id}-${randomPart}`,
        };
      }

      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': orderIdempotencyRef.current.key,
        },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as {
        order?: { id: string; orderNumber: string };
        error?: string;
        issues?: Array<{ message: string }>;
      };
      if (!res.ok || !data.order) {
        setErrorMessage(
          data.issues?.[0]?.message ||
            data.error ||
            'Nie udało się utworzyć szkicu zamówienia.',
        );
        return;
      }
      setCreatedOrder({
        id: data.order.id,
        orderNumber: data.order.orderNumber,
      });
      setStatusMessage(
        `Utworzono szkic zamówienia druku: ${data.order.orderNumber}.`,
      );
    } catch {
      setErrorMessage('Błąd sieci podczas tworzenia szkicu zamówienia.');
    } finally {
      setIsSubmittingOrder(false);
    }
  }

  function jumpToPreflightSlot(slot: PreflightIssueItem['slot']) {
    if (slot === 'cover') {
      pushRouteState(0, false);
    } else if (slot === 'dedication') {
      pushRouteState(1, false);
    } else if (slot === 'back-cover') {
      pushRouteState(maxSlide, false);
    } else if (typeof slot === 'number') {
      pushRouteState(slot + 1, false);
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
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="badge badge-gold">
              {ART_STYLE_META[story.input.artStyle].label}
            </span>
            <span className="badge badge-sage">
              {STORY_MOOD_META[story.input.mood].label}
            </span>
            <span className="badge">{formatProviderLabelPl(story.provider)}</span>
            <button
              type="button"
              className={`badge preflight-badge-btn ${
                preflight
                  ? preflight.readyForPrint
                    ? 'badge-sage'
                    : 'badge-danger'
                  : 'badge-gold'
              }`}
              onClick={() => setShowPreflightPanel((prev) => !prev)}
              aria-expanded={showPreflightPanel}
              data-testid="preflight-badge"
            >
              {isLoadingPreflight
                ? 'Sprawdzanie Pre-Flight…'
                : preflight
                  ? preflight.readyForPrint
                    ? `Pre-Flight OK • ${preflight.score}/100`
                    : `Pre-Flight: ${preflight.summary.errors} błędów • ${preflight.score}/100`
                  : 'Pre-Flight: sprawdź'}
            </button>
          </div>
        </div>
      </section>

      {/* Expandable Pre-Flight Quality Panel */}
      {showPreflightPanel && preflight && (
        <section
          className="paper-card preflight-panel"
          data-testid="preflight-panel"
          style={{ marginBottom: 16 }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              flexWrap: 'wrap',
              marginBottom: 10,
            }}
          >
            <div>
              <strong>Kontrola jakości druku (Pre-Flight)</strong>
              <span className="field-hint" style={{ marginLeft: 10 }}>
                Wynik: {preflight.score}/100 • Stron PDF: {preflight.metrics.totalPdfPages} •
                Gotowe ilustracje: {preflight.metrics.readyArtworkSlots}/
                {preflight.metrics.expectedArtworkSlots}
                {preflight.metrics.minEffectiveDpi !== null
                  ? ` • Min. DPI: ${preflight.metrics.minEffectiveDpi}`
                  : ''}
              </span>
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => void fetchPreflight()}
            >
              Odśwież Pre-Flight
            </button>
          </div>

          {preflight.issues.length === 0 ? (
            <p className="field-hint">
              Brak uwag technicznych — książka spełnia wszystkie kryteria druku.
            </p>
          ) : (
            <ul className="preflight-issue-list">
              {preflight.issues.map((issue, idx) => (
                <li
                  key={`${issue.code}-${String(issue.slot)}-${idx}`}
                  className={`preflight-issue preflight-issue--${issue.severity}`}
                  data-testid="preflight-issue-item"
                >
                  <button
                    type="button"
                    className="preflight-issue-jump"
                    onClick={() => jumpToPreflightSlot(issue.slot)}
                  >
                    <span className="preflight-issue-tag">
                      {issue.severity === 'error'
                        ? 'Błąd'
                        : issue.severity === 'warning'
                          ? 'Uwaga'
                          : 'Info'}
                    </span>
                    <span>{issue.message}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

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
          <button
            type="button"
            className={`btn btn-sm ${showPrintReadyPanel ? 'btn-sage' : 'btn-secondary'}`}
            onClick={() => setShowPrintReadyPanel((prev) => !prev)}
            aria-expanded={showPrintReadyPanel}
            data-testid="print-ready-toggle"
          >
            PDF dla drukarni (spady 3 mm)
          </button>
          <button
            type="button"
            className={`btn btn-sm ${showOrderDrawer ? 'btn-sage' : 'btn-secondary'}`}
            onClick={() => setShowOrderDrawer((prev) => !prev)}
            aria-expanded={showOrderDrawer}
            data-testid="order-draft-btn"
          >
            Zamówienie druku (szkic)
          </button>
          <Link href="/library" className="btn btn-secondary btn-sm">
            Biblioteka
          </Link>
        </div>
      </div>

      {/* Print-ready PDF & RODO action bar */}
      {showPrintReadyPanel && (
        <section className="paper-card print-drawer" style={{ marginBottom: 14 }}>
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
              <strong>Eksport poligraficzny (POD / drukarnia)</strong>
              <p className="field-hint">
                Zawiera spady 3 mm, znaczniki cięcia poza BleedBox oraz dopełnienie stron do
                wielokrotności 4 (wyklejka „Notatki i rysunki”).
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={isDownloadingPdf !== null}
                onClick={() =>
                  void handleDownloadPdf('square', {
                    bleedMm: 3,
                    cropMarks: true,
                    padToMultipleOf4: true,
                  })
                }
                data-testid="download-pdf-print-square"
              >
                {isDownloadingPdf === 'print-square'
                  ? 'Tworzenie PDF…'
                  : 'Drukarnia PDF: Kwadrat 21×21 (3 mm)'}
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={isDownloadingPdf !== null}
                onClick={() =>
                  void handleDownloadPdf('a4-landscape', {
                    bleedMm: 3,
                    cropMarks: true,
                    padToMultipleOf4: true,
                  })
                }
                data-testid="download-pdf-print-a4"
              >
                {isDownloadingPdf === 'print-a4'
                  ? 'Tworzenie PDF…'
                  : 'Drukarnia PDF: A4 poziomy (3 mm)'}
              </button>
            </div>
          </div>
        </section>
      )}

      {/* RODO Reference Photo Strip */}
      <div className="rodo-strip" style={{ marginBottom: 14 }}>
        {story.referencePhotos.length > 0 ? (
          <>
            <span className="field-hint">
              <strong>RODO:</strong> zapisane zdjęcia referencyjne dziecka (
              {story.referencePhotos.length}). Możesz je trwale usunąć po wygenerowaniu bajki.
            </span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {confirmingRodoPurge ? (
                <>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    disabled={isPurgingPhotos}
                    onClick={() => void handlePurgeReferencePhotos()}
                    data-testid="rodo-purge-confirm"
                  >
                    {isPurgingPhotos
                      ? 'Usuwanie zdjęć…'
                      : 'Potwierdź trwałe usunięcie zdjęć'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setConfirmingRodoPurge(false)}
                  >
                    Anuluj
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setConfirmingRodoPurge(true)}
                  data-testid="rodo-purge-btn"
                >
                  Usuń zdjęcia dziecka (RODO)
                </button>
              )}
            </div>
          </>
        ) : (
          <span className="badge badge-sage" data-testid="rodo-purged-badge">
            RODO: zdjęcia referencyjne dziecka zostały usunięte
          </span>
        )}
      </div>

      {/* Order Draft Drawer */}
      {showOrderDrawer && (
        <section className="paper-card order-drawer" style={{ marginBottom: 16 }}>
          <h2 className="section-heading" style={{ marginBottom: 6 }}>
            Zamówienie druku (szkic bez zobowiązań płatniczych)
          </h2>
          <p className="section-note" style={{ marginBottom: 12 }}>
            Utwórz szkic zamówienia z numerem <code>BK-RRRR-XXXXXX</code>, aby powiązać
            książkę z kontrolą Pre-Flight i śledzeniem statusu na stronie Zamówienia.
          </p>

          {createdOrder ? (
            <div className="alert alert-success" role="status">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <span>
                  Utworzono szkic zamówienia:{' '}
                  <strong data-testid="order-created-number">
                    {createdOrder.orderNumber}
                  </strong>
                </span>
                <Link href="/orders" className="btn btn-secondary btn-sm">
                  Sprawdź status w Zamówieniach →
                </Link>
              </div>
            </div>
          ) : (
            <form
              className="form-grid"
              data-testid="order-draft-form"
              onSubmit={(e) => void handleCreateOrderDraft(e)}
            >
              <div className="field-group">
                <label className="field-label" htmlFor="orderRecipientName">
                  Imię i nazwisko odbiorcy
                </label>
                <input
                  id="orderRecipientName"
                  name="recipientName"
                  data-testid="order-recipient-input"
                  type="text"
                  className="field-input"
                  required
                  value={orderRecipientName}
                  onChange={(e) => setOrderRecipientName(e.target.value)}
                  placeholder="np. Anna Kowalska"
                />
              </div>
              <div className="field-group">
                <label className="field-label" htmlFor="orderLine1">
                  Ulica i numer
                </label>
                <input
                  id="orderLine1"
                  name="line1"
                  data-testid="order-line1-input"
                  type="text"
                  className="field-input"
                  required
                  value={orderLine1}
                  onChange={(e) => setOrderLine1(e.target.value)}
                  placeholder="np. ul. Bajkowa 12/4"
                />
              </div>
              <div className="field-group">
                <label className="field-label" htmlFor="orderPostalCode">
                  Kod pocztowy
                </label>
                <input
                  id="orderPostalCode"
                  name="postalCode"
                  data-testid="order-postal-input"
                  type="text"
                  className="field-input"
                  required
                  value={orderPostalCode}
                  onChange={(e) => setOrderPostalCode(e.target.value)}
                  placeholder="np. 00-001"
                />
              </div>
              <div className="field-group">
                <label className="field-label" htmlFor="orderCity">
                  Miasto
                </label>
                <input
                  id="orderCity"
                  name="city"
                  data-testid="order-city-input"
                  type="text"
                  className="field-input"
                  required
                  value={orderCity}
                  onChange={(e) => setOrderCity(e.target.value)}
                  placeholder="np. Warszawa"
                />
              </div>
              <div className="field-group">
                <label className="field-label" htmlFor="orderEmail">
                  E-mail
                </label>
                <input
                  id="orderEmail"
                  name="email"
                  data-testid="order-email-input"
                  type="email"
                  className="field-input"
                  required
                  value={orderEmail}
                  onChange={(e) => setOrderEmail(e.target.value)}
                  placeholder="np. anna@example.com"
                />
              </div>
              <div className="field-group">
                <label className="field-label" htmlFor="orderPhone">
                  Telefon (opcjonalnie)
                </label>
                <input
                  id="orderPhone"
                  name="phone"
                  data-testid="order-phone-input"
                  type="tel"
                  className="field-input"
                  value={orderPhone}
                  onChange={(e) => setOrderPhone(e.target.value)}
                  placeholder="np. +48 600 100 200"
                />
              </div>
              <div className="field-group full-span">
                <button
                  type="submit"
                  className="btn btn-primary btn-sm"
                  disabled={isSubmittingOrder}
                  data-testid="order-draft-submit"
                >
                  {isSubmittingOrder
                    ? 'Zapisywanie szkicu…'
                    : 'Utwórz szkic zamówienia druku'}
                </button>
              </div>
            </form>
          )}
        </section>
      )}

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
                  : `Dla ${declinedChild.genitive} (${formatAgeYears(story.input.childAge)})`}
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

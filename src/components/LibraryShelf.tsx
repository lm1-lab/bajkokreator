'use client';

import Link from 'next/link';
import { useState } from 'react';
import { downloadStoryPdfBinary } from '@/lib/client-image';
import { formatAgeYears } from '@/lib/polish/inflection';
import type { StorageMode, StorySummary } from '@/lib/types/story';

interface LibraryShelfProps {
  initialStories: StorySummary[];
  storageMode: StorageMode;
}

export function LibraryShelf({ initialStories, storageMode }: LibraryShelfProps) {
  const [stories, setStories] = useState<StorySummary[]>(initialStories);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handlePdfDownload(story: StorySummary) {
    setErrorMessage(null);
    setDownloadingId(story.id);
    try {
      await downloadStoryPdfBinary(story.id, story.bookFormat, story.childName);
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Nie udało się pobrać PDF.',
      );
    } finally {
      setDownloadingId(null);
    }
  }

  async function handleDeleteConfirmed(storyId: string) {
    setErrorMessage(null);
    setDeletingId(storyId);
    try {
      const res = await fetch(`/api/stories/${encodeURIComponent(storyId)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setErrorMessage(body.error || 'Nie udało się usunąć bajki.');
        return;
      }
      setStories((prev) => prev.filter((s) => s.id !== storyId));
      setConfirmingId(null);
    } catch {
      setErrorMessage('Błąd sieci podczas usuwania bajki.');
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div>
      <section className="page-intro">
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <span className="eyebrow">Domowa półka z bajkami</span>
            <h1 className="page-title">Biblioteka zapisanych książek</h1>
            <p className="page-lead">
              Wszystkie utworzone bajki z szybkim podglądem, edycją i natychmiastowym
              eksportem do druku PDF.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="badge">
              Zapis: {storageMode === 'local' ? 'dysk lokalny' : 'tymczasowy /tmp (Vercel)'}
            </span>
            <Link href="/" className="btn btn-primary btn-sm">
              + Nowa bajka
            </Link>
          </div>
        </div>
      </section>

      {errorMessage && (
        <div className="alert alert-error" role="alert" style={{ marginBottom: 16 }}>
          {errorMessage}
        </div>
      )}

      {stories.length === 0 ? (
        <div
          className="paper-card"
          style={{ textAlign: 'center', padding: '44px 24px' }}
          data-testid="library-grid"
        >
          <h2 style={{ marginBottom: 8 }}>Półka z bajkami jest jeszcze pusta</h2>
          <p className="page-lead" style={{ margin: '0 auto 18px' }}>
            Stwórz pierwszą spersonalizowaną książeczkę dla dziecka — w Trybie Demo powstanie
            od razu bez żadnego klucza API.
          </p>
          <Link href="/" className="btn btn-primary">
            Otwórz kreator bajki
          </Link>
        </div>
      ) : (
        <section className="library-grid" data-testid="library-grid">
          {stories.map((story) => (
            <article
              key={story.id}
              className="library-card"
              data-testid="library-card"
            >
              <div className="library-card-cover">
                {story.coverUrl ? (
                   
                  <img src={story.coverUrl} alt={`Okładka bajki: ${story.title}`} />
                ) : (
                  <div className="book-art-empty" style={{ height: '100%', aspectRatio: 'auto' }}>
                    <strong>Tryb ręczny</strong>
                    <span>Wgraj okładkę w podglądzie</span>
                  </div>
                )}
              </div>

              <div className="library-card-body">
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <span className="badge badge-gold">
                    {story.childName} • {formatAgeYears(story.childAge)}
                  </span>
                  <span className="badge">{story.pageCount} stron</span>
                  <span className="badge">{story.provider}</span>
                </div>

                <h2 style={{ fontSize: '1.15rem' }}>{story.title}</h2>
                <p className="field-hint">{story.subtitle}</p>

                <div className="library-card-actions">
                  <Link
                    href={`/story/${encodeURIComponent(story.id)}?slide=0`}
                    className="btn btn-primary btn-sm"
                    data-testid="library-open-btn"
                  >
                    Otwórz
                  </Link>

                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={downloadingId === story.id}
                    onClick={() => void handlePdfDownload(story)}
                    data-testid="library-pdf-btn"
                  >
                    {downloadingId === story.id ? 'Pobieranie…' : 'Pobierz PDF'}
                  </button>

                  {confirmingId === story.id ? (
                    <>
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        disabled={deletingId === story.id}
                        onClick={() => void handleDeleteConfirmed(story.id)}
                        data-testid="library-delete-confirm"
                      >
                        {deletingId === story.id ? 'Usuwanie…' : 'Potwierdź usunięcie'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => setConfirmingId(null)}
                      >
                        Anuluj
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      onClick={() => setConfirmingId(story.id)}
                      data-testid="library-delete-btn"
                    >
                      Usuń
                    </button>
                  )}
                </div>
              </div>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}

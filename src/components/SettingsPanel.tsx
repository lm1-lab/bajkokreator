'use client';

import { useState } from 'react';
import type { SettingsSnapshot } from '@/lib/api-helpers';
import { estimateClientStoryCost } from '@/lib/cost-estimator';
import type { BookFormat, ProviderId } from '@/lib/types/story';

interface SettingsPanelProps {
  initialSnapshot: SettingsSnapshot;
}

export function SettingsPanel({ initialSnapshot }: SettingsPanelProps) {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot>(initialSnapshot);
  const [activeProvider, setActiveProvider] = useState<ProviderId>(
    initialSnapshot.settings.activeProvider,
  );
  const [textModel, setTextModel] = useState<string>(
    initialSnapshot.settings.textModel,
  );
  const [imageModel, setImageModel] = useState<string>(
    initialSnapshot.settings.imageModel,
  );
  const [defaultBookFormat, setDefaultBookFormat] = useState<BookFormat>(
    initialSnapshot.settings.defaultBookFormat,
  );
  const [defaultPreviewFirst, setDefaultPreviewFirst] = useState<boolean>(
    initialSnapshot.settings.defaultPreviewFirst,
  );

  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSave(ev: React.FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    setIsSaving(true);
    setSaveMessage(null);
    setErrorMessage(null);

    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activeProvider,
          textModel: textModel.trim(),
          imageModel: imageModel.trim(),
          defaultBookFormat,
          defaultPreviewFirst,
        }),
      });
      const data = (await res.json()) as SettingsSnapshot & { error?: string };
      if (!res.ok) {
        setErrorMessage(data.error || 'Nie udało się zapisać ustawień.');
        return;
      }
      setSnapshot(data);
      setSaveMessage('Zapisano domyślne ustawienia pracowni AI.');
    } catch {
      setErrorMessage('Błąd połączenia podczas zapisywania ustawień.');
    } finally {
      setIsSaving(false);
    }
  }

  const quotaPct =
    snapshot.quota.limit > 0
      ? Math.min(100, Math.round((snapshot.quota.used / snapshot.quota.limit) * 100))
      : 100;

  const nanoFull = estimateClientStoryCost({
    provider: 'gemini-api',
    pageCount: 10,
    generationMode: 'full',
    imageModel: 'gemini-nano-banana-2.1',
  });
  const nanoPreview = estimateClientStoryCost({
    provider: 'gemini-api',
    pageCount: 10,
    generationMode: 'preview-first',
    imageModel: 'gemini-nano-banana-2.1',
  });
  const proFull = estimateClientStoryCost({
    provider: 'gemini-api',
    pageCount: 10,
    generationMode: 'full',
    imageModel: 'gemini-3-pro-image',
  });

  return (
    <div>
      <section className="page-intro">
        <span className="eyebrow">Konfiguracja dostawców i bezpieczników</span>
        <h1 className="page-title">Ustawienia AI i gotowość subskrypcji Google</h1>
        <p className="page-lead">
          Wybierz domyślny adapter generowania bajek, kontroluj dzienny limit obrazów oraz
          sprawdź status integracji Google Gemini API i nadchodzącego adaptera subskrypcji
          Google AI Pro/Ultra.
        </p>
      </section>

      <div className="settings-grid">
        {/* Left column: Active Settings Form & Provider Matrix */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          <form className="paper-card" onSubmit={handleSave}>
            <h2 className="section-heading">Domyślna konfiguracja pracowni</h2>
            <p className="section-note">
              Zmienne tajne (klucze API, tokeny OAuth) są zawsze wczytywane wyłącznie po
              stronie serwera z pliku <code>.env</code> lub panelu Vercel — nigdy nie trafiają
              do przeglądarki.
            </p>

            <div className="field-grid" style={{ marginBottom: 16 }}>
              <div className="field-group full-span">
                <label className="field-label" htmlFor="settingsProvider">
                  Domyślny dostawca AI (<code>StoryProvider</code>)
                </label>
                <select
                  id="settingsProvider"
                  className="field-select"
                  value={activeProvider}
                  onChange={(e) => setActiveProvider(e.target.value as ProviderId)}
                  data-testid="settings-provider-select"
                >
                  <option value="demo">demo — Tryb Demo (akwarele wbudowane, 0 zł)</option>
                  <option value="manual">
                    manual — Tryb Ręczny (prompty pod Nano Banana, 0 zł)
                  </option>
                  <option value="gemini-api">
                    gemini-api — Google Gemini API (@google/genai)
                  </option>
                  <option value="google-subscription">
                    google-subscription — Subskrypcja Google AI Pro/Ultra (~2 grudnia 2026)
                  </option>
                </select>
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="textModel">
                  Model tekstowy (JSON + Biblia Postaci)
                </label>
                <input
                  id="textModel"
                  type="text"
                  className="field-input"
                  value={textModel}
                  onChange={(e) => setTextModel(e.target.value)}
                />
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="imageModel">
                  Model obrazów (twarz + kotwica okładki)
                </label>
                <select
                  id="imageModel"
                  className="field-select"
                  value={imageModel}
                  onChange={(e) => setImageModel(e.target.value)}
                >
                  <option value="gemini-nano-banana-2.1">gemini-nano-banana-2.1</option>
                  <option value="gemini-3-pro-image">gemini-3-pro-image</option>
                </select>
              </div>

              <div className="field-group full-span">
                <label className="field-label" htmlFor="defaultBookFormat">
                  Domyślny format PDF
                </label>
                <select
                  id="defaultBookFormat"
                  className="field-select"
                  value={defaultBookFormat}
                  onChange={(e) => setDefaultBookFormat(e.target.value as BookFormat)}
                >
                  <option value="square">Kwadrat 21×21 cm</option>
                  <option value="a4-landscape">A4 poziomy (29,7×21 cm)</option>
                </select>
              </div>
            </div>

            <label className="toggle-row" style={{ marginBottom: 16 }}>
              <input
                type="checkbox"
                checked={defaultPreviewFirst}
                onChange={(e) => setDefaultPreviewFirst(e.target.checked)}
              />
              <span>
                <strong>Domyślnie włącz tryb „Najpierw okładka + 1. strona na próbę”</strong>
                <br />
                <span className="field-hint">
                  Chroni budżet API — generuje 2 obrazy zamiast 11 przy starcie nowej bajki.
                </span>
              </span>
            </label>

            {errorMessage && (
              <div className="alert alert-error" role="alert" style={{ marginBottom: 12 }}>
                {errorMessage}
              </div>
            )}
            {saveMessage && (
              <div className="alert alert-success" role="status" style={{ marginBottom: 12 }}>
                {saveMessage}
              </div>
            )}

            <button
              type="submit"
              className="btn btn-primary"
              disabled={isSaving}
              data-testid="settings-save-btn"
            >
              {isSaving ? 'Zapisywanie…' : 'Zapisz ustawienia'}
            </button>
          </form>

          {/* 4 Adapter Status Cards */}
          <section className="paper-card">
            <h2 className="section-heading">Dostępne adaptery AI</h2>
            <p className="section-note">
              Wszystkie 4 adaptery implementują jeden kontrakt <code>StoryProvider</code> —
              przełączanie nie wymaga żadnych zmian w kreatorze ani generatorze PDF.
            </p>
            <div className="provider-cards">
              {snapshot.providers.map((p) => (
                <div
                  key={p.id}
                  className={`provider-card${activeProvider === p.id ? ' is-selected' : ''}`}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 6,
                      flexWrap: 'wrap',
                    }}
                  >
                    <strong>{p.name}</strong>
                    <span
                      className={`badge ${p.available ? 'badge-sage' : 'badge-gold'}`}
                    >
                      {p.available ? 'Gotowy' : 'Wymaga konfiguracji'}
                    </span>
                  </div>
                  <p className="field-hint">{p.description}</p>
                  <p className="field-hint">
                    <code>authStrategy: {p.authStrategy}</code>
                  </p>
                </div>
              ))}
            </div>
          </section>

          {/* Dedicated Google Subscription Adapter Section (~2 Dec 2026) */}
          <section
            className="paper-card"
            data-testid="subscription-adapter-section"
          >
            <span className="eyebrow">
              Gotowość na {snapshot.envStatus.subscriptionPlannedDate}
            </span>
            <h2 className="section-heading">
              Adapter <code>google-subscription</code> (Google AI Pro / Ultra)
            </h2>
            <p className="section-note">
              Wydzielony w pliku <code>src/lib/ai/subscription-adapter.ts</code> z osobnym
              interfejsem autoryzacji{' '}
              <code>AuthStrategy = &apos;api_key&apos; | &apos;subscription_oauth_stub&apos;</code>.
              Gdy Google otworzy płatne subskrypcje Google AI Pro/Ultra dla zewnętrznych
              agentów i aplikacji (planowane od {snapshot.envStatus.subscriptionPlannedDate}),
              wystarczy ustawić poniższe zmienne środowiskowe bez refaktoryzacji aplikacji:
            </p>

            <ul className="env-list" style={{ marginBottom: 12 }}>
              <li>
                <code>GOOGLE_AI_AUTH_STRATEGY</code>
                <span className="badge badge-gold">
                  {snapshot.envStatus.googleAuthStrategy}
                </span>
              </li>
              <li>
                <code>GOOGLE_SUBSCRIPTION_ENDPOINT</code>
                <span
                  className={`badge ${snapshot.envStatus.hasSubscriptionEndpoint ? 'badge-sage' : ''}`}
                >
                  {snapshot.envStatus.hasSubscriptionEndpoint ? 'Ustawiono' : 'Brak'}
                </span>
              </li>
              <li>
                <code>GOOGLE_SUBSCRIPTION_TOKEN</code>
                <span
                  className={`badge ${snapshot.envStatus.hasSubscriptionToken ? 'badge-sage' : ''}`}
                >
                  {snapshot.envStatus.hasSubscriptionToken ? 'Ustawiono (zamaskowano)' : 'Brak'}
                </span>
              </li>
              <li>
                <code>GOOGLE_SUBSCRIPTION_TIER</code>
                <span className="badge">{snapshot.envStatus.subscriptionTier}</span>
              </li>
            </ul>

            <p className="field-hint">{snapshot.envStatus.subscriptionReadyReason}</p>
          </section>
        </div>

        {/* Right column: Quota, Storage Mode, Env Readiness, Cost Table */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          <section className="paper-card" data-testid="quota-status">
            <h2 className="section-heading">Dzienny bezpiecznik obrazów</h2>
            <p className="section-note">
              Twardy limit <code>MAX_DAILY_IMAGE_GENERATIONS</code> chroni przed
              niekontrolowanym kosztem API. Błędy HTTP <code>400 / 402 / 403</code> nigdy
              nie są ponawiane (<code>attempts: 1</code>).
            </p>
            <div className="cost-row" style={{ marginBottom: 8 }}>
              <span>
                Zużyto dziś ({snapshot.quota.date}):{' '}
                <strong>
                  {snapshot.quota.used} / {snapshot.quota.limit}
                </strong>
              </span>
              <span className="badge badge-sage">
                Pozostało: {snapshot.quota.remaining}
              </span>
            </div>
            <div className="quota-bar-track" aria-hidden="true">
              <div className="quota-bar-fill" style={{ width: `${quotaPct}%` }} />
            </div>
          </section>

          <section className="paper-card">
            <h2 className="section-heading">Środowisko i zapis danych</h2>
            <p className="section-note">
              Lokalnie bajki zapisują się w katalogu <code>data/</code>, a na Vercel
              aplikacja automatycznie przełącza się na zapis w <code>/tmp</code>.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
              <span
                className="badge badge-terracotta"
                data-testid="storage-mode-badge"
              >
                Tryb zapisu:{' '}
                {snapshot.storageMode === 'local'
                  ? 'local (dysk lokalny)'
                  : 'tmp-fallback (/tmp na Vercel)'}
              </span>
              <span
                className={`badge ${snapshot.envStatus.hasGeminiApiKey ? 'badge-sage' : ''}`}
              >
                GEMINI_API_KEY:{' '}
                {snapshot.envStatus.hasGeminiApiKey ? 'Skonfigurowano' : 'Brak'}
              </span>
            </div>

            <h3 style={{ fontSize: '1rem', marginBottom: 8 }}>
              Orientacyjna tabela kosztów (10 stron + okładka)
            </h3>
            <table className="cost-table">
              <thead>
                <tr>
                  <th>Tryb / Model</th>
                  <th>Obrazy</th>
                  <th>Szacunek</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Tryb Demo / Ręczny</td>
                  <td>0 API</td>
                  <td>0,00 zł</td>
                </tr>
                <tr>
                  <td>Nano Banana 2.1 (próba)</td>
                  <td>{nanoPreview.imagesNow}</td>
                  <td>
                    {nanoPreview.formattedNowPln} ({nanoPreview.formattedNowUsd})
                  </td>
                </tr>
                <tr>
                  <td>Nano Banana 2.1 (pełna)</td>
                  <td>{nanoFull.imagesNow}</td>
                  <td>
                    {nanoFull.formattedNowPln} ({nanoFull.formattedNowUsd})
                  </td>
                </tr>
                <tr>
                  <td>Gemini 3 Pro Image (pełna)</td>
                  <td>{proFull.imagesNow}</td>
                  <td>
                    {proFull.formattedNowPln} ({proFull.formattedNowUsd})
                  </td>
                </tr>
              </tbody>
            </table>
          </section>
        </div>
      </div>
    </div>
  );
}

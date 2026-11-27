'use client';

import { useEffect, useState } from 'react';
import { OrderLookupWidget } from '@/components/OrderLookupWidget';
import type { KnowledgeBaseArticle } from '@/lib/support/knowledge-base';

interface HelpCenterProps {
  initialArticles: readonly KnowledgeBaseArticle[];
  categories: readonly string[];
}

export function HelpCenter({ initialArticles, categories }: HelpCenterProps) {
  const [query, setQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('');
  const [articles, setArticles] = useState<readonly KnowledgeBaseArticle[]>(initialArticles);
  const [isSearching, setIsSearching] = useState(false);

  // Customer inquiry state
  const [customerEmail, setCustomerEmail] = useState('');
  const [orderNumber, setOrderNumber] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [inquiryResult, setInquiryResult] = useState<{
    ticketId: string;
    shouldEscalate: boolean;
  } | null>(null);
  const [inquiryError, setInquiryError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function runSearch() {
      setIsSearching(true);
      try {
        const params = new URLSearchParams();
        if (query.trim()) params.set('q', query.trim());
        if (selectedCategory) params.set('category', selectedCategory);
        const res = await fetch(`/api/support/kb?${params.toString()}`, {
          cache: 'no-store',
        });
        if (!res.ok) return;
        const data = (await res.json()) as { articles?: KnowledgeBaseArticle[] };
        if (!cancelled && data.articles) {
          setArticles(data.articles);
        }
      } catch {
        // Keep last loaded articles
      } finally {
        if (!cancelled) setIsSearching(false);
      }
    }

    const timer = window.setTimeout(() => {
      void runSearch();
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, selectedCategory]);

  async function handleInquirySubmit(event: React.FormEvent) {
    event.preventDefault();
    setInquiryError(null);
    setInquiryResult(null);
    setIsSending(true);
    try {
      const res = await fetch('/api/support/inquiries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerEmail: customerEmail.trim(),
          ...(orderNumber.trim() ? { orderNumber: orderNumber.trim() } : {}),
          subject: subject.trim(),
          message: message.trim(),
        }),
      });
      const data = (await res.json()) as {
        ticket?: { id: string };
        escalation?: { shouldEscalate: boolean };
        error?: string;
      };
      if (!res.ok || !data.ticket) {
        setInquiryError(data.error || 'Nie udało się wysłać zgłoszenia.');
        return;
      }
      setInquiryResult({
        ticketId: data.ticket.id,
        shouldEscalate: Boolean(data.escalation?.shouldEscalate),
      });
      setSubject('');
      setMessage('');
    } catch {
      setInquiryError('Błąd sieci podczas wysyłania zgłoszenia.');
    } finally {
      setIsSending(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <section className="paper-card">
        <h2 className="section-heading">Baza wiedzy i najczęstsze pytania</h2>
        <p className="section-note" style={{ marginBottom: 12 }}>
          Przeszukaj odpowiedzi dotyczące formatów książek, przygotowania zdjęć, prywatności
          RODO i statusu zamówień.
        </p>

        <div className="field-group" style={{ marginBottom: 12 }}>
          <label className="field-label" htmlFor="kbSearchInput">
            Szukaj w bazie wiedzy
          </label>
          <input
            id="kbSearchInput"
            type="search"
            className="field-input"
            placeholder="np. RODO, zdjęcia, kwadrat, spady, status…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="kb-search-input"
          />
        </div>

        <div className="chips-wrap" style={{ marginBottom: 16 }}>
          <button
            type="button"
            className={`chip${selectedCategory === '' ? ' is-active' : ''}`}
            onClick={() => setSelectedCategory('')}
          >
            Wszystkie ({initialArticles.length})
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              className={`chip${selectedCategory === cat ? ' is-active' : ''}`}
              onClick={() => setSelectedCategory(cat)}
            >
              {cat}
            </button>
          ))}
        </div>

        {isSearching && (
          <p className="field-hint" style={{ marginBottom: 8 }}>
            Wyszukiwanie…
          </p>
        )}

        {articles.length === 0 ? (
          <p className="field-hint">
            Brak artykułów pasujących do zapytania. Napisz do nas poniżej, a przekażemy sprawę
            opiekunowi.
          </p>
        ) : (
          <div className="kb-grid">
            {articles.map((article) => (
              <article
                key={article.id}
                className="kb-card"
                data-testid="kb-article-card"
              >
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                  <span className="badge badge-gold">{article.category}</span>
                  {article.policyStatus === 'tbd_business_decision' && (
                    <span className="badge">Warunki handlowe w przygotowaniu</span>
                  )}
                </div>
                <h3 style={{ fontSize: '1.02rem', marginBottom: 6 }}>{article.title}</h3>
                <p className="field-hint" style={{ marginBottom: 8 }}>
                  {article.summary}
                </p>
                <p style={{ fontSize: '0.88rem', lineHeight: 1.55 }}>{article.content}</p>
              </article>
            ))}
          </div>
        )}
      </section>

      <div data-testid="help-order-lookup">
        <OrderLookupWidget
          title="Szybkie sprawdzenie statusu zamówienia"
          description="Weryfikacja odbywa się wyłącznie po numerze zamówienia i adresie e-mail lub kodzie pocztowym — nigdy nie ujawniamy pełnego adresu."
        />
      </div>

      <section className="paper-card">
        <h2 className="section-heading">Wyślij wiadomość do pracowni</h2>
        <p className="section-note" style={{ marginBottom: 14 }}>
          Zgłoszenia dotyczące reklamacji, zwrotów i wniosków RODO są automatycznie kierowane
          do człowieka (administratora), a dane wrażliwe (np. PESEL, telefon) są maskowane.
        </p>

        <form className="form-grid" onSubmit={(e) => void handleInquirySubmit(e)}>
          <div className="field-group">
            <label className="field-label" htmlFor="inquiryEmail">
              Twój adres e-mail
            </label>
            <input
              id="inquiryEmail"
              type="email"
              className="field-input"
              required
              value={customerEmail}
              onChange={(e) => setCustomerEmail(e.target.value)}
              placeholder="np. rodzic@example.com"
            />
          </div>
          <div className="field-group">
            <label className="field-label" htmlFor="inquiryOrderNumber">
              Numer zamówienia (opcjonalnie)
            </label>
            <input
              id="inquiryOrderNumber"
              type="text"
              className="field-input"
              value={orderNumber}
              onChange={(e) => setOrderNumber(e.target.value)}
              placeholder="np. BK-2026-ABC123"
            />
          </div>
          <div className="field-group full-span">
            <label className="field-label" htmlFor="inquirySubject">
              Temat
            </label>
            <input
              id="inquirySubject"
              type="text"
              className="field-input"
              required
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="W czym możemy pomóc?"
            />
          </div>
          <div className="field-group full-span">
            <label className="field-label" htmlFor="inquiryMessage">
              Wiadomość
            </label>
            <textarea
              id="inquiryMessage"
              className="field-textarea"
              required
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Opisz swoje pytanie lub numer strony w bajce…"
            />
          </div>
          <div className="field-group full-span">
            <button type="submit" className="btn btn-primary btn-sm" disabled={isSending}>
              {isSending ? 'Wysyłanie…' : 'Wyślij zgłoszenie'}
            </button>
          </div>
        </form>

        {inquiryError && (
          <div className="alert alert-error" role="alert" style={{ marginTop: 12 }}>
            {inquiryError}
          </div>
        )}
        {inquiryResult && (
          <div className="alert alert-success" role="status" style={{ marginTop: 12 }}>
            Zapisano zgłoszenie <strong>{inquiryResult.ticketId}</strong>.
            {inquiryResult.shouldEscalate
              ? ' Zgłoszenie zostało automatycznie oznaczone do priorytetowej obsługi przez opiekuna.'
              : ' Dziękujemy za wiadomość!'}
          </div>
        )}
      </section>
    </div>
  );
}

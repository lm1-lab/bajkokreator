'use client';

import { useState } from 'react';

interface CustomerOrderStatusView {
  orderNumber: string;
  status: string;
  statusLabelPl: string;
  nextStepPl: string;
  paymentStatus: string;
  bookFormat: string;
  quantity: number;
  customerApproved: boolean;
  preflightPassed: boolean;
  trackingNumber?: string;
  trackingUrl?: string;
  createdAt: string;
  updatedAt: string;
  timeline: Array<{
    status: string;
    labelPl: string;
    timestamp: string;
  }>;
}

interface OrderLookupWidgetProps {
  title?: string;
  description?: string;
}

export function OrderLookupWidget({
  title = 'Sprawdź status zamówienia',
  description = 'Podaj numer zamówienia (np. BK-2026-XXXXXX) oraz adres e-mail lub kod pocztowy z adresu dostawy.',
}: OrderLookupWidgetProps) {
  const [orderNumber, setOrderNumber] = useState('');
  const [verification, setVerification] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusView, setStatusView] = useState<CustomerOrderStatusView | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setErrorMessage(null);
    setStatusView(null);
    setIsLoading(true);
    try {
      const res = await fetch('/api/support/order-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderNumber: orderNumber.trim(),
          verification: verification.trim(),
        }),
      });
      const data = (await res.json()) as {
        found?: boolean;
        statusView?: CustomerOrderStatusView;
        error?: string;
      };
      if (!res.ok || !data.found || !data.statusView) {
        setErrorMessage(
          data.error ||
            'Nie znaleziono zamówienia lub podane dane weryfikacyjne są nieprawidłowe.',
        );
        return;
      }
      setStatusView(data.statusView);
    } catch {
      setErrorMessage('Błąd połączenia z serwerem podczas sprawdzania statusu.');
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <section className="paper-card">
      <h2 className="section-heading">{title}</h2>
      <p className="section-note" style={{ marginBottom: 14 }}>
        {description}
      </p>

      <form className="form-grid" onSubmit={(e) => void handleSubmit(e)}>
        <div className="field-group">
          <label className="field-label" htmlFor="lookupOrderNumber">
            Numer zamówienia
          </label>
          <input
            id="lookupOrderNumber"
            type="text"
            className="field-input"
            placeholder="np. BK-2026-ABC123"
            value={orderNumber}
            onChange={(e) => setOrderNumber(e.target.value)}
            data-testid="order-lookup-number"
            required
          />
        </div>

        <div className="field-group">
          <label className="field-label" htmlFor="lookupVerification">
            E-mail lub kod pocztowy
          </label>
          <input
            id="lookupVerification"
            type="text"
            className="field-input"
            placeholder="np. anna@example.com lub 00-001"
            value={verification}
            onChange={(e) => setVerification(e.target.value)}
            data-testid="order-lookup-verification"
            required
          />
        </div>

        <div className="field-group full-span">
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={isLoading}
            data-testid="order-lookup-submit"
          >
            {isLoading ? 'Sprawdzanie…' : 'Sprawdź status zamówienia'}
          </button>
        </div>
      </form>

      {errorMessage && (
        <div className="alert alert-error" role="alert" style={{ marginTop: 14 }}>
          {errorMessage}
        </div>
      )}

      {statusView && (
        <div
          className="status-card"
          data-testid="order-status-card"
          style={{ marginTop: 16 }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              flexWrap: 'wrap',
              marginBottom: 8,
            }}
          >
            <strong style={{ fontSize: '1.05rem' }}>{statusView.orderNumber}</strong>
            <span className="badge badge-sage">{statusView.statusLabelPl}</span>
          </div>
          <p className="field-hint" style={{ marginBottom: 10 }}>
            {statusView.nextStepPl}
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            <span className="badge">
              Format: {statusView.bookFormat === 'square' ? 'Kwadrat 21×21 cm' : 'A4 poziomy'}
            </span>
            <span className="badge">Liczba sztuk: {statusView.quantity}</span>
            <span className={`badge ${statusView.customerApproved ? 'badge-sage' : 'badge-gold'}`}>
              Akceptacja podglądu: {statusView.customerApproved ? 'Tak' : 'Oczekuje'}
            </span>
            <span className={`badge ${statusView.preflightPassed ? 'badge-sage' : 'badge-gold'}`}>
              Pre-Flight: {statusView.preflightPassed ? 'Zaliczony' : 'W trakcie'}
            </span>
          </div>
          {statusView.trackingNumber && (
            <p className="field-hint">
              <strong>Numer przesyłki:</strong> {statusView.trackingNumber}
            </p>
          )}
          {statusView.timeline.length > 0 && (
            <ol className="order-timeline">
              {statusView.timeline.map((step, idx) => (
                <li key={`${step.status}-${idx}`}>
                  <strong>{step.labelPl}</strong>
                  <span className="field-hint">
                    {' '}
                    ({new Date(step.timestamp).toLocaleString('pl-PL')})
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}

# BajkoKreator

Generator spersonalizowanych 10-stronicowych ilustrowanych bajek dla dzieci po polsku (13-stronicowy PDF gotowy do druku: okładka, dedykacja ze zdjęciem dziecka w ramce, strony 1–10 oraz tylna okładka), zbudowany na **Next.js App Router (TypeScript)** i **Vanilla CSS** (bez Tailwinda), gotowy do darmowego wdrożenia na **Vercel**.

## Najważniejsze funkcje

- **Kreator bajki (`/`):** upload 1–4 zdjęć dziecka (drag & drop + kompresja JPEG w przeglądarce), imię, wiek (1–12), płeć z poprawną polską odmianą (dziewczynka / chłopiec), opcjonalny towarzysz, 6 klikalnych inspiracji, 4 style graficzne, 4 nastroje, liczba stron (4–12, domyślnie 10), kalkulator kosztów, tryb próbny „Najpierw okładka + 1. strona na próbę” oraz podgląd okładki na żywo.
- **Podgląd i edycja książki (`/story/[id]`):** nawigacja URL-driven (`?slide=0..12`, `?view=all` bez `<Suspense>` i `useSearchParams()`), edycja tekstu na miejscu z trwałym zapisem, kopiowanie angielskiego promptu z niezmienną „Biblią Postaci” pod Nano Banana 1 kliknięciem, podmiana ilustracji własnym plikiem (JPG/PNG/WebP).
- **Deterministyczny eksport PDF (`pdf-lib` + `@pdf-lib/fontkit`):** osadzone polskie fonty TTF (`Lora` i `Plus Jakarta Sans`, pełne `ą ć ę ł ń ó ś ź ż`), formaty **Kwadrat 21×21 cm** i **A4 poziomy**, prawdziwe pobieranie binarne (`Blob` + `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`).
- **4 wymienne adaptery AI (`src/lib/ai/provider.ts`):**
  1. `demo` (domyślny, 0 zł, bez klucza API) — natychmiastowa spersonalizowana bajka po polsku ze spójnymi akwarelowymi ilustracjami książkowymi (~150 KB).
  2. `manual` — pełny scenariusz + gotowe angielskie prompty pod Gemini / Nano Banana + ręczne dogrywanie ilustracji.
  3. `gemini-api` (`@google/genai`) — `gemini-3.8-flash` (strukturalny JSON + Biblia Postaci) oraz `gemini-nano-banana-2.1` / `gemini-3-pro-image` (twarz ze zdjęć referencyjnych + okładka jako kotwica stylu dla stron 2–10), twardy dzienny limit `MAX_DAILY_IMAGE_GENERATIONS=30` i brak ponowień przy `400/402/403`.
  4. `google-subscription` (`src/lib/ai/subscription-adapter.ts`) — wydzielony adapter z `AuthStrategy` (`api_key` | `subscription_oauth_stub`) przygotowany pod planowane otwarcie płatnych subskrypcji Google AI Pro/Ultra (~2 grudnia 2026).
- **Biblioteka (`/library`) i Ustawienia (`/settings`):** półka z zapisanymi bajkami, szybkie pobieranie PDF, dwustopniowe usuwanie, licznik dziennej puli obrazów i status zapisu (`data/` lokalnie z automatycznym fallbackiem do `/tmp` na Vercel).
- **Fundament pod druk, obsługę klienta i system agentyczny (niezależny od dostawców):**
  - **Bezpieczeństwo i operacje (`/api/health`, `/api/ops/summary`, `/api/ops/retention/sweep`):** jednolity format błędów z `X-Request-Id`, strukturalny logger z maskowaniem PII, port `OperatorAuthGuard`, `RateLimiter`, magistrala zdarzeń `DomainEventBus` + JSONL oraz automatyczny sweep retencji RODO (`npm run retention:sweep`).
  - **Katalog sezonowych motywów i walidacja (`src/content/themes.json`, `/api/catalog/{themes,validate,drafts}`):** 100% całoroczne pokrycie polskich pór roku i świąt (strefa `Europe/Warsaw`), walidator redakcyjny z syntetycznym pre-flightem, nieinwazyjna poczekalnia szkiców i CLI `npm run catalog:validate`.
  - **Pre-flight i PDF poligraficzny (`/api/stories/[id]/preflight`, `/api/stories/[id]/pdf`):** wspólna specyfikacja geometrii (`src/lib/pdf/layout-spec.ts`), weryfikacja DPI okładki/stron/portretu dedykacji, spady 3 mm, `TrimBox`/`BleedBox`, znaczniki cięcia poza `BleedBox`, tryby POD (`combined` / `interior` / `cover-wrap`) oraz dopełnienie stron do wielokrotności 4.
  - **Zamówienia, idempotencja, webhooki i manifest druku (`/api/orders/*`, `/orders`):** port `OrderRepository` z optymistycznym wersjonowaniem, twarde allowlisty aktorów, limit zwrotów dla agentów (domyślnie `0 gr`), `IdempotencyStore`, weryfikator HMAC-SHA256 webhooków, SHA-256 `PrintJobManifest` oraz adaptery Dry-Run.
  - **Obsługa klienta i baza wiedzy (`/pomoc`, `/api/support/{kb,order-status,inquiries}`):** polska baza wiedzy (`src/content/knowledge-base.json`), weryfikowane sprawdzanie statusu zamówienia bez wycieku PII, obowiązkowa eskalacja (zwroty, reklamacje, RODO, chargeback/UOKiK) i automatyczna redakcja PII w zgłoszeniach.

## Uruchomienie lokalne

```bash
npm install
npm run dev
```

Aplikacja uruchomi się domyślnie w **Trybie Demo** (nie wymaga żadnych kluczy API).

## Weryfikacja i testy

```bash
npm run lint
npm run typecheck
npm run catalog:validate
npm test
npm run build
npm run test:e2e
```

## Darmowe wdrożenie na Vercel

1. Wypchnij repozytorium na GitHub (`lm1-lab/bajkokreator`, gałąź `main`).
2. Wejdź na [vercel.com/new](https://vercel.com/new) i zaimportuj repozytorium `lm1-lab/bajkokreator`.
3. Vercel automatycznie wykryje **Next.js** — pozostaw domyślne komendy budowania (`npm run build`).
4. *(Opcjonalnie — w Trybie Demo nie trzeba dodawać żadnych zmiennych!)* W zakładce **Settings → Environment Variables** możesz dodać:
   - `AI_PROVIDER=demo` (lub `manual`, `gemini-api`, `google-subscription`)
   - `GEMINI_API_KEY=...` (tylko dla `gemini-api`)
   - `GEMINI_TEXT_MODEL=gemini-3.8-flash`
   - `GEMINI_IMAGE_MODEL=gemini-nano-banana-2.1`
   - `MAX_DAILY_IMAGE_GENERATIONS=30`
   - Dla nadchodzącej subskrypcji Google AI (~2 grudnia 2026): `GOOGLE_AI_AUTH_STRATEGY=subscription_oauth_stub`, `GOOGLE_SUBSCRIPTION_ENDPOINT`, `GOOGLE_SUBSCRIPTION_TOKEN`, `GOOGLE_SUBSCRIPTION_TIER`.
5. Kliknij **Deploy** — aplikacja automatycznie użyje zapisu w `/tmp` na serwerach bezstanowych Vercel i udostępni pełny eksport PDF z osadzonymi polskimi fontami.

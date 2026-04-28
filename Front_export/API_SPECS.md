# HissabPro — API Specification
> Backend specification for Python migration
> Extracted from: `server.js` (12 498 lines), 46 migration files
> Date: 2026-04-27
> Version: 2.0.0

---

## A. Inventaire des Endpoints API

All endpoints are prefixed with `/api/`. Authentication via session cookie (`connect.sid`).
`requireAuth` = session required; `requireCabinetRole(['admin'])` = cabinet admin only.

### Authentication (`/api/auth/`)

| Method | URL | Auth | Description |
|--------|-----|------|-------------|
| POST | `/api/auth/signup` | No | Create user account |
| POST | `/api/auth/login` | No | Login, set session cookie |
| GET | `/api/auth/me` | Yes | Get current user + company |
| POST | `/api/auth/logout` | No | Destroy session |
| GET | `/api/auth/invitation/:token` | No | Validate client invitation token |
| POST | `/api/auth/signup-invitation` | No | Sign up via invitation token |
| GET | `/api/auth/member-invite/:token` | No | Validate member invite token |
| POST | `/api/auth/member-invite/:token` | No | Accept member invite, set password |

**POST /api/auth/signup**
```json
// Request
{ "email": "user@example.com", "password": "secret123", "name": "Ahmed Benali" }
// Response 201
{ "user": { "id": 1, "email": "user@example.com", "name": "Ahmed Benali", "user_type": "standard" }, "sessionId": "abc..." }
// Errors: 400 (missing fields), 409 (email already exists)
```

**POST /api/auth/login**
```json
// Request
{ "email": "user@example.com", "password": "secret123" }
// Response 200
{ "user": { "id": 1, "email": "...", "name": "...", "user_type": "standard|cabinet", "cabinet_role": null }, "company": { "id": 1, "name": "..." } }
// Errors: 401 (invalid credentials)
```

**GET /api/auth/me**
```json
// Response 200
{
  "user": { "id": 1, "email": "...", "name": "...", "user_type": "standard|cabinet", "cabinet_role": "admin|chef_mission|collaborateur" },
  "company": { "id": 1, "name": "...", "ice": "...", "idf": "...", "rc": "..." },
  "activeDossierId": null
}
// Errors: 401 (not authenticated)
```

---

### Company (`/api/company`)

| Method | URL | Auth | Description |
|--------|-----|------|-------------|
| GET | `/api/company` | Yes | Get current company profile |
| POST | `/api/company` | Yes | Create/update company profile |
| POST | `/api/onboarding` | Yes | Submit onboarding data |
| POST | `/api/onboarding/reset` | Yes | Reset onboarding |
| POST | `/api/onboarding/register-entreprise` | No (rate limited) | Self-service company registration |
| PUT | `/api/user/type` | Yes | Switch user type (standard/cabinet) |

**GET /api/company**
```json
// Response 200
{
  "id": 1, "name": "SARL MonEntreprise", "ice": "001234567890123",
  "idf": "12345678", "rc": "12345", "cnss": "123456789",
  "address": "123 Rue Hassan II", "city": "Casablanca",
  "phone": "0522001122", "email": "contact@entreprise.ma",
  "forme_juridique": "SARL", "type_comptabilite": "Engagement",
  "default_tva_rate": 20.00, "currency": "MAD",
  "rib": "007780000123456789012345", "bank_name": "Attijariwafa Bank",
  "fiscal_year_start": 1, "logo_url": null,
  "frequence_tva": "mensuel"
}
```

**POST /api/company**
```json
// Request (all optional except name)
{
  "name": "SARL MonEntreprise", "ice": "001234567890123",
  "idf": "12345678", "rc": "12345", "cnss": "123456789",
  "address": "...", "city": "Casablanca", "phone": "0522001122",
  "email": "contact@ma.ma", "forme_juridique": "SARL",
  "type_comptabilite": "Engagement", "default_tva_rate": 20,
  "rib": "007...", "bank_name": "Attijariwafa Bank"
}
// Response 200: { "company": {...} }
```

---

### Accounts / Chart of Accounts (`/api/accounts`)

| Method | URL | Auth | Description |
|--------|-----|------|-------------|
| GET | `/api/accounts` | Yes | List PCM accounts |

**GET /api/accounts**
```
// Query params: ?class=3&type=asset&search=client
// Response 200
{ "accounts": [{ "code": "3421", "name": "Clients", "class": 3, "type": "asset", "is_active": true }] }
```

---

### Contacts / Fournisseurs (`/api/contacts`)

| Method | URL | Auth | Description |
|--------|-----|------|-------------|
| GET | `/api/contacts` | Yes | List contacts (clients/fournisseurs) |
| POST | `/api/contacts` | Yes | Create contact |

**GET /api/contacts**
```
// Query params: ?type=client|fournisseur|both&search=text
// Response 200
{ "contacts": [{ "id": 1, "type": "client", "name": "...", "ice": "...", "account_code": "3421" }] }
```

**POST /api/contacts**
```json
// Request
{ "type": "client", "name": "SARL Client", "ice": "001234567890123", "idf": "123", "rc": "456", "address": "...", "city": "Rabat", "phone": "...", "email": "..." }
// Response 201: { "contact": {...} }
```

---

### Invoices — Factures (`/api/invoices`)

| Method | URL | Auth | Description |
|--------|-----|------|-------------|
| GET | `/api/invoices` | Yes | List invoices |
| GET | `/api/invoices/:id` | Yes | Get invoice detail |
| GET | `/api/invoices/:id/xml` | Yes | Export invoice as UBL 2.1 / CII XML |
| POST | `/api/invoices` | Yes | Create invoice + journal entry |
| PUT | `/api/invoices/:id/status` | Yes | Update invoice status |
| POST | `/api/invoices/:id/cancel` | Yes | Cancel invoice (creates avoir) |
| POST | `/api/invoices/:id/attachment` | Yes | Upload attachment |
| GET | `/api/invoices/:id/attachment` | Yes | Download attachment |
| GET | `/api/invoices/:id/has-attachment` | Yes | Check attachment exists |
| GET | `/api/invoices/:id/export` | Yes | Export invoice PDF |

**GET /api/invoices**
```
// Query params: ?type=sale|purchase&status=draft|sent|paid|cancelled|overdue&page=1&limit=50&date_from=2025-01-01&date_to=2025-12-31&search=text
// Response 200
{
  "invoices": [{
    "id": 1, "invoice_number": "F-2025-001", "type": "sale",
    "status": "sent", "date": "2025-01-15", "due_date": "2025-02-15",
    "subtotal": 10000.00, "tva_amount": 2000.00, "total": 12000.00,
    "tva_rate": 20.00, "contact_name": "SARL Client", "ice_client": "001...",
    "journal_entry_id": 5
  }],
  "total": 42, "page": 1, "limit": 50
}
```

**POST /api/invoices** *(Auto-creates double-entry journal)*
```json
// Request
{
  "type": "vente",  // "vente"|"achat"|"sale"|"purchase"
  "contact_id": 1,  // optional, fournisseur/client from contacts table
  "client_id": 2,   // optional, from clients table (vente module)
  "date": "2025-01-15",
  "due_date": "2025-02-15",
  "ice_client": "001234567890123",  // mandatory for type=sale
  "tva_rate": 20,   // default rate, overridden per line
  "payment_method": "virement",
  "notes": "Prestations informatiques",
  "lines": [
    {
      "description": "Développement web",
      "quantity": 1,
      "unit_price": 10000.00,
      "tva_rate": 20,    // can differ per line: 0|7|10|14|20
      "account_code": "7124"  // optional, defaults to 7111 (sale) or 6111 (purchase)
    }
  ]
}
// Response 200
{ "invoice": { "id": 1, "invoice_number": "F-2025-001", "journal_entry_id": 5, ... } }
// Errors: 400 (missing type/lines), 422 (ICE missing for sale)
```

**PUT /api/invoices/:id/status**
```json
// Request
{ "status": "sent" }  // draft|sent|paid|cancelled|overdue|validated|partially_paid
// Response 200: { "invoice": {...} }
// Note: cannot set "cancelled" directly — use POST /api/invoices/:id/cancel
```

---

### Devis / Quotes (`/api/vente/quotes`)

| Method | URL | Auth | Description |
|--------|-----|------|-------------|
| GET | `/api/vente/quotes` | Yes | List quotes |
| POST | `/api/vente/quotes` | Yes | Create quote |
| GET | `/api/vente/quotes/:id` | Yes | Get quote detail |
| PUT | `/api/vente/quotes/:id` | Yes | Update quote |
| DELETE | `/api/vente/quotes/:id` | Yes | Delete quote |
| PUT | `/api/vente/quotes/:id/status` | Yes | Update quote status |
| POST | `/api/vente/quotes/:id/convert` | Yes | Convert quote to invoice |

**POST /api/vente/quotes**
```json
// Request
{
  "client_id": 1, "date": "2025-01-10", "valid_until": "2025-01-25",
  "notes": "Devis valable 15 jours",
  "lines": [{ "description": "...", "quantity": 1, "unit_price": 5000, "tva_rate": 20 }]
}
// Response 201: { "quote": { "id": 1, "quote_number": "DV-2025-001", ... } }
```

---

### Expenses — Achats / Charges (`/api/expenses`)

| Method | URL | Auth | Description |
|--------|-----|------|-------------|
| GET | `/api/expenses` | Yes | List expenses |
| POST | `/api/expenses` | Yes | Create expense |
| POST | `/api/expenses/import-multi` | Yes | Bulk import (OCR multi) |
| PATCH | `/api/expenses/:id/status` | Yes | Update status |
| DELETE | `/api/expenses/:id` | Yes | Delete expense |
| GET | `/api/expenses/:id/document` | Yes | Get attached document |
| GET | `/api/expenses/:id` | Yes | Get expense detail |
| PUT | `/api/expenses/:id` | Yes | Update expense |
| POST | `/api/expenses/:id/valider` | Yes | Validate expense (creates journal entry) |
| POST | `/api/expenses/:id/split` | Yes | Split expense into multiple lines |

**POST /api/expenses**
```json
// Request
{
  "date": "2025-01-10", "description": "Loyer bureau janvier",
  "amount": 5000.00, "tva_rate": 20, "tva_amount": 1000.00, "total": 6000.00,
  "account_code": "6131", "payment_method": "virement",
  "contact_id": 3, "category": "loyer"
}
// Response 201: { "expense": { "id": 1, "status": "pending", ... } }
```

**POST /api/expenses/:id/valider**
```json
// Creates journal entry: 6111 (debit HT) + 3455 TVA récupérable + 4411 Fournisseurs (credit TTC)
// Response 200: { "expense": { ..., "status": "approved", "journal_entry_id": 10 } }
```

---

### Journal Entries (`/api/journal-entries`)

| Method | URL | Auth | Description |
|--------|-----|------|-------------|
| GET | `/api/journal-entries` | Yes | List journal entries |
| GET | `/api/journal-entries/:id` | Yes | Get journal entry with lines |
| POST | `/api/journal-entries` | Yes | Create manual journal entry |

**GET /api/journal-entries**
```
// Query params: ?journal_type=AC|VE|BQ|CA|OD&date_from=&date_to=&page=1&limit=50
// Response 200
{
  "entries": [{
    "id": 1, "entry_number": "VE-F-2025-001", "date": "2025-01-15",
    "journal_type": "VE", "description": "Facture F-2025-001",
    "total_debit": 12000.00, "total_credit": 12000.00, "is_balanced": true,
    "lines": [
      { "account_code": "3421", "account_name": "Clients", "debit": 12000, "credit": 0 },
      { "account_code": "7111", "account_name": "Ventes...", "debit": 0, "credit": 10000 },
      { "account_code": "4455", "account_name": "TVA facturée", "debit": 0, "credit": 2000 }
    ]
  }]
}
```

**POST /api/journal-entries** *(Manual OD entry)*
```json
// Request
{
  "date": "2025-01-31", "journal_type": "OD", "description": "Ecriture de régularisation",
  "lines": [
    { "account_code": "1111", "account_name": "Capital social", "debit": 0, "credit": 10000 },
    { "account_code": "5141", "account_name": "Banque", "debit": 10000, "credit": 0 }
  ]
}
// Validation: SUM(debit) MUST equal SUM(credit)
// Response 201: { "entry": { "id": 1, "is_balanced": true, ... } }
// Error 400: { "error": "Écriture non équilibrée: débit=X, crédit=Y" }
```

---

### Dashboard (`/api/dashboard`)

| Method | URL | Auth | Description |
|--------|-----|------|-------------|
| GET | `/api/dashboard` | Yes | Main dashboard KPIs |
| GET | `/api/dashboard/comptabilite` | Yes | Accounting dashboard |
| GET | `/api/client/dashboard` | Yes | Client (dossier) dashboard |

**GET /api/dashboard**
```json
// Response 200
{
  "revenue_month": 150000.00, "expenses_month": 80000.00,
  "outstanding_receivables": 45000.00, "outstanding_payables": 20000.00,
  "tva_balance": 5000.00, "cash_position": 200000.00,
  "invoices_overdue": 3, "invoices_draft": 5,
  "recent_invoices": [...], "recent_expenses": [...]
}
```

---

### OCR (`/api/ocr/invoice`)

| Method | URL | Auth | Description |
|--------|-----|------|-------------|
| POST | `/api/ocr/invoice` | Yes (rate limited) | Extract data from invoice image/PDF via GPT-4o |

**POST /api/ocr/invoice** *(multipart/form-data)*
```
// Fields: file (PDF or image, max 10MB)
// Response 200
{
  "extracted": {
    "fournisseur": "SARL Alpha", "ice_fournisseur": "001234567890123",
    "date": "2025-01-15", "numero_facture": "FF-2025-042",
    "lignes": [{ "description": "Matériel", "quantite": 2, "prix_unitaire": 1500, "tva": 20 }],
    "total_ht": 3000.00, "tva_montant": 600.00, "total_ttc": 3600.00
  }
}
```

---

### TVA (`/api/tva/`)

| Method | URL | Auth | Description |
|--------|-----|------|-------------|
| GET | `/api/tva/declaration` | Yes | Compute TVA declaration for period |
| GET | `/api/tva/export-simpl-csv` | Yes | Export SIMPL-TVA CSV (DGI format) |
| POST | `/api/tva/declarations` | Yes | Save TVA declaration |
| GET | `/api/tva/declarations` | Yes | List saved TVA declarations |

**GET /api/tva/declaration**
```
// Query params: ?year=2025&month=1   (mensuel) OR ?year=2025&quarter=1 (trimestriel)
// Response 200
{
  "period": "2025-01", "regime": "mensuel",
  "tva_collectee": 15000.00, "tva_deductible": 8000.00,
  "tva_due": 7000.00, "credit_reporte": 0,
  "breakdown_collectee": [
    { "taux": 20, "base": 50000, "tva": 10000 },
    { "taux": 10, "base": 25000, "tva": 2500 },
    { "taux": 14, "base": 17857, "tva": 2500 }
  ],
  "breakdown_deductible": [
    { "taux": 20, "base": 30000, "tva": 6000 },
    { "taux": 10, "base": 20000, "tva": 2000 }
  ]
}
```

**GET /api/tva/export-simpl-csv**
```
// Query params: ?year=2025&month=1
// Response: CSV file download (UTF-8 BOM), DGI SIMPL-TVA format
// Content-Type: text/csv; charset=utf-8
```

---

### Comptabilité — Balance & Grand Livre

| Method | URL | Auth | Description |
|--------|-----|------|-------------|
| GET | `/api/balance` | Yes | Balance des comptes |
| GET | `/api/balance-generale` | Yes | Balance générale |
| GET | `/api/grand-livre` | Yes | Grand livre |
| GET | `/api/balance-agee` | Yes | Balance âgée clients/fournisseurs |

**GET /api/balance**
```
// Query params: ?date_from=2025-01-01&date_to=2025-12-31&class=3
// Response 200
{ "accounts": [{ "code": "3421", "name": "Clients", "debit": 150000, "credit": 100000, "solde": 50000 }] }
```

**GET /api/grand-livre**
```
// Query params: ?account_code=3421&date_from=&date_to=
// Response 200
{
  "account": { "code": "3421", "name": "Clients" },
  "lines": [{ "date": "2025-01-15", "reference": "F-2025-001", "debit": 12000, "credit": 0, "solde_cumul": 12000 }],
  "total_debit": 150000, "total_credit": 100000, "solde_final": 50000
}
```

---

### Lettrage (`/api/lettrage/`)

| Method | URL | Auth | Description |
|--------|-----|------|-------------|
| GET | `/api/lettrage/lines/:account_code` | Yes | Get unlettré lines for account |
| POST | `/api/lettrage/auto` | Yes | Auto-lettrage |
| POST | `/api/lettrage/manual` | Yes | Manual lettrage |
| DELETE | `/api/lettrage/:code` | Yes | Delettrage |

**POST /api/lettrage/manual**
```json
// Request: select journal lines to lettrer (mark as matched)
{ "line_ids": [1, 2, 3], "account_code": "3421" }
// Validation: SUM(debit of selected) == SUM(credit of selected)
// Response 200: { "lettrage_code": "A001", "lines_updated": 3 }
```

---

### Notifications (`/api/notifications`)

| Method | URL | Auth | Description |
|--------|-----|------|-------------|
| GET | `/api/notifications` | Yes | List notifications |
| GET | `/api/notifications/unread-count` | Yes | Unread count |
| PUT | `/api/notifications/:id/read` | Yes | Mark as read |
| PUT | `/api/notifications/read-all` | Yes | Mark all as read |
| GET | `/api/notifications/preferences` | Yes | Get preferences |
| PUT | `/api/notifications/preferences` | Yes | Update preferences |

---

### Cabinet / Fiduciaire (`/api/cabinet/`)

| Method | URL | Auth | Role |
|--------|-----|------|------|
| GET | `/api/cabinet/dossiers` | Yes | any cabinet |
| GET | `/api/cabinet/dossiers/:id` | Yes | any cabinet |
| POST | `/api/cabinet/dossiers` | Yes | admin |
| PUT | `/api/cabinet/dossiers/:id` | Yes | admin |
| POST | `/api/cabinet/dossiers/:id/invite-client` | Yes | admin |
| POST | `/api/cabinet/switch/:id` | Yes | any cabinet |
| GET | `/api/cabinet/collaborateurs` | Yes | any cabinet |
| GET | `/api/cabinet/messages` | Yes | any cabinet |
| POST | `/api/cabinet/messages` | Yes | any cabinet |
| PUT | `/api/cabinet/messages/:id/read` | Yes | any cabinet |
| PUT | `/api/cabinet/messages/read-all` | Yes | any cabinet |
| DELETE | `/api/cabinet/messages/:id` | Yes | any cabinet |
| GET | `/api/cabinet/documents` | Yes | any cabinet |
| POST | `/api/cabinet/documents` | Yes | any cabinet |
| GET | `/api/cabinet/documents/:id/download` | Yes | any cabinet |
| DELETE | `/api/cabinet/documents/:id` | Yes | any cabinet |
| GET | `/api/cabinet/justificatifs` | Yes | any cabinet |
| POST | `/api/cabinet/justificatifs` | Yes | any cabinet |
| PUT | `/api/cabinet/justificatifs/:id` | Yes | any cabinet |
| POST | `/api/cabinet/justificatifs/:id/respond` | Yes | any cabinet |
| DELETE | `/api/cabinet/justificatifs/:id` | Yes | any cabinet |
| GET | `/api/cabinet/collaboration/stats` | Yes | any cabinet |
| GET | `/api/cabinet/members` | Yes | admin |
| POST | `/api/cabinet/members` | Yes | admin |
| PUT | `/api/cabinet/members/:id` | Yes | admin |
| POST | `/api/cabinet/members/:id/resend-invite` | Yes | admin |
| DELETE | `/api/cabinet/members/:id` | Yes | admin |
| GET | `/api/cabinet/permissions` | Yes | any cabinet |
| GET | `/api/cabinet/members/:id/dossiers` | Yes | admin |
| PUT | `/api/cabinet/members/:id/dossiers` | Yes | admin |
| GET | `/api/cabinet/members-with-dossiers` | Yes | admin |
| GET | `/api/cabinet/clients` | Yes | any cabinet |
| GET | `/api/cabinet/clients/:id` | Yes | any cabinet |
| PUT | `/api/cabinet/clients/:id` | Yes | any cabinet |
| POST | `/api/cabinet/clients/:id/toggle-active` | Yes | admin |
| POST | `/api/cabinet/clients/:id/resend-invite` | Yes | admin |
| POST | `/api/cabinet/clients` | Yes | admin |
| GET | `/api/cabinet/billing` | Yes | any cabinet |
| POST | `/api/cabinet/billing/status` | Yes | admin |
| GET | `/api/cabinet/declarations-overview` | Yes | any cabinet |
| GET | `/api/cabinet/is-acomptes-overview` | Yes | any cabinet |
| GET | `/api/cabinet/cloture-overview` | Yes | any cabinet |
| GET | `/api/cabinet/saisie` | Yes | any cabinet |
| GET | `/api/cabinet/portefeuille` | Yes | any cabinet |
| GET | `/api/cabinet/prospects` | Yes | any cabinet |
| POST | `/api/cabinet/prospects` | Yes | any cabinet |
| PUT | `/api/cabinet/prospects/:id` | Yes | any cabinet |
| DELETE | `/api/cabinet/prospects/:id` | Yes | any cabinet |

---

### Vente — Clients, Produits, Subscriptions, Payments

| Method | URL | Auth | Description |
|--------|-----|------|-------------|
| GET | `/api/vente/clients` | Yes | List clients |
| POST | `/api/vente/clients` | Yes | Create client |
| PUT | `/api/vente/clients/:id` | Yes | Update client |
| DELETE | `/api/vente/clients/:id` | Yes | Delete client |
| GET | `/api/vente/clients/:id/contacts` | Yes | List client contacts |
| POST | `/api/vente/clients/:id/contacts` | Yes | Add client contact |
| PUT | `/api/vente/clients/:id/contacts/:contactId` | Yes | Update contact |
| GET | `/api/vente/clients/:id/balance` | Yes | Client balance |
| GET | `/api/vente/products` | Yes | List products/services |
| POST | `/api/vente/products` | Yes | Create product |
| PUT | `/api/vente/products/:id` | Yes | Update product |
| DELETE | `/api/vente/products/:id` | Yes | Delete product |
| GET | `/api/vente/subscriptions` | Yes | List subscriptions |
| POST | `/api/vente/subscriptions` | Yes | Create subscription |
| PUT | `/api/vente/subscriptions/:id` | Yes | Update subscription |
| DELETE | `/api/vente/subscriptions/:id` | Yes | Delete subscription |
| GET | `/api/vente/subscriptions/:id/invoices` | Yes | Subscription invoices |
| POST | `/api/vente/subscriptions/process-due` | Yes | Generate due invoices |
| GET | `/api/vente/payments` | Yes | List payments |
| POST | `/api/vente/payments` | Yes | Record payment |
| PUT | `/api/vente/payments/:id/link` | Yes | Link payment to invoice |
| DELETE | `/api/vente/payments/:id/link` | Yes | Unlink payment |
| DELETE | `/api/vente/payments/:id` | Yes | Delete payment |
| GET | `/api/vente/reminders` | Yes | List payment reminders |
| GET | `/api/vente/reminders/stats` | Yes | Reminder stats |
| POST | `/api/vente/reminders` | Yes | Create reminder |
| PUT | `/api/vente/reminders/:id` | Yes | Update reminder |
| GET | `/api/vente/reminders/:invoice_id/history` | Yes | Reminder history |
| POST | `/api/vente/reminders/send-email` | Yes | Send reminder email |
| GET | `/api/vente/avoirs` | Yes | List credit notes (avoirs) |
| GET | `/api/vente/avoirs/:id` | Yes | Get avoir detail |
| GET | `/api/vente/suivi-paiements` | Yes | Payment tracking |

---

### Bank / Rapprochement bancaire (`/api/bank/`)

| Method | URL | Auth | Description |
|--------|-----|------|-------------|
| GET | `/api/bank/accounts` | Yes | List bank accounts |
| POST | `/api/bank/accounts` | Yes | Create bank account |
| PUT | `/api/bank/accounts/:id` | Yes | Update bank account |
| DELETE | `/api/bank/accounts/:id` | Yes | Delete bank account |
| GET | `/api/bank/transactions` | Yes | List bank transactions |
| POST | `/api/bank/import` | Yes | Import CSV bank statement |
| POST | `/api/bank/auto-match` | Yes | Auto-match transactions |
| PUT | `/api/bank/transactions/:id/match` | Yes | Manual match |
| PUT | `/api/bank/transactions/:id/ignore` | Yes | Ignore transaction |
| DELETE | `/api/bank/transactions/:id/match` | Yes | Unmatch transaction |
| GET | `/api/bank/stats` | Yes | Rapprochement stats |
| GET | `/api/bank/unmatched-invoices` | Yes | Unmatched invoices |
| GET | `/api/bank/unmatched-expenses` | Yes | Unmatched expenses |

---

### Immobilisations / Assets (`/api/assets`)

| Method | URL | Auth | Description |
|--------|-----|------|-------------|
| GET | `/api/assets` | Yes | List assets |
| GET | `/api/assets/depreciation-summary` | Yes | Depreciation summary |
| GET | `/api/assets/:id` | Yes | Get asset |
| GET | `/api/assets/:id/depreciation-schedule` | Yes | Amortissement schedule |
| POST | `/api/assets` | Yes | Create asset |
| PUT | `/api/assets/:id` | Yes | Update asset |
| DELETE | `/api/assets/:id` | Yes | Delete asset |
| GET | `/api/assets/export/csv` | Yes | Export CSV |
| POST | `/api/assets/generate-depreciations` | Yes | Generate depreciation entries |
| POST | `/api/assets/:id/dispose` | Yes | Record asset disposal |
| POST | `/api/assets/:id/scrap` | Yes | Scrap asset |

---

### Exercices / Clôture (`/api/exercices`, `/api/cloture`)

| Method | URL | Auth | Description |
|--------|-----|------|-------------|
| GET | `/api/exercices` | Yes | List fiscal years |
| POST | `/api/exercices` | Yes | Create fiscal year |
| GET | `/api/cloture/pre-checks` | Yes | Pre-clôture validations |
| GET | `/api/cloture/resultat` | Yes | Résultat de l'exercice |
| GET | `/api/cloture/preview-ran` | Yes | Preview clôture entries |
| POST | `/api/cloture/executer` | Yes | Execute clôture |

---

### Rapports Financiers

| Method | URL | Auth | Description |
|--------|-----|------|-------------|
| GET | `/api/bilan` | Yes | Bilan OHADA/PCM (Actif/Passif) |
| GET | `/api/cpc` | Yes | Compte de Produits et Charges (13 rubriques) |
| GET | `/api/cpc/export/csv` | Yes | Export CPC CSV |
| GET | `/api/esg` | Yes | État des Soldes de Gestion |
| GET | `/api/esg/export/csv` | Yes | Export ESG CSV |

---

### Trésorerie Prévisionnelle (`/api/tresorerie/`)

| Method | URL | Auth | Description |
|--------|-----|------|-------------|
| GET | `/api/tresorerie/previsionnel` | Yes | Cash flow forecast |
| GET | `/api/tresorerie/charges-recurrentes` | Yes | Recurring charges |
| POST | `/api/tresorerie/charges-recurrentes` | Yes | Create recurring charge |
| PUT | `/api/tresorerie/charges-recurrentes/:id` | Yes | Update recurring charge |
| DELETE | `/api/tresorerie/charges-recurrentes/:id` | Yes | Delete recurring charge |

---

### Effets de Commerce (`/api/effets`)

| Method | URL | Auth | Description |
|--------|-----|------|-------------|
| GET | `/api/effets` | Yes | List effets |
| POST | `/api/effets` | Yes | Create effet |
| PUT | `/api/effets/:id` | Yes | Update effet |
| PUT | `/api/effets/:id/status` | Yes | Update status |
| DELETE | `/api/effets/:id` | Yes | Delete effet |
| GET | `/api/effets/export/csv` | Yes | Export CSV |

---

### IS — Impôt sur les Sociétés (`/api/is`)

| Method | URL | Auth | Description |
|--------|-----|------|-------------|
| GET | `/api/is` | Yes | Compute IS for year |
| POST | `/api/is` | Yes | Save IS declaration |
| GET | `/api/is/declarations` | Yes | List IS declarations |

---

### Client Subscription & Plans (`/api/client/`)

| Method | URL | Auth | Description |
|--------|-----|------|-------------|
| GET | `/api/client/subscription` | Yes | Get subscription info |
| POST | `/api/client/subscription` | Yes | Subscribe |
| GET | `/api/client/plan` | Yes | Get plan features |
| GET | `/api/client/plan/access/:feature` | Yes | Check feature access |
| POST | `/api/client/plan` | Yes | Update plan |

**Client Plans:**
| Plan | Price | Code |
|------|-------|------|
| Starter | 99 MAD/mo | `starter` |
| Standard | 199 MAD/mo | `standard` |
| Premium | 499 MAD/mo | `premium` |

---

### Recherche Globale (`/api/search`)

| Method | URL | Auth | Description |
|--------|-----|------|-------------|
| GET | `/api/search` | Yes | Cross-module search |

```
// Query params: ?q=text&types=invoices,expenses,contacts
// Response 200: { "results": [{ "type": "invoice", "id": 1, "label": "F-2025-001 — SARL Client" }] }
```

---

### Public / Misc

| Method | URL | Auth | Description |
|--------|-----|------|-------------|
| POST | `/api/partner-request` | No | Partner request form |
| POST | `/api/cabinet-partenaire-request` | No | Cabinet partner request |
| POST | `/api/waitlist` | No (rate limited) | Join waitlist |
| GET | `/api/admin/partner-requests` | Yes | Admin: list partner requests |
| GET | `/api/internal/email-queue` | No (internal) | Internal email queue |
| PUT | `/api/internal/email-queue/:id/sent` | No (internal) | Mark email sent |
| GET | `/health` | No | Health check |

---

## B. Modèles de Données

All tables use PostgreSQL (Neon). Multi-tenancy enforced via `company_id` on every row. All amounts in MAD with `NUMERIC(15,2)`. All timestamps in UTC (`TIMESTAMPTZ`).

---

### `users`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| email | VARCHAR(255) | UNIQUE |
| password_hash | VARCHAR(255) | bcrypt |
| name | VARCHAR(255) | |
| user_type | VARCHAR(20) | `standard` \| `cabinet` |
| cabinet_role | VARCHAR(20) | `admin` \| `chef_mission` \| `collaborateur` \| NULL |
| created_at | TIMESTAMPTZ | |

---

### `sessions`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| user_id | INTEGER FK→users | ON DELETE CASCADE |
| token | VARCHAR(128) | UNIQUE |
| expires_at | TIMESTAMPTZ | 30-day TTL |
| active_company_id | INTEGER | Cabinet context switching |
| created_at | TIMESTAMPTZ | |

---

### `companies`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| user_id | INTEGER FK→users | Company owner |
| name | VARCHAR(255) NOT NULL | |
| ice | VARCHAR(15) | Identifiant Commun Entreprise (15 digits) |
| idf | VARCHAR(20) | Identifiant Fiscal |
| rc | VARCHAR(50) | Registre du Commerce |
| cnss | VARCHAR(20) | CNSS number |
| address | TEXT | |
| city | VARCHAR(100) | |
| phone | VARCHAR(20) | |
| email | VARCHAR(255) | |
| logo_url | TEXT | |
| fiscal_year_start | INTEGER DEFAULT 1 | Month number |
| default_tva_rate | NUMERIC(5,2) DEFAULT 20.00 | |
| currency | VARCHAR(3) DEFAULT 'MAD' | |
| forme_juridique | VARCHAR(50) | SARL, SA, SNC, Auto-entrepreneur |
| type_comptabilite | VARCHAR(20) DEFAULT 'Engagement' | Engagement \| Trésorerie |
| statut | VARCHAR(20) DEFAULT 'actif' | actif \| archive |
| collaborateur | VARCHAR(255) | Name (denormalized) |
| chef_de_mission | VARCHAR(255) | Name (denormalized) |
| collaborateur_id | INTEGER FK→users | Assigned collaborator |
| chef_de_mission_id | INTEGER FK→users | Assigned chef mission |
| rib | VARCHAR(30) | Bank account number |
| bank_name | VARCHAR(100) | |
| payment_conditions | TEXT | Default payment terms |
| pilote_pa | VARCHAR(255) | PA pilot assignment |
| abonnement | VARCHAR(100) DEFAULT 'Collaboratif' | |
| expert_comptable | VARCHAR(255) | |
| frequence_tva | VARCHAR(20) | mensuel \| trimestriel |
| client_invitation_token | VARCHAR(64) | |
| client_invitation_expires_at | TIMESTAMP | 7-day expiry |
| client_invitation_status | VARCHAR(20) DEFAULT 'none' | none \| pending \| accepted |
| client_user_id | INTEGER FK→users | Linked client user |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

---

### `pcm_accounts`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| code | VARCHAR(10) UNIQUE NOT NULL | e.g. `3421`, `7111` |
| name | VARCHAR(255) NOT NULL | |
| class | INTEGER NOT NULL | 1–7 (PCM classes) |
| type | VARCHAR(20) | `asset` \| `liability` \| `equity` \| `revenue` \| `expense` |
| parent_code | VARCHAR(10) | |
| is_active | BOOLEAN DEFAULT true | |
| allow_direct_posting | BOOLEAN DEFAULT true | |
| description | TEXT | |
| created_at | TIMESTAMPTZ | |

---

### `contacts`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| company_id | INTEGER FK→companies | |
| user_id | INTEGER FK→users | |
| type | VARCHAR(20) | `client` \| `fournisseur` \| `both` |
| name | VARCHAR(255) NOT NULL | |
| ice | VARCHAR(15) | |
| idf | VARCHAR(20) | |
| rc | VARCHAR(50) | |
| address | TEXT | |
| city | VARCHAR(100) | |
| phone | VARCHAR(20) | |
| email | VARCHAR(255) | |
| account_code | VARCHAR(10) | e.g. `3421` for clients, `4411` for fournisseurs |
| balance | NUMERIC(15,2) DEFAULT 0 | |
| is_active | BOOLEAN DEFAULT true | |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

---

### `invoices`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| company_id | INTEGER FK→companies | |
| user_id | INTEGER FK→users | |
| contact_id | INTEGER FK→contacts | Fournisseur/contact (old module) |
| client_id | INTEGER FK→clients | Vente module client |
| invoice_number | VARCHAR(50) NOT NULL | `F-YYYY-NNN` (sale) or `FC-YYYY-NNN` (purchase) |
| type | VARCHAR(20) | `sale` \| `purchase` |
| status | VARCHAR(20) DEFAULT 'draft' | `draft` \| `sent` \| `paid` \| `cancelled` \| `overdue` \| `validated` \| `partially_paid` |
| invoice_subtype | VARCHAR(20) | `avoir` for credit notes, NULL otherwise |
| date | DATE NOT NULL | |
| due_date | DATE | |
| subtotal | NUMERIC(15,2) | HT |
| tva_amount | NUMERIC(15,2) | TVA total |
| total | NUMERIC(15,2) | TTC |
| tva_rate | NUMERIC(5,2) DEFAULT 20.00 | Default rate for invoice |
| notes | TEXT | |
| ice_client | VARCHAR(15) | ICE of client (mandatory for sale) |
| payment_method | VARCHAR(50) | virement \| chèque \| espèces \| effet |
| journal_entry_id | INTEGER FK→journal_entries | Auto-created on POST |
| subscription_id | INTEGER FK→subscriptions | For auto-generated invoices |
| avoir_for_invoice_id | INTEGER FK→invoices | Which invoice this avoir cancels |
| avoir_id | INTEGER FK→invoices | The avoir created for this invoice |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

---

### `invoice_lines`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| invoice_id | INTEGER FK→invoices | ON DELETE CASCADE |
| description | VARCHAR(500) NOT NULL | |
| quantity | NUMERIC(10,2) DEFAULT 1 | |
| unit_price | NUMERIC(15,2) NOT NULL | HT |
| tva_rate | NUMERIC(5,2) DEFAULT 20.00 | Per-line rate |
| tva_amount | NUMERIC(15,2) DEFAULT 0 | |
| total | NUMERIC(15,2) NOT NULL | TTC for line |
| account_code | VARCHAR(10) | `7111` (sale) or `6111` (purchase) by default |
| sort_order | INTEGER DEFAULT 0 | |

---

### `invoice_attachments`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| invoice_id | INTEGER FK→invoices | ON DELETE CASCADE |
| filename | VARCHAR(255) | |
| content_type | VARCHAR(100) | |
| file_data | TEXT | Base64-encoded |
| created_at | TIMESTAMP | |

---

### `journal_entries`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| company_id | INTEGER FK→companies | |
| user_id | INTEGER FK→users | |
| entry_number | VARCHAR(50) | e.g. `VE-F-2025-001` |
| date | DATE NOT NULL | |
| journal_type | VARCHAR(20) DEFAULT 'OD' | `AC` (Achats) \| `VE` (Ventes) \| `BQ` (Banque) \| `CA` (Caisse) \| `OD` (Opérations Diverses) |
| reference | VARCHAR(100) | |
| description | TEXT | |
| source_type | VARCHAR(20) | `invoice` \| `expense` \| NULL |
| source_id | INTEGER | FK to source table |
| is_balanced | BOOLEAN DEFAULT true | SUM(debit) == SUM(credit) |
| total_debit | NUMERIC(15,2) DEFAULT 0 | |
| total_credit | NUMERIC(15,2) DEFAULT 0 | |
| status | VARCHAR(20) DEFAULT 'validated' | brouillon \| validated |
| created_at | TIMESTAMPTZ | |

---

### `journal_entry_lines`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| journal_entry_id | INTEGER FK→journal_entries | ON DELETE CASCADE |
| account_code | VARCHAR(10) NOT NULL | PCM account code |
| account_name | VARCHAR(255) | |
| debit | NUMERIC(15,2) DEFAULT 0 | |
| credit | NUMERIC(15,2) DEFAULT 0 | |
| description | TEXT | |
| sort_order | INTEGER DEFAULT 0 | |
| lettrage_code | VARCHAR(20) | NULL = non-lettrée (outstanding) |
| tiers_id | INTEGER | Denormalized contact/client ID |
| tiers_name | VARCHAR(255) | Denormalized contact name |

---

### `expenses` (Achats / Factures Fournisseurs)
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| company_id | INTEGER FK→companies | |
| user_id | INTEGER FK→users | |
| contact_id | INTEGER FK→contacts | Fournisseur |
| date | DATE NOT NULL | |
| description | VARCHAR(500) NOT NULL | |
| amount | NUMERIC(15,2) NOT NULL | HT |
| tva_rate | NUMERIC(5,2) DEFAULT 20.00 | |
| tva_amount | NUMERIC(15,2) DEFAULT 0 | |
| total | NUMERIC(15,2) NOT NULL | TTC |
| account_code | VARCHAR(10) DEFAULT '6111' | |
| payment_method | VARCHAR(50) DEFAULT 'virement' | |
| status | VARCHAR(20) DEFAULT 'pending' | `pending` \| `approved` \| `paid` \| `cancelled` |
| invoice_status | VARCHAR(20) DEFAULT 'a_traiter' | `a_traiter` \| `pre_traitee` \| `traitee` |
| receipt_url | TEXT | |
| document_data | TEXT | Base64 PDF/image |
| document_mime_type | VARCHAR(50) | |
| journal_entry_id | INTEGER FK→journal_entries | Set on validation |
| category | VARCHAR(50) | |
| fournisseur_nom | VARCHAR(255) | Denormalized |
| numero_facture | VARCHAR(100) | Supplier invoice ref |
| source | VARCHAR(50) DEFAULT 'saisie_manuelle' | saisie_manuelle \| ocr \| import |
| supplier_ice | VARCHAR(20) | |
| date_echeance | DATE | Due date |
| is_split | BOOLEAN DEFAULT false | |
| parent_document_id | INTEGER FK→expenses | For split docs |
| tva_rate_label | VARCHAR(20) | `multitaux` when multi-rate |
| added_at | TIMESTAMPTZ | |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

---

### `supplier_invoice_lines`
Multi-line ventilation for supplier invoices with multiple TVA rates.

| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| invoice_id | INTEGER FK→expenses | ON DELETE CASCADE |
| account_code | VARCHAR(20) DEFAULT '6111' | |
| account_label | VARCHAR(255) | |
| amount_ht | NUMERIC(12,2) NOT NULL | |
| tva_rate | NUMERIC(5,2) NOT NULL | |
| amount_tva | NUMERIC(12,2) NOT NULL | |
| sort_order | INTEGER NOT NULL DEFAULT 0 | |
| created_at | TIMESTAMPTZ | |

---

### `clients` (Vente Module)
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| company_id | INTEGER FK→companies | |
| name | VARCHAR(255) NOT NULL | |
| ice | VARCHAR(50) | |
| if_number | VARCHAR(50) | |
| rc_number | VARCHAR(50) | |
| address | TEXT | |
| city | VARCHAR(100) | |
| postal_code | VARCHAR(20) | |
| country | VARCHAR(100) DEFAULT 'Maroc' | |
| phone | VARCHAR(30) | |
| email | VARCHAR(255) | |
| website | VARCHAR(255) | |
| notes | TEXT | |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

---

### `client_contacts`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| client_id | INTEGER FK→clients | ON DELETE CASCADE |
| company_id | INTEGER FK→companies | |
| first_name | VARCHAR(100) NOT NULL | |
| last_name | VARCHAR(100) NOT NULL | |
| email | VARCHAR(255) | |
| phone | VARCHAR(30) | |
| title | VARCHAR(100) | |
| is_primary | BOOLEAN DEFAULT false | |

---

### `products`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| company_id | INTEGER FK→companies | |
| name | VARCHAR(255) NOT NULL | |
| description | TEXT | |
| type | VARCHAR(20) DEFAULT 'produit' | `produit` \| `service` \| `abonnement` |
| unit_price | NUMERIC(15,2) NOT NULL | |
| tva_rate | NUMERIC(5,2) DEFAULT 20 | CHECK IN (0, 7, 10, 14, 20) |
| unit | VARCHAR(50) DEFAULT 'unité' | |
| is_recurring | BOOLEAN DEFAULT false | |
| recurring_interval | VARCHAR(20) | `mensuel` \| `trimestriel` \| `annuel` |
| is_active | BOOLEAN DEFAULT true | |

---

### `quotes`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| company_id | INTEGER FK→companies | |
| client_id | INTEGER FK→clients | ON DELETE RESTRICT |
| quote_number | VARCHAR(30) NOT NULL | `DV-YYYY-NNN` |
| date | DATE NOT NULL | |
| valid_until | DATE | |
| status | VARCHAR(20) DEFAULT 'brouillon' | `brouillon` \| `envoyé` \| `accepté` \| `refusé` \| `expiré` |
| subtotal | NUMERIC(15,2) | |
| tva_amount | NUMERIC(15,2) | |
| total | NUMERIC(15,2) | |
| notes | TEXT | |
| converted_to_invoice_id | INTEGER FK→invoices | |

---

### `quote_lines`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| quote_id | INTEGER FK→quotes | ON DELETE CASCADE |
| product_id | INTEGER FK→products | ON DELETE SET NULL |
| description | TEXT NOT NULL | |
| quantity | NUMERIC(10,3) DEFAULT 1 | |
| unit_price | NUMERIC(15,2) NOT NULL | |
| tva_rate | NUMERIC(5,2) DEFAULT 20 | |
| total | NUMERIC(15,2) NOT NULL | |
| sort_order | INTEGER DEFAULT 0 | |

---

### `subscriptions`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| company_id | INTEGER FK→companies | |
| client_id | INTEGER FK→clients | ON DELETE RESTRICT |
| product_id | INTEGER FK→products | ON DELETE RESTRICT |
| start_date | DATE NOT NULL | |
| end_date | DATE | |
| next_invoice_date | DATE | |
| interval | VARCHAR(20) NOT NULL | `mensuel` \| `trimestriel` \| `annuel` |
| amount | NUMERIC(15,2) NOT NULL | |
| tva_rate | NUMERIC(5,2) DEFAULT 20 | |
| status | VARCHAR(20) DEFAULT 'actif' | `actif` \| `pausé` \| `annulé` \| `expiré` |
| notes | TEXT | |
| last_invoice_id | INTEGER FK→invoices | |

---

### `client_payments`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| company_id | INTEGER FK→companies | |
| client_id | INTEGER FK→clients | |
| invoice_id | INTEGER | |
| amount | NUMERIC(15,2) NOT NULL | |
| date | DATE NOT NULL | |
| method | VARCHAR(20) DEFAULT 'virement' | `virement` \| `chèque` \| `espèces` \| `carte` \| `effet` \| `autre` |
| reference | VARCHAR(100) | |
| status | VARCHAR(20) DEFAULT 'reçu' | `reçu` \| `en_attente` \| `annulé` |
| is_linked | BOOLEAN DEFAULT false | |
| label | TEXT | |
| bank_transaction_id | INTEGER FK→bank_transactions | |
| journal_entry_id | INTEGER FK→journal_entries | |
| notes | TEXT | |

---

### `reminders`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| company_id | INTEGER FK→companies | |
| invoice_id | INTEGER | |
| client_id | INTEGER FK→clients | |
| channel | VARCHAR(30) DEFAULT 'email' | `email` \| `telephone` \| `whatsapp` \| `physique` \| `courrier_recommande_ar` \| `autre` |
| level | VARCHAR(30) | `rappel` \| `relance` \| `mise_en_demeure` \| `contentieux` |
| status | VARCHAR(20) | `à_envoyer` \| `envoyé` \| `répondu` \| `résolu` |
| sent_at | TIMESTAMPTZ | |
| call_datetime | TIMESTAMPTZ | |
| tracking_number | VARCHAR(100) | Registered mail tracking |
| ar_received_date | DATE | |
| notes | TEXT | |
| sent_by | INTEGER FK→users | |

---

### `bank_accounts`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| company_id | INTEGER FK→companies | |
| name | VARCHAR(255) NOT NULL | |
| bank_name | VARCHAR(100) | |
| account_number | VARCHAR(50) | |
| rib | VARCHAR(30) | |
| currency | VARCHAR(3) DEFAULT 'MAD' | |
| last_import_at | TIMESTAMPTZ | |
| last_balance | NUMERIC(15,2) | |
| last_balance_date | DATE | |

---

### `bank_transactions`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| company_id | INTEGER FK→companies | |
| bank_account_id | INTEGER FK→bank_accounts | |
| transaction_date | DATE NOT NULL | |
| label | TEXT NOT NULL | |
| debit | NUMERIC(15,2) | |
| credit | NUMERIC(15,2) | |
| balance | NUMERIC(15,2) | |
| matched_invoice_id | INTEGER | |
| matched_expense_id | INTEGER | |
| match_status | VARCHAR(20) DEFAULT 'unmatched' | `unmatched` \| `auto_matched` \| `manual_matched` \| `ignored` |
| match_confidence | INTEGER | 0–100 |

---

### `assets` (Immobilisations)
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| company_id | INTEGER FK→companies | |
| name | VARCHAR(255) NOT NULL | |
| asset_account | VARCHAR(10) | PCM account (e.g. `2355`) |
| amortization_account | VARCHAR(10) | PCM amort account (e.g. `2835`) |
| expense_account | VARCHAR(10) | PCM DEA account (e.g. `6193`) |
| purchase_date | DATE NOT NULL | |
| purchase_amount | NUMERIC(15,2) NOT NULL | |
| useful_life_years | INTEGER NOT NULL | |
| depreciation_method | VARCHAR(20) | `linear` \| `degressive` |
| status | VARCHAR(20) DEFAULT 'active' | `active` \| `disposed` \| `scrapped` |
| disposal_date | DATE | |
| disposal_amount | NUMERIC(15,2) | |
| net_book_value | NUMERIC(15,2) | |

### `asset_depreciations`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| asset_id | INTEGER FK→assets | ON DELETE CASCADE |
| company_id | INTEGER FK→companies | |
| year | INTEGER NOT NULL | |
| depreciation_amount | NUMERIC(15,2) | |
| accumulated_depreciation | NUMERIC(15,2) | |
| net_book_value | NUMERIC(15,2) | |
| journal_entry_id | INTEGER FK→journal_entries | |
| generated_at | TIMESTAMPTZ | |

---

### `notifications`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| user_id | INTEGER FK→users | ON DELETE CASCADE |
| company_id | INTEGER | |
| type | VARCHAR(60) NOT NULL | e.g. `invoice_overdue`, `tva_deadline` |
| title | VARCHAR(500) NOT NULL | |
| message | TEXT NOT NULL | |
| link | VARCHAR(1000) | |
| is_read | BOOLEAN DEFAULT false | |
| created_at | TIMESTAMP | |

---

### `cabinet_members`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| cabinet_owner_id | INTEGER FK→users | ON DELETE CASCADE |
| member_user_id | INTEGER FK→users | ON DELETE CASCADE |
| role | VARCHAR(20) DEFAULT 'comptable' | `admin` \| `chef_mission` \| `collaborateur` \| `comptable` \| `assistant` |
| status | VARCHAR(20) DEFAULT 'active' | active \| inactive |
| invite_token | VARCHAR(128) UNIQUE | |
| invite_expires_at | TIMESTAMP | |
| invite_status | VARCHAR(20) DEFAULT 'active' | `pending` \| `active` \| `inactive` |
| invited_at | TIMESTAMP | |

---

### `cabinet_messages`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| company_id | INTEGER NOT NULL | Dossier |
| cabinet_user_id | INTEGER NOT NULL | Cabinet owner |
| sender_user_id | INTEGER | |
| sender_name | VARCHAR(255) | |
| message_type | VARCHAR(30) DEFAULT 'message' | |
| content | TEXT NOT NULL | |
| is_read | BOOLEAN DEFAULT false | |
| created_at | TIMESTAMP | |

---

### `cabinet_documents`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| company_id | INTEGER NOT NULL | |
| cabinet_user_id | INTEGER NOT NULL | |
| uploaded_by_user_id | INTEGER | |
| filename | VARCHAR(255) NOT NULL | |
| file_data | TEXT NOT NULL | Base64 |
| content_type | VARCHAR(100) | |
| category | VARCHAR(50) DEFAULT 'autre' | |
| period_month | INTEGER | |
| period_year | INTEGER | |
| file_size | INTEGER | |

---

### `cabinet_justificatif_requests`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| company_id | INTEGER NOT NULL | |
| cabinet_user_id | INTEGER NOT NULL | |
| title | VARCHAR(500) NOT NULL | |
| description | TEXT | |
| deadline | DATE | |
| status | VARCHAR(20) DEFAULT 'pending' | pending \| completed \| cancelled |
| document_id | INTEGER | |

---

### `tva_declarations`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| company_id | INTEGER FK→companies | |
| year | INTEGER NOT NULL | |
| month | INTEGER | For mensuel regime |
| quarter | INTEGER | For trimestriel regime |
| regime | VARCHAR(20) | mensuel \| trimestriel |
| tva_collectee | NUMERIC(15,2) | |
| tva_deductible | NUMERIC(15,2) | |
| tva_due | NUMERIC(15,2) | |
| credit_reporte | NUMERIC(15,2) DEFAULT 0 | |
| status | VARCHAR(20) DEFAULT 'draft' | draft \| submitted |
| submitted_at | TIMESTAMPTZ | |
| created_at | TIMESTAMPTZ | |

---

### `fiscal_years` / `exercices`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| company_id | INTEGER FK→companies | |
| year | INTEGER NOT NULL | |
| start_date | DATE NOT NULL | |
| end_date | DATE NOT NULL | |
| status | VARCHAR(20) DEFAULT 'ouvert' | ouvert \| clôturé |
| cloture_date | TIMESTAMPTZ | |
| cloture_journal_entry_id | INTEGER FK→journal_entries | |

---

### `effets` (Effets de Commerce)
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| company_id | INTEGER FK→companies | |
| type | VARCHAR(20) | lettre_de_change \| billet_à_ordre |
| direction | VARCHAR(10) | emis \| reçu |
| montant | NUMERIC(15,2) NOT NULL | |
| tiers_nom | VARCHAR(255) | |
| date_emission | DATE | |
| date_echeance | DATE | |
| status | VARCHAR(20) | en_cours \| encaisse \| impaye \| annule |
| reference | VARCHAR(100) | |
| banque | VARCHAR(100) | |
| journal_entry_id | INTEGER FK→journal_entries | |

---

### `is_declarations` (Impôt sur les Sociétés)
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| company_id | INTEGER FK→companies | |
| year | INTEGER NOT NULL | |
| resultat_fiscal | NUMERIC(15,2) | |
| is_theorique | NUMERIC(15,2) | |
| cm_theorique | NUMERIC(15,2) | Cotisation minimale (0.5% CA) |
| is_du | NUMERIC(15,2) | MAX(IS théorique, CM) |
| acomptes_verses | NUMERIC(15,2) | |
| solde_is | NUMERIC(15,2) | |
| taux_is | NUMERIC(5,2) | 10% \| 20% \| 31% progressive |
| status | VARCHAR(20) | draft \| submitted |

---

### `recurring_charges` (Charges récurrentes trésorerie)
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| company_id | INTEGER FK→companies | |
| label | VARCHAR(255) NOT NULL | |
| amount | NUMERIC(15,2) NOT NULL | |
| frequency | VARCHAR(20) | mensuel \| trimestriel \| annuel |
| start_date | DATE | |
| end_date | DATE | |
| category | VARCHAR(50) | loyer \| salaire \| assurance... |
| is_active | BOOLEAN DEFAULT true | |

---

### `email_queue`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| to_email | VARCHAR(255) NOT NULL | |
| subject | VARCHAR(500) NOT NULL | |
| html_body | TEXT NOT NULL | |
| status | VARCHAR(20) DEFAULT 'pending' | pending \| sent \| failed |
| error | TEXT | |
| created_at | TIMESTAMPTZ | |
| sent_at | TIMESTAMPTZ | |

---

### `waitlist_subscribers`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| email | VARCHAR(255) UNIQUE NOT NULL | |
| company_name | VARCHAR(255) | |
| phone | VARCHAR(30) | |
| created_at | TIMESTAMPTZ | |

---

### `lettrage_sequences`
| Column | Type | Notes |
|--------|------|-------|
| company_id | INTEGER PK FK→companies | |
| next_index | INTEGER DEFAULT 0 | Auto-increment per company |

---

## C. Règles Métier & Logique Fonctionnelle

### C.1 Écritures Comptables Automatiques (Double Entrée PCM)

Every invoice creation and expense validation triggers an automatic journal entry. The system enforces SUM(debit) == SUM(credit) strictly.

#### Facture de Vente (type = 'sale')
```
Débit   3421 — Clients                    TTC
Crédit  7111 — Ventes de marchandises HT  HT
Crédit  4455 — Etat TVA facturée          TVA
```
- If TVA = 0%: only 2 lines (3421 debit, 7111 credit)
- Account 7111 is the default; each line can override with specific 71xx code
- Journal type: `VE` (Ventes)
- Entry number: `VE-F-YYYY-NNN`

#### Facture d'Achat (type = 'purchase')
```
Débit   6111 — Achats de marchandises     HT
Débit   3455 — Etat TVA récupérable       TVA
Crédit  4411 — Fournisseurs               TTC
```
- Account 6111 is the default; each line can override with specific 61xx/62xx/63xx code
- Journal type: `AC` (Achats)
- Entry number: `AC-FC-YYYY-NNN`

#### Validation d'une Dépense (POST /api/expenses/:id/valider)
Same pattern as Facture d'Achat: 6111 + 3455 debit, 4411 credit TTC.

#### Avoir (Credit Note — POST /api/invoices/:id/cancel)
Creates a new invoice with `invoice_subtype = 'avoir'` and reverse journal entry:
```
For sale avoir:
  Débit  4455 — TVA facturée    TVA (reversal)
  Débit  7111 — Ventes          HT (reversal)
  Crédit 3421 — Clients         TTC (reversal)
```

---

### C.2 Numérotation Séquentielle

Sequences are **per-company, per-year, per-type**. Reset at each new year.

| Document | Pattern | Example |
|----------|---------|---------|
| Facture vente | `F-YYYY-NNN` | `F-2025-001` |
| Facture achat | `FC-YYYY-NNN` | `FC-2025-001` |
| Devis | `DV-YYYY-NNN` | `DV-2025-001` |
| Avoir | `AV-YYYY-NNN` | `AV-2025-001` |
| Journal VE | `VE-{invoice_number}` | `VE-F-2025-001` |
| Journal AC | `AC-{invoice_number}` | `AC-FC-2025-001` |

**Sequence query** (executed at invoice creation):
```sql
SELECT COUNT(*) as cnt
FROM invoices
WHERE type = $1
  AND EXTRACT(YEAR FROM date) = EXTRACT(YEAR FROM $2::date)
  AND company_id = $3
  AND (invoice_subtype IS NULL OR invoice_subtype \!= 'avoir')
```
Number = COUNT + 1, zero-padded to 3 digits.

**⚠️ Race condition risk**: Python implementation must use `SELECT ... FOR UPDATE` or a dedicated sequence table to avoid duplicates under concurrent requests.

---

### C.3 TVA Marocaine — 5 Taux

| Taux | Usage |
|------|-------|
| 0% | Exonéré (export, médicaments, produits de base) |
| 7% | Eau, électricité, sucre raffiné |
| 10% | Restauration, opérations bancaires |
| 14% | Transport, beurre |
| 20% | Taux normal (tous autres biens et services) |

Mixed-rate invoices: each line has its own `tva_rate`. TVA grouped by rate for declaration.

**TVA Declaration Logic:**
```
TVA collectée = SUM(credit on 4455 lines) for period
TVA déductible = SUM(debit on 3455 lines) for period
TVA due = MAX(0, TVA collectée - TVA déductible)
Crédit reportable = MAX(0, TVA déductible - TVA collectée)
```

**Régimes:**
- **Mensuel**: declaration monthly, deadline = 20th of following month
- **Trimestriel**: Q1 (Jan-Mar) → April 20, Q2 → July 20, Q3 → Oct 20, Q4 → Jan 20

---

### C.4 Validation Double Partie (Équilibre)

```python
# Enforced on every POST /api/journal-entries
total_debit = sum(line.debit for line in lines)
total_credit = sum(line.credit for line in lines)
if abs(total_debit - total_credit) > 0.01:  # tolerance for float rounding
    raise ValidationError(f"Écriture non équilibrée: débit={total_debit}, crédit={total_credit}")
```

`journal_entries.is_balanced` is always true (enforced before insert). Automated entries from invoices are always balanced by construction.

---

### C.5 ICE Validation (Identifiant Commun Entreprise)

**Rule**: ICE is **mandatory** for all `type = 'sale'` invoices.
- ICE must be 15 digits
- Source: from `clients.ice` (vente module) or `contacts.ice` (old module) or manual field `ice_client`
- Error code on missing: `422 ICE_REQUIRED`

ICE is included in PDF invoice as a legal mandatory mention.

---

### C.6 Pipeline OCR (GPT-4o)

1. Client uploads invoice image or PDF (max 10MB)
2. File compressed/resized if image: 1024px max, JPEG 0.5 quality, fallback 768px/0.4 if >75KB
3. GPT-4o vision API called with structured prompt to extract:
   - Fournisseur name, ICE, address
   - Invoice date, number, due date
   - Line items (description, qty, unit_price, tva_rate)
   - Total HT, TVA, TTC
4. Response validated, returned as `extracted` object
5. Client can review and edit before saving as expense
6. `source = 'ocr'` set on resulting expense record

Rate limit: OCR endpoint is rate-limited (per IP).

---

### C.7 RBAC (Role-Based Access Control)

#### Standard Users (user_type = 'standard')
- Full access to their own company's data
- Multi-tenant isolation: all queries filtered by `company_id`

#### Cabinet Users (user_type = 'cabinet')

| Role | Access |
|------|--------|
| `admin` | Full cabinet management, create/delete members and dossiers |
| `chef_mission` | Manage assigned dossiers, view all cabinet data |
| `collaborateur` | Access only assigned dossiers |

**Context switching**: Cabinet users can switch active dossier via `POST /api/cabinet/switch/:id`. Session stores `active_company_id`. All subsequent queries use this company_id.

**`getEffectiveCompanyId(req, client)`** — the core multi-tenant function:
```javascript
// For standard users: return companies.id WHERE user_id = req.userId
// For cabinet users: return sessions.active_company_id (the switched dossier)
// Falls back to user's own company if no active dossier
```

Python equivalent must be implemented as a middleware/dependency.

#### Client Users (user_type = 'standard', linked via client_user_id)
- Read-only access to their dossier's financial data via `/api/client/dashboard`
- Cannot post journal entries or modify invoices

---

### C.8 Lettrage (Matching Débit/Crédit)

Lettrage links debit and credit lines on the same account (typically 3421/4411) to mark invoices as paid/matched.

**Rules:**
- Lines must be on the same account code
- SUM(selected debit) must equal SUM(selected credit) within 0.01 tolerance
- On match: assign sequential `lettrage_code` (e.g. `A`, `B`, `AA`) from `lettrage_sequences`
- Lettrée lines: excluded from balance âgée report
- Unlettré lines: appear in balance âgée as outstanding receivables/payables

**Auto-lettrage** (`POST /api/lettrage/auto`): automatic matching by amount for a given account/tiers.

**Delettrage** (`DELETE /api/lettrage/:code`): removes lettrage_code from all matching lines.

---

### C.9 Clôture d'Exercice

Pre-checks before clôture:
1. All journal entries balanced
2. No pending TVA declarations
3. Balance générale balanced (actif = passif + capitaux propres)
4. No unlettrées outstanding entries that affect result

Clôture process:
1. Close all P&L accounts (classe 6 + 7) → result goes to 1181 (Résultats nets)
2. Mark fiscal year as `clôturé`
3. Create opening entries for next year (report à nouveau)
4. Lock period against further modification

---

### C.10 Amortissements (Depreciation)

Two methods:
- **Linéaire (Linear)**: `annual_depreciation = purchase_amount / useful_life_years`
- **Dégressif (Degressive)**: `rate = (1/useful_life_years) * degressive_coefficient`; coefficient depends on life: 5-6 years = 1.5x, 7-9 years = 2x, ≥10 years = 3x

Auto-journal on generation:
```
Débit  619x — DEA (Dotations aux amortissements)  annual_amount
Crédit 28xx — Amortissement immobilisation         annual_amount
```

On disposal:
```
Débit  28xx  — Amortissement cumulé
Débit  6511  — VNA des immo cédées (net book value)
Crédit 2xxx  — Immobilisation (original cost)
Crédit 7511  — PC des immo cédées (disposal price)
```

---

### C.11 Impôt sur les Sociétés (IS)

Progressive rates (Maroc 2025):
| Résultat fiscal | Taux |
|-----------------|------|
| ≤ 300 000 MAD | 10% |
| 300 001 – 1 000 000 MAD | 20% |
| > 1 000 000 MAD | 31% |

**Cotisation Minimale (CM)** = 0.5% of turnover (chiffre d'affaires HT), minimum 3 000 MAD.

`IS dû = MAX(IS théorique, CM)`

**4 acomptes** de 25% chacun versés au cours de l'exercice. Solde = IS dû − acomptes versés.

---

## D. Conformité Réglementaire Marocaine

### D.1 Plan Comptable Marocain (PCM)

**Référence légale**: Arrêté du Ministre des Finances n° 1-05-219 du 12 joumada I 1426 (Arrêté n° 12-05), CGNC (Code Général de Normalisation Comptable).

**7 Classes:**

| Classe | Catégorie | Comptes principaux |
|--------|-----------|-------------------|
| 1 | Financement Permanent | 1111 Capital social, 1140 Réserve légale, 1481 Emprunts |
| 2 | Actif Immobilisé | 2311 Terrains, 2321 Bâtiments, 2332 Matériel, 2355 Matériel informatique |
| 3 | Actif Circulant HB | 3421 Clients, 3455 TVA récupérable, 3491 Charges constatées d'avance |
| 4 | Passif Circulant HB | 4411 Fournisseurs, 4455 TVA facturée, 4456 TVA due, 4432 Personnel |
| 5 | Trésorerie | 5141 Banque, 5161 Caisse, 5541 Banque créditrice |
| 6 | Charges d'Exploitation | 6111 Achats marchandises, 6131 Loyers, 6171 Salaires, 6193 DEA |
| 7 | Produits d'Exploitation | 7111 Ventes Morocco, 7124 Ventes services, 7311 Intérêts reçus |

**Key PCM account mappings used automatically by HissabPro:**

| Event | Debit | Credit |
|-------|-------|--------|
| Vente | 3421 Clients | 7111 Ventes + 4455 TVA |
| Achat | 6111 Achats + 3455 TVA récup. | 4411 Fournisseurs |
| Paiement client | 5141 Banque | 3421 Clients |
| Paiement fournisseur | 4411 Fournisseurs | 5141 Banque |
| Amortissement | 619x DEA | 28xx Amort. immo |
| Cession immo | 28xx + 6511 VNA | 2xxx Immo + 7511 PC |

---

### D.2 Mentions Légales Obligatoires sur Factures

Per DGI and commercial law requirements:

| Mention | Source Field | Obligatoire |
|---------|-------------|-------------|
| Identifiant Fiscal (IF) | `companies.idf` | ✅ |
| ICE (Identifiant Commun Entreprise) | `companies.ice` | ✅ |
| Registre du Commerce (RC) | `companies.rc` | ✅ |
| CNSS | `companies.cnss` | ✅ (if applicable) |
| RIB / Coordonnées bancaires | `companies.rib` | Recommandé |
| ICE du client | `invoices.ice_client` | ✅ (pour vente) |
| Numéro de facture | `invoices.invoice_number` | ✅ |
| Date de facture | `invoices.date` | ✅ |
| Date d'échéance | `invoices.due_date` | Recommandé |
| Désignation des biens/services | `invoice_lines.description` | ✅ |
| Prix unitaire HT | `invoice_lines.unit_price` | ✅ |
| Taux de TVA | `invoice_lines.tva_rate` | ✅ |
| Montant TVA | `invoices.tva_amount` | ✅ |
| Montant TTC | `invoices.total` | ✅ |

---

### D.3 Export SIMPL-TVA (DGI)

Format: **CSV with UTF-8 BOM** (`\ufeff` prefix required for Excel compatibility).

SIMPL-TVA is the DGI's (Direction Générale des Impôts) electronic declaration format.

**Column structure for TVA collectée:**
```
ICE,IF,RC,PERIODE,TYPE_OPERATION,NUMERO_PIECE,DATE,TIERS_NOM,TIERS_ICE,
BASE_HT_20,TVA_20,BASE_HT_14,TVA_14,BASE_HT_10,TVA_10,BASE_HT_7,TVA_7,TOTAL_HT,TOTAL_TVA
```

**Column structure for TVA déductible:**
```
ICE,IF,RC,PERIODE,TYPE_OPERATION,NUMERO_PIECE,DATE,FOURNISSEUR_NOM,FOURNISSEUR_ICE,
BASE_HT_20,TVA_20,BASE_HT_14,TVA_14,BASE_HT_10,TVA_10,BASE_HT_7,TVA_7,TOTAL_HT,TOTAL_TVA
```

- Date format: `DD/MM/YYYY`
- Decimal separator: `,` (comma) — French Excel convention
- Each invoice becomes one row, TVA split by rate
- Periode format: `MM/YYYY` (mensuel) or `TN/YYYY` (trimestriel, e.g. `T1/2025`)

---

### D.4 CPC — Compte de Produits et Charges

13 rubriques réglementaires (CGNC):

| N° | Rubrique |
|----|---------|
| I | Produits d'exploitation |
| II | Charges d'exploitation |
| III | Résultat d'exploitation (I - II) |
| IV | Produits financiers |
| V | Charges financières |
| VI | Résultat financier (IV - V) |
| VII | Résultat courant (III + VI) |
| VIII | Produits non courants |
| IX | Charges non courantes |
| X | Résultat non courant (VIII - IX) |
| XI | Résultat avant impôts (VII + X) |
| XII | Impôts sur les bénéfices (IS) |
| XIII | Résultat net (XI - XII) |

Each rubrique maps to specific PCM account ranges:
- Produits d'exploitation: 7111–7199
- Charges d'exploitation: 6111–6199
- Produits financiers: 7311–7399
- Charges financières: 6311–6399
- Produits non courants: 7511–7599
- Charges non courantes: 6511–6599

---

### D.5 ESG — État des Soldes de Gestion

Calculated from PCM accounts:

| Solde | Calcul |
|-------|--------|
| Marge brute sur ventes | Ventes − Achats consommés |
| Valeur Ajoutée (VA) | Marge brute − Charges externes |
| EBE (Excédent Brut d'Exploitation) | VA + Subventions − Impôts taxes − Charges personnel |
| Résultat d'exploitation | EBE − Dotations + Reprises |
| Résultat courant | Résultat d'exploitation ± Résultat financier |
| Résultat net | Résultat courant ± Résultat non courant − IS |
| CAF (Capacité d'Autofinancement) | Résultat net + DEA − Plus-values cessions |

---

### D.6 Bilan PCM (Actif / Passif)

**ACTIF:**
- Actif immobilisé (classes 2): Immobilisations nettes
- Actif circulant (classes 3): Stocks, Clients, État TVA récupérable
- Trésorerie Actif (classes 5): Banque (débiteur), Caisse

**PASSIF:**
- Financement permanent (classes 1): Capitaux propres + Dettes LT
- Passif circulant (classes 4): Fournisseurs, État TVA facturée, Dettes CT
- Trésorerie Passif (classes 5): Banque (créditeur)

**Vérification**: Total Actif = Total Passif (équilibre comptable).

---

### D.7 E-Invoicing — Formats Supportés

HissabPro supports two e-invoicing formats via `GET /api/invoices/:id/xml`:

**UBL 2.1 (Universal Business Language)**
```xml
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2">
  <ID>F-2025-001</ID>
  <IssueDate>2025-01-15</IssueDate>
  <AccountingSupplierParty>
    <Party>
      <PartyName><Name>SARL MonEntreprise</Name></PartyName>
      <PartyTaxScheme>
        <CompanyID>001234567890123</CompanyID> <\!-- ICE -->
      </PartyTaxScheme>
    </Party>
  </AccountingSupplierParty>
  <\!-- ... -->
  <TaxTotal>
    <TaxAmount currencyID="MAD">2000.00</TaxAmount>
  </TaxTotal>
  <LegalMonetaryTotal>
    <PayableAmount currencyID="MAD">12000.00</PayableAmount>
  </LegalMonetaryTotal>
</Invoice>
```

**CII (Cross-Industry Invoice — UN/CEFACT)**
Similar structure, used for Factur-X compatibility.

---

### D.8 Rapprochement Bancaire (Bank Reconciliation)

CSV import format (standard Moroccan bank statements):
```
Date;Libellé;Débit;Crédit;Solde
15/01/2025;VIR CLIENT SARL ALPHA;;12000.00;125000.00
20/01/2025;LOYER LOCAL;6000.00;;119000.00
```

Auto-matching algorithm:
1. Exact amount match on invoice TTC
2. Fuzzy client name match (>70% similarity)
3. Date proximity (±7 days)
4. Confidence score assigned (0–100)
5. Auto-matched if confidence > 80, else flagged for manual review

---

## E. Spécifications Techniques pour le Backend Python

### E.1 Stack Cible

| Composant | Choix recommandé | Raison |
|-----------|-----------------|--------|
| Framework web | **FastAPI** | Async natif, OpenAPI auto-generated, Pydantic validation |
| ORM | **SQLAlchemy 2.0** (async) | Alembic migrations, type-safe, PostgreSQL-first |
| Migrations | **Alembic** | Compatible SQLAlchemy, reversible, history |
| Database | **PostgreSQL 15+** (Neon) | Réutiliser le même Neon cluster |
| Auth | **python-jose** + **bcrypt** | JWT ou session cookie (à décider) |
| PDF | **WeasyPrint** ou **reportlab** | Génération PDF factures |
| CSV | **csv** stdlib + codecs | UTF-8 BOM pour SIMPL-TVA |
| OCR AI | **openai** SDK (GPT-4o) | Vision API, même modèle que l'actuel |
| Validation | **Pydantic v2** | Schémas request/response auto-documentés |
| Background tasks | **Celery** + Redis | Abonnements récurrents, email queue |

---

### E.2 Structure Projet Recommandée

```
hissabpro/
├── app/
│   ├── main.py                  # FastAPI app factory, middleware, CORS
│   ├── config.py                # Settings (pydantic BaseSettings)
│   ├── database.py              # SQLAlchemy async engine + session
│   │
│   ├── apps/
│   │   ├── accounts/            # PCM accounts, chart of accounts
│   │   │   ├── models.py
│   │   │   ├── schemas.py
│   │   │   ├── service.py
│   │   │   └── router.py
│   │   │
│   │   ├── auth/                # Users, sessions, RBAC middleware
│   │   │   ├── models.py
│   │   │   ├── schemas.py
│   │   │   ├── service.py
│   │   │   ├── router.py
│   │   │   └── dependencies.py  # get_current_user, get_effective_company_id
│   │   │
│   │   ├── invoicing/           # Factures (sale + purchase), avoirs, lignes
│   │   │   ├── models.py
│   │   │   ├── schemas.py
│   │   │   ├── service.py       # invoice_number generation, journal auto-creation
│   │   │   └── router.py
│   │   │
│   │   ├── vente/               # Clients, devis, abonnements, paiements, relances
│   │   │   ├── models.py
│   │   │   ├── schemas.py
│   │   │   ├── service.py
│   │   │   └── router.py
│   │   │
│   │   ├── journal/             # Journal entries, lettrage, balance, grand livre
│   │   │   ├── models.py
│   │   │   ├── schemas.py
│   │   │   ├── service.py       # double-entry validation, lettrage logic
│   │   │   └── router.py
│   │   │
│   │   ├── cabinet/             # Multi-tenant cabinet/fiduciaire mode
│   │   │   ├── models.py        # cabinet_members, messages, documents, justificatifs
│   │   │   ├── schemas.py
│   │   │   ├── service.py
│   │   │   └── router.py
│   │   │
│   │   ├── reports/             # Bilan, CPC, ESG, Balance générale, Grand livre
│   │   │   ├── schemas.py
│   │   │   ├── service.py       # PCM aggregation logic
│   │   │   └── router.py
│   │   │
│   │   ├── tax/                 # TVA, IS, SIMPL-TVA export
│   │   │   ├── schemas.py
│   │   │   ├── service.py       # TVA computation, IS progressive rate
│   │   │   └── router.py
│   │   │
│   │   ├── bank/                # Bank accounts, transactions, rapprochement
│   │   │   ├── models.py
│   │   │   ├── schemas.py
│   │   │   ├── service.py       # CSV import, auto-match algorithm
│   │   │   └── router.py
│   │   │
│   │   ├── assets/              # Immobilisations, amortissements
│   │   │   ├── models.py
│   │   │   ├── schemas.py
│   │   │   ├── service.py       # linear/degressive depreciation
│   │   │   └── router.py
│   │   │
│   │   └── ocr/                 # OCR pipeline GPT-4o
│   │       ├── schemas.py
│   │       ├── service.py       # GPT-4o vision call, extraction parsing
│   │       └── router.py
│   │
│   └── core/
│       ├── security.py          # Password hashing, token generation
│       ├── exceptions.py        # Custom HTTP exceptions
│       └── pagination.py        # Shared pagination logic
│
├── alembic/
│   ├── env.py
│   └── versions/                # Migration files (ported from JS migrations)
│
├── tests/
│   ├── conftest.py              # Test DB, fixtures
│   └── apps/                   # Per-module tests
│
├── pyproject.toml               # uv / poetry dependencies
├── alembic.ini
└── .env.example
```

---

### E.3 Configuration (Variables d'Environnement)

```bash
# Database
DATABASE_URL=postgresql+asyncpg://user:pass@host:5432/hissabpro

# Auth
SECRET_KEY=
SESSION_MAX_AGE_DAYS=30
BCRYPT_ROUNDS=12

# OpenAI (OCR)
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o

# Email
POSTMARK_SERVER_TOKEN=
POSTMARK_FROM_EMAIL=noreply@hissabpro.ma

# App
APP_ENV=production
CORS_ORIGINS=https://hissabpro.polsia.app
DEBUG=false
LOG_LEVEL=INFO

# Redis (Celery)
REDIS_URL=REDACTED
async def session_middleware(request: Request, call_next):
    session_token = request.cookies.get("connect.sid")
    if session_token:
        session = await get_session_by_token(db, session_token)
        if session and session.expires_at > datetime.utcnow():
            request.state.session = session
            request.state.user_id = session.user_id
    return await call_next(request)
```

---

### E.7 API Versioning & OpenAPI

```python
app = FastAPI(
    title="HissabPro API",
    description="Comptabilité marocaine PCM — Backend API",
    version="2.0.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)
```

All endpoints prefixed with `/api/`. Use APIRouter with prefix per module.

---

### E.8 Error Response Format

Standardize all errors to match existing frontend expectations:

```python
# Standard error format (matches Express app)
class ErrorResponse(BaseModel):
    error: str          # Human-readable message
    code: str | None    # Machine-readable code (e.g. "ICE_REQUIRED")
    message: str | None # Detailed message

# HTTP status codes used:
# 400 — Bad request (validation, missing fields)
# 401 — Unauthenticated
# 403 — Forbidden (RBAC)
# 404 — Not found
# 409 — Conflict (duplicate, e.g. email exists)
# 422 — Business rule violation (e.g. ICE_REQUIRED, unbalanced entry)
# 429 — Rate limited
# 500 — Internal server error
```

---

### E.9 Performance Considerations

| Concern | Recommendation |
|---------|---------------|
| Balance générale | Pre-aggregate via materialized view or scheduled job |
| Grand livre | Paginate (default 100 lines/page, max 500) |
| SIMPL-TVA export | Stream response with `StreamingResponse` |
| PDF generation | Async background task, return URL |
| OCR | Async, 30s timeout, return 202 + polling if needed |
| Lettrage auto | Background task for large datasets |
| Bank import | Batch insert with `insert().values([...])`, not loop |

---

### E.10 Migration Plan from Node.js

1. **Phase 1**: Set up Python project, port all Alembic migrations from JS migrations. Verify schema parity.
2. **Phase 2**: Implement auth + company management. Shadow-test against Node.js responses.
3. **Phase 3**: Implement invoicing + journal. Critical path — test all accounting rules.
4. **Phase 4**: Implement TVA, IS, reports (Bilan/CPC/ESG).
5. **Phase 5**: Implement cabinet module (most complex RBAC logic).
6. **Phase 6**: Implement bank reconciliation + OCR pipeline.
7. **Phase 7**: Load testing, cutover. Node.js decommission.

---

*Document généré automatiquement par HissabPro Engineering Agent*
*Date: 2026-04-27 | Instance: 26863 | App: https://hissabpro.polsia.app*


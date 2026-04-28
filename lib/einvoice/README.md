# HissabPro E-Invoice Module

This module handles conversion of HissabPro invoices to standard e-invoice formats (UBL 2.1, CII, and future DGI Maroc).

---

## Architecture

```
lib/einvoice/
├── canonical.js          # DB invoice → format-agnostic canonical model
├── index.js              # Registry + public API
├── README.md             # This file
└── mappers/
    ├── ubl.js            # canonical → UBL 2.1 XML
    ├── cii.js            # canonical → CII (CrossIndustryInvoice) XML
    └── dgi-maroc.js      # canonical → DGI Maroc XML (STUB — awaiting spec)
```

The design separates **data extraction** (canonical.js) from **format rendering** (mappers). Adding a new format requires only writing a new mapper — the canonical model never changes.

---

## Canonical Invoice Model

`canonical.js` converts a raw DB invoice into a stable intermediate format:

```javascript
{
  id:             "42",
  invoiceNumber:  "F-2024-001",
  typeCode:       "380",          // 380=invoice, 381=credit note (UN/EDIFACT)
  invoiceType:    "sale",         // 'sale' | 'purchase'
  issueDate:      "2024-01-15",
  dueDate:        "2024-02-15",
  currency:       "MAD",

  seller: {
    name, ice, idf, rc,           // Moroccan legal identifiers
    address, city, country,
    phone, email
  },

  buyer: {
    name, ice, idf, rc,
    address, city, country
  },

  lines: [{
    id, description,
    quantity, unitPrice,
    tvaRate,              // 0 | 7 | 10 | 14 | 20 (percent, not decimal)
    tvaAmount, totalHT, totalTTC,
    accountCode
  }],

  subtotalHT:   1000.00,
  tvaAmount:     200.00,
  totalTTC:     1200.00,

  tvaBreakdown: [         // aggregated by rate
    { rate: 20, baseHT: 1000.00, tvaAmount: 200.00 }
  ],

  notes:          "...",
  paymentMethod:  "virement",
  buyerReference: "ICE_CLIENT"
}
```

---

## Available Formats

| Format | Standard | Status | Note |
|--------|----------|--------|------|
| `UBL-2.1` | OASIS UBL 2.1 | ✅ Production | EN 16931 compliant |
| `CII` | UN/CEFACT D16B | ✅ Production | EN 16931 compliant, Factur-X compatible |
| `DGI-MAROC` | DGI Maroc | 🚧 Stub | Awaiting official DGI specification |

---

## API Endpoint

```
GET /api/invoices/:id/export?format=UBL-2.1
→ 200 application/xml   — XML file download

GET /api/invoices/:id/export?format=CII
→ 200 application/xml   — XML file download
```

---

## Adding a New Format

1. Create `lib/einvoice/mappers/your-format.js`:

```javascript
'use strict';

function toYourFormat(canonical) {
  const { invoiceNumber, issueDate, seller, buyer, lines, totalTTC } = canonical;
  // Build and return an XML string
  return `<?xml version="1.0"?>...`;
}

module.exports = { toYourFormat };
```

2. Register in `lib/einvoice/index.js`:

```javascript
const { toYourFormat } = require('./mappers/your-format');
mappers['YOUR-FORMAT'] = toYourFormat;
```

3. The export endpoint in `server.js` automatically picks it up — no changes needed there.

---

## Moroccan Legal Identifiers

| Field | Description | Required in export |
|-------|-------------|-------------------|
| `ice` | Identifiant Commun de l'Entreprise (9 digits) | Mandatory for DGI |
| `idf` | Identifiant Fiscal | Mandatory for seller |
| `rc`  | Registre du Commerce | Recommended |
| `cnss` | Caisse Nationale de Sécurité Sociale | Not in XML scope |

---

## DGI Maroc Extension

When the official DGI specification is published:

1. Open `lib/einvoice/mappers/dgi-maroc.js`
2. Replace the stub `throw new Error(...)` with the real implementation
3. Use the skeleton in the commented block as a starting point
4. Test against DGI's sandbox (SIMPL portal)
5. Remove the `DGI-MAROC` exclusion from `formats()` in `index.js`

The mapper will be automatically available in the export endpoint and frontend once registered.

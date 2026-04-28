'use strict';

/**
 * E-Invoicing module — public API
 *
 * Extensible mapper registry.  Adding a new output format is a
 * two-step operation:
 *   1. Create `lib/einvoice/mappers/<name>.js` exporting { generate(canonical) }
 *   2. Register it here under the desired format key.
 *
 * The canonical model is never touched when adding formats.
 *
 * Supported formats
 * -----------------
 *   UBL-2.1  →  OASIS UBL 2.1 Invoice XML (XML)
 *   (future) CII-D16B  →  UN/CEFACT CII D16B XML
 *   (future) DGI-MA    →  Moroccan DGI proprietary format
 */

const { buildCanonicalInvoice } = require('./canonical');
const ublMapper  = require('./mappers/ubl21');
const ciiMapper  = require('./mappers/cii');

const MAPPERS = {
  'UBL-2.1': ublMapper,
  'CII':     ciiMapper,
};

const SUPPORTED_FORMATS = Object.keys(MAPPERS);

/**
 * Generate an e-invoice in the requested format.
 *
 * @param {number|string} invoiceId
 * @param {string} format  - one of SUPPORTED_FORMATS
 * @param {import('pg').Pool} pool
 * @returns {Promise<{ xml: string, canonical: object, format: string }>}
 */
async function generateEInvoice(invoiceId, format, pool) {
  const mapper = MAPPERS[format];
  if (!mapper) {
    const err = new Error(`Unsupported format: "${format}". Supported: ${SUPPORTED_FORMATS.join(', ')}`);
    err.status = 400;
    throw err;
  }

  const canonical = await buildCanonicalInvoice(invoiceId, pool);
  const xml       = mapper.generate(canonical);

  return { xml, canonical, format };
}

module.exports = {
  generateEInvoice,
  buildCanonicalInvoice,
  SUPPORTED_FORMATS,
};

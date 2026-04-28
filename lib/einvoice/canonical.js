'use strict';

/**
 * Canonical Invoice Builder
 *
 * Fetches invoice data from the database and normalises it into a
 * single, format-agnostic representation.  This is the single source
 * of truth consumed by every e-invoicing mapper (UBL 2.1, CII, …).
 *
 * @param {number|string} invoiceId
 * @param {import('pg').Pool} pool
 * @returns {Promise<CanonicalInvoice>}
 */
async function buildCanonicalInvoice(invoiceId, pool) {
  // ── 1. Invoice header + company (supplier) ────────────────────────
  const invoiceResult = await pool.query(
    `SELECT
       i.id,
       i.invoice_number,
       i.type,
       i.invoice_subtype,
       i.status,
       i.date,
       i.due_date,
       i.notes,
       i.payment_method,
       i.ice_client,
       i.client_id,
       i.contact_id,
       i.company_id,
       -- company (always the "owner" tenant)
       c.name            AS company_name,
       c.ice             AS company_ice,
       c.idf             AS company_idf,
       c.rc              AS company_rc,
       c.address         AS company_address,
       c.city            AS company_city,
       c.rib             AS company_rib,
       c.bank_name       AS company_bank_name,
       c.payment_conditions AS company_payment_conditions,
       c.currency        AS company_currency
     FROM invoices i
     JOIN companies c ON c.id = i.company_id
     WHERE i.id = $1`,
    [invoiceId]
  );

  if (invoiceResult.rows.length === 0) {
    const err = new Error(`Invoice ${invoiceId} not found`);
    err.status = 404;
    throw err;
  }

  const inv = invoiceResult.rows[0];

  // ── 2. Invoice lines ───────────────────────────────────────────────
  const linesResult = await pool.query(
    `SELECT
       id,
       description,
       quantity,
       unit_price,
       tva_rate,
       tva_amount,
       total,
       account_code,
       sort_order
     FROM invoice_lines
     WHERE invoice_id = $1
     ORDER BY sort_order, id`,
    [invoiceId]
  );

  const lines = linesResult.rows.map((l) => {
    const unitPriceHT = parseFloat(l.unit_price);
    const quantity    = parseFloat(l.quantity);
    const tvaRate     = parseFloat(l.tva_rate || 0);
    const totalHT     = parseFloat((quantity * unitPriceHT).toFixed(2));
    const tvaAmount   = parseFloat(l.tva_amount || (totalHT * tvaRate / 100).toFixed(2));
    const totalTTC    = parseFloat((totalHT + tvaAmount).toFixed(2));

    return {
      id:           l.id,
      description:  l.description,
      quantity,
      unitPriceHT,
      tvaRate,
      tvaAmount,
      totalHT,
      totalTTC,
      accountCode:  l.account_code || null,
    };
  });

  // ── 3. Totals ──────────────────────────────────────────────────────
  const totalHT  = lines.reduce((s, l) => s + l.totalHT, 0);
  const totalTVA = lines.reduce((s, l) => s + l.tvaAmount, 0);
  const totalTTC = lines.reduce((s, l) => s + l.totalTTC, 0);

  // Tax breakdown grouped by rate
  const tvaMap = {};
  for (const l of lines) {
    const key = String(l.tvaRate);
    if (!tvaMap[key]) tvaMap[key] = { rate: l.tvaRate, taxableAmount: 0, taxAmount: 0 };
    tvaMap[key].taxableAmount = parseFloat((tvaMap[key].taxableAmount + l.totalHT).toFixed(2));
    tvaMap[key].taxAmount     = parseFloat((tvaMap[key].taxAmount + l.tvaAmount).toFixed(2));
  }
  const taxBreakdown = Object.values(tvaMap).sort((a, b) => a.rate - b.rate);

  // ── 4. Resolve counterparty ────────────────────────────────────────
  // For sale invoices  → customer is clients table (or fallback to contacts)
  // For purchase invoices → supplier is contacts table; customer is the company
  let clientRow   = null;
  let contactRow  = null;

  if (inv.client_id) {
    const r = await pool.query(
      `SELECT id, name, ice, if_number AS idf, rc_number AS rc, address, city
       FROM clients
       WHERE id = $1`,
      [inv.client_id]
    );
    clientRow = r.rows[0] || null;
  }

  if (!clientRow && inv.contact_id) {
    const r = await pool.query(
      `SELECT id, name, ice, idf, rc, address, city
       FROM contacts
       WHERE id = $1`,
      [inv.contact_id]
    );
    contactRow = r.rows[0] || null;
  }

  const counterparty = clientRow || contactRow || null;

  // Build party objects
  const companyParty = {
    name:     inv.company_name  || '',
    ice:      inv.company_ice   || null,
    idf:      inv.company_idf   || null,
    rc:       inv.company_rc    || null,
    address:  inv.company_address || null,
    city:     inv.company_city  || null,
    rib:      inv.company_rib   || null,
    bankName: inv.company_bank_name || null,
  };

  const counterpartyParty = counterparty ? {
    name:    counterparty.name    || '',
    ice:     counterparty.ice     || inv.ice_client || null,
    idf:     counterparty.idf     || null,
    rc:      counterparty.rc      || null,
    address: counterparty.address || null,
    city:    counterparty.city    || null,
    rib:     null,
    bankName: null,
  } : {
    name:    '',
    ice:     inv.ice_client || null,
    idf:     null,
    rc:      null,
    address: null,
    city:    null,
    rib:     null,
    bankName: null,
  };

  const isSale    = inv.type === 'sale' || inv.type === 'vente';
  const supplier  = isSale ? companyParty     : counterpartyParty;
  const customer  = isSale ? counterpartyParty : companyParty;

  // ── 5. Assemble canonical object ──────────────────────────────────
  return {
    id:            inv.id,
    invoiceNumber: inv.invoice_number,
    type:          inv.type,            // 'sale' | 'purchase'
    subtype:       inv.invoice_subtype || null,  // 'avoir' | null
    status:        inv.status,
    date:          inv.date ? inv.date.toISOString().slice(0, 10) : null,
    dueDate:       inv.due_date ? inv.due_date.toISOString().slice(0, 10) : null,
    currency:      inv.company_currency || 'MAD',
    paymentMethod: inv.payment_method || null,
    paymentTerms:  inv.company_payment_conditions || null,
    notes:         inv.notes || null,

    supplier,
    customer,

    lines,

    totals: {
      totalHT:      parseFloat(totalHT.toFixed(2)),
      taxBreakdown,
      totalTVA:     parseFloat(totalTVA.toFixed(2)),
      totalTTC:     parseFloat(totalTTC.toFixed(2)),
    },
  };
}

module.exports = { buildCanonicalInvoice };

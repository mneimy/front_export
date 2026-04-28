'use strict';

/**
 * UBL 2.1 Invoice Mapper
 *
 * Transforms a canonical invoice object into a well-formed XML string
 * conforming to OASIS UBL 2.1 Invoice schema.
 *
 * Spec: urn:oasis:names:specification:ubl:schema:xsd:Invoice-2
 * Reference: http://docs.oasis-open.org/ubl/os-UBL-2.1/
 */

// ── Helpers ──────────────────────────────────────────────────────────

/** Escape XML special characters */
function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Format number to 2 decimal places */
function num(v) {
  return parseFloat(v || 0).toFixed(2);
}

/**
 * Map Moroccan payment method → UBL PaymentMeansCode
 * Codes from ISO 20022 / UNCL4461
 */
const PAYMENT_MEANS_CODES = {
  virement:        '30',  // credit transfer
  cheque:          '20',  // cheque
  espece:          '10',  // cash
  prelevement:     '49',  // direct debit
  carte:           '48',  // bank card
  lettre_change:   '60',  // exchange of letter
};

function paymentMeansCode(method) {
  if (!method) return '1';
  const m = String(method).toLowerCase().trim();
  return PAYMENT_MEANS_CODES[m] || '1';
}

/**
 * Invoice type code:
 *   380 → commercial invoice
 *   381 → credit note (avoir)
 *   389 → self-billed invoice (not used here)
 */
function invoiceTypeCode(canonical) {
  if (canonical.subtype === 'avoir') return '381';
  return '380';
}

// ── Party XML ────────────────────────────────────────────────────────

function partyXml(party) {
  const lines = ['<cac:Party>'];

  // ICE → PartyIdentification (Moroccan identifier)
  if (party.ice) {
    lines.push(
      '  <cac:PartyIdentification>',
      `    <cbc:ID schemeID="ICE">${esc(party.ice)}</cbc:ID>`,
      '  </cac:PartyIdentification>'
    );
  }

  // Name
  if (party.name) {
    lines.push(
      '  <cac:PartyName>',
      `    <cbc:Name>${esc(party.name)}</cbc:Name>`,
      '  </cac:PartyName>'
    );
  }

  // Postal address
  const hasAddress = party.address || party.city;
  if (hasAddress) {
    lines.push('  <cac:PostalAddress>');
    if (party.address) lines.push(`    <cbc:StreetName>${esc(party.address)}</cbc:StreetName>`);
    if (party.city)    lines.push(`    <cbc:CityName>${esc(party.city)}</cbc:CityName>`);
    lines.push(
      '    <cac:Country>',
      '      <cbc:IdentificationCode>MA</cbc:IdentificationCode>',
      '    </cac:Country>',
      '  </cac:PostalAddress>'
    );
  }

  // Tax scheme (TVA)
  if (party.idf) {
    lines.push(
      '  <cac:PartyTaxScheme>',
      `    <cbc:CompanyID schemeID="IF">${esc(party.idf)}</cbc:CompanyID>`,
      '    <cac:TaxScheme>',
      '      <cbc:ID>TVA</cbc:ID>',
      '    </cac:TaxScheme>',
      '  </cac:PartyTaxScheme>'
    );
  }

  // Legal entity (RC + registration name)
  lines.push('  <cac:PartyLegalEntity>');
  if (party.name) lines.push(`    <cbc:RegistrationName>${esc(party.name)}</cbc:RegistrationName>`);
  if (party.rc)   lines.push(`    <cbc:CompanyID schemeID="RC">${esc(party.rc)}</cbc:CompanyID>`);
  lines.push('  </cac:PartyLegalEntity>');

  lines.push('</cac:Party>');
  return lines;
}

// ── TaxTotal XML ─────────────────────────────────────────────────────

function taxTotalXml(totals, currency) {
  const lines = [
    '<cac:TaxTotal>',
    `  <cbc:TaxAmount currencyID="${esc(currency)}">${num(totals.totalTVA)}</cbc:TaxAmount>`,
  ];

  for (const sub of totals.taxBreakdown) {
    // UBL TaxCategory ID mapping for Moroccan TVA rates
    // 'S' = standard rate, 'Z' = zero rate, 'E' = exempt
    const catId = sub.rate === 0 ? 'Z' : 'S';

    lines.push(
      '  <cac:TaxSubtotal>',
      `    <cbc:TaxableAmount currencyID="${esc(currency)}">${num(sub.taxableAmount)}</cbc:TaxableAmount>`,
      `    <cbc:TaxAmount currencyID="${esc(currency)}">${num(sub.taxAmount)}</cbc:TaxAmount>`,
      '    <cac:TaxCategory>',
      `      <cbc:ID>${catId}</cbc:ID>`,
      `      <cbc:Percent>${num(sub.rate)}</cbc:Percent>`,
      '      <cac:TaxScheme>',
      '        <cbc:ID>TVA</cbc:ID>',
      '      </cac:TaxScheme>',
      '    </cac:TaxCategory>',
      '  </cac:TaxSubtotal>'
    );
  }

  lines.push('</cac:TaxTotal>');
  return lines;
}

// ── LegalMonetaryTotal XML ────────────────────────────────────────────

function legalMonetaryTotalXml(totals, currency) {
  return [
    '<cac:LegalMonetaryTotal>',
    `  <cbc:LineExtensionAmount currencyID="${esc(currency)}">${num(totals.totalHT)}</cbc:LineExtensionAmount>`,
    `  <cbc:TaxExclusiveAmount currencyID="${esc(currency)}">${num(totals.totalHT)}</cbc:TaxExclusiveAmount>`,
    `  <cbc:TaxInclusiveAmount currencyID="${esc(currency)}">${num(totals.totalTTC)}</cbc:TaxInclusiveAmount>`,
    `  <cbc:PayableAmount currencyID="${esc(currency)}">${num(totals.totalTTC)}</cbc:PayableAmount>`,
    '</cac:LegalMonetaryTotal>',
  ];
}

// ── InvoiceLine XML ──────────────────────────────────────────────────

function invoiceLineXml(line, idx, currency) {
  const lines = [
    '<cac:InvoiceLine>',
    `  <cbc:ID>${idx}</cbc:ID>`,
    `  <cbc:InvoicedQuantity unitCode="C62">${num(line.quantity)}</cbc:InvoicedQuantity>`,
    `  <cbc:LineExtensionAmount currencyID="${esc(currency)}">${num(line.totalHT)}</cbc:LineExtensionAmount>`,
  ];

  // Tax info per line
  const catId = line.tvaRate === 0 ? 'Z' : 'S';
  lines.push(
    '  <cac:TaxTotal>',
    `    <cbc:TaxAmount currencyID="${esc(currency)}">${num(line.tvaAmount)}</cbc:TaxAmount>`,
    '    <cac:TaxSubtotal>',
    `      <cbc:TaxableAmount currencyID="${esc(currency)}">${num(line.totalHT)}</cbc:TaxableAmount>`,
    `      <cbc:TaxAmount currencyID="${esc(currency)}">${num(line.tvaAmount)}</cbc:TaxAmount>`,
    '      <cac:TaxCategory>',
    `        <cbc:ID>${catId}</cbc:ID>`,
    `        <cbc:Percent>${num(line.tvaRate)}</cbc:Percent>`,
    '        <cac:TaxScheme>',
    '          <cbc:ID>TVA</cbc:ID>',
    '        </cac:TaxScheme>',
    '      </cac:TaxCategory>',
    '    </cac:TaxSubtotal>',
    '  </cac:TaxTotal>'
  );

  lines.push(
    '  <cac:Item>',
    `    <cbc:Description>${esc(line.description)}</cbc:Description>`,
    '    <cac:ClassifiedTaxCategory>',
    `      <cbc:ID>${catId}</cbc:ID>`,
    `      <cbc:Percent>${num(line.tvaRate)}</cbc:Percent>`,
    '      <cac:TaxScheme>',
    '        <cbc:ID>TVA</cbc:ID>',
    '      </cac:TaxScheme>',
    '    </cac:ClassifiedTaxCategory>',
    '  </cac:Item>',
    '  <cac:Price>',
    `    <cbc:PriceAmount currencyID="${esc(currency)}">${num(line.unitPriceHT)}</cbc:PriceAmount>`,
    '  </cac:Price>',
    '</cac:InvoiceLine>'
  );

  return lines;
}

// ── Main Generator ───────────────────────────────────────────────────

/**
 * Generate a UBL 2.1 Invoice XML string from a canonical invoice.
 *
 * @param {object} canonical - output of buildCanonicalInvoice()
 * @returns {string} well-formed XML
 */
function generate(canonical) {
  const currency = canonical.currency || 'MAD';
  const typeCode = invoiceTypeCode(canonical);
  const pmCode   = paymentMeansCode(canonical.paymentMethod);

  const doc = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Invoice',
    '  xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"',
    '  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"',
    '  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2">',

    // ── Header ────────────────────────────────────────────────────────
    '  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>',
    '  <cbc:CustomizationID>urn:oasis:names:specification:ubl:schema:xsd:Invoice-2</cbc:CustomizationID>',
    `  <cbc:ID>${esc(canonical.invoiceNumber)}</cbc:ID>`,
    `  <cbc:IssueDate>${esc(canonical.date || '')}</cbc:IssueDate>`,
  ];

  if (canonical.dueDate) {
    doc.push(`  <cbc:DueDate>${esc(canonical.dueDate)}</cbc:DueDate>`);
  }

  doc.push(
    `  <cbc:InvoiceTypeCode>${typeCode}</cbc:InvoiceTypeCode>`,
    `  <cbc:DocumentCurrencyCode>${esc(currency)}</cbc:DocumentCurrencyCode>`
  );

  if (canonical.notes) {
    doc.push(`  <cbc:Note>${esc(canonical.notes)}</cbc:Note>`);
  }

  // ── AccountingSupplierParty ───────────────────────────────────────
  doc.push('  <cac:AccountingSupplierParty>');
  for (const l of partyXml(canonical.supplier)) {
    doc.push('    ' + l);
  }
  doc.push('  </cac:AccountingSupplierParty>');

  // ── AccountingCustomerParty ───────────────────────────────────────
  doc.push('  <cac:AccountingCustomerParty>');
  for (const l of partyXml(canonical.customer)) {
    doc.push('    ' + l);
  }
  doc.push('  </cac:AccountingCustomerParty>');

  // ── PaymentMeans ──────────────────────────────────────────────────
  doc.push(
    '  <cac:PaymentMeans>',
    `    <cbc:PaymentMeansCode>${pmCode}</cbc:PaymentMeansCode>`
  );
  if (canonical.dueDate) {
    doc.push(`    <cbc:PaymentDueDate>${esc(canonical.dueDate)}</cbc:PaymentDueDate>`);
  }
  if (canonical.supplier.rib) {
    doc.push(
      '    <cac:PayeeFinancialAccount>',
      `      <cbc:ID>${esc(canonical.supplier.rib)}</cbc:ID>`,
      canonical.supplier.bankName
        ? `      <cbc:Name>${esc(canonical.supplier.bankName)}</cbc:Name>`
        : '',
      '    </cac:PayeeFinancialAccount>'
    );
  }
  doc.push('  </cac:PaymentMeans>');

  // ── PaymentTerms ──────────────────────────────────────────────────
  if (canonical.paymentTerms) {
    doc.push(
      '  <cac:PaymentTerms>',
      `    <cbc:Note>${esc(canonical.paymentTerms)}</cbc:Note>`,
      '  </cac:PaymentTerms>'
    );
  }

  // ── TaxTotal ─────────────────────────────────────────────────────
  for (const l of taxTotalXml(canonical.totals, currency)) {
    doc.push('  ' + l);
  }

  // ── LegalMonetaryTotal ────────────────────────────────────────────
  for (const l of legalMonetaryTotalXml(canonical.totals, currency)) {
    doc.push('  ' + l);
  }

  // ── InvoiceLines ─────────────────────────────────────────────────
  canonical.lines.forEach((line, idx) => {
    for (const l of invoiceLineXml(line, idx + 1, currency)) {
      doc.push('  ' + l);
    }
  });

  doc.push('</Invoice>');

  return doc.filter((l) => l !== '').join('\n');
}

module.exports = { generate };

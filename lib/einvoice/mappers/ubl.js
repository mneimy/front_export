'use strict';

/**
 * UBL 2.1 Invoice Mapper
 * ----------------------
 * Converts a canonical invoice object to a UBL 2.1 XML string.
 *
 * Standard: OASIS UBL 2.1
 * Schema: urn:oasis:names:specification:ubl:schema:xsd:Invoice-2
 *
 * Reference: https://docs.oasis-open.org/ubl/UBL-2.1.html
 *            https://www.oasis-open.org/specs/UBL-Invoice-2.1.xsd
 */

/**
 * Escape XML special characters
 * @param {any} val
 * @returns {string}
 */
function escXml(val) {
  if (val == null) return '';
  return String(val)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Format a number to 2 decimal places for monetary amounts
 * @param {number} n
 * @returns {string}
 */
function fmt(n) {
  return (n || 0).toFixed(2);
}

/**
 * Build a UBL Party block (cac:AccountingSupplierParty or BuyerParty)
 * @param {object} party  - canonical party
 * @param {string} tag    - 'AccountingSupplierParty' | 'AccountingCustomerParty'
 * @returns {string}
 */
function buildPartyBlock(party, tag) {
  const taxLines = [];
  if (party.ice) {
    taxLines.push(`
          <cac:PartyTaxScheme>
            <cbc:CompanyID>${escXml(party.ice)}</cbc:CompanyID>
            <cac:TaxScheme>
              <cbc:ID>ICE</cbc:ID>
            </cac:TaxScheme>
          </cac:PartyTaxScheme>`);
  }
  if (party.idf) {
    taxLines.push(`
          <cac:PartyTaxScheme>
            <cbc:CompanyID>${escXml(party.idf)}</cbc:CompanyID>
            <cac:TaxScheme>
              <cbc:ID>IF</cbc:ID>
            </cac:TaxScheme>
          </cac:PartyTaxScheme>`);
  }
  if (party.rc) {
    taxLines.push(`
          <cac:PartyTaxScheme>
            <cbc:CompanyID>${escXml(party.rc)}</cbc:CompanyID>
            <cac:TaxScheme>
              <cbc:ID>RC</cbc:ID>
            </cac:TaxScheme>
          </cac:PartyTaxScheme>`);
  }

  return `
  <cac:${tag}>
    <cac:Party>
      <cac:PartyName>
        <cbc:Name>${escXml(party.name)}</cbc:Name>
      </cac:PartyName>
      <cac:PostalAddress>
        ${party.address ? `<cbc:StreetName>${escXml(party.address)}</cbc:StreetName>` : ''}
        ${party.city    ? `<cbc:CityName>${escXml(party.city)}</cbc:CityName>` : ''}
        <cac:Country>
          <cbc:IdentificationCode>${escXml(party.country || 'MA')}</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>${taxLines.join('')}
      <cac:Contact>
        ${party.phone ? `<cbc:Telephone>${escXml(party.phone)}</cbc:Telephone>` : ''}
        ${party.email ? `<cbc:ElectronicMail>${escXml(party.email)}</cbc:ElectronicMail>` : ''}
      </cac:Contact>
    </cac:Party>
  </cac:${tag}>`;
}

/**
 * Build a TaxTotal block aggregating all TVA rates
 * @param {Array} tvaBreakdown
 * @param {string} currency
 * @returns {string}
 */
function buildTaxTotal(tvaBreakdown, currency) {
  const totalTax = tvaBreakdown.reduce((s, t) => s + t.tvaAmount, 0);
  const subtotals = tvaBreakdown.map(t => `
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="${currency}">${fmt(t.baseHT)}</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="${currency}">${fmt(t.tvaAmount)}</cbc:TaxAmount>
        <cac:TaxCategory>
          <cbc:ID>${t.rate === 0 ? 'Z' : 'S'}</cbc:ID>
          <cbc:Percent>${fmt(t.rate)}</cbc:Percent>
          <cac:TaxScheme>
            <cbc:ID>VAT</cbc:ID>
          </cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>`).join('');

  return `
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${currency}">${fmt(totalTax)}</cbc:TaxAmount>${subtotals}
  </cac:TaxTotal>`;
}

/**
 * Build InvoiceLine blocks
 * @param {Array}  lines
 * @param {string} currency
 * @returns {string}
 */
function buildInvoiceLines(lines, currency) {
  return lines.map(l => `
  <cac:InvoiceLine>
    <cbc:ID>${escXml(l.id)}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="C62">${fmt(l.quantity)}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${currency}">${fmt(l.totalHT)}</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="${currency}">${fmt(l.tvaAmount)}</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="${currency}">${fmt(l.totalHT)}</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="${currency}">${fmt(l.tvaAmount)}</cbc:TaxAmount>
        <cac:TaxCategory>
          <cbc:ID>${l.tvaRate === 0 ? 'Z' : 'S'}</cbc:ID>
          <cbc:Percent>${fmt(l.tvaRate)}</cbc:Percent>
          <cac:TaxScheme>
            <cbc:ID>VAT</cbc:ID>
          </cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Description>${escXml(l.description)}</cbc:Description>
      <cac:ClassifiedTaxCategory>
        <cbc:ID>${l.tvaRate === 0 ? 'Z' : 'S'}</cbc:ID>
        <cbc:Percent>${fmt(l.tvaRate)}</cbc:Percent>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="${currency}">${fmt(l.unitPrice)}</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>`).join('');
}

/**
 * Map canonical invoice → UBL 2.1 XML string
 * @param {object} canonical
 * @returns {string}
 */
function toUBL(canonical) {
  const { invoiceNumber, typeCode, issueDate, dueDate, currency,
          seller, buyer, lines, subtotalHT, tvaAmount, totalTTC,
          tvaBreakdown, notes, buyerReference } = canonical;

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">

  <!-- UBL Invoice 2.1 — Generated by HissabPro -->
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>urn:cen.eu:en16931:2017</cbc:CustomizationID>
  <cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>
  <cbc:ID>${escXml(invoiceNumber)}</cbc:ID>
  <cbc:IssueDate>${escXml(issueDate)}</cbc:IssueDate>
  ${dueDate ? `<cbc:DueDate>${escXml(dueDate)}</cbc:DueDate>` : ''}
  <cbc:InvoiceTypeCode>${escXml(typeCode)}</cbc:InvoiceTypeCode>
  ${notes ? `<cbc:Note>${escXml(notes)}</cbc:Note>` : ''}
  <cbc:DocumentCurrencyCode>${escXml(currency)}</cbc:DocumentCurrencyCode>
  ${buyerReference ? `<cbc:BuyerReference>${escXml(buyerReference)}</cbc:BuyerReference>` : ''}
${buildPartyBlock(seller, 'AccountingSupplierParty')}
${buildPartyBlock(buyer, 'AccountingCustomerParty')}
${buildTaxTotal(tvaBreakdown, currency)}
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${currency}">${fmt(subtotalHT)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${currency}">${fmt(subtotalHT)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${currency}">${fmt(totalTTC)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${currency}">${fmt(totalTTC)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
${buildInvoiceLines(lines, currency)}
</Invoice>
`;
}

module.exports = { toUBL };

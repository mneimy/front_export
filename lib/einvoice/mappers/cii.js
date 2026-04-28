'use strict';

/**
 * CII (Cross Industry Invoice) Mapper
 * ------------------------------------
 * Converts a canonical invoice object to a UN/CEFACT CII XML string.
 *
 * Standard: UN/CEFACT Cross Industry Invoice D16B
 * Namespace: urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100
 *
 * Also aligned with EN 16931 (European e-invoice standard) and
 * Factur-X / ZUGFeRD embedded PDF profiles.
 *
 * Reference:
 *   https://unece.org/trade/uncefact/xml-schemas
 *   https://fnfe-mpe.org/factur-x/
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
 * Format a number to 2 decimal places
 * @param {number} n
 * @returns {string}
 */
function fmt(n) {
  return (n || 0).toFixed(2);
}

/**
 * Convert ISO date (YYYY-MM-DD) to CII format (YYYYMMDD)
 * @param {string|null} isoDate
 * @returns {string}
 */
function toCIIDate(isoDate) {
  if (!isoDate) return '';
  return isoDate.replace(/-/g, '');
}

/**
 * Build a TradeParty block for seller or buyer.
 * Includes Moroccan-specific identifiers (ICE, IF, RC).
 *
 * @param {object} party     - canonical party
 * @param {string} partyTag  - 'SellerTradeParty' | 'BuyerTradeParty'
 * @returns {string}
 */
function buildTradeParty(party, partyTag) {
  const ids = [];

  // ICE — Identifiant Commun de l'Entreprise (mandatory in Morocco)
  if (party.ice) {
    ids.push(`
          <ram:ID schemeID="ICE">${escXml(party.ice)}</ram:ID>`);
  }
  // IF — Identifiant Fiscal
  if (party.idf) {
    ids.push(`
          <ram:ID schemeID="IF">${escXml(party.idf)}</ram:ID>`);
  }
  // RC — Registre du Commerce
  if (party.rc) {
    ids.push(`
          <ram:ID schemeID="RC">${escXml(party.rc)}</ram:ID>`);
  }

  const taxReg = party.ice ? `
          <ram:SpecifiedTaxRegistration>
            <ram:ID schemeID="VA">${escXml(party.ice)}</ram:ID>
          </ram:SpecifiedTaxRegistration>` : '';

  return `
          <ram:${partyTag}>
            <ram:Name>${escXml(party.name)}</ram:Name>${ids.join('')}
            <ram:PostalTradeAddress>
              ${party.address ? `<ram:LineOne>${escXml(party.address)}</ram:LineOne>` : ''}
              ${party.city    ? `<ram:CityName>${escXml(party.city)}</ram:CityName>` : ''}
              <ram:CountryID>${escXml(party.country || 'MA')}</ram:CountryID>
            </ram:PostalTradeAddress>${taxReg}
          </ram:${partyTag}>`;
}

/**
 * Build ApplicableTradeTax blocks, one per TVA rate.
 * @param {Array} tvaBreakdown
 * @param {string} currency
 * @returns {string}
 */
function buildApplicableTradeTax(tvaBreakdown, currency) {
  return tvaBreakdown.map(t => `
          <ram:ApplicableTradeTax>
            <ram:CalculatedAmount currencyID="${currency}">${fmt(t.tvaAmount)}</ram:CalculatedAmount>
            <ram:TypeCode>VAT</ram:TypeCode>
            <ram:BasisAmount currencyID="${currency}">${fmt(t.baseHT)}</ram:BasisAmount>
            <ram:CategoryCode>${t.rate === 0 ? 'Z' : 'S'}</ram:CategoryCode>
            <ram:RateApplicablePercent>${fmt(t.rate)}</ram:RateApplicablePercent>
          </ram:ApplicableTradeTax>`).join('');
}

/**
 * Build IncludedSupplyChainTradeLineItem blocks, one per invoice line.
 * @param {Array} lines
 * @param {string} currency
 * @returns {string}
 */
function buildTradeLineItems(lines, currency) {
  return lines.map(l => `
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument>
        <ram:LineID>${escXml(l.id)}</ram:LineID>
      </ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct>
        <ram:Name>${escXml(l.description)}</ram:Name>
      </ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:NetPriceProductTradePrice>
          <ram:ChargeAmount currencyID="${currency}">${fmt(l.unitPrice)}</ram:ChargeAmount>
        </ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery>
        <ram:BilledQuantity unitCode="C62">${fmt(l.quantity)}</ram:BilledQuantity>
      </ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode>
          <ram:CategoryCode>${l.tvaRate === 0 ? 'Z' : 'S'}</ram:CategoryCode>
          <ram:RateApplicablePercent>${fmt(l.tvaRate)}</ram:RateApplicablePercent>
        </ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation>
          <ram:LineTotalAmount currencyID="${currency}">${fmt(l.totalHT)}</ram:LineTotalAmount>
        </ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>`).join('');
}

/**
 * Map canonical invoice → CII XML string
 * @param {object} canonical
 * @returns {string}
 */
function toCII(canonical) {
  const { invoiceNumber, typeCode, issueDate, dueDate, currency,
          seller, buyer, lines, subtotalHT, tvaAmount, totalTTC,
          tvaBreakdown, notes } = canonical;

  const totalTax = tvaBreakdown.reduce((s, t) => s + t.tvaAmount, 0);

  return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice
  xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
  xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"
  xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100"
  xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100">

  <!-- CII D16B — Generated by HissabPro -->

  <rsm:ExchangedDocumentContext>
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>urn:cen.eu:en16931:2017</ram:ID>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>

  <rsm:ExchangedDocument>
    <ram:ID>${escXml(invoiceNumber)}</ram:ID>
    <ram:TypeCode>${escXml(typeCode)}</ram:TypeCode>
    <ram:IssueDateTime>
      <udt:DateTimeString format="102">${toCIIDate(issueDate)}</udt:DateTimeString>
    </ram:IssueDateTime>
    ${notes ? `<ram:IncludedNote><ram:Content>${escXml(notes)}</ram:Content></ram:IncludedNote>` : ''}
  </rsm:ExchangedDocument>

  <rsm:SupplyChainTradeTransaction>
${buildTradeLineItems(lines, currency)}
    <ram:ApplicableHeaderTradeAgreement>
      ${buyerReference(canonical)}
${buildTradeParty(seller, 'SellerTradeParty')}
${buildTradeParty(buyer, 'BuyerTradeParty')}
    </ram:ApplicableHeaderTradeAgreement>

    <ram:ApplicableHeaderTradeDelivery/>

    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>${escXml(currency)}</ram:InvoiceCurrencyCode>
      ${dueDate ? `<ram:SpecifiedTradePaymentTerms>
        <ram:DueDateDateTime>
          <udt:DateTimeString format="102">${toCIIDate(dueDate)}</udt:DateTimeString>
        </ram:DueDateDateTime>
      </ram:SpecifiedTradePaymentTerms>` : ''}
${buildApplicableTradeTax(tvaBreakdown, currency)}
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount currencyID="${currency}">${fmt(subtotalHT)}</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount currencyID="${currency}">${fmt(subtotalHT)}</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="${currency}">${fmt(totalTax)}</ram:TaxTotalAmount>
        <ram:GrandTotalAmount currencyID="${currency}">${fmt(totalTTC)}</ram:GrandTotalAmount>
        <ram:DuePayableAmount currencyID="${currency}">${fmt(totalTTC)}</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>

</rsm:CrossIndustryInvoice>
`;
}

/**
 * Internal helper — build BuyerReference line if present
 * @param {object} canonical
 * @returns {string}
 */
function buyerReference(canonical) {
  if (!canonical.buyerReference) return '';
  return `<ram:BuyerReference>${escXml(canonical.buyerReference)}</ram:BuyerReference>`;
}

// `generate` is the standard interface expected by the mapper registry
function generate(canonical) {
  return toCII(canonical);
}

module.exports = { toCII, generate };

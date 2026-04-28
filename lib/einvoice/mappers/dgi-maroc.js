'use strict';

/**
 * DGI Maroc E-Invoice Mapper (STUB)
 * -----------------------------------
 * Template for the official Moroccan DGI (Direction Générale des Impôts)
 * e-invoicing format.
 *
 * STATUS: STUB — awaiting official DGI specification publication.
 *
 * Context:
 *   Morocco is implementing mandatory e-invoicing (facturation électronique)
 *   under the Finance Law 2024 (Loi de Finances 2024), managed by DGI.
 *   The technical specifications for the XML format are expected to be
 *   published by DGI once the regulatory framework is finalized.
 *
 * How to complete this mapper:
 *   1. Obtain the official DGI technical specification (cahier des charges)
 *   2. Identify the target XML namespace and schema
 *   3. Map each canonical field (see lib/einvoice/canonical.js) to the
 *      corresponding DGI XML element
 *   4. Register in lib/einvoice/index.js: mappers['DGI-MAROC'] = dgiMarocMapper
 *   5. Add to the export endpoint's accepted format list
 *
 * Known DGI requirements (as of current public guidance):
 *   - ICE (Identifiant Commun de l'Entreprise) is MANDATORY for both parties
 *   - IF (Identifiant Fiscal) required for supplier
 *   - Invoice must include: issueDate, dueDate, invoiceNumber, currency (MAD)
 *   - TVA breakdown by rate required (0%, 7%, 10%, 14%, 20%)
 *   - Each line must have: description, quantity, unit_price_HT, tva_rate, total_TTC
 *   - XML must be signed with an approved digital certificate
 *   - Submission via DGI SIMPL portal API (endpoint TBD)
 *
 * Canonical fields available (all are in the `canonical` object):
 *   - canonical.invoiceNumber     — e.g. "F-2024-001"
 *   - canonical.typeCode          — "380" (invoice) or "381" (credit note)
 *   - canonical.issueDate         — "YYYY-MM-DD"
 *   - canonical.dueDate           — "YYYY-MM-DD" or null
 *   - canonical.currency          — "MAD"
 *   - canonical.seller.name       — company name
 *   - canonical.seller.ice        — ICE (mandatory)
 *   - canonical.seller.idf        — Identifiant Fiscal
 *   - canonical.seller.rc         — Registre du Commerce
 *   - canonical.seller.address    — street address
 *   - canonical.seller.city       — city
 *   - canonical.buyer.name        — client name
 *   - canonical.buyer.ice         — client ICE (required per DGI rules)
 *   - canonical.buyer.idf         — client IF
 *   - canonical.buyer.rc          — client RC
 *   - canonical.lines[]           — array of line items
 *     - .id, .description, .quantity, .unitPrice
 *     - .tvaRate (e.g. 20 for 20%), .tvaAmount, .totalHT, .totalTTC
 *   - canonical.subtotalHT        — total before TVA
 *   - canonical.tvaAmount         — total TVA
 *   - canonical.totalTTC          — grand total including TVA
 *   - canonical.tvaBreakdown[]    — [{rate, baseHT, tvaAmount}, ...]
 *   - canonical.notes             — free text notes
 */

// TODO: Replace with actual DGI namespace once published
const DGI_NAMESPACE = 'urn:ma:gov:dgi:einvoice:TODO';

/**
 * Map canonical invoice → DGI Maroc XML string
 *
 * @param {object} canonical - Canonical invoice (from lib/einvoice/canonical.js)
 * @returns {string}         - XML string
 * @throws {Error}           - Until specification is available
 */
function toDGIMaroc(canonical) {
  // TODO: Implement once DGI publishes the official technical specification.
  // See comments above for the list of required fields.

  throw new Error(
    'Le format DGI Maroc est en attente de la spécification officielle de la DGI. ' +
    'Utilisez UBL-2.1 ou CII en attendant.'
  );

  /* =========================================================
   * SKELETON — uncomment and fill in once spec is available
   * =========================================================
   *
   * const { invoiceNumber, typeCode, issueDate, dueDate, currency,
   *         seller, buyer, lines, subtotalHT, tvaAmount, totalTTC,
   *         tvaBreakdown } = canonical;
   *
   * // ICE is mandatory per DGI rules
   * if (!seller.ice) throw new Error('ICE vendeur requis pour le format DGI');
   * if (!buyer.ice)  throw new Error('ICE acheteur requis pour le format DGI');
   *
   * return `<?xml version="1.0" encoding="UTF-8"?>
   * <FactureElectronique xmlns="${DGI_NAMESPACE}">
   *   <Entete>
   *     <NumeroFacture>${invoiceNumber}</NumeroFacture>
   *     <DateEmission>${issueDate}</DateEmission>
   *     <DateEcheance>${dueDate || ''}</DateEcheance>
   *     <Devise>${currency}</Devise>
   *   </Entete>
   *   <Vendeur>
   *     <ICE>${seller.ice}</ICE>
   *     <IF>${seller.idf || ''}</IF>
   *     <RC>${seller.rc || ''}</RC>
   *     <Nom>${seller.name}</Nom>
   *     <Adresse>${seller.address || ''}</Adresse>
   *     <Ville>${seller.city || ''}</Ville>
   *   </Vendeur>
   *   <Acheteur>
   *     <ICE>${buyer.ice}</ICE>
   *     <IF>${buyer.idf || ''}</IF>
   *     <Nom>${buyer.name}</Nom>
   *     <Adresse>${buyer.address || ''}</Adresse>
   *     <Ville>${buyer.city || ''}</Ville>
   *   </Acheteur>
   *   <Lignes>
   *     ${lines.map(l => `
   *     <Ligne>
   *       <Numero>${l.id}</Numero>
   *       <Designation>${l.description}</Designation>
   *       <Quantite>${l.quantity}</Quantite>
   *       <PrixUnitaireHT>${l.unitPrice.toFixed(2)}</PrixUnitaireHT>
   *       <TauxTVA>${l.tvaRate}</TauxTVA>
   *       <MontantTVA>${l.tvaAmount.toFixed(2)}</MontantTVA>
   *       <TotalTTC>${l.totalTTC.toFixed(2)}</TotalTTC>
   *     </Ligne>`).join('')}
   *   </Lignes>
   *   <Totaux>
   *     <TotalHT>${subtotalHT.toFixed(2)}</TotalHT>
   *     <TotalTVA>${tvaAmount.toFixed(2)}</TotalTVA>
   *     <TotalTTC>${totalTTC.toFixed(2)}</TotalTTC>
   *   </Totaux>
   * </FactureElectronique>`;
   * ========================================================= */
}

module.exports = { toDGIMaroc };

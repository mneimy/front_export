/**
 * HissabPro - Entreprises Views Module
 * 5 views: Paramétrage, Saisie, Révision, Déclarations, Prospects
 * Fetches REAL dossiers from /api/cabinet/saisie — NO mock data.
 * Pennylane-exact design — pixel-perfect via entreprises-views.css
 */

(function () {
    'use strict';

    // ── Module state ───────────────────────────────────────────────────────────
    var STATE = {
        dossiers: [],
        filtered: [],
        loading: false,
        declarationsTab: 'TVA',
        declarationsYear: new Date().getFullYear(),
        prospectsTab: 'signature',
        saisieSearch: '',
        saisieFilters: {},
    };

    var CACHE = {
        tva: null,
        is: null,
        cloture: null,
        prospects_signature: null,
        prospects_perdus: null,
    };

    var MONTHS_FR = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Jun', 'Jul', 'Aoû', 'Sep', 'Oct', 'Nov', 'Déc'];

    var STATUT_LDM_LABELS = {
        'en_discussion':       { label: 'En discussion',          color: 'blue'   },
        'ldm_envoyee':         { label: 'LDM envoyée',            color: 'orange' },
        'en_attente_signature':{ label: 'En attente signature',   color: 'orange' },
        'perdu':               { label: 'Perdu',                   color: 'red'    },
    };

    var AVATAR_COLORS = ['green', 'purple', 'orange', 'blue', 'pink', 'teal', 'indigo', 'amber'];

    // ── Boot ────────────────────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', function () {
        renderLoadingState();
        fetchDossiers().then(function () {
            injectViewContent();
            overrideLoadFunction();
        });
    });

    // ── Fetch real data ────────────────────────────────────────────────────────
    function fetchDossiers() {
        return fetch('/api/cabinet/saisie?limit=200', { credentials: 'include' })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                STATE.dossiers = (data && data.dossiers) ? data.dossiers : [];
                STATE.filtered  = STATE.dossiers.slice();
            })
            .catch(function (err) {
                console.warn('[entv] fetch failed:', err);
                STATE.dossiers = [];
                STATE.filtered  = [];
            });
    }

    function renderLoadingState() {
        ['view-entreprises-parametrage', 'view-entreprises-saisie',
         'view-entreprises-revision', 'view-entreprises-declarations',
         'view-entreprises-prospects'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.innerHTML = '<div class="entv-view"><div class="entv-loading"><div class="entv-spinner"></div><span>Chargement des dossiers…</span></div></div>';
        });
    }

    function injectViewContent() {
        var map = {
            'view-entreprises-parametrage':  buildParametrageHTML(),
            'view-entreprises-saisie':       buildSaisieHTML(STATE.filtered),
            'view-entreprises-revision':      buildRevisionHTML(),
            'view-entreprises-declarations':  buildDeclarationsHTML(),
            'view-entreprises-prospects':    buildProspectsHTML(),
        };
        Object.keys(map).forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.innerHTML = map[id];
        });
        bindSaisieFilters();
        bindParametrageRows();
        injectProspectsModal();
        injectParametrageDrawer();
    }

    function overrideLoadFunction() {
        window.loadEntreprisesView = async function (subview) {
            if (typeof window._entvSetActiveNav === 'function') {
                window._entvSetActiveNav(subview);
            }
            try { localStorage.setItem('hissabpro_entv_last', subview); } catch (e) {}

            if (subview === 'declarations') {
                await loadDeclarationsData(STATE.declarationsTab);
            } else if (subview === 'prospects') {
                await loadProspectsData(STATE.prospectsTab);
            }
        };

        window.loadEntreprisesProspects = async function () {
            if (typeof window._entvSetActiveNav === 'function') {
                window._entvSetActiveNav('prospects');
            }
            try { localStorage.setItem('hissabpro_entv_last', 'prospects'); } catch (e) {}
            await loadProspectsData(STATE.prospectsTab);
        };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // HELPER RENDERERS — Pennylane exact
    // ═══════════════════════════════════════════════════════════════════════════

    function escHtml(s) {
        return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
    function esc(s) { return escHtml(s); }

    // Hash a string to get a consistent color index
    function hashColor(name) {
        var hash = 0;
        var s = String(name || '');
        for (var i = 0; i < s.length; i++) {
            hash = ((hash << 5) - hash) + s.charCodeAt(i);
            hash |= 0;
        }
        return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
    }

    function badge(text, color) {
        var cls = 'entv-badge';
        if (color === 'orange') cls += ' entv-badge-orange';
        else if (color === 'blue')   cls += ' entv-badge-blue';
        else if (color === 'green')  cls += ' entv-badge-green';
        else if (color === 'red')    cls += ' entv-badge-red';
        else cls += ' entv-badge-gray';
        return '<span class="' + cls + '">' + escHtml(text) + '</span>';
    }

    function avatars(items) {
        if (!items || !items.length) return '<span style="color:#94a3b8;">—</span>';
        return '<div class="entv-avatar-group">' +
            items.filter(Boolean).map(function (item) {
                var name = String(item).trim();
                var initials = name.split(/\s+/).map(function (w) { return w[0] || ''; }).join('').toUpperCase().slice(0, 2);
                var colorCls = 'entv-avatar-' + hashColor(name);
                return '<div class="entv-avatar ' + colorCls + '" title="' + escHtml(name) + '">' + escHtml(initials) + '</div>';
            }).join('') +
            '</div>';
    }

    function teamAvatars(teamArr) {
        if (!teamArr || teamArr.length === 0) return '<span style="color:#94a3b8;">—</span>';
        return avatars(teamArr.filter(Boolean));
    }

    function progress(value) {
        var v = Math.max(0, Math.min(100, parseInt(value) || 0));
        return '<div class="entv-progress-wrap">' +
            '<div class="entv-progress-track">' +
            '<div class="entv-progress-bar" style="width:' + v + '%;"></div>' +
            '</div>' +
            '<span class="entv-progress-label">' + v + '%</span>' +
            '</div>';
    }

    function headerBar(title, buttons) {
        return '<div class="entv-header-bar">' +
            '<h2>' + title + '</h2>' +
            '<div class="entv-header-actions">' + (buttons || '') + '</div>' +
            '</div>';
    }

    function exportBtn(viewId) {
        return '<button class="entv-btn" onclick="window._entvExportCSV && window._entvExportCSV(\'' + viewId + '\')">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
            'Export</button>';
    }

    function createBtn() {
        return '<button class="entv-btn-primary" onclick="window.openCreateDossierModal && window.openCreateDossierModal()">' +
            '+ Créer un nouveau dossier client</button>';
    }

    function filterBar(extraFilters, viewId) {
        var allFilters = [
            { key: 'utilisateurs',         label: 'Utilisateurs' },
            { key: 'frequence_tva',        label: 'Fréq TVA' },
            { key: 'exercice_comptable',   label: 'Exercice comptable' },
            { key: 'perimetre_mission',    label: 'Périmètre mission' },
        ].concat((extraFilters || []).map(function (f) {
            return typeof f === 'string' ? { key: f.toLowerCase().replace(/\s+/g, '_'), label: f } : f;
        }));

        var chips = allFilters.map(function (f) {
            return '<button class="entv-filter-chip" data-filter-key="' + f.key + '" data-view="' + (viewId || '') + '">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>' +
                f.label + ' <span class="entv-chip-arrow">▾</span></button>';
        }).join('');

        return '<div class="entv-filter-bar" id="filter-bar-' + (viewId || 'main') + '">' +
            '<input class="entv-search" placeholder="Rechercher une entreprise" id="search-' + (viewId || 'main') + '" />' +
            chips +
            '<button class="entv-filter-chip entv-filter-customize">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>' +
            'Personnaliser</button>' +
            '</div>';
    }

    // Table building
    function th(label, sortable) {
        if (sortable) {
            return '<th class="entv-th-sortable">' + label + ' <span class="entv-sort-arrow">↕</span></th>';
        }
        return '<th>' + label + '</th>';
    }
    function td(content) { return '<td>' + (content !== null && content !== undefined ? content : '—') + '</td>'; }
    function tr(cells) { return '<tr class="entv-row">' + cells + '</tr>'; }
    function trClickable(cells, handler) {
        return '<tr class="entv-row" style="cursor:pointer;" onclick="' + handler + '">' +
            (Array.isArray(cells) ? cells.join('') : cells) + '</tr>';
    }

    function tableWrap(headers, bodyRows, tableId) {
        return '<div class="entv-table-wrap">' +
            '<table class="entv-table"' + (tableId ? ' id="' + tableId + '"' : '') + '>' +
            '<thead><tr>' + headers.map(function(h) { return th(h, h === 'Nom' || h === 'Raison sociale'); }).join('') + '</tr></thead>' +
            '<tbody' + (tableId ? ' id="' + tableId + '-body"' : '') + '>' + (bodyRows || '<tr><td colspan="' + headers.length + '" class="entv-no-data">Aucun dossier trouvé</td></tr>') + '</tbody>' +
            '</table></div>';
    }

    function loadingSpinner() {
        return '<div class="entv-loading"><div class="entv-spinner"></div><span>Chargement des données...</span></div>';
    }

    function fmtAmount(n) {
        if (n == null || isNaN(n)) return '';
        return Number(n).toLocaleString('fr-MA', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' MAD';
    }

    function fmtDate(d) {
        if (!d) return '—';
        var dt = new Date(d);
        if (isNaN(dt.getTime())) return '—';
        return dt.toLocaleDateString('fr-MA', { day: '2-digit', month: '2-digit', year: 'numeric' });
    }

    function numBadge(n, alertThreshold, warnThreshold) {
        if (n === null || n === undefined || n === 0) return badge('0', 'gray');
        if (alertThreshold !== undefined && n >= alertThreshold) return badge(String(n), 'red');
        if (warnThreshold  !== undefined && n >= warnThreshold)  return badge(String(n), 'orange');
        return badge(String(n), 'blue');
    }

    // ── View re-render helper ──────────────────────────────────────────────
    function rerenderView(viewId) {
        var el, html;
        if (viewId === 'parametrage') {
            el = document.getElementById('view-entreprises-parametrage');
            html = buildParametrageHTML();
        } else if (viewId === 'saisie') {
            el = document.getElementById('view-entreprises-saisie');
            html = buildSaisieHTML(STATE.filtered);
        } else if (viewId === 'revision') {
            el = document.getElementById('view-entreprises-revision');
            html = buildRevisionHTML();
        }
        if (el && html) {
            el.innerHTML = html;
        }
    }


    // ═══════════════════════════════════════════════════════════════════════════
    // VUE 1 — PARAMÉTRAGE
    // ═══════════════════════════════════════════════════════════════════════════

    function buildParametrageHTML() {
        var allRows = STATE.dossiers.map(function (c) {
            var team = [c.collaborateur, c.chef_de_mission].filter(Boolean);
            var cells = [
                td('<span class="entv-company-name">' + escHtml(c.name) + '</span>'),
                td(avatars(team)),
                td(c.categorie_fiscale ? badge(c.categorie_fiscale, 'blue') : '—'),
                td(c.regime_fiscal ? badge(c.regime_fiscal, 'gray') : '—'),
                td(c.frequence_tva ? badge(c.frequence_tva, 'gray') : '—'),
                td(c.perimetre_mission ? escHtml(c.perimetre_mission) : '—'),
                td(c.date_cloture || '—'),
                td(c.statut ? badge(c.statut === 'actif' ? 'Actif' : 'Archivé', c.statut === 'actif' ? 'green' : 'gray') : '—'),
            ].join('');
            return '<tr class="entv-row entv-row-parametrage" data-company-id="' + c.id + '" data-company-name="' + escHtml(c.name) + '">' + cells + '</tr>';
        }).join('');

        return '<div class="entv-view">' +
            headerBar('Paramétrage') +
            tableWrap(
                ['Raison sociale', 'Équipe', 'IS/IR', 'Régime', 'Fréq TVA', 'Périmètre', 'Clôture', 'Statut'],
                allRows
            ) +
            '</div>';
    }


    // ═══════════════════════════════════════════════════════════════════════════
    // VUE 2 — SAISIE (cockpit production)
    // ═══════════════════════════════════════════════════════════════════════════

    function buildSaisieHTML(dossiers) {
        var src = dossiers || STATE.filtered;

        if (!src.length) {
            return '<div class="entv-view">' +
                headerBar('Saisie') +
                '<div class="entv-placeholder"><p>Aucun dossier trouvé.</p></div>' +
                '</div>';
        }

        var allRows = src.map(function (c) {
            var team = [c.collaborateur, c.chef_de_mission].filter(Boolean);

            var txBadges = '<div style="display:flex;gap:4px;">' +
                (c.tx_a_traiter > 0 ? badge(c.tx_a_traiter + ' à traiter', 'orange') : badge('0', 'green')) +
                (c.tx_pre > 0 ? badge(c.tx_pre + ' pré.', 'blue') : '') +
                '</div>';

            var banqueBadge = c.banque_connectee
                ? badge('Connectée', 'green')
                : badge('Non connectée', 'gray');

            var autoBadge = c.automatisation === null
                ? '<span style="color:#94a3b8;">—</span>'
                : c.automatisation >= 80
                    ? badge(c.automatisation + '%', 'green')
                    : c.automatisation >= 50
                        ? badge(c.automatisation + '%', 'blue')
                        : badge(c.automatisation + '%', 'orange');

            var sn = escHtml(c.name).replace(/'/g, '&#39;');
            return trClickable([
                td('<span class="entv-company-name">' + escHtml(c.name) + '</span>'),
                td(c.pilote_pa ? escHtml(c.pilote_pa) : (c.chef_de_mission || '—')),
                td(c.type_comptabilite || '—'),
                td(c.forme_juridique || '—'),
                td(teamAvatars(team)),
                td(c.frequence_tva || '—'),
                td(txBadges),
                td(banqueBadge),
                td(numBadge(c.ecritures_attente, 20, 5)),
                td(numBadge(c.factures_fournisseurs, 20, 5)),
                td(numBadge(c.factures_clients, 20, 5)),
                td(numBadge(c.docs_approuver, 10, 3)),
                td(autoBadge),
            ], 'window._entvOpenDossierToView(' + (c.id || 0) + ',&quot;' + sn + '&quot;,&quot;journal&quot;)');
        }).join('');

        return '<div class="entv-view">' +
            headerBar('Saisie') +
            tableWrap(
                ['Raison sociale', 'Pilote PA', 'Type compta', 'Forme',
                 'Équipe', 'Fréq TVA', 'Transactions', 'Banque',
                 'Écr. attente', 'Fact. fourn.', 'Fact. clients',
                 'Docs', 'Automatisation'],
                allRows,
                'saisie-table'
            ) +
            '</div>';
    }

    // ── Saisie filter binding (placeholder for future use) ─────────────────
    function bindSaisieFilters() {
        // No filter bar in current version
    }


    // ═══════════════════════════════════════════════════════════════════════════
    // VUE 3 — RÉVISION
    // ═══════════════════════════════════════════════════════════════════════════

    function buildRevisionHTML() {
        var allRows = STATE.dossiers.map(function (c) {
            var team = [c.collaborateur, c.chef_de_mission].filter(Boolean);
            var sn = escHtml(c.name).replace(/'/g, '&#39;');
            return trClickable([
                td('<span class="entv-company-name">' + escHtml(c.name) + '</span>'),
                td(c.collaborateur ? escHtml(c.collaborateur) : '—'),
                td(c.chef_de_mission ? escHtml(c.chef_de_mission) : '—'),
                td(c.expert_comptable ? escHtml(c.expert_comptable) : '—'),
                td('Clôture comptable 2025'),
                td('—'),
                td(badge('À planifier', 'gray')),
                td(progress(0)),
                td(avatars(team)),
            ], 'window._entvOpenDossierToView(' + (c.id || 0) + ',&quot;' + sn + '&quot;,&quot;balance-generale&quot;)');
        }).join('');

        return '<div class="entv-view">' +
            headerBar('Révision') +
            tableWrap(
                ['Raison sociale', 'Collaborateur', 'Chef de mission', 'Expert-comptable',
                 'Nom dossier', 'Date limite', 'Statut', 'Progression', 'Impliqués'],
                allRows
            ) +
            '</div>';
    }


    // ═══════════════════════════════════════════════════════════════════════════
    // VUE 4 — DÉCLARATIONS
    // ═══════════════════════════════════════════════════════════════════════════

    function buildDeclarationsHTML() {
        var tabs = ['TVA', 'Acomptes IS', 'Suivi clôture'];
        var tabBtns = tabs.map(function (t) {
            var active = t === 'TVA';
            var cls = active ? 'entv-btn-primary' : 'entv-btn';
            return '<button data-decl-tab="' + t + '" class="' + cls + '" onclick="window._entvDeclSwitchTab(\'' + escHtml(t) + '\')">' + t + '</button>';
        }).join('');

        var yearBtns =
            '<div class="entv-year-nav">' +
            '<button class="entv-btn" onclick="window._entvDeclPrevYear()">←</button>' +
            '<span id="entv-decl-year">' + STATE.declarationsYear + '</span>' +
            '<button class="entv-btn" onclick="window._entvDeclNextYear()">→</button>' +
            '</div>';

        return '<div class="entv-view">' +
            headerBar('Déclarations', yearBtns) +
            '<div class="entv-tab-bar">' +
            '<div class="entv-tab-wrap">' + tabBtns + '</div>' +
            '</div>' +
            '<div data-decl-panel="TVA">' + loadingSpinner() + '</div>' +
            '<div data-decl-panel="Acomptes IS" style="display:none;">' + loadingSpinner() + '</div>' +
            '<div data-decl-panel="Suivi clôture" style="display:none;">' + loadingSpinner() + '</div>' +
            '</div>';
    }

    async function loadDeclarationsData(tab) {
        tab = tab || STATE.declarationsTab;
        var year = STATE.declarationsYear;
        var panel = document.querySelector('[data-decl-panel="' + tab + '"]');
        if (!panel) return;

        if (tab === 'TVA') {
            if (CACHE.tva && CACHE.tva.year === year) { renderTVATable(CACHE.tva); return; }
            panel.innerHTML = loadingSpinner();
            try {
                var res = await fetch('/api/cabinet/declarations-overview?year=' + year);
                var data = await res.json();
                CACHE.tva = Object.assign({ year: year }, data);
                renderTVATable(CACHE.tva);
            } catch (e) { panel.innerHTML = '<div class="entv-placeholder"><p>Erreur de chargement.</p></div>'; }
        } else if (tab === 'Acomptes IS') {
            if (CACHE.is && CACHE.is.year === year) { renderISTable(CACHE.is); return; }
            panel.innerHTML = loadingSpinner();
            try {
                var res2 = await fetch('/api/cabinet/is-acomptes-overview?year=' + year);
                var data2 = await res2.json();
                CACHE.is = Object.assign({ year: year }, data2);
                renderISTable(CACHE.is);
            } catch (e) { panel.innerHTML = '<div class="entv-placeholder"><p>Erreur de chargement.</p></div>'; }
        } else if (tab === 'Suivi clôture') {
            if (CACHE.cloture) { renderClotureTable(CACHE.cloture); return; }
            panel.innerHTML = loadingSpinner();
            try {
                var res3 = await fetch('/api/cabinet/cloture-overview');
                var data3 = await res3.json();
                CACHE.cloture = data3;
                renderClotureTable(CACHE.cloture);
            } catch (e) { panel.innerHTML = '<div class="entv-placeholder"><p>Erreur de chargement.</p></div>'; }
        }
    }

    function renderTVATable(data) {
        var panel = document.querySelector('[data-decl-panel="TVA"]');
        if (!panel) return;

        var companies = data.companies || [];
        if (companies.length === 0) {
            panel.innerHTML = '<div class="entv-placeholder"><p>Aucun dossier client. Créez un dossier pour voir les déclarations TVA.</p></div>';
            return;
        }

        var now = new Date();
        var currentMonth = now.getMonth() + 1;
        var currentYear = now.getFullYear();
        var year = data.year || currentYear;

        var headers = ['Raison sociale', 'Forme', 'Équipe', 'Fréq TVA', 'Date limite'].concat(MONTHS_FR);

        var rows = companies.map(function (c) {
            var monthCells = MONTHS_FR.map(function (mLabel, idx) {
                var month = idx + 1;
                var isQuarterly = c.frequence_tva === 'Trimestrielle';
                var quarterEndMonths = [3, 6, 9, 12];
                var monthToQuarter = { 3: 1, 6: 2, 9: 3, 12: 4 };

                if (isQuarterly && quarterEndMonths.indexOf(month) === -1) {
                    return td('<span style="color:#cbd5e1;">—</span>');
                }

                var declKey, decl;
                if (!isQuarterly) {
                    declKey = 'm' + month;
                    decl = c.declarations[declKey];
                } else {
                    var q = monthToQuarter[month];
                    declKey = 'q' + q;
                    decl = c.declarations[declKey];
                }

                if (decl) {
                    var amtTxt = fmtAmount(Math.abs(decl.tva_due));
                    if (decl.is_credit) return td(badge('Crédit · ' + amtTxt, 'blue'));
                    return td(badge((decl.tva_due > 0 ? 'Déclarée · ' + amtTxt : 'Déclarée'), 'green'));
                }

                var isPast = (year < currentYear) || (year === currentYear && month < currentMonth);
                var isCurrent = (year === currentYear && month === currentMonth);

                if (isPast) {
                    if (!isQuarterly || quarterEndMonths.indexOf(month) !== -1) return td(badge('En retard', 'red'));
                    return td('<span style="color:#cbd5e1;">—</span>');
                } else if (isCurrent) {
                    return td(badge('À déclarer', 'orange'));
                }
                return td('<span style="color:#cbd5e1;">—</span>');
            });

            var dateLimite = '20/' + String(currentMonth < 12 ? currentMonth + 1 : 1).padStart(2, '0') + '/' + (currentMonth < 12 ? year : year + 1);

            var cells = [
                td('<span class="entv-company-name">' + esc(c.name) + '</span>'),
                td(c.forme_juridique || '—'),
                td(teamAvatars(c.team)),
                td(c.frequence_tva || 'Mensuelle'),
                td(dateLimite),
            ].concat(monthCells);

            var sn = esc(c.name).replace(/'/g, '&#39;');
            return '<tr class="entv-row" style="cursor:pointer;" onclick="window._entvOpenDossierToView(' + (c.id || c.company_id || 0) + ',&quot;' + sn + '&quot;,&quot;declarations-tva&quot;)">' + cells.join('') + '</tr>';
        }).join('');

        panel.innerHTML = '<div class="entv-table-wrap"><table class="entv-table"><thead><tr>' +
            headers.map(function(h) { return th(h); }).join('') +
            '</tr></thead><tbody>' + rows + '</tbody></table></div>';
    }

    function renderISTable(data) {
        var panel = document.querySelector('[data-decl-panel="Acomptes IS"]');
        if (!panel) return;

        var companies = data.companies || [];
        if (companies.length === 0) {
            panel.innerHTML = '<div class="entv-placeholder"><p>Aucun dossier client disponible.</p></div>';
            return;
        }

        var year = data.year || new Date().getFullYear();

        var acompteLabels = [
            'Ac. 1 (31/03/' + year + ')',
            'Ac. 2 (30/06/' + year + ')',
            'Ac. 3 (30/09/' + year + ')',
            'Ac. 4 (31/12/' + year + ')',
        ];

        var headers = ['Raison sociale', 'Forme', 'Équipe', 'IS N-1', 'Base N-1'].concat(acompteLabels);

        var rows = companies.map(function (c) {
            var acCells = (c.acomptes || []).map(function (a) {
                if (a.statut === 'non_calcule') return td(badge('À calculer', 'gray'));
                var montantStr = a.montant ? fmtAmount(a.montant) : '—';
                if (a.statut === 'a_payer') return td(badge(montantStr, 'orange'));
                return td(badge(montantStr + ' · À vérifier', 'red'));
            });

            var cells = [
                td('<span class="entv-company-name">' + esc(c.name) + '</span>'),
                td(c.forme_juridique || 'SARL'),
                td(teamAvatars(c.team)),
                td(c.is_annuel_n1 != null ? fmtAmount(c.is_annuel_n1) : '—'),
                td(c.fiscal_year_label || '—'),
            ].concat(acCells);

            var sn = esc(c.name).replace(/'/g, '&#39;');
            return '<tr class="entv-row" style="cursor:pointer;" onclick="window._entvOpenDossierToView(' + (c.id || c.company_id || 0) + ',&quot;' + sn + '&quot;,&quot;declarations-is&quot;)">' + cells.join('') + '</tr>';
        }).join('');

        panel.innerHTML = '<div class="entv-table-wrap"><table class="entv-table"><thead><tr>' +
            headers.map(function(h) { return th(h); }).join('') +
            '</tr></thead><tbody>' + rows + '</tbody></table></div>';
    }

    function renderClotureTable(data) {
        var panel = document.querySelector('[data-decl-panel="Suivi clôture"]');
        if (!panel) return;

        var companies = data.companies || [];
        if (companies.length === 0) {
            panel.innerHTML = '<div class="entv-placeholder"><p>Aucun dossier client disponible.</p></div>';
            return;
        }

        var FY_STATUTS = {
            'ouvert':     { label: 'Ouvert',      color: 'blue'   },
            'en_cloture': { label: 'En clôture',  color: 'orange' },
            'cloture':    { label: 'Clôturé',     color: 'green'  },
        };

        var headers = ['Raison sociale', 'Forme', 'Équipe', 'Exercice', 'Début', 'Fin', 'Statut', 'Date clôture', 'Clôturé par'];

        var rows = companies.map(function (c) {
            var fy = c.fiscal_year;
            var fyStatusInfo = fy ? (FY_STATUTS[fy.status] || { label: fy.status, color: 'gray' }) : null;

            var cells = [
                td('<span class="entv-company-name">' + esc(c.name) + '</span>'),
                td(c.forme_juridique || 'SARL'),
                td(teamAvatars(c.team)),
                td(fy ? esc(fy.label) : '—'),
                td(fy ? fmtDate(fy.start_date) : '—'),
                td(fy ? fmtDate(fy.end_date) : '—'),
                td(fy ? badge(fyStatusInfo.label, fyStatusInfo.color) : '—'),
                td(fy && fy.closed_at ? fmtDate(fy.closed_at) : '—'),
                td(fy && fy.closed_by ? esc(fy.closed_by) : '—'),
            ];

            var sn = esc(c.name).replace(/'/g, '&#39;');
            return '<tr class="entv-row" style="cursor:pointer;" onclick="window._entvOpenDossierToView(' + (c.id || c.company_id || 0) + ',&quot;' + sn + '&quot;,&quot;balance-generale&quot;)">' + cells.join('') + '</tr>';
        }).join('');

        panel.innerHTML = '<div class="entv-table-wrap"><table class="entv-table"><thead><tr>' +
            headers.map(function(h) { return th(h); }).join('') +
            '</tr></thead><tbody>' + rows + '</tbody></table></div>';
    }


    // ═══════════════════════════════════════════════════════════════════════════
    // VUE 5 — PROSPECTS
    // ═══════════════════════════════════════════════════════════════════════════

    function buildProspectsHTML() {
        var tabBtns =
            '<button id="entv-prospect-tab-signature" class="entv-btn-primary" onclick="window._entvProspectSwitchTab(\'signature\')">Signature lettre de mission</button>' +
            '<button id="entv-prospect-tab-perdus" class="entv-btn" onclick="window._entvProspectSwitchTab(\'perdus\')">Prospects perdus</button>';

        return '<div class="entv-view">' +
            headerBar('Prospects', '<button class="entv-btn-primary" onclick="window._entvProspectOpenModal()">+ Créer un prospect</button>') +
            '<div class="entv-tab-bar">' +
            '<div class="entv-tab-wrap">' + tabBtns + '</div>' +
            '</div>' +
            '<div class="entv-prospect-controls">' +
            '<input class="entv-search" id="entv-prospect-search" placeholder="Rechercher un prospect" oninput="window._entvProspectSearch()" />' +
            '</div>' +
            '<div id="entv-prospects-panel">' + loadingSpinner() + '</div>' +
            '</div>';
    }

    async function loadProspectsData(tab) {
        tab = tab || STATE.prospectsTab;
        var panel = document.getElementById('entv-prospects-panel');
        if (!panel) return;

        var cacheKey = tab === 'perdus' ? 'prospects_perdus' : 'prospects_signature';
        if (CACHE[cacheKey]) { renderProspectsTable(CACHE[cacheKey], tab); return; }

        panel.innerHTML = loadingSpinner();

        try {
            var statuts = tab === 'perdus' ? 'perdu' : '';
            var url = '/api/cabinet/prospects' + (statuts ? '?statut=' + statuts : '');
            var res = await fetch(url);
            var data = await res.json();
            var prospects = data.prospects || [];

            if (tab !== 'perdus') {
                prospects = prospects.filter(function (p) { return p.statut_ldm !== 'perdu'; });
            }

            CACHE[cacheKey] = prospects;
            renderProspectsTable(prospects, tab);
        } catch (e) {
            panel.innerHTML = '<div class="entv-placeholder"><p>Erreur de chargement.</p></div>';
        }
    }

    function renderProspectsTable(prospects, tab) {
        var panel = document.getElementById('entv-prospects-panel');
        if (!panel) return;

        if (!prospects || prospects.length === 0) {
            var emptyMsg = tab === 'perdus' ? 'Aucun prospect perdu enregistré.' : 'Vous n\'avez pas encore de prospect.';
            var emptyBtn = tab !== 'perdus' ? '<button class="entv-btn-primary" onclick="window._entvProspectOpenModal()">+ Créer un prospect</button>' : '';
            panel.innerHTML = '<div class="entv-empty"><h3 class="entv-empty-title">' + emptyMsg + '</h3><p class="entv-empty-desc">Créez votre premier prospect pour suivre vos lettres de mission.</p>' + emptyBtn + '</div>';
            return;
        }

        var headers = ['Raison sociale', 'Interlocuteur', 'Email', 'Téléphone', 'Responsable', 'Statut LDM', 'À faire', 'Actions'];

        var rows = prospects.map(function (p) {
            var statutInfo = STATUT_LDM_LABELS[p.statut_ldm] || { label: p.statut_ldm, color: 'gray' };

            var actions = '<div style="display:flex;gap:4px;">' +
                '<button class="entv-btn" style="height:26px;padding:0 8px;font-size:11px;" onclick="window._entvProspectEdit(' + p.id + ')">Éditer</button>';
            if (p.statut_ldm !== 'perdu') {
                actions += '<button class="entv-btn" style="height:26px;padding:0 8px;font-size:11px;color:#ef4444;border-color:#fca5a5;" onclick="window._entvProspectMarkPerdu(' + p.id + ')">Perdu</button>';
            }
            actions += '<button class="entv-btn" style="height:26px;padding:0 8px;font-size:11px;color:#ef4444;border-color:#fca5a5;" onclick="window._entvProspectDelete(' + p.id + ')">✕</button></div>';

            return '<tr class="entv-row" style="cursor:pointer;" onclick="if(!event.target.closest(&quot;button&quot;))window._entvProspectEdit(' + p.id + ')">' + [
                td('<strong>' + esc(p.raison_sociale) + '</strong>'),
                td(p.interlocuteur ? esc(p.interlocuteur) : '—'),
                td(p.email ? '<a href="mailto:' + esc(p.email) + '" style="color:#0d9488;">' + esc(p.email) + '</a>' : '—'),
                td(p.telephone ? esc(p.telephone) : '—'),
                td(p.responsable ? esc(p.responsable) : '—'),
                td(badge(statutInfo.label, statutInfo.color)),
                td(p.a_faire || '—'),
                td(actions),
            ].join('') + '</tr>';
        }).join('');

        panel.innerHTML = '<div class="entv-table-wrap"><table class="entv-table"><thead><tr>' +
            headers.map(function(h) { return th(h); }).join('') +
            '</tr></thead><tbody>' + rows + '</tbody></table></div>';
    }


    // ── Prospects Modal ─────────────────────────────────────────────────────────

    function injectProspectsModal() {
        if (document.getElementById('entv-prospect-modal')) return;
        var modal = document.createElement('div');
        modal.id = 'entv-prospect-modal';
        modal.style.cssText = 'display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.4);align-items:center;justify-content:center;';
        modal.innerHTML =
            '<div style="background:#fff;border-radius:12px;padding:1.75rem;width:480px;max-width:95vw;max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.25);">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem;">' +
            '<h2 style="font-size:16px;font-weight:600;color:#1f2937;margin:0;" id="entv-modal-title">Nouveau prospect</h2>' +
            '<button onclick="window._entvProspectCloseModal()" style="background:none;border:none;font-size:18px;cursor:pointer;color:#64748b;">✕</button>' +
            '</div>' +
            '<form id="entv-prospect-form" onsubmit="return false;">' +
            '<input type="hidden" id="entv-modal-prospect-id" value="" />' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">' +
            modalField('Raison sociale *', 'entv-modal-raison-sociale', 'text', 'SARL Atlas Trading...') +
            modalField('Interlocuteur', 'entv-modal-interlocuteur', 'text', 'Mohamed Alami') +
            modalField('Email', 'entv-modal-email', 'email', 'contact@entreprise.ma') +
            modalField('Téléphone', 'entv-modal-telephone', 'tel', '+212 6XX XXX XXX') +
            modalField('Responsable', 'entv-modal-responsable', 'text', 'Nom du responsable cabinet') +
            '</div>' +
            '<div style="margin-bottom:12px;">' +
            '<label style="display:block;font-size:12px;font-weight:500;color:#334155;margin-bottom:4px;">Statut LDM</label>' +
            '<select id="entv-modal-statut" style="width:100%;height:32px;padding:0 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;font-family:Inter,sans-serif;">' +
            '<option value="en_discussion">En discussion</option>' +
            '<option value="ldm_envoyee">LDM envoyée</option>' +
            '<option value="en_attente_signature">En attente de signature</option>' +
            '</select></div>' +
            '<div style="margin-bottom:12px;">' +
            '<label style="display:block;font-size:12px;font-weight:500;color:#334155;margin-bottom:4px;">À faire</label>' +
            '<input type="text" id="entv-modal-a-faire" placeholder="Relancer pour signature, envoyer devis..." style="width:100%;height:32px;padding:0 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;font-family:Inter,sans-serif;" /></div>' +
            '<div style="margin-bottom:16px;">' +
            '<label style="display:block;font-size:12px;font-weight:500;color:#334155;margin-bottom:4px;">Notes</label>' +
            '<textarea id="entv-modal-notes" rows="3" placeholder="Notes sur le prospect..." style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;font-family:Inter,sans-serif;resize:vertical;"></textarea></div>' +
            '<div id="entv-modal-error" style="color:#ef4444;font-size:12px;margin-bottom:8px;display:none;"></div>' +
            '<div style="display:flex;justify-content:flex-end;gap:8px;">' +
            '<button type="button" onclick="window._entvProspectCloseModal()" class="entv-btn">Annuler</button>' +
            '<button type="submit" id="entv-modal-submit" onclick="window._entvProspectSave()" class="entv-btn-primary">Enregistrer</button>' +
            '</div></form></div>';
        document.body.appendChild(modal);
    }

    function modalField(label, id, type, placeholder) {
        return '<div>' +
            '<label style="display:block;font-size:12px;font-weight:500;color:#334155;margin-bottom:4px;">' + label + '</label>' +
            '<input type="' + type + '" id="' + id + '" placeholder="' + placeholder + '" style="width:100%;height:32px;padding:0 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;font-family:Inter,sans-serif;" /></div>';
    }


    // ═══════════════════════════════════════════════════════════════════════════
    // TAB SWITCH HANDLERS
    // ═══════════════════════════════════════════════════════════════════════════

    window._entvDeclSwitchTab = async function (tab) {
        STATE.declarationsTab = tab;
        document.querySelectorAll('[data-decl-panel]').forEach(function (p) {
            p.style.display = (p.dataset.declPanel === tab) ? 'block' : 'none';
        });
        document.querySelectorAll('[data-decl-tab]').forEach(function (b) {
            b.className = (b.dataset.declTab === tab) ? 'entv-btn-primary' : 'entv-btn';
        });
        await loadDeclarationsData(tab);
    };

    window._entvDeclPrevYear = function () {
        STATE.declarationsYear--;
        CACHE.tva = null; CACHE.is = null;
        var el = document.getElementById('entv-decl-year');
        if (el) el.textContent = STATE.declarationsYear;
        loadDeclarationsData(STATE.declarationsTab);
    };

    window._entvDeclNextYear = function () {
        STATE.declarationsYear++;
        CACHE.tva = null; CACHE.is = null;
        var el = document.getElementById('entv-decl-year');
        if (el) el.textContent = STATE.declarationsYear;
        loadDeclarationsData(STATE.declarationsTab);
    };

    window._entvProspectSwitchTab = async function (tab) {
        STATE.prospectsTab = tab;
        var sigBtn = document.getElementById('entv-prospect-tab-signature');
        var perBtn = document.getElementById('entv-prospect-tab-perdus');
        if (sigBtn) sigBtn.className = (tab === 'signature') ? 'entv-btn-primary' : 'entv-btn';
        if (perBtn) perBtn.className = (tab === 'perdus')    ? 'entv-btn-primary' : 'entv-btn';
        await loadProspectsData(tab);
    };

    window._entvProspectSearch = function () {
        var q = ((document.getElementById('entv-prospect-search') || {}).value || '').toLowerCase().trim();
        var tab = STATE.prospectsTab;
        var cacheKey = tab === 'perdus' ? 'prospects_perdus' : 'prospects_signature';
        var all = CACHE[cacheKey];
        if (!all) return;
        var filtered = q ? all.filter(function (p) {
            return (p.raison_sociale || '').toLowerCase().indexOf(q) !== -1 ||
                   (p.interlocuteur || '').toLowerCase().indexOf(q) !== -1 ||
                   (p.email || '').toLowerCase().indexOf(q) !== -1;
        }) : all;
        renderProspectsTable(filtered, tab);
    };

    window._entvProspectOpenModal = function (prospect) {
        var modal = document.getElementById('entv-prospect-modal');
        if (!modal) { injectProspectsModal(); modal = document.getElementById('entv-prospect-modal'); }

        document.getElementById('entv-modal-prospect-id').value = '';
        document.getElementById('entv-modal-raison-sociale').value = '';
        document.getElementById('entv-modal-interlocuteur').value = '';
        document.getElementById('entv-modal-email').value = '';
        document.getElementById('entv-modal-telephone').value = '';
        document.getElementById('entv-modal-responsable').value = '';
        document.getElementById('entv-modal-statut').value = 'en_discussion';
        document.getElementById('entv-modal-a-faire').value = '';
        document.getElementById('entv-modal-notes').value = '';
        document.getElementById('entv-modal-error').style.display = 'none';
        document.getElementById('entv-modal-title').textContent = 'Nouveau prospect';

        if (prospect) {
            document.getElementById('entv-modal-title').textContent = 'Modifier le prospect';
            document.getElementById('entv-modal-prospect-id').value = prospect.id;
            document.getElementById('entv-modal-raison-sociale').value = prospect.raison_sociale || '';
            document.getElementById('entv-modal-interlocuteur').value = prospect.interlocuteur || '';
            document.getElementById('entv-modal-email').value = prospect.email || '';
            document.getElementById('entv-modal-telephone').value = prospect.telephone || '';
            document.getElementById('entv-modal-responsable').value = prospect.responsable || '';
            document.getElementById('entv-modal-statut').value = prospect.statut_ldm || 'en_discussion';
            document.getElementById('entv-modal-a-faire').value = prospect.a_faire || '';
            document.getElementById('entv-modal-notes').value = prospect.notes || '';
        }

        modal.style.display = 'flex';
    };

    window._entvProspectCloseModal = function () {
        var modal = document.getElementById('entv-prospect-modal');
        if (modal) modal.style.display = 'none';
    };

    window._entvProspectSave = async function () {
        var pid = document.getElementById('entv-modal-prospect-id').value;
        var raisonSociale = (document.getElementById('entv-modal-raison-sociale').value || '').trim();
        var errorEl = document.getElementById('entv-modal-error');
        var submitBtn = document.getElementById('entv-modal-submit');

        if (!raisonSociale) {
            errorEl.textContent = 'La raison sociale est requise.';
            errorEl.style.display = 'block';
            return;
        }
        errorEl.style.display = 'none';
        submitBtn.textContent = 'Enregistrement...';
        submitBtn.disabled = true;

        var body = {
            raison_sociale: raisonSociale,
            interlocuteur: document.getElementById('entv-modal-interlocuteur').value || null,
            email: document.getElementById('entv-modal-email').value || null,
            telephone: document.getElementById('entv-modal-telephone').value || null,
            responsable: document.getElementById('entv-modal-responsable').value || null,
            statut_ldm: document.getElementById('entv-modal-statut').value,
            a_faire: document.getElementById('entv-modal-a-faire').value || null,
            notes: document.getElementById('entv-modal-notes').value || null,
        };

        try {
            var url = pid ? '/api/cabinet/prospects/' + pid : '/api/cabinet/prospects';
            var method = pid ? 'PUT' : 'POST';
            var res = await fetch(url, {
                method: method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            var data = await res.json();
            if (!res.ok) {
                errorEl.textContent = data.error || 'Erreur lors de l\'enregistrement.';
                errorEl.style.display = 'block';
                return;
            }
            CACHE.prospects_signature = null;
            CACHE.prospects_perdus = null;
            window._entvProspectCloseModal();
            await loadProspectsData(STATE.prospectsTab);
        } catch (e) {
            errorEl.textContent = 'Erreur réseau. Veuillez réessayer.';
            errorEl.style.display = 'block';
        } finally {
            submitBtn.textContent = 'Enregistrer';
            submitBtn.disabled = false;
        }
    };

    window._entvProspectEdit = async function (id) {
        var allCache = (CACHE.prospects_signature || []).concat(CACHE.prospects_perdus || []);
        var p = allCache.find(function (x) { return x.id === id; });
        if (p) { window._entvProspectOpenModal(p); return; }
        try {
            var res = await fetch('/api/cabinet/prospects');
            var data = await res.json();
            var found = (data.prospects || []).find(function (x) { return x.id === id; });
            if (found) window._entvProspectOpenModal(found);
        } catch (e) { /* silent */ }
    };

    window._entvProspectMarkPerdu = async function (id) {
        if (!confirm('Marquer ce prospect comme perdu ?')) return;
        try {
            var res = await fetch('/api/cabinet/prospects/' + id, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ statut_ldm: 'perdu' }),
            });
            if (res.ok) {
                CACHE.prospects_signature = null;
                CACHE.prospects_perdus = null;
                await loadProspectsData(STATE.prospectsTab);
            }
        } catch (e) { /* silent */ }
    };

    window._entvProspectDelete = async function (id) {
        if (!confirm('Supprimer ce prospect définitivement ?')) return;
        try {
            var res = await fetch('/api/cabinet/prospects/' + id, { method: 'DELETE' });
            if (res.ok) {
                CACHE.prospects_signature = null;
                CACHE.prospects_perdus = null;
                await loadProspectsData(STATE.prospectsTab);
            }
        } catch (e) { /* silent */ }
    };

    window.switchDeclarationsTab = window._entvDeclSwitchTab;
    window.switchProspectsTab    = window._entvProspectSwitchTab;

    // ═══════════════════════════════════════════════════════════════════════════
    // PARAMÉTRAGE DRAWER
    // ═══════════════════════════════════════════════════════════════════════════

    var DRAWER_STATE = {
        companyId: null,
        members: [],     // cabinet members cache [{id, name, role}]
        loading: false,
    };

    // ── Bind click handlers on parametrage rows ────────────────────────────────
    function bindParametrageRows() {
        var container = document.getElementById('view-entreprises-parametrage');
        if (!container) return;
        container.addEventListener('click', function (e) {
            var row = e.target.closest('.entv-row-parametrage');
            if (!row) return;
            var id   = parseInt(row.dataset.companyId);
            var name = row.dataset.companyName || '';
            openParametrageDrawer(id, name);
        });
    }

    // ── Inject drawer + backdrop into DOM (once) ───────────────────────────────
    function injectParametrageDrawer() {
        if (document.getElementById('entv-param-drawer')) return;

        // Backdrop
        var backdrop = document.createElement('div');
        backdrop.id = 'entv-param-backdrop';
        backdrop.addEventListener('click', closeParametrageDrawer);
        document.body.appendChild(backdrop);

        // Drawer
        var drawer = document.createElement('div');
        drawer.id = 'entv-param-drawer';
        drawer.innerHTML = buildDrawerHTML();
        document.body.appendChild(drawer);

        // Escape key
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') closeParametrageDrawer();
        });
    }

    function buildDrawerHTML() {
        function field(label, id, inputHTML, fullWidth) {
            return '<div class="entv-drawer-field' + (fullWidth ? ' full-width' : '') + '">' +
                '<label class="entv-drawer-label" for="' + id + '">' + label + '</label>' +
                inputHTML +
                '</div>';
        }

        function textInput(id, placeholder) {
            return '<input type="text" class="entv-drawer-input" id="' + id + '" placeholder="' + (placeholder || '') + '" />';
        }

        function numInput(id, min, max) {
            return '<input type="number" class="entv-drawer-input" id="' + id + '" min="' + (min||1) + '" max="' + (max||31) + '" />';
        }

        function selectInput(id, options) {
            var opts = options.map(function(o) {
                return '<option value="' + escHtml(o.v) + '">' + escHtml(o.l || o.v) + '</option>';
            }).join('');
            return '<select class="entv-drawer-select" id="' + id + '">' + opts + '</select>';
        }

        var memberSelect = '<select class="entv-drawer-select" id="drawer-collaborateur-id"><option value="">—</option></select>';
        var chefSelect   = '<select class="entv-drawer-select" id="drawer-chef-mission-id"><option value="">—</option></select>';
        var expertSelect = '<select class="entv-drawer-select" id="drawer-expert-comptable-id"><option value="">—</option></select>';
        var piloteSelect = '<select class="entv-drawer-select" id="drawer-pilote-pa-id"><option value="">—</option></select>';

        return '' +
            // Header
            '<div class="entv-drawer-header">' +
            '<span class="entv-drawer-title" id="drawer-company-name">Paramétrage</span>' +
            '<button class="entv-drawer-close" id="drawer-close-btn" title="Fermer">✕</button>' +
            '</div>' +

            // Body
            '<div class="entv-drawer-body" id="drawer-body">' +

            // Section: Équipe
            '<div class="entv-drawer-section">' +
            '<div class="entv-drawer-section-title">Équipe</div>' +
            '<div class="entv-drawer-grid">' +
            field('Collaborateur', 'drawer-collaborateur-id', memberSelect) +
            field('Chef de mission', 'drawer-chef-mission-id', chefSelect) +
            field('Expert-comptable', 'drawer-expert-comptable-id', expertSelect) +
            field('Pilote PA', 'drawer-pilote-pa-id', piloteSelect) +
            '</div>' +
            '</div>' +

            // Section: Fiscal
            '<div class="entv-drawer-section">' +
            '<div class="entv-drawer-section-title">Fiscal</div>' +
            '<div class="entv-drawer-grid">' +
            field('Catégorie fiscale', 'drawer-categorie-fiscale', selectInput('drawer-categorie-fiscale', [
                {v:'IS', l:'IS — Impôt sur les Sociétés'},
                {v:'IR', l:'IR — Impôt sur le Revenu'},
            ])) +
            field('Régime fiscal', 'drawer-regime-fiscal', selectInput('drawer-regime-fiscal', [
                {v:'Normal', l:'Normal'},
                {v:'Simplifié', l:'Simplifié'},
            ])) +
            field('Fréquence TVA', 'drawer-frequence-tva', selectInput('drawer-frequence-tva', [
                {v:'Mensuelle'},
                {v:'Trimestrielle'},
                {v:'Non soumis'},
            ])) +
            field('Jour décl. TVA', 'drawer-jour-tva', numInput('drawer-jour-tva', 1, 31)) +
            field('Date de clôture (JJ/MM)', 'drawer-date-cloture', textInput('drawer-date-cloture', '31/12'), true) +
            '</div>' +
            '</div>' +

            // Section: Mission
            '<div class="entv-drawer-section">' +
            '<div class="entv-drawer-section-title">Mission</div>' +
            '<div class="entv-drawer-grid">' +
            field('Périmètre de mission', 'drawer-perimetre-mission', selectInput('drawer-perimetre-mission', [
                {v:'Tenue complète'},
                {v:'Révision'},
                {v:'Supervision'},
                {v:'Paie'},
                {v:'Fiscalité'},
                {v:'Tenue + Paie'},
                {v:'Tenue + Fiscalité'},
            ]), true) +
            '</div>' +
            '</div>' +

            // Section: Juridique
            '<div class="entv-drawer-section">' +
            '<div class="entv-drawer-section-title">Juridique</div>' +
            '<div class="entv-drawer-grid">' +
            field('Forme juridique', 'drawer-forme-juridique', selectInput('drawer-forme-juridique', [
                {v:'', l:'— Choisir —'},
                {v:'SARL'},{v:'SA'},{v:'SAS'},{v:'SNC'},{v:'SCI'},
                {v:'EI', l:'EI — Entreprise individuelle'},
                {v:'Auto-entrepreneur'},{v:'Autre'},
            ])) +
            field('Ville', 'drawer-city', textInput('drawer-city', 'Casablanca')) +
            field('ICE', 'drawer-ice', textInput('drawer-ice', '001234567000000')) +
            field('IF', 'drawer-idf', textInput('drawer-idf', '12345678')) +
            field('RC', 'drawer-rc', textInput('drawer-rc', 'RC 12345')) +
            '</div>' +
            '</div>' +

            // Section: Statut
            '<div class="entv-drawer-section">' +
            '<div class="entv-drawer-section-title">Statut du dossier</div>' +
            '<div class="entv-drawer-grid">' +
            field('Statut', 'drawer-statut', selectInput('drawer-statut', [
                {v:'actif', l:'Actif'},
                {v:'archive', l:'Archivé'},
            ])) +
            '</div>' +
            '</div>' +

            '</div>' + // end drawer-body

            // Footer
            '<div class="entv-drawer-footer">' +
            '<span class="entv-drawer-error" id="drawer-error"></span>' +
            '<button class="entv-drawer-save" id="drawer-save-btn">Enregistrer</button>' +
            '</div>';
    }

    // ── Open drawer: load company data + members ───────────────────────────────
    async function openParametrageDrawer(companyId, companyName) {
        DRAWER_STATE.companyId = companyId;

        var drawer   = document.getElementById('entv-param-drawer');
        var backdrop = document.getElementById('entv-param-backdrop');
        var titleEl  = document.getElementById('drawer-company-name');
        var errorEl  = document.getElementById('drawer-error');
        var saveBtn  = document.getElementById('drawer-save-btn');

        if (!drawer) return;

        // Show with company name
        if (titleEl) titleEl.textContent = companyName || 'Paramétrage';
        if (errorEl) errorEl.textContent = '';
        backdrop.classList.add('visible');
        drawer.classList.add('open');

        // Wire close button
        var closeBtn = document.getElementById('drawer-close-btn');
        if (closeBtn) closeBtn.onclick = closeParametrageDrawer;

        // Wire save button
        if (saveBtn) saveBtn.onclick = saveParametrageDrawer;

        // Show loading
        var body = document.getElementById('drawer-body');
        if (body) body.style.opacity = '0.5';
        if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Chargement…'; }

        try {
            // Load members + company data in parallel
            var results = await Promise.all([
                loadDrawerMembers(),
                fetch('/api/cabinet/dossiers/' + companyId, { credentials: 'include' }).then(function(r){ return r.json(); })
            ]);

            var company = results[1].dossier;
            if (company) populateDrawerForm(company);
        } catch (e) {
            if (errorEl) errorEl.textContent = 'Erreur de chargement.';
        } finally {
            if (body) body.style.opacity = '1';
            if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Enregistrer'; }
        }
    }

    // ── Load and cache cabinet members, populate member selects ───────────────
    async function loadDrawerMembers() {
        if (DRAWER_STATE.members.length > 0) {
            populateMemberSelects(DRAWER_STATE.members);
            return;
        }
        try {
            var res = await fetch('/api/cabinet/collaborateurs', { credentials: 'include' });
            var data = await res.json();
            DRAWER_STATE.members = data.members || [];
            populateMemberSelects(DRAWER_STATE.members);
        } catch (e) { /* silent — dropdowns will be empty */ }
    }

    function populateMemberSelects(members) {
        var selectIds = [
            'drawer-collaborateur-id',
            'drawer-chef-mission-id',
            'drawer-expert-comptable-id',
            'drawer-pilote-pa-id',
        ];
        selectIds.forEach(function(sid) {
            var sel = document.getElementById(sid);
            if (!sel) return;
            // Keep first empty option, replace the rest
            var emptyOpt = '<option value="">—</option>';
            var memberOpts = members.map(function(m) {
                return '<option value="' + m.id + '">' + escHtml(m.name) + (m.role ? ' (' + escHtml(m.role) + ')' : '') + '</option>';
            }).join('');
            sel.innerHTML = emptyOpt + memberOpts;
        });
    }

    // ── Populate form fields from company data ─────────────────────────────────
    function populateDrawerForm(c) {
        function setVal(id, val) {
            var el = document.getElementById(id);
            if (el) el.value = val || '';
        }

        // Équipe
        setVal('drawer-collaborateur-id',    c.collaborateur_id    || '');
        setVal('drawer-chef-mission-id',     c.chef_de_mission_id  || '');
        setVal('drawer-expert-comptable-id', c.expert_comptable_id || '');
        setVal('drawer-pilote-pa-id',        c.pilote_pa_id        || '');

        // Fiscal
        setVal('drawer-categorie-fiscale', c.categorie_fiscale || 'IS');
        setVal('drawer-regime-fiscal',     c.regime_fiscal     || 'Normal');
        setVal('drawer-frequence-tva',     c.frequence_tva     || 'Mensuelle');
        setVal('drawer-jour-tva',          c.jour_tva          || 20);
        setVal('drawer-date-cloture',      c.date_cloture      || '31/12');

        // Mission
        setVal('drawer-perimetre-mission', c.perimetre_mission || 'Tenue complète');

        // Juridique
        setVal('drawer-forme-juridique', c.forme_juridique || '');
        setVal('drawer-city',            c.city            || '');
        setVal('drawer-ice',             c.ice             || '');
        setVal('drawer-idf',             c.idf             || '');
        setVal('drawer-rc',              c.rc              || '');

        // Statut
        setVal('drawer-statut', c.statut || 'actif');
    }

    // ── Save drawer ────────────────────────────────────────────────────────────
    async function saveParametrageDrawer() {
        var companyId = DRAWER_STATE.companyId;
        if (!companyId) return;

        var errorEl = document.getElementById('drawer-error');
        var saveBtn = document.getElementById('drawer-save-btn');

        if (errorEl) errorEl.textContent = '';
        if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Enregistrement…'; }

        function getVal(id) {
            var el = document.getElementById(id);
            return el ? el.value.trim() : '';
        }
        function getInt(id) {
            var v = parseInt(getVal(id));
            return isNaN(v) ? null : v;
        }

        // Look up names for backward-compat text fields
        var collaborateurId     = getInt('drawer-collaborateur-id');
        var chefId              = getInt('drawer-chef-mission-id');
        var expertId            = getInt('drawer-expert-comptable-id');
        var piloteId            = getInt('drawer-pilote-pa-id');

        function memberName(id) {
            if (!id) return null;
            var m = DRAWER_STATE.members.find(function(x){ return x.id === id; });
            return m ? m.name : null;
        }

        // We need the existing company name (required by PUT)
        var stateEntry = STATE.dossiers.find(function(d){ return d.id === companyId; });
        var companyName = stateEntry ? stateEntry.name : (document.getElementById('drawer-company-name') || {}).textContent || '';

        var payload = {
            // Required
            name: companyName,

            // Équipe
            collaborateur_id:     collaborateurId   || null,
            chef_de_mission_id:   chefId            || null,
            expert_comptable_id:  expertId          || null,
            pilote_pa_id:         piloteId          || null,
            // Also update text fallback fields
            collaborateur:        memberName(collaborateurId),
            chef_de_mission:      memberName(chefId),
            expert_comptable:     memberName(expertId),
            pilote_pa:            memberName(piloteId),

            // Fiscal
            categorie_fiscale: getVal('drawer-categorie-fiscale'),
            regime_fiscal:     getVal('drawer-regime-fiscal'),
            frequence_tva:     getVal('drawer-frequence-tva'),
            jour_tva:          getInt('drawer-jour-tva'),
            date_cloture:      getVal('drawer-date-cloture'),

            // Mission
            perimetre_mission: getVal('drawer-perimetre-mission'),

            // Juridique
            forme_juridique: getVal('drawer-forme-juridique') || null,
            city:            getVal('drawer-city')            || null,
            ice:             getVal('drawer-ice')             || null,
            idf:             getVal('drawer-idf')             || null,
            rc:              getVal('drawer-rc')              || null,

            // Statut
            statut: getVal('drawer-statut') || 'actif',
        };

        try {
            var res = await fetch('/api/cabinet/dossiers/' + companyId, {
                method: 'PUT',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            var data = await res.json();
            if (!res.ok) {
                if (errorEl) errorEl.textContent = data.error || 'Erreur lors de l\'enregistrement.';
                return;
            }

            // Update STATE.dossiers with the returned data
            var idx = STATE.dossiers.findIndex(function(d){ return d.id === companyId; });
            if (idx !== -1 && data.dossier) {
                STATE.dossiers[idx] = Object.assign(STATE.dossiers[idx], data.dossier, {
                    // resolve display names
                    collaborateur:   memberName(data.dossier.collaborateur_id)   || STATE.dossiers[idx].collaborateur,
                    chef_de_mission: memberName(data.dossier.chef_de_mission_id) || STATE.dossiers[idx].chef_de_mission,
                });
            }

            // Refresh parametrage table view in-place
            var paramEl = document.getElementById('view-entreprises-parametrage');
            if (paramEl) {
                paramEl.innerHTML = buildParametrageHTML();
                bindParametrageRows();
            }

            closeParametrageDrawer();
        } catch (e) {
            if (errorEl) errorEl.textContent = 'Erreur réseau. Veuillez réessayer.';
        } finally {
            if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Enregistrer'; }
        }
    }

    // ── Close drawer ───────────────────────────────────────────────────────────
    function closeParametrageDrawer() {
        var drawer   = document.getElementById('entv-param-drawer');
        var backdrop = document.getElementById('entv-param-backdrop');
        if (drawer)   drawer.classList.remove('open');
        if (backdrop) backdrop.classList.remove('visible');
        DRAWER_STATE.companyId = null;
    }

    window.switchDeclarationsTab = window._entvDeclSwitchTab;
    window.switchProspectsTab    = window._entvProspectSwitchTab;

    // ── Public refresh hook (callable from outside if data changes) ─────────────
    window._entvRefresh = function () {
        fetchDossiers().then(injectViewContent);
    };

    // ── Context-aware dossier navigation from cabinet enterprise views ───────────────
    window._entvOpenDossierToView = function(id, name, targetView) {
        if (typeof window.switchDossierContext !== 'function') {
            console.warn('[entv] switchDossierContext not available');
            return;
        }
        window.switchDossierContext(id, name).then(function() {
            if (typeof window.navigate === 'function') {
                window.navigate(targetView || 'journal');
            }
        }).catch(function(e) {
            console.error('[entv] switch dossier failed', e);
        });
    };

    window._entvOpenParametrage = function(id, name) {
        // T2: will open paramétrage drawer — placeholder for now
        if (typeof window.showToast === 'function') {
            window.showToast('Paramétrage de ' + name + ' — bientôt disponible', 'info');
        } else {
            console.log('[entv] Paramétrage drawer (T2):', id, name);
        }
    };

})();

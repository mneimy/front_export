/**
 * HissabPro — Frontend Permissions Helper
 *
 * Provides:
 *   usePermissions()     — load permissions from API into window._hpPerms
 *   hasPermission(mod, action) — check if current user can do action on module
 *   canView(module)      — shorthand for hasPermission(module, 'view')
 *   canEdit(module)      — shorthand for hasPermission(module, 'edit')
 *   applyRbacMasking()   — apply CSS visibility to sidebar / UI elements
 *
 * Modules: dashboard_cabinet, entreprises, portefeuille, utilisateurs,
 *          parametres_cabinet, imports_exports, comptabilite_dossier, gestion_dossier
 *
 * Usage:
 *   await usePermissions();
 *   if (!canView('portefeuille')) navigate('entreprises');
 */

(function(window) {
  'use strict';

  // Internal state
  let _loaded = false;
  let _loading = null;
  let _permissions = {};
  let _role = null;
  let _roleName = null;

  /**
   * Load permissions from /api/cabinet/permissions.
   * Safe to call multiple times — subsequent calls are no-ops after first load.
   * Returns a promise that resolves when permissions are ready.
   */
  function usePermissions() {
    if (_loaded) return Promise.resolve(_permissions);
    if (_loading) return _loading;

    _loading = fetch('/api/cabinet/permissions', {
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    })
      .then(r => r.ok ? r.json() : { permissions: {}, role: null })
      .then(data => {
        _permissions = data.permissions || {};
        _role = data.role || null;
        _roleName = data.role_name || null;
        _loaded = true;
        _loading = null;
        return _permissions;
      })
      .catch(() => {
        _loaded = true;
        _loading = null;
        return {};
      });

    return _loading;
  }

  /**
   * Invalidate cached permissions (e.g. after role change).
   */
  function resetPermissions() {
    _loaded = false;
    _loading = null;
    _permissions = {};
    _role = null;
    _roleName = null;
  }

  /**
   * Check if current user has a specific permission.
   * @param {string} module  — e.g. 'portefeuille'
   * @param {string} action  — 'view' | 'edit'
   * @returns {boolean}
   */
  function hasPermission(module, action) {
    const mod = _permissions[module];
    if (!mod) return false;
    return mod[action] === true;
  }

  function canView(module) { return hasPermission(module, 'view'); }
  function canEdit(module) { return hasPermission(module, 'edit'); }

  /**
   * Return the current role string (e.g. 'admin', 'chef_mission', 'collaborateur')
   */
  function getCurrentRole() { return _role; }
  function getCurrentRoleName() { return _roleName; }
  function isAdmin() { return _role === 'admin'; }

  /**
   * Apply RBAC masking to sidebar navigation elements.
   * Called after usePermissions() resolves and after DOM is ready.
   *
   * Sidebar element IDs targeted (cabinet Level-1 nav):
   *   os-l1-accueil     → dashboard_cabinet (Accueil/Portefeuille grid)
   *   os-l1-entreprises → entreprises
   *   os-l1-portefeuille→ portefeuille
   *   os-l1-collab      → utilisateurs
   *   os-l1-imports     → imports_exports
   *   os-l1-exports     → imports_exports
   *   os-l1-parametres  → parametres_cabinet
   */
  function applyRbacMasking() {
    if (!_loaded) return;

    // Map of element-id → { module, action }
    const navRules = [
      { id: 'os-l1-accueil',      module: 'dashboard_cabinet',  action: 'view' },
      { id: 'os-l1-entreprises',  module: 'entreprises',         action: 'view' },
      { id: 'os-l1-portefeuille', module: 'portefeuille',        action: 'view' },
      { id: 'os-l1-collab',       module: 'utilisateurs',        action: 'view' },
      { id: 'os-l1-imports',      module: 'imports_exports',     action: 'view' },
      { id: 'os-l1-exports',      module: 'imports_exports',     action: 'view' },
      { id: 'os-l1-parametres',   module: 'parametres_cabinet',  action: 'view' },
      // Legacy nav IDs (kept for backward compat)
      { id: 'nav-parametres-cabinet', module: 'parametres_cabinet', action: 'view' },
      { id: 'nav-utilisateurs-cabinet', module: 'utilisateurs',     action: 'view' },
      { id: 'nav-collab-home',    module: 'utilisateurs',        action: 'view' },
    ];

    for (const rule of navRules) {
      const el = document.getElementById(rule.id);
      if (!el) continue;
      const allowed = hasPermission(rule.module, rule.action);
      // Use setProperty with 'important' to override pennylane-final.css !important display rules
      if (allowed) el.style.removeProperty('display'); else el.style.setProperty('display', 'none', 'important');
    }

    // Hide "Créer dossier" buttons for non-admin
    if (!isAdmin()) {
      document.querySelectorAll('.btn-create-dossier-admin').forEach(btn => {
        btn.style.display = 'none';
      });
    }

    // Invite button on Utilisateurs page: admin only
    const btnInvite = document.getElementById('btn-invite-member');
    if (btnInvite) {
      btnInvite.style.display = isAdmin() ? '' : 'none';
    }

    // Also hide/show section titles that become orphaned
    // If portefeuille and accueil are both hidden, hide the "Principal" section title
    const accueilHidden = !hasPermission('dashboard_cabinet', 'view');
    const portefHidden = !hasPermission('portefeuille', 'view');
    const entreprisesShown = hasPermission('entreprises', 'view');

    // Section "Principal" label — only shown when at least one item is visible
    const principalLabel = document.querySelector('#os-cabinet-level1-nav .os-nav-section-title');
    if (principalLabel && accueilHidden && portefHidden && !entreprisesShown) {
      principalLabel.style.display = 'none';
    }

    // Mark read-only mode for assistant role
    if (_role === 'assistant') {
      document.body.classList.add('hp-readonly-mode');
    } else {
      document.body.classList.remove('hp-readonly-mode');
    }

    // Client read-only (employe) mode
    if (window._hpClientRole === 'employe') {
      document.body.classList.add('hp-client-readonly');
    } else {
      document.body.classList.remove('hp-client-readonly');
    }
  }

  // Expose to global scope
  window.usePermissions = usePermissions;
  window.resetPermissions = resetPermissions;
  window.hasPermission = hasPermission;
  window.canView = canView;
  window.canEdit = canEdit;
  window.getCurrentRole = getCurrentRole;
  window.getCurrentRoleName = getCurrentRoleName;
  window.applyRbacMasking = applyRbacMasking;
  window._hpPerms = { loaded: () => _loaded, role: () => _role };

})(window);

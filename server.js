const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { OpenAI } = require('openai');
let PDFDocument;
try { PDFDocument = require('pdf-lib').PDFDocument; } catch(e) { console.warn('[startup] pdf-lib unavailable:', e.message); }
const { generateEInvoice, SUPPORTED_FORMATS } = require('./lib/einvoice');

const app = express();
const port = process.env.PORT || 3000;

// Fail fast if DATABASE_URL is missing
if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

// Session secret - generate one if not set
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

// ============================================================
// CLIENT SUBSCRIPTION PLANS (entreprises — 99 / 199 / 499 DH)
// ============================================================
const CLIENT_PLANS = {
  starter:  { label: 'Starter',  price_mad: 99,  color: '#6b7280' },
  standard: { label: 'Standard', price_mad: 199, color: '#7c3aed' },
  premium:  { label: 'Premium',  price_mad: 499, color: '#059669' },
};

// Cabinet billing: 49 DH HT / mois / dossier actif
const CABINET_PRICE_PER_DOSSIER = 49;

// Cabinet statuses
const CABINET_STATUSES = {
  en_attente:    { label: 'En attente',    color: '#d97706', bg: '#fef3c7' },
  en_deploiement:{ label: 'En déploiement',color: '#7c3aed', bg: '#ede9fe' },
  actif:         { label: 'Actif',          color: '#059669', bg: '#ecfdf5' },
};

// ============================================================
// CLIENT PLAN FEATURES (entreprise/standard users)
// ============================================================

// Plan hierarchy — each level includes all features of lower levels
const CLIENT_PLAN_ORDER = ['starter', 'standard', 'premium'];

// Maps a feature key to the minimum plan required to access it
// Cabinets (user_type='cabinet') bypass ALL of this — no restriction
const CLIENT_FEATURE_GATE = {
  suivi_transactions:   'standard', // Detailed bank transaction management
  rapports_avances:     'standard', // Advanced financial reports (bilan, CPC, etc.)
  export_donnees:       'standard', // Data exports
  interaction_cabinet:  'standard', // Advanced cabinet interaction features
  comptabilite_avancee: 'premium',  // Journal, TVA, IS, immobilisations, lettrage
  dashboard_complet:    'premium',  // Full dashboard, analytics, prévisionnel
  automatisation:       'premium',  // Automated reminders, recurring billing
  autonomie_comptable:  'premium',  // Full accounting autonomy
};

// Get current plan for a company. Defaults to 'starter' if no subscription record.
async function getClientPlan(companyId) {
  const result = await pool.query(
    `SELECT plan, status, started_at, expires_at FROM client_subscriptions WHERE company_id = $1`,
    [companyId]
  );
  if (result.rows.length === 0) return 'starter';
  const sub = result.rows[0];
  if (sub.status === 'inactive') return 'starter';
  if (sub.expires_at && new Date(sub.expires_at) < new Date()) return 'starter';
  return sub.plan;
}

// Middleware: gate an API route by client plan feature
// Cabinets always bypass. Standard users are checked.
function checkClientPlan(feature) {
  return async function(req, res, next) {
    if (req.userType === 'cabinet') return next(); // cabinets: full access
    const requiredPlan = CLIENT_FEATURE_GATE[feature];
    if (!requiredPlan) return next(); // unknown feature = allow
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return next(); // no company yet (onboarding) = allow
    const plan = await getClientPlan(companyId);
    const hasAccess = CLIENT_PLAN_ORDER.indexOf(plan) >= CLIENT_PLAN_ORDER.indexOf(requiredPlan);
    if (!hasAccess) {
      const planLabel = requiredPlan === 'standard' ? 'Standard (199 MAD/mois)' : 'Premium (499 MAD/mois)';
      return res.status(403).json({
        error: `Fonctionnalité réservée au plan ${planLabel}.`,
        plan_required: requiredPlan,
        current_plan: plan,
        feature,
        upgrade_url: '/app.html#mon-abonnement'
      });
    }
    next();
  };
}

app.use(express.json({ limit: '10mb' }));

// ============================================================
// SECURITY MIDDLEWARE
// ============================================================

// 1. Security headers (no external package needed)
app.use((req, res, next) => {
  // CSP: allows jsPDF from cdnjs, Google Fonts, inline styles (needed by app)
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "img-src 'self' data: blob:; " +
    "font-src 'self' data: https://fonts.gstatic.com; " +
    "connect-src 'self'; " +
    "frame-ancestors 'none'"
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// 2. In-memory rate limiter factory (no external package)
function createRateLimiter({ windowMs, max, keyFn, message }) {
  const hits = new Map(); // key -> { count, resetTime }
  // Periodic cleanup to prevent memory leaks
  setInterval(() => {
    const now = Date.now();
    for (const [key, data] of hits) {
      if (data.resetTime <= now) hits.delete(key);
    }
  }, windowMs).unref();

  return function rateLimiter(req, res, next) {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
    const key = keyFn ? keyFn(req, ip) : ip;
    const now = Date.now();
    let data = hits.get(key);
    if (!data || data.resetTime <= now) {
      data = { count: 0, resetTime: now + windowMs };
      hits.set(key, data);
    }
    data.count++;
    if (data.count > max) {
      const retryAfterSeconds = Math.ceil((data.resetTime - now) / 1000);
      const mins = Math.ceil(retryAfterSeconds / 60);
      const msg = typeof message === 'function' ? message(mins) : (message || `Trop de tentatives, réessayez dans ${mins} minute${mins > 1 ? 's' : ''}`);
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ error: msg });
    }
    next();
  };
}

// Specific rate limiters
const loginRateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  message: (mins) => `Trop de tentatives de connexion, réessayez dans ${mins} minute${mins > 1 ? 's' : ''}`
});

const signupRateLimit = createRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3,
  message: () => "Trop d'inscriptions depuis cette adresse IP, réessayez dans 1 heure"
});

const ocrRateLimit = createRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  // Keyed by user ID (set by requireAuth middleware which runs before this)
  keyFn: (req, ip) => req.userId ? `user:${req.userId}` : ip,
  message: (mins) => `Trop d'appels OCR, réessayez dans ${mins} minute${mins > 1 ? 's' : ''}`
});

const inviteRateLimit = createRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  keyFn: (req, ip) => req.userId ? `user:${req.userId}` : ip,
  message: (mins) => `Trop d'invitations envoyées, réessayez dans ${mins} minute${mins > 1 ? 's' : ''}`
});

// 3. CSRF protection: require X-Requested-With header on state-changing requests
// Auth endpoints (login, signup, member-invite accept, logout) are excluded because
// they are pre-session — SameSite=Strict on the session cookie covers authenticated routes.
const CSRF_EXCLUDED_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/signup',
  '/api/auth/signup-invitation',
  '/api/auth/logout',
]);
app.use((req, res, next) => {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const isExcluded = CSRF_EXCLUDED_PATHS.has(req.path) ||
      req.path.startsWith('/api/auth/member-invite');
    if (!isExcluded) {
      const xrw = req.headers['x-requested-with'];
      if (!xrw || xrw.toLowerCase() !== 'xmlhttprequest') {
        return res.status(403).json({ error: 'Requête non autorisée (protection CSRF)' });
      }
    }
  }
  next();
});

// Cookie parser (simple implementation)
function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie;
  if (!header) return cookies;
  header.split(';').forEach(cookie => {
    const [name, ...rest] = cookie.trim().split('=');
    cookies[name] = decodeURIComponent(rest.join('='));
  });
  return cookies;
}

// ============================================================
// PASSWORD HASHING (PBKDF2 - built-in, secure)
// ============================================================
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  // Handle legacy sha256 hashes (no colon separator) from cabinet member creation
  if (!stored.includes(':')) {
    const legacyHash = crypto.createHash('sha256').update(password + (process.env.SESSION_SECRET || 'REDACTED')).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(legacyHash, 'hex'));
  }
  const [salt, hash] = stored.split(':');
  const verify = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(verify, 'hex'));
}

// ============================================================
// SESSION MANAGEMENT
// ============================================================
function generateToken() {
  return crypto.randomBytes(48).toString('hex');
}

async function createSession(userId) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE);
  await pool.query(
    'INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, $3)',
    [userId, token, expiresAt]
  );
  return { token, expiresAt };
}

async function getSession(token) {
  if (!token) return null;
  const result = await pool.query(
    `SELECT s.*, u.email, u.name, u.user_type, u.cabinet_role, u.onboarding_completed, u.entreprise_role, s.active_company_id,
      COALESCE(cm.cabinet_owner_id, u.id) as cabinet_owner_id
     FROM sessions s
     JOIN users u ON s.user_id = u.id
     LEFT JOIN cabinet_members cm ON cm.member_user_id = u.id AND cm.status = 'active'
     WHERE s.token = $1 AND s.expires_at > NOW()`,
    [token]
  );
  return result.rows[0] || null;
}

async function deleteSession(token) {
  await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
}

// Clean expired sessions periodically
async function cleanExpiredSessions() {
  try {
    await pool.query('DELETE FROM sessions WHERE expires_at < NOW()');
  } catch (e) {
    // ignore
  }
}
setInterval(cleanExpiredSessions, 60 * 60 * 1000); // every hour

// ============================================================
// NOTIFICATION SERVICE
// ============================================================

// Email transport configuration (in priority order):
// 1. POSTMARK_SERVER_TOKEN → Postmark HTTP API (recommended)
// 2. POLSIA_EMAIL_PROXY_URL → Polsia platform proxy (when available)
// 3. No config → emails disabled with warning log
const POSTMARK_SERVER_TOKEN = process.env.POSTMARK_SERVER_TOKEN || '';
const POLSIA_EMAIL_PROXY_URL = (process.env.POLSIA_EMAIL_PROXY_URL || '').replace(/\/$/, '');
const POLSIA_API_KEY_EMAIL = process.env.POLSIA_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'hissabpro@polsia.app';
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || 'HissabPro';

if (!POSTMARK_SERVER_TOKEN && !POLSIA_EMAIL_PROXY_URL) {
  console.warn('[EMAIL] ⚠️  No email transport configured. Set POSTMARK_SERVER_TOKEN or POLSIA_EMAIL_PROXY_URL. Emails will NOT be sent.');
}

function buildEmailHtml(title, message, link) {
  const btnUrl = link ? `https://hissabpro.polsia.app${link}` : 'https://hissabpro.polsia.app/app';
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,#059669,#10b981);padding:28px 36px;">
          <table cellpadding="0" cellspacing="0"><tr>
            <td style="width:38px;height:38px;background:rgba(255,255,255,0.2);border-radius:8px;text-align:center;vertical-align:middle;">
              <span style="color:#fff;font-family:Georgia,serif;font-weight:700;font-size:16px;">H</span>
            </td>
            <td style="padding-left:12px;color:#fff;font-size:18px;font-weight:700;letter-spacing:-0.3px;">HissabPro</td>
          </tr></table>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:32px 36px;">
          <h2 style="margin:0 0 12px;font-size:20px;font-weight:700;color:#111827;">${title}</h2>
          <p style="margin:0 0 28px;font-size:15px;color:#374151;line-height:1.6;">${message}</p>
          <a href="${btnUrl}" style="display:inline-block;background:#059669;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:600;letter-spacing:0.2px;">Voir sur HissabPro →</a>
        </td></tr>
        <!-- Footer -->
        <tr><td style="padding:20px 36px;border-top:1px solid #f3f4f6;">
          <p style="margin:0;font-size:12px;color:#9ca3af;">Vous recevez cet email car vous avez un compte HissabPro. Pour gérer vos préférences de notifications, connectez-vous à votre espace et accédez aux Paramètres.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

async function sendNotificationEmail(to, subject, htmlBody) {
  if (!to) {
    console.warn('[EMAIL] No recipient provided, skipping');
    return;
  }

  // === Transport 1: Postmark HTTP API (preferred) ===
  if (POSTMARK_SERVER_TOKEN) {
    try {
      const resp = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'X-Postmark-Server-Token': POSTMARK_SERVER_TOKEN
        },
        body: JSON.stringify({
          From: `${EMAIL_FROM_NAME} <${EMAIL_FROM}>`,
          To: to,
          Subject: subject,
          HtmlBody: htmlBody,
          MessageStream: 'outbound'
        })
      });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        console.error(`[EMAIL] Postmark API error (${resp.status}): ${txt}`);
      } else {
        const data = await resp.json().catch(() => ({}));
        console.log(`[EMAIL] ✅ Sent to ${to} via Postmark (MessageID: ${data.MessageID || 'n/a'})`);
      }
      return;
    } catch (e) {
      console.error('[EMAIL] Postmark API exception:', e.message);
      // Fall through to next transport
    }
  }

  // === Transport 2: Polsia email proxy (forward-compat) ===
  if (POLSIA_EMAIL_PROXY_URL && POLSIA_API_KEY_EMAIL) {
    try {
      const resp = await fetch(POLSIA_EMAIL_PROXY_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${POLSIA_API_KEY_EMAIL}`
        },
        body: JSON.stringify({
          to,
          subject,
          html: htmlBody,
          from_name: EMAIL_FROM_NAME,
          from_slug: 'hissabpro'
        })
      });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        console.error(`[EMAIL] Polsia proxy error (${resp.status}): ${txt}`);
      } else {
        console.log(`[EMAIL] ✅ Sent to ${to} via Polsia proxy`);
      }
      return;
    } catch (e) {
      console.error('[EMAIL] Polsia proxy exception:', e.message);
    }
  }

  // === No transport: queue to DB for later processing ===
  try {
    await pool.query(
      `INSERT INTO email_queue (to_email, subject, html_body, status) VALUES ($1, $2, $3, 'pending')`,
      [to, subject, htmlBody]
    );
    console.warn(`[EMAIL] ⏳ Queued email to ${to} (no transport configured). Subject: "${subject}"`);
  } catch (qErr) {
    console.error(`[EMAIL] ❌ Failed to queue email to ${to}: ${qErr.message}. Subject: "${subject}"`);
  }
}

// Build branded invitation email HTML
function buildInvitationEmail(cabinetName, dossierName, inviteUrl) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Invitation HissabPro</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
        <tr><td style="background:linear-gradient(135deg,#059669,#10b981);padding:28px 36px;">
          <table cellpadding="0" cellspacing="0"><tr>
            <td style="width:38px;height:38px;background:rgba(255,255,255,0.2);border-radius:8px;text-align:center;vertical-align:middle;">
              <span style="color:#fff;font-family:Georgia,serif;font-weight:700;font-size:16px;">H</span>
            </td>
            <td style="padding-left:12px;color:#fff;font-size:18px;font-weight:700;letter-spacing:-0.3px;">HissabPro</td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:32px 36px;">
          <h2 style="margin:0 0 12px;font-size:20px;font-weight:700;color:#111827;">Vous êtes invité(e) à rejoindre HissabPro</h2>
          <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.6;">
            Votre cabinet <strong>${cabinetName}</strong> vous invite à rejoindre HissabPro pour votre dossier <strong>${dossierName}</strong>.
          </p>
          <p style="margin:0 0 28px;font-size:15px;color:#374151;line-height:1.6;">
            Créez votre espace pour déposer vos documents, suivre votre trésorerie, et collaborer directement avec votre cabinet.
          </p>
          <a href="${inviteUrl}" style="display:inline-block;background:#059669;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:600;letter-spacing:0.2px;">Créer mon espace →</a>
          <p style="margin:24px 0 0;font-size:12px;color:#9ca3af;">Ce lien expire dans 7 jours. Si vous n'êtes pas à l'origine de cette invitation, ignorez cet email.</p>
        </td></tr>
        <tr><td style="padding:20px 36px;border-top:1px solid #f3f4f6;">
          <p style="margin:0;font-size:12px;color:#9ca3af;">HissabPro — Comptabilité & gestion pour les entreprises marocaines</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// Build branded cabinet member invitation email
function buildMemberInviteEmail(cabinetName, memberName, roleLabel, inviteUrl) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Invitation cabinet HissabPro</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
        <tr><td style="background:linear-gradient(135deg,#059669,#10b981);padding:28px 36px;">
          <table cellpadding="0" cellspacing="0"><tr>
            <td style="width:38px;height:38px;background:rgba(255,255,255,0.2);border-radius:8px;text-align:center;vertical-align:middle;">
              <span style="color:#fff;font-family:Georgia,serif;font-weight:700;font-size:16px;">H</span>
            </td>
            <td style="padding-left:12px;color:#fff;font-size:18px;font-weight:700;letter-spacing:-0.3px;">HissabPro</td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:32px 36px;">
          <h2 style="margin:0 0 12px;font-size:20px;font-weight:700;color:#111827;">Bienvenue dans l'équipe !</h2>
          <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.6;">
            Bonjour <strong>${memberName}</strong>,<br><br>
            Le cabinet <strong>${cabinetName}</strong> vous invite à rejoindre son espace HissabPro
            en tant que <strong>${roleLabel}</strong>.
          </p>
          <p style="margin:0 0 28px;font-size:15px;color:#374151;line-height:1.6;">
            Cliquez sur le lien ci-dessous pour créer votre mot de passe et accéder à votre espace.
          </p>
          <a href="${inviteUrl}" style="display:inline-block;background:#059669;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:600;letter-spacing:0.2px;">Créer mon espace →</a>
          <p style="margin:24px 0 0;font-size:12px;color:#9ca3af;">Ce lien expire dans 7 jours. Si vous n'êtes pas à l'origine de cette invitation, ignorez cet email.</p>
        </td></tr>
        <tr><td style="padding:20px 36px;border-top:1px solid #f3f4f6;">
          <p style="margin:0;font-size:12px;color:#9ca3af;">HissabPro — Comptabilité & gestion pour les entreprises marocaines</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// Create a notification for a user + optionally email them
async function createNotification(userId, companyId, type, title, message, link) {
  try {
    // Check if user has disabled this type
    const prefsResult = await pool.query(
      'SELECT email_enabled, types_disabled FROM notification_preferences WHERE user_id = $1',
      [userId]
    );
    const prefs = prefsResult.rows[0];
    if (prefs && prefs.types_disabled && prefs.types_disabled.includes(type)) return null;

    const result = await pool.query(
      `INSERT INTO notifications (user_id, company_id, type, title, message, link)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [userId, companyId || null, type, title, message, link || null]
    );

    // Send email unless user has disabled it
    const emailEnabled = !prefs || prefs.email_enabled !== false;
    if (emailEnabled) {
      const userResult = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
      const userEmail = userResult.rows[0]?.email;
      if (userEmail) {
        const html = buildEmailHtml(title, message, link || '/app');
        sendNotificationEmail(userEmail, title, html).catch(() => {});
      }
    }

    return result.rows[0]?.id || null;
  } catch (e) {
    console.error('createNotification error (non-blocking):', e.message);
    return null;
  }
}

// Notify client (via company.email) for client-facing events + in-app if client has account
async function notifyClient(cabinetUserId, companyId, type, title, message, link) {
  try {
    const compResult = await pool.query('SELECT id, name, email FROM companies WHERE id = $1', [companyId]);
    const company = compResult.rows[0];
    if (!company) return;

    // Find standard user with matching email (if any)
    if (company.email) {
      const clientUserResult = await pool.query(
        'SELECT id FROM users WHERE email = $1 AND user_type = $2',
        [company.email, 'standard']
      );
      if (clientUserResult.rows.length > 0) {
        const clientUserId = clientUserResult.rows[0].id;
        await createNotification(clientUserId, companyId, type, title, message, link);
        return; // createNotification already sends email
      }
      // No account: just send email to company.email
      const html = buildEmailHtml(title, message, '/app');
      sendNotificationEmail(company.email, title, html).catch(() => {});
    }
  } catch (e) {
    console.error('notifyClient error (non-blocking):', e.message);
  }
}

// Notify cabinet user (self-notification for cabinet events)
async function notifyCabinet(cabinetUserId, companyId, type, title, message, link) {
  await createNotification(cabinetUserId, companyId, type, title, message, link);
}

// ============================================================
// AUTH MIDDLEWARE
// ============================================================
async function requireAuth(req, res, next) {
  const cookies = parseCookies(req);
  const token = cookies.session_token;

  if (!token) {
    return res.status(401).json({ error: 'Non authentifie' });
  }

  const session = await getSession(token);
  if (!session) {
    return res.status(401).json({ error: 'Session expiree' });
  }

  req.userId = session.user_id;
  req.userEmail = session.email;
  req.userName = session.name;
  req.userType = session.user_type || 'standard';
  req.cabinetRole = session.cabinet_role || null;
  req.cabinetOwnerId = parseInt(session.cabinet_owner_id) || session.user_id;
  req.activeCompanyId = session.active_company_id || null;
  req.onboardingCompleted = session.onboarding_completed === true;
  req.entrepriseRole = session.entreprise_role || null;
  next();
}

// Require a specific cabinet role (use AFTER requireAuth)
// roles: array of allowed roles, e.g. ['admin'] or ['admin', 'comptable']
function requireCabinetRole(roles) {
  return function(req, res, next) {
    // Explicit check: standard/entreprise users cannot access cabinet routes
    if (req.userType !== 'cabinet') {
      return res.status(403).json({ error: 'Accès réservé aux comptes cabinet. Les comptes entreprise n\'ont pas accès à cette fonctionnalité.' });
    }
    if (!req.cabinetRole) {
      return res.status(403).json({ error: 'Accès réservé aux membres du cabinet' });
    }
    if (!roles.includes(req.cabinetRole)) {
      return res.status(403).json({ error: 'Permissions insuffisantes pour cette action' });
    }
    next();
  };
}

// Middleware: enforce entreprise RBAC permissions
// Permission constants:
//   'delete'       - can delete records
//   'user_mgmt'    - can invite/manage users
//   'ventes'       - can access sales/client features
//   'achats'       - can access purchase/supplier features
//   'full'         - full access
const ENTREPRISE_PERMISSIONS = {
  'dirigeant':              ['full', 'delete', 'user_mgmt', 'ventes', 'achats'],
  'associe':                ['full', 'delete', 'user_mgmt', 'ventes', 'achats'],
  'assistante_saisie':      ['ventes', 'achats'],
  'assistant_fournisseur':  ['achats'],
  'assistant_client':       ['ventes'],
};

function requireEntreprisePermission(permission) {
  return (req, res, next) => {
    // Cabinet users are not subject to entreprise RBAC
    if (req.userType === 'cabinet') return next();
    // If no entreprise role (legacy/unset), treat as dirigeant
    const role = req.entrepriseRole || 'dirigeant';
    const perms = ENTREPRISE_PERMISSIONS[role] || [];
    if (perms.includes('full') || perms.includes(permission)) {
      return next();
    }
    return res.status(403).json({ error: 'Accès refusé — permissions insuffisantes', required: permission, role });
  };
}

// Health check endpoint (required for Render)
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', version: '2.0.0' });
});

// Helper: get effective company id for data operations
// Cabinet mode: uses active_company_id from session
// Standard mode: uses first company of user
async function getEffectiveCompanyId(req, dbClient) {
  if (req.activeCompanyId) return req.activeCompanyId;
  const c = dbClient || pool;
  const result = await c.query('SELECT id FROM companies WHERE user_id = $1 ORDER BY id LIMIT 1', [req.userId]);
  return result.rows.length > 0 ? result.rows[0].id : null;
}

// ============================================================
// AUTH ROUTES (no auth required)
// ============================================================

app.post('/api/auth/signup', signupRateLimit, async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe sont requis' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caracteres' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Format email invalide' });
    }

    // Check if user exists
    const existing = await pool.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Un compte existe deja avec cet email' });
    }

    // Create user
    const passwordHash = hashPassword(password);
    const result = await pool.query(
      'INSERT INTO users (email, name, password_hash) VALUES (LOWER($1), $2, $3) RETURNING id, email, name',
      [email, name || null, passwordHash]
    );
    const user = result.rows[0];

    // Create default company for user
    await pool.query(
      'INSERT INTO companies (name, user_id) VALUES ($1, $2)',
      ['Mon Entreprise', user.id]
    );

    // Create session
    const session = await createSession(user.id);

    res.setHeader('Set-Cookie', `session_token=${session.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE / 1000}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
    res.json({ user: { id: user.id, email: user.email, name: user.name, onboarding_completed: false } });
  } catch (err) {
    console.error('POST /api/auth/signup error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/auth/login', loginRateLimit, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe sont requis' });
    }

    // Find user
    const result = await pool.query(
      'SELECT id, email, name, password_hash, onboarding_completed FROM users WHERE LOWER(email) = LOWER($1)',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }

    const user = result.rows[0];

    if (!user.password_hash) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }

    // Verify password
    const valid = verifyPassword(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }

    // Create session
    const session = await createSession(user.id);

    // Auto-link standard (invited) clients to their cabinet dossier
    try {
      const linkedDossier = await pool.query(
        'SELECT id FROM companies WHERE client_user_id = $1 LIMIT 1',
        [user.id]
      );
      if (linkedDossier.rows.length > 0) {
        await pool.query(
          'UPDATE sessions SET active_company_id = $1 WHERE token = $2',
          [linkedDossier.rows[0].id, session.token]
        );
      }
    } catch (_) { /* non-blocking */ }

    res.setHeader('Set-Cookie', `session_token=${session.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE / 1000}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
    res.json({ user: { id: user.id, email: user.email, name: user.name, onboarding_completed: user.onboarding_completed === true } });
  } catch (err) {
    console.error('POST /api/auth/login error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================================
// CLIENT INVITATION AUTH ROUTES
// ============================================================

// GET /api/auth/invitation/:token — validate token, return dossier info
app.get('/api/auth/invitation/:token', async (req, res) => {
  try {
    const { token } = req.params;
    if (!token) return res.status(400).json({ error: 'Token manquant' });

    const result = await pool.query(
      `SELECT c.id, c.name as dossier_name, c.email as client_email,
              c.client_invitation_status, c.client_invitation_expires_at,
              u.name as cabinet_name
       FROM companies c
       JOIN users u ON c.user_id = u.id
       WHERE c.client_invitation_token = $1`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Lien d\'invitation invalide ou expiré' });
    }

    const row = result.rows[0];

    // Check expiry
    if (row.client_invitation_expires_at && new Date() > new Date(row.client_invitation_expires_at)) {
      return res.status(410).json({ error: 'Ce lien d\'invitation a expiré. Demandez à votre cabinet de vous renvoyer une invitation.' });
    }

    // Check if a user account already exists with this email
    let accountExists = false;
    if (row.client_email) {
      const existingUser = await pool.query(
        'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
        [row.client_email]
      );
      accountExists = existingUser.rows.length > 0;
    }

    res.json({
      dossier_id: row.id,
      dossier_name: row.dossier_name,
      client_email: row.client_email,
      cabinet_name: row.cabinet_name,
      invitation_status: row.client_invitation_status,
      account_exists: accountExists
    });
  } catch (err) {
    console.error('GET /api/auth/invitation error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/auth/signup-invitation — create account from invitation token
app.post('/api/auth/signup-invitation', signupRateLimit, async (req, res) => {
  try {
    const { token, name, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Données manquantes' });
    if (password.length < 6) return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères' });

    // Validate token
    const tokenResult = await pool.query(
      `SELECT c.id as company_id, c.name as dossier_name, c.email as client_email,
              c.client_invitation_expires_at, c.client_invitation_status, c.client_user_id
       FROM companies c
       WHERE c.client_invitation_token = $1`,
      [token]
    );

    if (tokenResult.rows.length === 0) {
      return res.status(404).json({ error: 'Lien d\'invitation invalide' });
    }

    const dossier = tokenResult.rows[0];

    if (dossier.client_invitation_expires_at && new Date() > new Date(dossier.client_invitation_expires_at)) {
      return res.status(410).json({ error: 'Ce lien d\'invitation a expiré' });
    }

    if (!dossier.client_email) {
      return res.status(400).json({ error: 'Aucun email associé à ce dossier' });
    }

    // Check if user already exists
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
      [dossier.client_email]
    );

    let userId;
    if (existingUser.rows.length > 0) {
      // Account exists — ensure user_type is 'standard' (client invitation = entreprise role)
      userId = existingUser.rows[0].id;
      await pool.query(
        "UPDATE users SET user_type = 'standard', cabinet_role = NULL WHERE id = $1 AND user_type != 'standard'",
        [userId]
      );
    } else {
      // Create new standard user account
      const passwordHash = hashPassword(password);
      const newUser = await pool.query(
        `INSERT INTO users (email, name, password_hash, user_type)
         VALUES (LOWER($1), $2, $3, 'standard')
         RETURNING id`,
        [dossier.client_email, name || dossier.client_email.split('@')[0], passwordHash]
      );
      userId = newUser.rows[0].id;
    }

    // Link user to dossier
    await pool.query(
      `UPDATE companies SET
         client_user_id = $1,
         client_invitation_status = 'accepted',
         client_invitation_token = NULL,
         client_invitation_expires_at = NULL
       WHERE id = $2`,
      [userId, dossier.company_id]
    );

    // Create session with active_company_id set to this dossier
    const session = await createSession(userId);
    await pool.query(
      'UPDATE sessions SET active_company_id = $1 WHERE token = $2',
      [dossier.company_id, session.token]
    );

    res.setHeader('Set-Cookie', `session_token=${session.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE / 1000}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
    res.json({ ok: true, dossier_id: dossier.company_id });
  } catch (err) {
    console.error('POST /api/auth/signup-invitation error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/auth/member-invite/:token — validate cabinet member invite token
app.get('/api/auth/member-invite/:token', async (req, res) => {
  try {
    const { token } = req.params;
    if (!token) return res.status(400).json({ error: 'Token manquant' });

    const result = await pool.query(
      `SELECT cm.id, cm.role, cm.invite_expires_at, cm.invite_status,
              u.email, u.name,
              owner.name as cabinet_name
       FROM cabinet_members cm
       JOIN users u ON u.id = cm.member_user_id
       JOIN users owner ON owner.id = cm.cabinet_owner_id
       WHERE cm.invite_token = $1`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Lien d\'invitation invalide ou expiré' });
    }

    const row = result.rows[0];

    if (row.invite_expires_at && new Date() > new Date(row.invite_expires_at)) {
      return res.status(410).json({ error: 'Ce lien d\'invitation a expiré. Demandez à votre administrateur de vous renvoyer une invitation.' });
    }

    // Check if user already has a password set
    const userCheck = await pool.query('SELECT password_hash FROM users WHERE email = LOWER($1)', [row.email]);
    const hasPassword = !!(userCheck.rows[0]?.password_hash);

    const roleLabel = { chef_mission: 'Chef de mission', collaborateur: 'Collaborateur', comptable: 'Comptable', assistant: 'Assistant' }[row.role] || row.role;

    res.json({
      email: row.email,
      name: row.name,
      role: row.role,
      role_label: roleLabel,
      cabinet_name: row.cabinet_name,
      invite_status: row.invite_status,
      has_password: hasPassword
    });
  } catch (err) {
    console.error('GET /api/auth/member-invite error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/auth/member-invite/:token — accept cabinet member invitation + set password
app.post('/api/auth/member-invite/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const { password, name } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Données manquantes' });
    if (password.length < 6) return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères' });

    // Validate token
    const tokenResult = await pool.query(
      `SELECT cm.id as member_id, cm.member_user_id, cm.invite_expires_at, cm.invite_status, cm.role,
              u.email, cm.cabinet_owner_id
       FROM cabinet_members cm
       JOIN users u ON u.id = cm.member_user_id
       WHERE cm.invite_token = $1`,
      [token]
    );

    if (tokenResult.rows.length === 0) {
      return res.status(404).json({ error: 'Lien d\'invitation invalide' });
    }

    const invite = tokenResult.rows[0];

    if (invite.invite_expires_at && new Date() > new Date(invite.invite_expires_at)) {
      return res.status(410).json({ error: 'Ce lien d\'invitation a expiré' });
    }

    // Set password and name on user account
    const passwordHash = hashPassword(password);
    await pool.query(
      'UPDATE users SET password_hash = $1, user_type = $2, cabinet_role = $3, name = COALESCE(NULLIF($4, \'\'), name) WHERE id = $5',
      [passwordHash, 'cabinet', invite.role, name || null, invite.member_user_id]
    );

    // Mark invite as accepted — clear token
    await pool.query(
      `UPDATE cabinet_members SET invite_status = 'active', invite_token = NULL, invite_expires_at = NULL WHERE id = $1`,
      [invite.member_id]
    );

    // Create session
    const session = await createSession(invite.member_user_id);

    res.setHeader('Set-Cookie', `session_token=${session.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE / 1000}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/auth/member-invite error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const cookies = parseCookies(req);
    const token = cookies.session_token;
    if (token) {
      await deleteSession(token);
    }
    res.setHeader('Set-Cookie', 'session_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/auth/logout error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/auth/me', async (req, res) => {
  try {
    const cookies = parseCookies(req);
    const token = cookies.session_token;

    if (!token) {
      return res.status(401).json({ error: 'Non authentifie' });
    }

    const session = await getSession(token);
    if (!session) {
      return res.status(401).json({ error: 'Session expiree' });
    }

    const cabinetOwnerId = parseInt(session.cabinet_owner_id) || session.user_id;

    // For standard users who are clients of a dossier, fetch their client_role
    let clientRole = null;
    if ((session.user_type || 'standard') === 'standard') {
      const clientComp = await pool.query(
        `SELECT client_role FROM companies WHERE client_user_id = $1 LIMIT 1`,
        [session.user_id]
      );
      if (clientComp.rows.length > 0) clientRole = clientComp.rows[0].client_role || 'gerant';
    }

    res.json({ user: { id: session.user_id, email: session.email, name: session.name, user_type: session.user_type || 'standard', cabinet_role: session.cabinet_role || null, cabinet_owner_id: cabinetOwnerId, active_company_id: session.active_company_id || null, onboarding_completed: session.onboarding_completed === true, entreprise_role: session.entreprise_role || null, client_role: clientRole } });
  } catch (err) {
    console.error('GET /api/auth/me error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================================
// ALL API ROUTES BELOW REQUIRE AUTH
// ============================================================

// ---- COMPANY ----
app.get('/api/company', requireAuth, async (req, res) => {
  try {
    let result;
    if (req.activeCompanyId) {
      result = await pool.query('SELECT * FROM companies WHERE id = $1 AND user_id = $2', [req.activeCompanyId, req.userId]);
    } else {
      result = await pool.query('SELECT * FROM companies WHERE user_id = $1 ORDER BY id LIMIT 1', [req.userId]);
    }
    if (result.rows.length === 0) {
      return res.json({ company: null });
    }
    res.json({ company: result.rows[0] });
  } catch (err) {
    console.error('GET /api/company error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/company', requireAuth, async (req, res) => {
  try {
    const { name, ice, idf, rc, cnss, address, city, phone, email, default_tva_rate, rib, bank_name, payment_conditions } = req.body;
    if (!name) return res.status(400).json({ error: 'Le nom est requis' });

    // Check if company exists for this user
    const existing = await pool.query('SELECT id FROM companies WHERE user_id = $1 LIMIT 1', [req.userId]);
    let result;

    if (existing.rows.length > 0) {
      result = await pool.query(
        `UPDATE companies SET name=$1, ice=$2, idf=$3, rc=$4, cnss=$5, address=$6, city=$7, phone=$8, email=$9, default_tva_rate=$10, rib=$13, bank_name=$14, payment_conditions=$15, updated_at=NOW()
         WHERE id=$11 AND user_id=$12 RETURNING *`,
        [name, ice || null, idf || null, rc || null, cnss || null, address || null, city || null, phone || null, email || null, default_tva_rate || 20, existing.rows[0].id, req.userId, rib || null, bank_name || null, payment_conditions || null]
      );
    } else {
      result = await pool.query(
        `INSERT INTO companies (name, ice, idf, rc, cnss, address, city, phone, email, default_tva_rate, user_id, rib, bank_name, payment_conditions)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
        [name, ice || null, idf || null, rc || null, cnss || null, address || null, city || null, phone || null, email || null, default_tva_rate || 20, req.userId, rib || null, bank_name || null, payment_conditions || null]
      );
    }
    res.json({ company: result.rows[0] });
  } catch (err) {
    console.error('POST /api/company error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================================
// ONBOARDING
// ============================================================

// POST /api/onboarding — save all wizard steps at once
// Updates companies, users (user_type, onboarding_completed), and creates initial fiscal year
app.post('/api/onboarding', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const {
      // Step 1
      user_type,
      // Step 2 — company info
      company_name, ice, idf, rc, forme_juridique, address, city,
      patente, nb_collaborateurs, activite,
      // Step 3 — accounting config
      fiscal_start, fiscal_end, tva_regime,
      // Step 4 — bank info
      bank_name, rib, account_number
    } = req.body;

    // Validate ICE (15 digits) and RIB (24 digits) if provided
    if (ice && !/^\d{15}$/.test(ice.trim())) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'ICE invalide : doit contenir exactement 15 chiffres' });
    }
    if (rib && !/^\d{24}$/.test(rib.trim())) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'RIB invalide : doit contenir exactement 24 chiffres' });
    }

    // 1) Update user type
    if (user_type && ['standard', 'cabinet'].includes(user_type)) {
      await client.query(
        'UPDATE users SET user_type = $1 WHERE id = $2',
        [user_type, req.userId]
      );
    }

    // For entreprise users, set entreprise_role = 'dirigeant' if not already set
    if (user_type === 'standard' || !user_type) {
      await client.query(
        `UPDATE users SET entreprise_role = COALESCE(entreprise_role, 'dirigeant') WHERE id = $1`,
        [req.userId]
      );
    }

    // 2) Update company info
    const companyResult = await client.query(
      'SELECT id FROM companies WHERE user_id = $1 ORDER BY id LIMIT 1',
      [req.userId]
    );

    let companyId;
    if (companyResult.rows.length > 0) {
      companyId = companyResult.rows[0].id;
      await client.query(
        `UPDATE companies SET
          name = COALESCE($1, name),
          ice = $2,
          idf = $3,
          rc = $4,
          forme_juridique = $5,
          address = $6,
          city = $7,
          tva_regime = $8,
          bank_name = COALESCE($9, bank_name),
          rib = COALESCE($10, rib),
          patente = COALESCE($12, patente),
          nb_collaborateurs = COALESCE($13, nb_collaborateurs),
          activite = COALESCE($14, activite),
          updated_at = NOW()
         WHERE id = $11`,
        [
          company_name || null,
          ice || null,
          idf || null,
          rc || null,
          forme_juridique || null,
          address || null,
          city || null,
          tva_regime || 'Mensuel',
          bank_name || null,
          rib || null,
          companyId,
          patente || null,
          nb_collaborateurs ? parseInt(nb_collaborateurs) : null,
          activite || null
        ]
      );
    } else {
      const newCompany = await client.query(
        `INSERT INTO companies (name, ice, idf, rc, forme_juridique, address, city, tva_regime, bank_name, rib, user_id, patente, nb_collaborateurs, activite)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
        [
          company_name || 'Mon Entreprise',
          ice || null,
          idf || null,
          rc || null,
          forme_juridique || null,
          address || null,
          city || null,
          tva_regime || 'Mensuel',
          bank_name || null,
          rib || null,
          req.userId,
          patente || null,
          nb_collaborateurs ? parseInt(nb_collaborateurs) : null,
          activite || null
        ]
      );
      companyId = newCompany.rows[0].id;
    }

    // 3) Create initial fiscal year if dates provided
    if (fiscal_start && fiscal_end && companyId) {
      const existingFY = await client.query(
        'SELECT id FROM fiscal_years WHERE company_id = $1 LIMIT 1',
        [companyId]
      );
      if (existingFY.rows.length === 0) {
        const startDate = new Date(fiscal_start);
        const endDate = new Date(fiscal_end);
        const label = `Exercice ${startDate.getFullYear()}-${endDate.getFullYear() !== startDate.getFullYear() ? endDate.getFullYear() : startDate.getFullYear()}`;
        await client.query(
          `INSERT INTO fiscal_years (company_id, label, start_date, end_date, status)
           VALUES ($1, $2, $3, $4, 'ouvert')`,
          [companyId, label, fiscal_start, fiscal_end]
        );
      }
    }

    // 4) Mark onboarding complete
    await client.query(
      'UPDATE users SET onboarding_completed = true WHERE id = $1',
      [req.userId]
    );

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/onboarding error:', err.message);
    res.status(500).json({ error: 'Erreur lors de la sauvegarde de l\'onboarding' });
  } finally {
    client.release();
  }
});

// POST /api/onboarding/reset — allow user to redo onboarding from settings
app.post('/api/onboarding/reset', requireAuth, async (req, res) => {
  try {
    await pool.query('UPDATE users SET onboarding_completed = false WHERE id = $1', [req.userId]);
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/onboarding/reset error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/onboarding/register-entreprise — public: create account + save plan (no auth required)
app.post('/api/onboarding/register-entreprise', signupRateLimit, express.json(), async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, email, password, company_name, plan } = req.body || {};

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Nom, email et mot de passe sont requis' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères' });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Format email invalide' });
    }

    const validPlans = ['starter', 'standard', 'premium'];
    const selectedPlan = validPlans.includes(plan) ? plan : 'starter';
    const planPrices = { starter: 99, standard: 199, premium: 499 };

    // Check existing user
    const existing = await client.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Un compte existe déjà avec cet email' });
    }

    await client.query('BEGIN');

    // Create user (user_type standard = entreprise)
    const passwordHash = hashPassword(password);
    const userResult = await client.query(
      `INSERT INTO users (email, name, password_hash, user_type)
       VALUES (LOWER($1), $2, $3, 'standard')
       RETURNING id, email, name`,
      [email, name.trim(), passwordHash]
    );
    const user = userResult.rows[0];

    // Create company with real name
    const companyResult = await client.query(
      'INSERT INTO companies (name, user_id) VALUES ($1, $2) RETURNING id',
      [company_name?.trim() || name.trim(), user.id]
    );
    const companyId = companyResult.rows[0].id;

    // Mark onboarding completed (they chose plan = done)
    await client.query(
      `UPDATE users SET onboarding_completed = true, user_type = 'standard' WHERE id = $1`,
      [user.id]
    );

    // Save subscription plan
    await client.query(
      `INSERT INTO client_subscriptions (user_id, plan, price_dh, status)
       VALUES ($1, $2, $3, 'active')`,
      [user.id, selectedPlan, planPrices[selectedPlan]]
    );

    await client.query('COMMIT');

    // Create session
    const session = await createSession(user.id);
    // Set active company
    await pool.query('UPDATE sessions SET active_company_id = $1 WHERE token = $2', [companyId, session.token]);

    res.setHeader('Set-Cookie', `session_token=${session.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE / 1000}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
    res.json({ success: true, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/onboarding/register-entreprise error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally {
    client.release();
  }
});

// ---- PCM ACCOUNTS ----
app.get('/api/accounts', requireAuth, async (req, res) => {
  try {
    const { class: classFilter, search } = req.query;
    let query = 'SELECT * FROM pcm_accounts WHERE is_active = true';
    const params = [];

    if (classFilter) {
      params.push(parseInt(classFilter));
      query += ` AND class = $${params.length}`;
    }

    if (search) {
      params.push(`%${search}%`);
      query += ` AND (code LIKE $${params.length} OR LOWER(name) LIKE LOWER($${params.length}))`;
    }

    query += ' ORDER BY code ASC';
    const result = await pool.query(query, params);
    res.json({ accounts: result.rows, count: result.rows.length });
  } catch (err) {
    console.error('GET /api/accounts error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ---- CONTACTS ----
app.get('/api/contacts', requireAuth, async (req, res) => {
  try {
    const { type } = req.query;
    let query = 'SELECT * FROM contacts WHERE is_active = true AND user_id = $1';
    const params = [req.userId];

    if (req.activeCompanyId) {
      params.push(req.activeCompanyId);
      query += ` AND company_id = $${params.length}`;
    }
    if (type) {
      params.push(type);
      query += ` AND (type = $${params.length} OR type = 'both')`;
    }
    query += ' ORDER BY name ASC';

    const result = await pool.query(query, params);
    res.json({ contacts: result.rows });
  } catch (err) {
    console.error('GET /api/contacts error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/contacts', requireAuth, async (req, res) => {
  try {
    const { type, name, ice, idf, rc, address, city, phone, email } = req.body;
    if (!name || !type) return res.status(400).json({ error: 'Nom et type sont requis' });

    const companyId = await getEffectiveCompanyId(req);

    const result = await pool.query(
      `INSERT INTO contacts (company_id, type, name, ice, idf, rc, address, city, phone, email, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [companyId, type, name, ice || null, idf || null, rc || null, address || null, city || null, phone || null, email || null, req.userId]
    );
    res.json({ contact: result.rows[0] });
  } catch (err) {
    console.error('POST /api/contacts error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ---- INVOICES ----
app.get('/api/invoices', requireAuth, async (req, res) => {
  try {
    const { type, status, search, page, per_page } = req.query;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const perPage = Math.min(200, Math.max(1, parseInt(per_page) || 50));
    const offset = (pageNum - 1) * perPage;

    const baseFrom = `FROM invoices i
      LEFT JOIN contacts c ON i.contact_id = c.id
      LEFT JOIN clients cl ON i.client_id = cl.id
      LEFT JOIN invoices av ON i.avoir_id = av.id`;

    let whereClause = 'WHERE i.user_id = $1';
    const params = [req.userId];

    if (req.activeCompanyId) {
      params.push(req.activeCompanyId);
      whereClause += ` AND i.company_id = $${params.length}`;
    }
    if (type) {
      params.push(type);
      whereClause += ` AND i.type = $${params.length}`;
    }
    if (status) {
      if (status === 'unpaid') {
        whereClause += ` AND i.type = 'sale' AND i.status IN ('sent', 'overdue', 'draft')`;
      } else {
        params.push(status);
        whereClause += ` AND i.status = $${params.length}`;
      }
    }
    if (search) {
      params.push(`%${search}%`);
      const p = params.length;
      whereClause += ` AND (i.invoice_number ILIKE $${p} OR cl.name ILIKE $${p} OR c.name ILIKE $${p})`;
    }

    // Count total (without pagination)
    const countResult = await pool.query(
      `SELECT COUNT(*) as total ${baseFrom} ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].total);

    // Paginated data
    const dataParams = [...params, perPage, offset];
    const dataResult = await pool.query(
      `SELECT i.*, c.name as contact_name,
        cl.name as client_name, cl.ice as client_ice,
        av.invoice_number as avoir_number
        ${baseFrom} ${whereClause}
        ORDER BY i.date DESC, i.id DESC
        LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    );

    res.json({
      invoices: dataResult.rows,
      pagination: {
        page: pageNum,
        per_page: perPage,
        total,
        total_pages: Math.ceil(total / perPage)
      }
    });
  } catch (err) {
    console.error('GET /api/invoices error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/invoices/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const invoiceResult = await pool.query(
      `SELECT i.*, c.name as contact_name, c.ice as contact_ice, c.address as contact_address, c.city as contact_city,
       cl.name as client_name, cl.ice as client_ice, cl.address as client_address, cl.city as client_city,
       cl.if_number as client_if_number, cl.rc_number as client_rc_number,
       av.invoice_number as avoir_number
       FROM invoices i
       LEFT JOIN contacts c ON i.contact_id = c.id
       LEFT JOIN clients cl ON i.client_id = cl.id
       LEFT JOIN invoices av ON i.avoir_id = av.id
       WHERE i.id = $1 AND i.user_id = $2`,
      [id, req.userId]
    );
    if (invoiceResult.rows.length === 0) return res.status(404).json({ error: 'Facture non trouvee' });

    const linesResult = await pool.query(
      'SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY sort_order ASC',
      [id]
    );

    res.json({ invoice: invoiceResult.rows[0], lines: linesResult.rows });
  } catch (err) {
    console.error('GET /api/invoices/:id error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── E-Invoicing: GET /api/invoices/:id/xml?format=UBL-2.1 ─────────────────────
// Returns the invoice as structured XML in the requested e-invoicing format.
// Default format: UBL-2.1
// Supported formats are exposed in the X-EInvoice-Formats response header.
app.get('/api/invoices/:id/xml', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const format = (req.query.format || 'UBL-2.1').toString().trim();

    // Security: verify the invoice belongs to the authenticated user
    const ownerCheck = await pool.query(
      'SELECT id, invoice_number, company_id FROM invoices WHERE id = $1 AND user_id = $2',
      [id, req.userId]
    );
    if (ownerCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Facture non trouvee' });
    }

    const { xml, canonical } = await generateEInvoice(id, format, pool);

    // Filename: {company_name}_{invoice_number}_UBL.xml
    const companySlug = (canonical.supplier.name || 'company')
      .replace(/[^a-zA-Z0-9\u00C0-\u024F]/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 50);
    const invoiceSlug = (canonical.invoiceNumber || String(id))
      .replace(/[^a-zA-Z0-9-]/g, '_');
    const filename = `${companySlug}_${invoiceSlug}_${format.replace(/[^A-Z0-9]/g, '_')}.xml`;

    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.set('X-EInvoice-Format', format);
    res.set('X-EInvoice-Formats', SUPPORTED_FORMATS.join(', '));
    res.send(xml);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'Facture non trouvee' });
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error('GET /api/invoices/:id/xml error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/invoices', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { type: rawType, contact_id, client_id, date, due_date, notes, ice_client, tva_rate, lines, payment_method } = req.body;
    if (!rawType || !lines || lines.length === 0) {
      return res.status(400).json({ error: 'Type et lignes sont requis' });
    }
    // Normalize invoice type: accept French (vente/achat) or English (sale/purchase)
    const typeMap = { vente: 'sale', achat: 'purchase', sale: 'sale', purchase: 'purchase' };
    const type = typeMap[(rawType || '').toLowerCase()] || rawType;
    if (type !== 'sale' && type !== 'purchase') {
      return res.status(400).json({ error: 'Type de facture invalide. Utilisez: vente ou achat' });
    }

    const companyId = await getEffectiveCompanyId(req, client);

    // ICE validation for sale invoices (mandatory)
    if (type === 'sale') {
      let iceValue = ice_client || null;
      // If client_id provided, fetch ICE from clients table
      if (client_id) {
        const clientRow = await client.query(
          `SELECT ice FROM clients WHERE id = $1 AND company_id = $2`,
          [client_id, companyId]
        );
        if (clientRow.rows.length > 0) {
          iceValue = iceValue || clientRow.rows[0].ice;
        }
      }
      if (!iceValue || !iceValue.trim()) {
        return res.status(422).json({
          error: "L'ICE est obligatoire pour émettre une facture",
          code: 'ICE_REQUIRED',
          message: "L'ICE est obligatoire pour émettre une facture. Complétez la fiche client ou saisissez l'ICE manuellement."
        });
      }
    }

    // Generate invoice number: F-YYYY-NNN (sale) or FC-YYYY-NNN (purchase), per company
    const countResult = await client.query(
      `SELECT COUNT(*) as cnt FROM invoices WHERE type = $1 AND EXTRACT(YEAR FROM date) = EXTRACT(YEAR FROM $2::date) AND company_id = $3 AND (invoice_subtype IS NULL OR invoice_subtype != 'avoir')`,
      [type, date || new Date().toISOString().split('T')[0], companyId]
    );
    const prefix = type === 'sale' ? 'F' : 'FC';
    const year = new Date(date || Date.now()).getFullYear();
    const num = parseInt(countResult.rows[0].cnt) + 1;
    const invoiceNumber = `${prefix}-${year}-${String(num).padStart(3, '0')}`;

    // Calculate totals with per-line TVA rates
    const defaultRate = parseFloat(tva_rate) || 20;
    let subtotal = 0;
    let tvaAmount = 0;
    for (const line of lines) {
      const lineHT = parseFloat(line.quantity) * parseFloat(line.unit_price);
      const lineRate = parseFloat(line.tva_rate) >= 0 ? parseFloat(line.tva_rate) : defaultRate;
      subtotal += lineHT;
      tvaAmount += lineHT * lineRate / 100;
    }
    const total = subtotal + tvaAmount;

    // Resolve final ICE value (from client record if client_id provided)
    let finalIce = ice_client || null;
    if (client_id && !finalIce) {
      const iceRow = await client.query(`SELECT ice FROM clients WHERE id = $1`, [client_id]);
      if (iceRow.rows.length > 0) finalIce = iceRow.rows[0].ice;
    }

    const invoiceResult = await client.query(
      `INSERT INTO invoices (company_id, contact_id, client_id, invoice_number, type, date, due_date, subtotal, tva_amount, total, tva_rate, notes, ice_client, payment_method, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
      [companyId, contact_id || null, client_id || null, invoiceNumber, type, date || new Date().toISOString().split('T')[0],
       due_date || null, subtotal, tvaAmount, total, defaultRate, notes || null, finalIce, payment_method || null, req.userId]
    );
    const invoice = invoiceResult.rows[0];

    // Insert lines with per-line TVA rates
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineRate = parseFloat(line.tva_rate) >= 0 ? parseFloat(line.tva_rate) : defaultRate;
      const lineTotal = parseFloat(line.quantity) * parseFloat(line.unit_price);
      const lineTva = lineTotal * lineRate / 100;

      await client.query(
        `INSERT INTO invoice_lines (invoice_id, description, quantity, unit_price, tva_rate, tva_amount, total, account_code, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [invoice.id, line.description, line.quantity, line.unit_price, lineRate, lineTva, lineTotal + lineTva, line.account_code || (type === 'sale' ? '7111' : '6111'), i]
      );
    }

    // Create journal entry
    const journalType = type === 'sale' ? 'VE' : 'AC';
    const entryNum = `${journalType}-${invoiceNumber}`;

    const journalResult = await client.query(
      `INSERT INTO journal_entries (company_id, entry_number, date, journal_type, reference, description, source_type, source_id, total_debit, total_credit, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'invoice', $7, $8, $9, $10) RETURNING id`,
      [companyId, entryNum, date || new Date().toISOString().split('T')[0], journalType, invoiceNumber,
       `Facture ${invoiceNumber}`, invoice.id, total, total, req.userId]
    );
    const journalId = journalResult.rows[0].id;

    if (type === 'sale') {
      await client.query(
        `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order, tiers_id)
         VALUES ($1, '3421', 'Clients', $2, 0, $3, 0, $4)`,
        [journalId, total, `Facture ${invoiceNumber}`, contact_id || null]
      );
      await client.query(
        `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order)
         VALUES ($1, '7111', 'Ventes de marchandises au Maroc', 0, $2, $3, 1)`,
        [journalId, subtotal, `Facture ${invoiceNumber}`]
      );
      if (tvaAmount > 0) {
        await client.query(
          `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order)
           VALUES ($1, '4455', 'Etat - TVA facturee', 0, $2, $3, 2)`,
          [journalId, tvaAmount, `TVA - Facture ${invoiceNumber}`]
        );
      }
    } else {
      await client.query(
        `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order)
         VALUES ($1, '6111', 'Achats de marchandises', $2, 0, $3, 0)`,
        [journalId, subtotal, `Facture ${invoiceNumber}`]
      );
      if (tvaAmount > 0) {
        await client.query(
          `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order)
           VALUES ($1, '3455', 'Etat - TVA recuperable', $2, 0, $3, 1)`,
          [journalId, tvaAmount, `TVA - Facture ${invoiceNumber}`]
        );
      }
      await client.query(
        `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order, tiers_id)
         VALUES ($1, '4411', 'Fournisseurs', 0, $2, $3, 2, $4)`,
        [journalId, total, `Facture ${invoiceNumber}`, contact_id || null]
      );
    }

    await client.query('UPDATE invoices SET journal_entry_id = $1 WHERE id = $2', [journalId, invoice.id]);

    await client.query('COMMIT');
    res.json({ invoice: { ...invoice, journal_entry_id: journalId } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/invoices error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally {
    client.release();
  }
});

app.put('/api/invoices/:id/status', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!['draft', 'sent', 'paid', 'cancelled', 'overdue', 'validated', 'partially_paid'].includes(status)) {
      return res.status(400).json({ error: 'Statut invalide' });
    }
    // Block direct cancellation — must use the /cancel endpoint which creates an avoir
    if (status === 'cancelled') {
      return res.status(400).json({ error: "Pour annuler une facture, utilisez l'endpoint /cancel qui crée automatiquement un avoir." });
    }
    const result = await pool.query(
      'UPDATE invoices SET status = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3 RETURNING *',
      [status, id, req.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Facture non trouvee' });
    res.json({ invoice: result.rows[0] });
  } catch (err) {
    console.error('PUT /api/invoices/:id/status error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Cancel invoice — creates an avoir (credit note) with reverse journal entries
app.post('/api/invoices/:id/cancel', requireAuth, async (req, res) => {
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    const { id } = req.params;
    const companyId = await getEffectiveCompanyId(req, dbClient);

    // Fetch original invoice
    const origRes = await dbClient.query(
      `SELECT i.*, c.name as contact_name FROM invoices i LEFT JOIN contacts c ON i.contact_id = c.id WHERE i.id = $1 AND i.user_id = $2 AND i.company_id = $3`,
      [id, req.userId, companyId]
    );
    if (origRes.rows.length === 0) {
      await dbClient.query('ROLLBACK');
      return res.status(404).json({ error: 'Facture non trouvée' });
    }
    const orig = origRes.rows[0];

    if (orig.status === 'cancelled') {
      await dbClient.query('ROLLBACK');
      return res.status(400).json({ error: 'Cette facture est déjà annulée' });
    }
    if (orig.invoice_subtype === 'avoir') {
      await dbClient.query('ROLLBACK');
      return res.status(400).json({ error: 'Un avoir ne peut pas être annulé' });
    }
    if (orig.avoir_id) {
      await dbClient.query('ROLLBACK');
      return res.status(400).json({ error: 'Un avoir a déjà été créé pour cette facture' });
    }

    // Generate avoir number: AV-YYYY-NNN per company
    const avcntRes = await dbClient.query(
      `SELECT COUNT(*) as cnt FROM invoices WHERE invoice_subtype = 'avoir' AND company_id = $1 AND EXTRACT(YEAR FROM date) = $2`,
      [companyId, new Date().getFullYear()]
    );
    const avNum = parseInt(avcntRes.rows[0].cnt) + 1;
    const avcYear = new Date().getFullYear();
    const avcNumber = `AV-${avcYear}-${String(avNum).padStart(3, '0')}`;

    // Get original invoice lines
    const linesRes = await dbClient.query(
      'SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY sort_order ASC',
      [id]
    );

    // Create avoir invoice (negative amounts = reversed)
    const avcDate = new Date().toISOString().split('T')[0];
    const avcRes = await dbClient.query(
      `INSERT INTO invoices (company_id, contact_id, client_id, invoice_number, type, status, date, subtotal, tva_amount, total, tva_rate, notes, ice_client, user_id, avoir_for_invoice_id, invoice_subtype)
       VALUES ($1, $2, $3, $4, $5, 'cancelled', $6, $7, $8, $9, $10, $11, $12, $13, $14, 'avoir') RETURNING *`,
      [companyId, orig.contact_id, orig.client_id, avcNumber, orig.type, avcDate,
       -Math.abs(orig.subtotal), -Math.abs(orig.tva_amount), -Math.abs(orig.total),
       orig.tva_rate, `Avoir pour facture ${orig.invoice_number}`, orig.ice_client, req.userId, orig.id]
    );
    const avoir = avcRes.rows[0];

    // Copy invoice lines (negated)
    for (let i = 0; i < linesRes.rows.length; i++) {
      const l = linesRes.rows[i];
      await dbClient.query(
        `INSERT INTO invoice_lines (invoice_id, description, quantity, unit_price, tva_rate, tva_amount, total, account_code, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [avoir.id, l.description, l.quantity, l.unit_price, l.tva_rate, -Math.abs(l.tva_amount), -Math.abs(l.total), l.account_code, i]
      );
    }

    // Create reverse journal entry (AV journal type)
    const avcEntryNum = `AV-${avcNumber}`;
    const totalAbs = Math.abs(orig.total);
    const subtotalAbs = Math.abs(orig.subtotal);
    const tvaAmtAbs = Math.abs(orig.tva_amount);

    const avJournalRes = await dbClient.query(
      `INSERT INTO journal_entries (company_id, entry_number, date, journal_type, reference, description, source_type, source_id, total_debit, total_credit, user_id)
       VALUES ($1, $2, $3, 'AV', $4, $5, 'invoice', $6, $7, $8, $9) RETURNING id`,
      [companyId, avcEntryNum, avcDate, avcNumber, `Avoir ${avcNumber} (annulation ${orig.invoice_number})`, avoir.id, totalAbs, totalAbs, req.userId]
    );
    const avJournalId = avJournalRes.rows[0].id;

    if (orig.type === 'sale') {
      // Reverse: Credit 3421, Debit 7111, Debit 4455 (if TVA)
      await dbClient.query(
        `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order) VALUES ($1, '3421', 'Clients', 0, $2, $3, 0)`,
        [avJournalId, totalAbs, `Avoir ${avcNumber}`]
      );
      await dbClient.query(
        `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order) VALUES ($1, '7111', 'Ventes de marchandises au Maroc', $2, 0, $3, 1)`,
        [avJournalId, subtotalAbs, `Avoir ${avcNumber}`]
      );
      if (tvaAmtAbs > 0) {
        await dbClient.query(
          `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order) VALUES ($1, '4455', 'Etat - TVA facturee', $2, 0, $3, 2)`,
          [avJournalId, tvaAmtAbs, `TVA - Avoir ${avcNumber}`]
        );
      }
    } else {
      // Reverse purchase: Debit 4411, Credit 6111, Credit 3455 (if TVA)
      await dbClient.query(
        `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order) VALUES ($1, '6111', 'Achats de marchandises', 0, $2, $3, 0)`,
        [avJournalId, subtotalAbs, `Avoir ${avcNumber}`]
      );
      if (tvaAmtAbs > 0) {
        await dbClient.query(
          `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order) VALUES ($1, '3455', 'Etat - TVA recuperable', 0, $2, $3, 1)`,
          [avJournalId, tvaAmtAbs, `TVA - Avoir ${avcNumber}`]
        );
      }
      await dbClient.query(
        `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order) VALUES ($1, '4411', 'Fournisseurs', $2, 0, $3, 2)`,
        [avJournalId, totalAbs, `Avoir ${avcNumber}`]
      );
    }

    // Link avoir to journal entry
    await dbClient.query('UPDATE invoices SET journal_entry_id = $1 WHERE id = $2', [avJournalId, avoir.id]);

    // Mark original invoice as cancelled and link avoir
    await dbClient.query(
      'UPDATE invoices SET status = $1, avoir_id = $2, updated_at = NOW() WHERE id = $3',
      ['cancelled', avoir.id, id]
    );

    await dbClient.query('COMMIT');
    res.json({ invoice: { ...orig, status: 'cancelled', avoir_id: avoir.id }, avoir });
  } catch (err) {
    await dbClient.query('ROLLBACK');
    console.error('POST /api/invoices/:id/cancel error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally {
    dbClient.release();
  }
});

// ---- QUOTES (DEVIS) ----
app.get('/api/vente/quotes', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    // Auto-expire: quotes sent but past valid_until date
    await pool.query(
      `UPDATE quotes SET status = 'expiré', updated_at = NOW() WHERE company_id = $1 AND status = 'envoyé' AND valid_until IS NOT NULL AND valid_until < CURRENT_DATE`,
      [companyId]
    );
    const { status, search } = req.query;
    let query = `SELECT q.*, cl.name as client_name FROM quotes q LEFT JOIN clients cl ON q.client_id = cl.id WHERE q.company_id = $1`;
    const params = [companyId];
    if (status) { params.push(status); query += ` AND q.status = $${params.length}`; }
    if (search) { params.push(`%${search.toLowerCase()}%`); query += ` AND (LOWER(q.quote_number) LIKE $${params.length} OR LOWER(cl.name) LIKE $${params.length})`; }
    query += ' ORDER BY q.date DESC, q.id DESC';
    const result = await pool.query(query, params);
    res.json({ quotes: result.rows });
  } catch (err) {
    console.error('GET /api/vente/quotes error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/vente/quotes', requireAuth, async (req, res) => {
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    const { client_id, date, due_date, notes, lines } = req.body;
    const companyId = await getEffectiveCompanyId(req, dbClient);

    // Validate client exists
    if (!client_id) {
      await dbClient.query('ROLLBACK');
      return res.status(400).json({ error: 'client_id est requis pour créer un devis' });
    }
    const clientCheck = await dbClient.query('SELECT id FROM clients WHERE id = $1 AND company_id = $2', [client_id, companyId]);
    if (clientCheck.rows.length === 0) {
      await dbClient.query('ROLLBACK');
      return res.status(400).json({ error: 'Client introuvable' });
    }

    // Generate quote number D-YYYY-NNN
    const qcntRes = await dbClient.query(
      `SELECT COUNT(*) as cnt FROM quotes WHERE company_id = $1 AND EXTRACT(YEAR FROM date) = EXTRACT(YEAR FROM $2::date)`,
      [companyId, date || new Date().toISOString().split('T')[0]]
    );
    const qnum = parseInt(qcntRes.rows[0].cnt) + 1;
    const qyear = new Date(date || Date.now()).getFullYear();
    const quoteNumber = `D-${qyear}-${String(qnum).padStart(3, '0')}`;

    // Calculate totals
    let subtotal = 0, tvaAmount = 0;
    const validLines = (lines || []).filter(l => l.description && parseFloat(l.quantity) > 0);
    for (const l of validLines) {
      const ht = parseFloat(l.quantity) * parseFloat(l.unit_price || 0);
      const rate = parseFloat(l.tva_rate) >= 0 ? parseFloat(l.tva_rate) : 20;
      subtotal += ht;
      tvaAmount += ht * rate / 100;
    }
    const total = subtotal + tvaAmount;

    const qres = await dbClient.query(
      `INSERT INTO quotes (company_id, client_id, quote_number, date, valid_until, status, subtotal, tva_amount, total, notes)
       VALUES ($1, $2, $3, $4, $5, 'brouillon', $6, $7, $8, $9) RETURNING *`,
      [companyId, client_id, quoteNumber, date || new Date().toISOString().split('T')[0],
       due_date || null, subtotal, tvaAmount, total, notes || null]
    );
    const quote = qres.rows[0];

    for (let i = 0; i < validLines.length; i++) {
      const l = validLines[i];
      const rate = parseFloat(l.tva_rate) >= 0 ? parseFloat(l.tva_rate) : 20;
      const ht = parseFloat(l.quantity) * parseFloat(l.unit_price || 0);
      const lineTva = ht * rate / 100;
      await dbClient.query(
        `INSERT INTO quote_lines (quote_id, description, quantity, unit_price, tva_rate, total, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [quote.id, l.description, l.quantity, l.unit_price || 0, rate, ht + lineTva, i]
      );
    }

    await dbClient.query('COMMIT');
    res.json({ quote });
  } catch (err) {
    await dbClient.query('ROLLBACK');
    console.error('POST /api/vente/quotes error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally {
    dbClient.release();
  }
});

// GET single quote with lines
app.get('/api/vente/quotes/:id', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    const qres = await pool.query(
      `SELECT q.*, cl.name as client_name, cl.ice as client_ice, cl.address as client_address
       FROM quotes q LEFT JOIN clients cl ON q.client_id = cl.id
       WHERE q.id = $1 AND q.company_id = $2`,
      [req.params.id, companyId]
    );
    if (!qres.rows.length) return res.status(404).json({ error: 'Devis introuvable' });
    const lres = await pool.query(
      `SELECT * FROM quote_lines WHERE quote_id = $1 ORDER BY sort_order ASC, id ASC`,
      [req.params.id]
    );
    res.json({ quote: qres.rows[0], lines: lres.rows });
  } catch (err) {
    console.error('GET /api/vente/quotes/:id error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// UPDATE quote (only if brouillon)
app.put('/api/vente/quotes/:id', requireAuth, async (req, res) => {
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    const companyId = await getEffectiveCompanyId(req, dbClient);
    const { client_id, date, due_date, notes, lines } = req.body;
    const existing = await dbClient.query(`SELECT * FROM quotes WHERE id = $1 AND company_id = $2`, [req.params.id, companyId]);
    if (!existing.rows.length) { await dbClient.query('ROLLBACK'); return res.status(404).json({ error: 'Devis introuvable' }); }
    if (existing.rows[0].status !== 'brouillon') { await dbClient.query('ROLLBACK'); return res.status(400).json({ error: 'Seuls les devis en brouillon peuvent être modifiés' }); }

    let subtotal = 0, tvaAmount = 0;
    const validLines = (lines || []).filter(l => l.description && parseFloat(l.quantity) > 0);
    for (const l of validLines) {
      const ht = parseFloat(l.quantity) * parseFloat(l.unit_price || 0);
      const rate = parseFloat(l.tva_rate) >= 0 ? parseFloat(l.tva_rate) : 20;
      subtotal += ht;
      tvaAmount += ht * rate / 100;
    }
    const total = subtotal + tvaAmount;

    await dbClient.query(
      `UPDATE quotes SET client_id=$1, date=$2, valid_until=$3, notes=$4, subtotal=$5, tva_amount=$6, total=$7, updated_at=NOW() WHERE id=$8`,
      [client_id || existing.rows[0].client_id, date || existing.rows[0].date, due_date || null, notes || null, subtotal, tvaAmount, total, req.params.id]
    );
    await dbClient.query(`DELETE FROM quote_lines WHERE quote_id = $1`, [req.params.id]);
    for (let i = 0; i < validLines.length; i++) {
      const l = validLines[i];
      const rate = parseFloat(l.tva_rate) >= 0 ? parseFloat(l.tva_rate) : 20;
      const ht = parseFloat(l.quantity) * parseFloat(l.unit_price || 0);
      await dbClient.query(
        `INSERT INTO quote_lines (quote_id, description, quantity, unit_price, tva_rate, total, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [req.params.id, l.description, l.quantity, l.unit_price || 0, rate, ht + ht * rate / 100, i]
      );
    }
    await dbClient.query('COMMIT');
    const updated = await pool.query(`SELECT * FROM quotes WHERE id = $1`, [req.params.id]);
    res.json({ quote: updated.rows[0] });
  } catch (err) {
    await dbClient.query('ROLLBACK');
    console.error('PUT /api/vente/quotes/:id error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally {
    dbClient.release();
  }
});

// DELETE quote (only brouillon)
app.delete('/api/vente/quotes/:id', requireAuth, async (req, res) => {
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    const companyId = await getEffectiveCompanyId(req, dbClient);
    const existing = await dbClient.query(`SELECT * FROM quotes WHERE id = $1 AND company_id = $2`, [req.params.id, companyId]);
    if (!existing.rows.length) { await dbClient.query('ROLLBACK'); return res.status(404).json({ error: 'Devis introuvable' }); }
    if (existing.rows[0].status !== 'brouillon') { await dbClient.query('ROLLBACK'); return res.status(400).json({ error: 'Seuls les devis en brouillon peuvent être supprimés' }); }
    await dbClient.query(`DELETE FROM quote_lines WHERE quote_id = $1`, [req.params.id]);
    await dbClient.query(`DELETE FROM quotes WHERE id = $1`, [req.params.id]);
    await dbClient.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await dbClient.query('ROLLBACK');
    console.error('DELETE /api/vente/quotes/:id error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally {
    dbClient.release();
  }
});

// UPDATE status
app.put('/api/vente/quotes/:id/status', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    const { status } = req.body;
    const allowed = ['brouillon', 'envoyé', 'accepté', 'refusé', 'expiré'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'Statut invalide' });
    const result = await pool.query(
      `UPDATE quotes SET status=$1, updated_at=NOW() WHERE id=$2 AND company_id=$3 RETURNING *`,
      [status, req.params.id, companyId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Devis introuvable' });
    res.json({ quote: result.rows[0] });
  } catch (err) {
    console.error('PUT /api/vente/quotes/:id/status error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// CONVERT devis to invoice
app.post('/api/vente/quotes/:id/convert', requireAuth, async (req, res) => {
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    const companyId = await getEffectiveCompanyId(req, dbClient);
    const { ice } = req.body;

    const qres = await dbClient.query(
      `SELECT q.*, cl.ice as client_ice, cl.name as client_name FROM quotes q LEFT JOIN clients cl ON q.client_id = cl.id WHERE q.id = $1 AND q.company_id = $2`,
      [req.params.id, companyId]
    );
    if (!qres.rows.length) { await dbClient.query('ROLLBACK'); return res.status(404).json({ error: 'Devis introuvable' }); }
    const quote = qres.rows[0];
    if (quote.converted_to_invoice_id) { await dbClient.query('ROLLBACK'); return res.status(400).json({ error: 'Devis déjà converti' }); }
    if (!['accepté', 'envoyé'].includes(quote.status)) { await dbClient.query('ROLLBACK'); return res.status(400).json({ error: 'Le devis doit être accepté ou envoyé pour être converti' }); }

    // ICE required for invoice
    const clientIce = (ice || quote.client_ice || '').trim();
    if (!clientIce) {
      await dbClient.query('ROLLBACK');
      return res.status(422).json({ error: 'ICE_REQUIRED', message: "L'ICE client est obligatoire pour créer une facture" });
    }

    // Update client ICE if provided
    if (ice && ice.trim()) {
      await dbClient.query(`UPDATE clients SET ice = $1 WHERE id = $2 AND company_id = $3`, [ice.trim(), quote.client_id, companyId]);
    }

    // Get quote lines
    const linesRes = await dbClient.query(`SELECT * FROM quote_lines WHERE quote_id = $1 ORDER BY sort_order ASC, id ASC`, [req.params.id]);

    // Generate invoice number F-YYYY-NNN (aligned with main invoice format, scoped by company)
    const invYear = new Date(quote.date || Date.now()).getFullYear();
    const invCntRes = await dbClient.query(
      `SELECT COUNT(*) as cnt FROM invoices WHERE type = 'sale' AND EXTRACT(YEAR FROM date) = $1 AND company_id = $2 AND (invoice_subtype IS NULL OR invoice_subtype != 'avoir')`,
      [invYear, companyId]
    );
    const invNum = parseInt(invCntRes.rows[0].cnt) + 1;
    const invoiceNumber = `F-${invYear}-${String(invNum).padStart(3, '0')}`;

    // Create invoice
    const invRes = await dbClient.query(
      `INSERT INTO invoices (user_id, company_id, type, client_id, invoice_number, date, due_date, status, subtotal, tva_amount, total, notes, ice)
       VALUES ($1, $2, 'sale', $3, $4, $5, $6, 'draft', $7, $8, $9, $10, $11) RETURNING *`,
      [req.userId, companyId, quote.client_id, invoiceNumber, quote.date,
       quote.valid_until || null, quote.subtotal, quote.tva_amount, quote.total, quote.notes, clientIce]
    );
    const invoice = invRes.rows[0];

    // Copy lines
    for (let i = 0; i < linesRes.rows.length; i++) {
      const l = linesRes.rows[i];
      await dbClient.query(
        `INSERT INTO invoice_lines (invoice_id, description, quantity, unit_price, tva_rate, total, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [invoice.id, l.description, l.quantity, l.unit_price, l.tva_rate, l.total, i]
      );
    }

    // Create PCM journal entries
    const journalDate = quote.date || new Date().toISOString().split('T')[0];
    const ref = invoiceNumber;
    if (parseFloat(quote.total) > 0) {
      // 3421 Clients (debit)
      await dbClient.query(
        `INSERT INTO journal_entries (user_id, company_id, date, account_code, description, debit, credit, reference)
         VALUES ($1,$2,$3,'3421',$4,$5,0,$6)`,
        [req.userId, companyId, journalDate, `Facture ${invoiceNumber} - ${quote.client_name}`, quote.total, ref]
      );
      // 4455 TVA facturée (credit)
      if (parseFloat(quote.tva_amount) > 0) {
        await dbClient.query(
          `INSERT INTO journal_entries (user_id, company_id, date, account_code, description, debit, credit, reference)
           VALUES ($1,$2,$3,'4455',$4,0,$5,$6)`,
          [req.userId, companyId, journalDate, `TVA ${invoiceNumber}`, quote.tva_amount, ref]
        );
      }
      // 7111 Ventes produits/services (credit)
      await dbClient.query(
        `INSERT INTO journal_entries (user_id, company_id, date, account_code, description, debit, credit, reference)
         VALUES ($1,$2,$3,'7111',$4,0,$5,$6)`,
        [req.userId, companyId, journalDate, `Vente ${invoiceNumber} - ${quote.client_name}`, quote.subtotal, ref]
      );
    }

    // Mark quote as converted
    await dbClient.query(
      `UPDATE quotes SET status='accepté', converted_to_invoice_id=$1, updated_at=NOW() WHERE id=$2`,
      [invoice.id, req.params.id]
    );

    await dbClient.query('COMMIT');
    res.json({ success: true, invoice_id: invoice.id, invoice_number: invoiceNumber });
  } catch (err) {
    await dbClient.query('ROLLBACK');
    console.error('POST /api/vente/quotes/:id/convert error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally {
    dbClient.release();
  }
});

// ---- FACTURES FOURNISSEURS (EXPENSES) ----
app.get('/api/expenses', requireAuth, async (req, res) => {
  try {
    const { status, category, invoice_status, fournisseur, tva_rate, from, to, search, sort_by, sort_dir, page, per_page } = req.query;
    // Explicitly exclude document_data (can be MB-sized) but include split metadata
    const companyId = await getEffectiveCompanyId(req);
    let query = `SELECT e.id, e.company_id, e.contact_id, e.date, e.description, e.amount, e.tva_rate, e.tva_amount, e.total, e.account_code, e.payment_method, e.status, e.receipt_url, e.journal_entry_id, e.category, e.created_at, e.updated_at, e.user_id, e.invoice_status, e.fournisseur_nom, e.numero_facture, e.source, e.added_at, e.is_split, e.parent_document_id, e.document_mime_type, (e.document_data IS NOT NULL) as has_document, c.name as contact_name FROM expenses e LEFT JOIN contacts c ON e.contact_id = c.id WHERE e.company_id = $1`;
    const params = [companyId];
    // By default, hide split parent documents (they are archived after split)
    // unless caller explicitly requests them via ?show_split=true
    if (req.query.show_split !== 'true') {
      query += ` AND (e.is_split IS NULL OR e.is_split = false)`;
    }
    if (status) {
      params.push(status);
      query += ` AND e.status = $${params.length}`;
    }
    if (invoice_status) {
      // Support comma-separated multiple statuses: "a_traiter,pre_traitee"
      const statuses = invoice_status.split(',').map(s => s.trim()).filter(Boolean);
      if (statuses.length === 1) {
        params.push(statuses[0]);
        query += ` AND e.invoice_status = $${params.length}`;
      } else if (statuses.length > 1) {
        const placeholders = statuses.map((_, i) => `$${params.length + i + 1}`).join(',');
        params.push(...statuses);
        query += ` AND e.invoice_status IN (${placeholders})`;
      }
    }
    if (category) {
      params.push(category);
      query += ` AND e.category = $${params.length}`;
    }
    if (fournisseur) {
      params.push(`%${fournisseur}%`);
      query += ` AND (COALESCE(e.fournisseur_nom, c.name, '') ILIKE $${params.length})`;
    }
    if (tva_rate) {
      if (tva_rate === 'multitaux') {
        // skip — complex, handled client-side
      } else if (tva_rate === 'aucune') {
        params.push(0);
        query += ` AND e.tva_rate = $${params.length}`;
      } else {
        params.push(parseFloat(tva_rate));
        query += ` AND e.tva_rate = $${params.length}`;
      }
    }
    if (from) {
      params.push(from);
      query += ` AND e.date >= $${params.length}`;
    }
    if (to) {
      params.push(to);
      query += ` AND e.date <= $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      query += ` AND (e.description ILIKE $${params.length} OR COALESCE(e.fournisseur_nom,'') ILIKE $${params.length} OR COALESCE(e.numero_facture,'') ILIKE $${params.length} OR COALESCE(c.name,'') ILIKE $${params.length})`;
    }

    // Sorting
    const allowedSortCols = { date: 'e.date', fournisseur: 'COALESCE(e.fournisseur_nom, c.name)', montant: 'e.total', tva: 'e.tva_rate', ajout: 'e.added_at', invoice_status: 'e.invoice_status' };
    const sortCol = allowedSortCols[sort_by] || 'e.date';
    const sortDir = sort_dir === 'asc' ? 'ASC' : 'DESC';
    query += ` ORDER BY ${sortCol} ${sortDir}, e.id DESC`;

    // Pagination
    const limit = Math.min(parseInt(per_page) || 50, 100);
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;
    params.push(limit);
    query += ` LIMIT $${params.length}`;
    params.push(offset);
    query += ` OFFSET $${params.length}`;

    const result = await pool.query(query, params);

    // Count total (for pagination) — reuse same WHERE filters, strip ORDER BY/LIMIT/OFFSET
    const countFilterParams = params.slice(0, params.length - 2);
    const countWhereStart = query.indexOf(' WHERE ');
    const countOrderStart = query.indexOf(' ORDER BY ');
    const whereBody = countOrderStart > 0
      ? query.slice(countWhereStart, countOrderStart)
      : query.slice(countWhereStart);
    const countQueryStr = `SELECT COUNT(*) as total FROM expenses e LEFT JOIN contacts c ON e.contact_id = c.id${whereBody}`;

    const countResult = await pool.query(countQueryStr, countFilterParams);
    const total = parseInt(countResult.rows[0].total);

    res.json({ expenses: result.rows, total, page: Math.max(parseInt(page) || 1, 1), per_page: limit });
  } catch (err) {
    console.error('GET /api/expenses error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/expenses', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { contact_id, date, description, amount, tva_rate, account_code, payment_method, category, fournisseur_nom, numero_facture, source, invoice_status } = req.body;
    if (!description || !amount) {
      return res.status(400).json({ error: 'Description et montant sont requis' });
    }

    const companyId = await getEffectiveCompanyId(req, client);

    const rate = parseFloat(tva_rate) || 20;
    const amt = parseFloat(amount);
    const tvaAmount = amt * rate / 100;
    const total = amt + tvaAmount;
    const accCode = account_code || '6111';
    // Manual entry → always 'traitee' (it has a journal entry); imports handled by import-multi endpoint
    const invStatus = invoice_status || 'traitee';
    const expSource = source || 'saisie_manuelle';

    const expenseResult = await client.query(
      `INSERT INTO expenses (company_id, contact_id, date, description, amount, tva_rate, tva_amount, total, account_code, payment_method, category, status, user_id, invoice_status, fournisseur_nom, numero_facture, source, added_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'approved', $12, $13, $14, $15, $16, NOW()) RETURNING *`,
      [companyId, contact_id || null, date || new Date().toISOString().split('T')[0], description, amt, rate, tvaAmount, total, accCode, payment_method || 'virement', category || null, req.userId, invStatus, fournisseur_nom || null, numero_facture || null, expSource]
    );
    const expense = expenseResult.rows[0];

    // Create journal entry for expense
    const countResult = await client.query(
      `SELECT COUNT(*) as cnt FROM journal_entries WHERE journal_type = 'AC' AND user_id = $1`,
      [req.userId]
    );
    const entryNum = `DEP-${new Date(date || Date.now()).getFullYear()}-${String(parseInt(countResult.rows[0].cnt) + 1).padStart(4, '0')}`;

    const accResult = await client.query('SELECT name FROM pcm_accounts WHERE code = $1', [accCode]);
    const accName = accResult.rows.length > 0 ? accResult.rows[0].name : 'Charge';

    const journalResult = await client.query(
      `INSERT INTO journal_entries (company_id, entry_number, date, journal_type, reference, description, source_type, source_id, total_debit, total_credit, user_id)
       VALUES ($1, $2, $3, 'AC', $4, $5, 'expense', $6, $7, $8, $9) RETURNING id`,
      [companyId, entryNum, date || new Date().toISOString().split('T')[0], entryNum, description, expense.id, total, total, req.userId]
    );
    const journalId = journalResult.rows[0].id;

    await client.query(
      `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order)
       VALUES ($1, $2, $3, $4, 0, $5, 0)`,
      [journalId, accCode, accName, amt, description]
    );

    if (tvaAmount > 0) {
      await client.query(
        `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order)
         VALUES ($1, '3455', 'Etat - TVA recuperable', $2, 0, $3, 1)`,
        [journalId, tvaAmount, `TVA ${rate}%`]
      );
    }

    const paymentAccount = payment_method === 'especes' ? '5161' : '5141';
    const paymentName = payment_method === 'especes' ? 'Caisse' : 'Banques (solde debiteur)';
    await client.query(
      `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order)
       VALUES ($1, $2, $3, 0, $4, $5, 2)`,
      [journalId, paymentAccount, paymentName, total, description]
    );

    await client.query('UPDATE expenses SET journal_entry_id = $1 WHERE id = $2', [journalId, expense.id]);

    await client.query('COMMIT');
    res.json({ expense: { ...expense, journal_entry_id: journalId } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/expenses error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally {
    client.release();
  }
});

// ---- MULTI-FILE IMPORT: Factures Fournisseurs ----
// Accepts array of { file_data, filename } — runs OCR on each, creates expense records
app.post('/api/expenses/import-multi', requireAuth, async (req, res) => {
  try {
    const { files } = req.body; // [{ file_data: "data:...", filename: "facture.pdf" }]
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'Aucun fichier fourni' });
    }
    if (files.length > 25) {
      return res.status(400).json({ error: 'Maximum 25 fichiers par import' });
    }

    const companyId = await getEffectiveCompanyId(req, null);
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
    });

    const results = [];

    for (const file of files) {
      const { file_data, ocr_data, filename } = file;
      console.log(`[import-multi] Processing file: ${filename}, file_data=${file_data ? Math.round(file_data.length/1024) + 'KB' : 'null'}, ocr_data=${ocr_data ? Math.round(ocr_data.length/1024) + 'KB' : 'null'}`);
      if (!file_data || !file_data.startsWith('data:')) {
        console.log(`[import-multi] ${filename}: invalid format, skipping`);
        results.push({ filename: filename || 'inconnu', success: false, error: 'Format invalide' });
        continue;
      }

      // Size check
      if (file_data.length > 4_000_000) {
        console.log(`[import-multi] ${filename}: too large (${Math.round(file_data.length/1024)}KB), skipping`);
        results.push({ filename, success: false, error: 'Fichier trop volumineux (max 3MB)' });
        continue;
      }

      // Use compressed ocr_data for OpenAI if available, otherwise fall back to file_data
      const ocrPayload = ocr_data && ocr_data.startsWith('data:image/') ? ocr_data : file_data;
      const ocrPayloadSizeKB = Math.round(ocrPayload.length / 1024);
      console.log(`[import-multi] ${filename}: OCR payload=${ocrPayloadSizeKB}KB (${ocr_data ? 'compressed' : 'original'})`);

      let extracted = null;
      let ocrSuccess = false;

      // Run OCR — enhanced prompt for full extraction
      const prompt = `Tu es un expert-comptable marocain. Analyse cette facture fournisseur et extrais TOUTES les informations disponibles au format JSON strict (sans markdown, sans commentaires, uniquement le JSON brut):
{
  "fournisseur_nom": "raison sociale ou nom du fournisseur (obligatoire)",
  "fournisseur_ice": "ICE du fournisseur (15 chiffres) si visible, sinon null",
  "numero_facture": "numero de la facture si visible, sinon null",
  "date_facture": "YYYY-MM-DD (date d'emission) si visible, sinon null",
  "date_echeance": "YYYY-MM-DD (date d'echeance/paiement) si visible, sinon null",
  "description": "objet ou libelle global de la facture",
  "lignes": [
    {
      "description": "description du produit ou service",
      "quantite": 1,
      "prix_unitaire_ht": 100.00,
      "tva_rate": 20,
      "compte_pcm": "6111"
    }
  ],
  "total_ht": 100.00,
  "total_tva": 20.00,
  "total_ttc": 120.00,
  "tva_rates": [20],
  "suggested_account": "6111"
}

REGLES IMPORTANTES:
- Extrais le nom COMPLET du fournisseur (raison sociale, pas juste le logo)
- L'ICE au Maroc = 15 chiffres, souvent precede de "ICE:" ou "I.C.E" ou "I.C.E N°"
- Si plusieurs taux de TVA sont presents dans la facture, mets TOUS les taux dans "tva_rates" (ex: [20, 14, 7])
- Le "total_tva" doit etre le montant TOTAL de TVA, meme si plusieurs taux
- Comptes PCM classes 6 courants: 6111=achats marchandises, 6121=matieres premieres, 6125=locations, 6131=frais transport, 6141=fournitures entretien, 6142=prestataires services, 6143=honoraires, 6145=frais juridiques, 6151=fournitures bureau, 6161=assurances, 6171=telecoms, 6181=documentation, 6191=publicite, 6200=autres charges ext., 6311=interets emprunts, 6581=penalites, 6171=travaux services
- Choisis le "suggested_account" en fonction du contenu de la facture (type d'achat/service)
- Si une valeur n'est pas visible, utilise null
- Les montants doivent etre des nombres, pas des chaines
Reponds UNIQUEMENT avec le JSON.`;

      try {
        // Skip OCR if payload is too large for proxy (~100KB limit)
        if (ocrPayloadSizeKB > 90) {
          console.warn(`[import-multi] ${filename}: OCR payload too large (${ocrPayloadSizeKB}KB > 90KB proxy limit), skipping OCR`);
        } else {
          let response;
          for (const detail of ['auto', 'low']) {
            try {
              console.log(`[import-multi] ${filename}: OCR attempt detail=${detail}, payload=${ocrPayloadSizeKB}KB`);
              response = await openai.chat.completions.create({
                model: 'gpt-4o',
                messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: ocrPayload, detail } }, { type: 'text', text: prompt }] }],
                max_tokens: 1500
              });
              console.log(`[import-multi] ${filename}: OCR success with detail=${detail}`);
              break;
            } catch (retryErr) {
              console.error(`[import-multi] ${filename}: OCR failed detail=${detail}: ${retryErr.message} (status=${retryErr.status})`);
              if (retryErr.status !== 500) throw retryErr;
            }
          }
          if (response) {
            const rawText = response.choices[0]?.message?.content || '{}';
            try {
              const cleaned = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
              extracted = JSON.parse(cleaned);
              // Validate we got meaningful data
              ocrSuccess = !!(extracted.fournisseur_nom || extracted.total_ttc || extracted.total_ht);
              console.log(`[import-multi] ${filename}: OCR extracted fournisseur=${extracted.fournisseur_nom}, ttc=${extracted.total_ttc}, success=${ocrSuccess}`);
            } catch (e) {
              console.warn(`[import-multi] ${filename}: OCR JSON parse failed: ${e.message}`);
            }
          } else {
            console.warn(`[import-multi] ${filename}: OCR returned no response (all attempts failed)`);
          }
        }
      } catch (ocrErr) {
        console.error(`[import-multi] OCR failed for ${filename}:`, ocrErr.message);
        // Not fatal — record created as a_traiter
      }

      // Determine invoice_status
      const invStatus = ocrSuccess ? 'pre_traitee' : 'a_traiter';

      // Extract data from OCR result
      const fournisseurNom = extracted?.fournisseur_nom || null;
      const fournisseurIce = extracted?.fournisseur_ice || null;
      const numeroFacture = extracted?.numero_facture || null;
      const dateFacture = extracted?.date_facture || new Date().toISOString().split('T')[0];
      const dateEcheance = extracted?.date_echeance || null;
      const totalHt = parseFloat(extracted?.total_ht) || 0;
      const totalTva = parseFloat(extracted?.total_tva) || 0;
      const totalTtc = parseFloat(extracted?.total_ttc) || (totalHt + totalTva);

      // Multitaux detection: if multiple TVA rates found, use -1 to signal "Multitaux"
      const tvaRates = Array.isArray(extracted?.tva_rates) ? extracted.tva_rates : [];
      const isMultitaux = tvaRates.length > 1;
      let tvaRate;
      if (isMultitaux) {
        tvaRate = -1; // signals "Multitaux" in the frontend
      } else if (tvaRates.length === 1) {
        tvaRate = parseFloat(tvaRates[0]) || 20;
      } else if (totalHt > 0 && totalTva > 0) {
        tvaRate = Math.round((totalTva / totalHt) * 100);
      } else {
        tvaRate = 20;
      }

      // Build description from OCR description, first line, or filename
      const ocrDescription = extracted?.description || null;
      const firstLine = extracted?.lignes?.[0]?.description;
      const description = ocrDescription || firstLine || (fournisseurNom ? `Facture ${fournisseurNom}` : (filename || 'Facture importee'));

      // Account code: use OCR suggested_account, or first line's compte_pcm, or default
      let accountCode = extracted?.suggested_account || extracted?.lignes?.[0]?.compte_pcm || '6111';

      // Supplier memory: if fournisseur is known, reuse their last account_code
      if (fournisseurNom) {
        try {
          const knownSupplier = await pool.query(
            `SELECT account_code FROM expenses
             WHERE company_id = $1 AND fournisseur_nom ILIKE $2
             AND invoice_status = 'traitee' AND account_code IS NOT NULL
             ORDER BY updated_at DESC NULLS LAST, created_at DESC LIMIT 1`,
            [companyId, fournisseurNom.trim()]
          );
          if (knownSupplier.rows.length > 0 && knownSupplier.rows[0].account_code) {
            accountCode = knownSupplier.rows[0].account_code;
          }
        } catch (e) {
          // non-fatal — use OCR suggestion
        }
      }

      // Detect MIME type from data URI
      const mimeMatch = file_data.match(/^data:([^;]+);base64,/);
      const mimeType = mimeMatch ? mimeMatch[1] : 'application/octet-stream';

      // Save to DB (including original document for PDF splitting)
      try {
        const insertResult = await pool.query(
          `INSERT INTO expenses (company_id, date, description, amount, tva_rate, tva_amount, total, account_code, payment_method, status, user_id, invoice_status, fournisseur_nom, numero_facture, source, added_at, document_data, document_mime_type, supplier_ice, date_echeance)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'virement', 'pending', $9, $10, $11, $12, 'import_ocr', NOW(), $13, $14, $15, $16) RETURNING id`,
          [companyId, dateFacture, description, totalHt || totalTtc, tvaRate, totalTva, totalTtc || totalHt, accountCode, req.userId, invStatus, fournisseurNom, numeroFacture, file_data, mimeType, fournisseurIce, dateEcheance]
        );
        console.log(`[import-multi] ${filename}: saved as expense #${insertResult.rows[0].id}, status=${invStatus}`);
        results.push({
          filename,
          success: true,
          expense_id: insertResult.rows[0].id,
          invoice_status: invStatus,
          fournisseur_nom: fournisseurNom,
          numero_facture: numeroFacture,
          total_ttc: totalTtc
        });
      } catch (dbErr) {
        console.error(`DB insert failed for ${filename}:`, dbErr.message);
        results.push({ filename, success: false, error: 'Erreur base de donnees' });
      }
    }

    const successCount = results.filter(r => r.success).length;
    const pretraiteeCount = results.filter(r => r.success && r.invoice_status === 'pre_traitee').length;
    console.log(`[import-multi] Complete: ${files.length} files, ${successCount} success (${pretraiteeCount} pre_traitee, ${successCount - pretraiteeCount} a_traiter), ${files.length - successCount} failed`);
    res.json({
      results,
      summary: {
        total: files.length,
        success: successCount,
        failed: files.length - successCount,
        pre_traitee: pretraiteeCount,
        a_traiter: successCount - pretraiteeCount
      }
    });
  } catch (err) {
    console.error('POST /api/expenses/import-multi error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PATCH /api/expenses/:id/status — update invoice_status
app.patch('/api/expenses/:id/status', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    const { invoice_status } = req.body;
    const allowed = ['a_traiter', 'pre_traitee', 'traitee'];
    if (!allowed.includes(invoice_status)) {
      return res.status(400).json({ error: 'Statut invalide' });
    }
    const result = await pool.query(
      `UPDATE expenses SET invoice_status = $1 WHERE id = $2 AND company_id = $3 RETURNING id`,
      [invoice_status, req.params.id, companyId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Facture non trouvee' });
    res.json({ success: true });
  } catch (err) {
    console.error('PATCH /api/expenses/:id/status error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/expenses/:id
app.delete('/api/expenses/:id', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const companyId = await getEffectiveCompanyId(req, client);
    await client.query('BEGIN');
    // Get journal_entry_id to cascade delete
    const exp = await client.query(`SELECT journal_entry_id FROM expenses WHERE id=$1 AND company_id=$2`, [req.params.id, companyId]);
    if (exp.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Facture non trouvee' }); }
    const jeId = exp.rows[0].journal_entry_id;
    if (jeId) {
      // Check if journal entry is locked (fiscal year closed)
      const lockedCheck = await client.query(`SELECT is_locked FROM journal_entries WHERE id=$1`, [jeId]);
      if (lockedCheck.rows.length > 0 && lockedCheck.rows[0].is_locked) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Cette écriture est verrouillée (exercice clôturé). Impossible de la supprimer.' });
      }
      await client.query(`DELETE FROM journal_entry_lines WHERE journal_entry_id=$1`, [jeId]);
      await client.query(`DELETE FROM journal_entries WHERE id=$1`, [jeId]);
    }
    await client.query(`DELETE FROM expenses WHERE id=$1 AND company_id=$2`, [req.params.id, companyId]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('DELETE /api/expenses/:id error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally {
    client.release();
  }
});

// ---- PDF DOCUMENT RETRIEVAL ----
// GET /api/expenses/:id/document — returns the stored document (base64 data URI)
app.get('/api/expenses/:id/document', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    const result = await pool.query(
      `SELECT id, document_data, document_mime_type, is_split, parent_document_id
       FROM expenses WHERE id=$1 AND company_id=$2`,
      [req.params.id, companyId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Facture non trouvée' });
    const row = result.rows[0];
    if (!row.document_data) return res.status(404).json({ error: 'Aucun document stocké pour cette facture' });
    res.json({
      document_data: row.document_data,
      mime_type: row.document_mime_type,
      is_split: row.is_split,
      parent_document_id: row.parent_document_id
    });
  } catch (err) {
    console.error('GET /api/expenses/:id/document error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ---- SINGLE EXPENSE GET / UPDATE / VALIDER ----
// GET /api/expenses/:id — get full expense record (no document_data)
app.get('/api/expenses/:id', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    const result = await pool.query(
      `SELECT e.id, e.company_id, e.contact_id, e.date, e.description, e.amount, e.tva_rate, e.tva_amount, e.total, e.account_code, e.payment_method, e.status, e.receipt_url, e.journal_entry_id, e.category, e.created_at, e.updated_at, e.user_id, e.invoice_status, e.fournisseur_nom, e.numero_facture, e.source, e.added_at, e.is_split, e.parent_document_id, e.document_mime_type, (e.document_data IS NOT NULL) as has_document, e.supplier_ice, e.date_echeance, c.name as contact_name FROM expenses e LEFT JOIN contacts c ON e.contact_id = c.id WHERE e.id = $1 AND e.company_id = $2`,
      [req.params.id, companyId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Facture non trouvée' });
    // Also fetch ventilation lines
    const linesResult = await pool.query(
      `SELECT id, account_code, account_label, amount_ht, tva_rate, amount_tva, sort_order FROM supplier_invoice_lines WHERE invoice_id = $1 ORDER BY sort_order`,
      [req.params.id]
    );
    res.json({ expense: result.rows[0], lines: linesResult.rows });
  } catch (err) {
    console.error('GET /api/expenses/:id error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/expenses/:id — update expense fields + ventilation lines (pre-validation save)
app.put('/api/expenses/:id', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { fournisseur_nom, numero_facture, date, account_code, tva_rate, tva_rate_label, amount, tva_amount, total, description, supplier_ice, date_echeance, lines } = req.body;
    const companyId = await getEffectiveCompanyId(req, client);
    const result = await client.query(
      `UPDATE expenses SET
        fournisseur_nom = CASE WHEN $1::text IS NOT NULL THEN $1 ELSE fournisseur_nom END,
        numero_facture  = CASE WHEN $2::text IS NOT NULL THEN $2 ELSE numero_facture END,
        date            = CASE WHEN $3::text IS NOT NULL THEN $3::date ELSE date END,
        account_code    = CASE WHEN $4::text IS NOT NULL THEN $4 ELSE account_code END,
        tva_rate        = CASE WHEN $5::text IS NOT NULL THEN $5::numeric ELSE tva_rate END,
        amount          = CASE WHEN $6::text IS NOT NULL THEN $6::numeric ELSE amount END,
        tva_amount      = CASE WHEN $7::text IS NOT NULL THEN $7::numeric ELSE tva_amount END,
        total           = CASE WHEN $8::text IS NOT NULL THEN $8::numeric ELSE total END,
        description     = CASE WHEN $9::text IS NOT NULL THEN $9 ELSE description END,
        supplier_ice    = CASE WHEN $12::text IS NOT NULL THEN $12 ELSE supplier_ice END,
        date_echeance   = CASE WHEN $13::text IS NOT NULL THEN $13::date ELSE date_echeance END,
        tva_rate_label  = CASE WHEN $14::text IS NOT NULL THEN $14 ELSE tva_rate_label END,
        invoice_status  = CASE WHEN invoice_status = 'a_traiter' THEN 'pre_traitee' ELSE invoice_status END,
        updated_at      = NOW()
       WHERE id = $10 AND company_id = $11 RETURNING *`,
      [
        fournisseur_nom  !== undefined ? String(fournisseur_nom)  : null,
        numero_facture   !== undefined ? String(numero_facture)   : null,
        date             !== undefined ? String(date)             : null,
        account_code     !== undefined ? String(account_code)     : null,
        tva_rate         !== undefined ? String(tva_rate)         : null,
        amount           !== undefined ? String(amount)           : null,
        tva_amount       !== undefined ? String(tva_amount)       : null,
        total            !== undefined ? String(total)            : null,
        description      !== undefined ? String(description)      : null,
        req.params.id,
        companyId,
        supplier_ice    !== undefined ? String(supplier_ice)    : null,
        date_echeance   !== undefined ? String(date_echeance)   : null,
        tva_rate_label  !== undefined ? String(tva_rate_label)  : null
      ]
    );
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Facture non trouvée' });
    }
    // Save ventilation lines if provided
    if (Array.isArray(lines)) {
      await client.query('DELETE FROM supplier_invoice_lines WHERE invoice_id = $1', [req.params.id]);
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        const accRes = await client.query('SELECT name FROM pcm_accounts WHERE code = $1 LIMIT 1', [l.account_code]);
        const accLabel = l.account_label || (accRes.rows.length > 0 ? accRes.rows[0].name : '');
        await client.query(
          `INSERT INTO supplier_invoice_lines (invoice_id, account_code, account_label, amount_ht, tva_rate, amount_tva, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [req.params.id, l.account_code || '6111', accLabel, parseFloat(l.amount_ht) || 0, parseFloat(l.tva_rate) || 0, parseFloat(l.amount_tva) || 0, i]
        );
      }
    }
    await client.query('COMMIT');
    res.json({ expense: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PUT /api/expenses/:id error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally {
    client.release();
  }
});

// POST /api/expenses/:id/valider — create HA journal entry + mark traitée (supports multi-line ventilation)
app.post('/api/expenses/:id/valider', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const companyId = await getEffectiveCompanyId(req, client);
    const expResult = await client.query(
      `SELECT * FROM expenses WHERE id=$1 AND company_id=$2`,
      [req.params.id, companyId]
    );
    if (expResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Facture non trouvée' });
    }
    const exp = expResult.rows[0];
    if (exp.invoice_status === 'traitee') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Facture déjà validée' });
    }

    // Accept form updates passed alongside validation
    const { fournisseur_nom, numero_facture, date, account_code, tva_rate, tva_rate_label, amount, tva_amount, total, description, supplier_ice, date_echeance, lines } = req.body;
    const finalAccCode      = account_code    || exp.account_code    || '6111';
    const finalDate         = date            || (exp.date ? (typeof exp.date === 'string' ? exp.date.split('T')[0] : new Date(exp.date).toISOString().split('T')[0]) : new Date().toISOString().split('T')[0]);
    const finalAmount       = parseFloat(amount    !== undefined ? amount    : exp.amount)    || 0;
    const finalTvaRate      = parseFloat(tva_rate  !== undefined ? tva_rate  : exp.tva_rate)  || 0;
    const finalTvaAmount    = parseFloat(tva_amount !== undefined ? tva_amount : exp.tva_amount) || 0;
    const finalTotal        = parseFloat(total !== undefined ? total : exp.total) || (finalAmount + finalTvaAmount);
    const finalFournisseur  = (fournisseur_nom !== undefined ? fournisseur_nom : exp.fournisseur_nom) || 'Fournisseur';
    const finalIce          = supplier_ice !== undefined ? supplier_ice : exp.supplier_ice;
    const finalEcheance     = date_echeance || exp.date_echeance || null;
    const finalNumFacture   = (numero_facture  !== undefined ? numero_facture  : exp.numero_facture)  || '';
    const finalDesc         = (description     !== undefined ? description     : exp.description)     || `Facture ${finalFournisseur}${finalNumFacture ? ' - ' + finalNumFacture : ''}`;
    const finalTvaRateLabel = tva_rate_label !== undefined ? tva_rate_label : (exp.tva_rate_label || null);

    // Persist final field values
    await client.query(
      `UPDATE expenses SET fournisseur_nom=$1, numero_facture=$2, date=$3::date, account_code=$4, tva_rate=$5, tva_rate_label=$6, amount=$7, tva_amount=$8, total=$9, description=$10 WHERE id=$11`,
      [finalFournisseur, finalNumFacture, finalDate, finalAccCode, finalTvaRate, finalTvaRateLabel, finalAmount, finalTvaAmount, finalTotal, finalDesc, exp.id]
    );

    // Save ventilation lines if provided
    const ventilationLines = Array.isArray(lines) && lines.length > 0 ? lines : null;
    if (ventilationLines) {
      await client.query('DELETE FROM supplier_invoice_lines WHERE invoice_id = $1', [exp.id]);
      for (let i = 0; i < ventilationLines.length; i++) {
        const l = ventilationLines[i];
        const accRes = await client.query('SELECT name FROM pcm_accounts WHERE code = $1 LIMIT 1', [l.account_code]);
        const accLabel = l.account_label || (accRes.rows.length > 0 ? accRes.rows[0].name : '');
        await client.query(
          `INSERT INTO supplier_invoice_lines (invoice_id, account_code, account_label, amount_ht, tva_rate, amount_tva, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [exp.id, l.account_code || '6111', accLabel, parseFloat(l.amount_ht) || 0, parseFloat(l.tva_rate) || 0, parseFloat(l.amount_tva) || 0, i]
        );
      }
    }

    // Journal entry number
    const countResult = await client.query(
      `SELECT COUNT(*) as cnt FROM journal_entries WHERE journal_type = 'AC' AND user_id = $1`,
      [req.userId]
    );
    const entryYear = new Date(finalDate).getFullYear();
    const entryNum  = `HA-${entryYear}-${String(parseInt(countResult.rows[0].cnt) + 1).padStart(4, '0')}`;

    // Insert journal entry header
    const journalResult = await client.query(
      `INSERT INTO journal_entries (company_id, entry_number, date, journal_type, reference, description, source_type, source_id, total_debit, total_credit, user_id)
       VALUES ($1, $2, $3::date, 'AC', $4, $5, 'expense', $6, $7, $8, $9) RETURNING id`,
      [companyId, entryNum, finalDate, entryNum, finalDesc, exp.id, finalTotal, finalTotal, req.userId]
    );
    const journalId = journalResult.rows[0].id;

    let sortOrder = 0;
    if (ventilationLines && ventilationLines.length > 1) {
      // Multi-line: one charge debit + one TVA debit per line, one global credit 4411
      for (const l of ventilationLines) {
        const ht = parseFloat(l.amount_ht) || 0;
        const tva = parseFloat(l.amount_tva) || 0;
        const lRate = parseFloat(l.tva_rate) || 0;
        if (ht <= 0) continue;
        const lCode = l.account_code || '6111';
        const accRes = await client.query('SELECT name FROM pcm_accounts WHERE code = $1 LIMIT 1', [lCode]);
        const lName = l.account_label || (accRes.rows.length > 0 ? accRes.rows[0].name : 'Charges');
        // Debit: charge account
        await client.query(
          `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order) VALUES ($1,$2,$3,$4,0,$5,$6)`,
          [journalId, lCode, lName, ht, finalDesc, sortOrder++]
        );
        // Debit: TVA déductible (if TVA > 0)
        if (tva > 0) {
          await client.query(
            `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order) VALUES ($1,'3455','État - TVA récupérable',$2,0,$3,$4)`,
            [journalId, tva, `TVA ${lRate}%`, sortOrder++]
          );
        }
      }
    } else {
      // Simple single-line: charge HT debit
      const accResult = await client.query('SELECT name FROM pcm_accounts WHERE code = $1 LIMIT 1', [finalAccCode]);
      const accName   = accResult.rows.length > 0 ? accResult.rows[0].name : 'Charges';
      await client.query(
        `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order) VALUES ($1,$2,$3,$4,0,$5,$6)`,
        [journalId, finalAccCode, accName, finalAmount, finalDesc, sortOrder++]
      );
      if (finalTvaAmount > 0) {
        await client.query(
          `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order) VALUES ($1,'3455','État - TVA récupérable',$2,0,$3,$4)`,
          [journalId, finalTvaAmount, `TVA ${finalTvaRate}%`, sortOrder++]
        );
      }
    }

    // Credit 4411 Fournisseur (TTC) — always single credit line
    await client.query(
      `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order, tiers_id, tiers_name) VALUES ($1,'4411',$2,0,$3,$4,$5,$6,$7)`,
      [journalId, `Fournisseurs - ${finalFournisseur}`, finalTotal, finalDesc, sortOrder++, exp.contact_id || null, finalFournisseur || null]
    );

    // Mark expense as traitée + save form fields
    await client.query(
      `UPDATE expenses SET invoice_status='traitee', journal_entry_id=$1,
       fournisseur_nom=COALESCE($3, fournisseur_nom),
       numero_facture=COALESCE($4, numero_facture),
       date=COALESCE($5::date, date),
       account_code=COALESCE($6, account_code),
       tva_rate=$7, amount=$8, tva_amount=$9, total=$10,
       description=COALESCE($11, description),
       supplier_ice=COALESCE($12, supplier_ice),
       date_echeance=COALESCE($13::date, date_echeance),
       updated_at=NOW()
       WHERE id=$2`,
      [journalId, exp.id,
       fournisseur_nom || null, numero_facture || null,
       finalDate, finalAccCode,
       finalTvaRate, finalAmount, finalTvaAmount, finalTotal,
       description || null, finalIce || null, finalEcheance]
    );

    await client.query('COMMIT');
    res.json({ success: true, journal_entry_id: journalId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/expenses/:id/valider error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally {
    client.release();
  }
});

// ---- PDF SPLIT ENDPOINT ----
// POST /api/expenses/:id/split — extract page groups into separate expense records
app.post('/api/expenses/:id/split', requireAuth, async (req, res) => {
  try {
    const { segments } = req.body;
    // segments: [{ pages: [1, 2] }, { pages: [3, 4, 5] }, ...]
    if (!Array.isArray(segments) || segments.length < 1) {
      return res.status(400).json({ error: 'Au moins un segment requis' });
    }
    if (segments.length > 50) {
      return res.status(400).json({ error: 'Maximum 50 segments par découpage' });
    }

    const companyId = await getEffectiveCompanyId(req, null);

    // Fetch parent expense
    const parentRes = await pool.query(
      `SELECT * FROM expenses WHERE id=$1 AND company_id=$2`,
      [req.params.id, companyId]
    );
    if (parentRes.rows.length === 0) return res.status(404).json({ error: 'Facture non trouvée' });
    const parent = parentRes.rows[0];

    if (!parent.document_data) {
      return res.status(400).json({ error: 'Ce document n\'a pas de fichier source stocké. Réimportez la facture.' });
    }
    if (parent.document_mime_type !== 'application/pdf') {
      return res.status(400).json({ error: 'Seuls les fichiers PDF peuvent être découpés' });
    }

    // Load PDF with pdf-lib
    const base64Data = parent.document_data.split(',')[1];
    const pdfBytes = Buffer.from(base64Data, 'base64');
    const srcPdf = await PDFDocument.load(pdfBytes);
    const totalPages = srcPdf.getPageCount();

    // Validate all segments
    for (const seg of segments) {
      if (!Array.isArray(seg.pages) || seg.pages.length === 0) {
        return res.status(400).json({ error: 'Chaque segment doit contenir au moins une page' });
      }
      for (const p of seg.pages) {
        if (!Number.isInteger(p) || p < 1 || p > totalPages) {
          return res.status(400).json({ error: `Page ${p} invalide (document: ${totalPages} pages)` });
        }
      }
    }

    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
    });

    const OCR_PROMPT = `Tu es un expert-comptable marocain. Analyse cette facture fournisseur et extrais TOUTES les informations au format JSON strict (sans markdown, uniquement le JSON brut):
{"fournisseur_nom":"raison sociale","fournisseur_ice":"ICE 15 chiffres ou null","numero_facture":"numero ou null","date_facture":"YYYY-MM-DD ou null","date_echeance":"YYYY-MM-DD ou null","description":"objet global","lignes":[{"description":"...","quantite":1,"prix_unitaire_ht":0,"tva_rate":20,"compte_pcm":"6111"}],"total_ht":0,"total_tva":0,"total_ttc":0,"tva_rates":[20],"suggested_account":"6111"}
Comptes PCM: 6111=achats marchandises, 6121=matieres premieres, 6125=locations, 6131=transport, 6141=fournitures entretien, 6142=prestataires, 6143=honoraires, 6151=fournitures bureau, 6161=assurances, 6171=telecoms, 6191=publicite, 6200=autres charges. Si plusieurs taux TVA, mettre tous dans tva_rates. Montants en nombres. Reponds UNIQUEMENT avec le JSON.`;

    const created = [];

    // Process each segment in parallel (OCR)
    const segmentJobs = segments.map(async (seg) => {
      // Extract pages into new PDF
      const newPdf = await PDFDocument.create();
      const zeroIndexed = seg.pages.map(p => p - 1);
      const copiedPages = await newPdf.copyPages(srcPdf, zeroIndexed);
      copiedPages.forEach(p => newPdf.addPage(p));
      const newPdfBytes = await newPdf.save();
      const newPdfBase64 = `data:application/pdf;base64,${Buffer.from(newPdfBytes).toString('base64')}`;

      // Run OCR on segment
      let extracted = null;
      let ocrSuccess = false;
      try {
        let response;
        for (const detail of ['auto', 'low']) {
          try {
            response = await openai.chat.completions.create({
              model: 'gpt-4o',
              messages: [{ role: 'user', content: [
                { type: 'image_url', image_url: { url: newPdfBase64, detail } },
                { type: 'text', text: OCR_PROMPT }
              ]}],
              max_tokens: 1500
            });
            break;
          } catch (retryErr) {
            if (retryErr.status !== 500) throw retryErr;
          }
        }
        if (response) {
          const raw = response.choices[0]?.message?.content || '{}';
          try {
            const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            extracted = JSON.parse(cleaned);
            ocrSuccess = !!(extracted.fournisseur_nom || extracted.total_ttc || extracted.total_ht);
          } catch (_) {}
        }
      } catch (ocrErr) {
        console.error(`OCR failed for split segment (pages ${seg.pages.join(',')}):`, ocrErr.message);
      }

      const invStatus = ocrSuccess ? 'pre_traitee' : 'a_traiter';
      const fournisseurNom = extracted?.fournisseur_nom || parent.fournisseur_nom || null;
      const fournisseurIce = extracted?.fournisseur_ice || parent.supplier_ice || null;
      const numeroFacture = extracted?.numero_facture || null;
      const dateFacture = extracted?.date_facture || parent.date;
      const dateEcheance = extracted?.date_echeance || null;
      const totalHt = parseFloat(extracted?.total_ht) || 0;
      const totalTva = parseFloat(extracted?.total_tva) || 0;
      const totalTtc = parseFloat(extracted?.total_ttc) || (totalHt + totalTva);
      const splitTvaRates = Array.isArray(extracted?.tva_rates) ? extracted.tva_rates : [];
      const splitMultitaux = splitTvaRates.length > 1;
      let tvaRate;
      if (splitMultitaux) {
        tvaRate = -1;
      } else if (splitTvaRates.length === 1) {
        tvaRate = parseFloat(splitTvaRates[0]) || 20;
      } else if (totalHt > 0 && totalTva > 0) {
        tvaRate = Math.round((totalTva / totalHt) * 100);
      } else {
        tvaRate = 20;
      }
      const ocrDesc = extracted?.description || null;
      const firstLine = extracted?.lignes?.[0]?.description;
      const description = ocrDesc || firstLine || (fournisseurNom ? `Facture ${fournisseurNom}` : `Découpage — pages ${seg.pages.join('-')}`);
      const accountCode = extracted?.suggested_account || extracted?.lignes?.[0]?.compte_pcm || parent.account_code || '6111';

      const insertRes = await pool.query(
        `INSERT INTO expenses
           (company_id, date, description, amount, tva_rate, tva_amount, total,
            account_code, payment_method, status, user_id, invoice_status,
            fournisseur_nom, numero_facture, source, added_at,
            document_data, document_mime_type, parent_document_id,
            supplier_ice, date_echeance)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'virement','pending',$9,$10,$11,$12,'import_ocr',NOW(),$13,'application/pdf',$14,$15,$16)
         RETURNING id`,
        [
          companyId, dateFacture, description,
          totalHt || totalTtc, tvaRate, totalTva, totalTtc || totalHt,
          accountCode, req.userId,
          invStatus, fournisseurNom, numeroFacture,
          newPdfBase64, req.params.id,
          fournisseurIce, dateEcheance
        ]
      );

      return {
        id: insertRes.rows[0].id,
        invoice_status: invStatus,
        fournisseur_nom: fournisseurNom,
        pages: seg.pages
      };
    });

    const segmentResults = await Promise.all(segmentJobs);
    created.push(...segmentResults);

    // Mark parent as split (hides it from active listing)
    await pool.query(
      `UPDATE expenses SET is_split=true WHERE id=$1`,
      [req.params.id]
    );

    res.json({
      created,
      parent_id: parseInt(req.params.id),
      message: `${created.length} facture${created.length > 1 ? 's créées' : ' créée'} depuis le découpage`
    });
  } catch (err) {
    console.error('POST /api/expenses/:id/split error:', err.message);
    res.status(500).json({ error: 'Erreur serveur: ' + err.message });
  }
});

// ---- JOURNAL ENTRIES ----
app.get('/api/journal-entries', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Aucune entreprise sélectionnée' });

    const { journal_type, from, to, account_code, page, per_page } = req.query;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const perPage = Math.min(200, Math.max(1, parseInt(per_page) || 50));
    const offset = (pageNum - 1) * perPage;

    let whereClause = 'WHERE company_id = $1';
    const params = [companyId];

    if (journal_type) {
      params.push(journal_type);
      whereClause += ` AND journal_type = $${params.length}`;
    }
    if (from) {
      params.push(from);
      whereClause += ` AND date >= $${params.length}`;
    }
    if (to) {
      params.push(to);
      whereClause += ` AND date <= $${params.length}`;
    }
    if (account_code) {
      params.push(account_code);
      whereClause += ` AND id IN (SELECT journal_entry_id FROM journal_entry_lines WHERE account_code = $${params.length})`;
    }

    // Count total
    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM journal_entries ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].total);

    // Paginated data
    const dataParams = [...params, perPage, offset];
    const result = await pool.query(
      `SELECT * FROM journal_entries ${whereClause}
       ORDER BY date DESC, id DESC
       LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    );

    res.json({
      entries: result.rows,
      pagination: {
        page: pageNum,
        per_page: perPage,
        total,
        total_pages: Math.ceil(total / perPage)
      }
    });
  } catch (err) {
    console.error('GET /api/journal-entries error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/journal-entries/:id', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Aucune entreprise sélectionnée' });

    const { id } = req.params;
    const entryResult = await pool.query('SELECT * FROM journal_entries WHERE id = $1 AND company_id = $2', [id, companyId]);
    if (entryResult.rows.length === 0) return res.status(404).json({ error: 'Ecriture non trouvee' });

    const linesResult = await pool.query(
      'SELECT * FROM journal_entry_lines WHERE journal_entry_id = $1 ORDER BY sort_order ASC',
      [id]
    );

    res.json({ entry: entryResult.rows[0], lines: linesResult.rows });
  } catch (err) {
    console.error('GET /api/journal-entries/:id error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Manual journal entry (OD - Operations Diverses)
app.post('/api/journal-entries', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { date, description, reference, lines, journal_type: rawJournalType, status: rawStatus } = req.body;
    if (!lines || lines.length < 2) {
      return res.status(400).json({ error: 'Minimum 2 lignes requises' });
    }

    // Validate journal_type
    const validJournalTypes = ['AC', 'VE', 'BQ', 'CA', 'OD', 'RAN', 'AN', 'PA', 'VT', 'AT', 'TR'];
    const journalType = validJournalTypes.includes(rawJournalType) ? rawJournalType : 'OD';

    // Validate status
    const validStatuses = ['brouillon', 'validé'];
    const entryStatus = validStatuses.includes(rawStatus) ? rawStatus : 'validé';

    let totalDebit = 0, totalCredit = 0;
    for (const line of lines) {
      totalDebit += parseFloat(line.debit) || 0;
      totalCredit += parseFloat(line.credit) || 0;
    }

    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      return res.status(400).json({ error: `Écriture non équilibrée : Débit=${totalDebit.toFixed(2)} Crédit=${totalCredit.toFixed(2)}` });
    }

    const companyId = await getEffectiveCompanyId(req, client);

    // Block creation of entries in a locked (closed) fiscal year
    const entryDate = date || new Date().toISOString().split('T')[0];
    const lockedFyCheck = await client.query(
      `SELECT id, label FROM fiscal_years WHERE company_id = $1 AND status = 'cloture' AND $2::date BETWEEN start_date AND end_date`,
      [companyId, entryDate]
    );
    if (lockedFyCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: `Impossible de créer une écriture sur l'exercice clôturé : ${lockedFyCheck.rows[0].label}` });
    }

    // Generate sequential entry number per journal type and company
    const countResult = await client.query(
      `SELECT COUNT(*) as cnt FROM journal_entries WHERE journal_type = $1 AND company_id = $2`,
      [journalType, companyId]
    );
    const entryNum = `${journalType}-${new Date(entryDate).getFullYear()}-${String(parseInt(countResult.rows[0].cnt) + 1).padStart(4, '0')}`;

    const entryResult = await client.query(
      `INSERT INTO journal_entries (company_id, entry_number, date, journal_type, reference, description, total_debit, total_credit, user_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [companyId, entryNum, entryDate, journalType, reference || null, description || 'Écriture comptable', totalDebit, totalCredit, req.userId, entryStatus]
    );
    const entry = entryResult.rows[0];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.account_code) continue;
      const accResult = await client.query('SELECT name FROM pcm_accounts WHERE code = $1', [line.account_code]);
      const accName = accResult.rows.length > 0 ? accResult.rows[0].name : (line.account_label || line.account_code);

      await client.query(
        `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [entry.id, line.account_code, accName, parseFloat(line.debit) || 0, parseFloat(line.credit) || 0, line.description || line.label || '', i]
      );
    }

    await client.query('COMMIT');
    res.json({ entry });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/journal-entries error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally {
    client.release();
  }
});

// ---- DASHBOARD ----
app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Aucune entreprise sélectionnée' });

    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().getMonth() + 1;
    const startOfYear = `${currentYear}-01-01`;
    const endOfYear = `${currentYear}-12-31`;
    const startOfMonth = `${currentYear}-${String(currentMonth).padStart(2, '0')}-01`;

    console.log('[DASHBOARD] userId=%s companyId=%s year=%d month=%d', req.userId, companyId, currentYear, currentMonth);

    // Safe number helpers — never return NaN
    const safeFloat = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
    const safeInt = (v) => { const n = parseInt(v, 10); return isNaN(n) ? 0 : n; };

    // Named query helper for diagnostics
    const runQ = async (name, sql, params) => {
      try { return await pool.query(sql, params); }
      catch (e) { console.error('[DASHBOARD] Query "%s" failed: %s', name, e.message); throw e; }
    };

    const [
      revenueResult,
      expenseResult,
      monthRevenueResult,
      monthExpenseResult,
      unpaidInvoicesResult,
      recentEntriesResult,
      invoiceCountResult,
      tvaResult
    ] = await Promise.all([
      runQ('revenue_year',
        `SELECT COALESCE(SUM(total), 0) as total FROM invoices WHERE type = 'sale' AND status != 'cancelled' AND date >= $2 AND date <= $3 AND company_id = $1`,
        [companyId, startOfYear, endOfYear]),
      runQ('expenses_year',
        `SELECT COALESCE(SUM(total), 0) as total FROM expenses WHERE status != 'cancelled' AND date >= $2 AND date <= $3 AND company_id = $1`,
        [companyId, startOfYear, endOfYear]),
      runQ('revenue_month',
        `SELECT COALESCE(SUM(total), 0) as total FROM invoices WHERE type = 'sale' AND status != 'cancelled' AND date >= $2 AND date <= $3 AND company_id = $1`,
        [companyId, startOfMonth, endOfYear]),
      runQ('expenses_month',
        `SELECT COALESCE(SUM(total), 0) as total FROM expenses WHERE status != 'cancelled' AND date >= $2 AND date <= $3 AND company_id = $1`,
        [companyId, startOfMonth, endOfYear]),
      runQ('unpaid_invoices',
        `SELECT COUNT(*) as count, COALESCE(SUM(total), 0) as total FROM invoices WHERE type = 'sale' AND status IN ('sent', 'overdue') AND company_id = $1`,
        [companyId]),
      runQ('recent_entries',
        `SELECT je.*, (SELECT json_agg(jel ORDER BY jel.sort_order) FROM journal_entry_lines jel WHERE jel.journal_entry_id = je.id) as lines
         FROM journal_entries je WHERE je.company_id = $1 ORDER BY je.date DESC, je.id DESC LIMIT 10`,
        [companyId]),
      runQ('invoice_count',
        `SELECT COUNT(*) as count FROM invoices WHERE company_id = $1`,
        [companyId]),
      runQ('tva_year',
        `SELECT
           COALESCE(SUM(CASE WHEN i.type = 'sale' THEN i.tva_amount ELSE 0 END), 0) as tva_collectee,
           COALESCE(SUM(CASE WHEN i.type = 'purchase' THEN i.tva_amount ELSE 0 END), 0) as tva_deductible_invoices
         FROM invoices i WHERE i.status != 'cancelled' AND i.date >= $2 AND i.date <= $3 AND i.company_id = $1`,
        [companyId, startOfYear, endOfYear])
    ]);

    const tvaExpenseResult = await runQ('tva_expense_year',
      `SELECT COALESCE(SUM(tva_amount), 0) as tva_deductible FROM expenses WHERE status != 'cancelled' AND date >= $2 AND date <= $3 AND company_id = $1`,
      [companyId, startOfYear, endOfYear]);

    // Additional KPI queries: monthly CA (12 months), créances details, TVA mensuelle, top5, N-1
    const now = new Date();
    const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    const twelveMonthsAgoStr = twelveMonthsAgo.toISOString().split('T')[0];
    const prevYear = currentYear - 1;
    const startOfPrevYear = `${prevYear}-01-01`;
    const endOfPrevYear = `${prevYear}-12-31`;

    const [monthlyCaResult, creancesKpiResult, tvaMoisResult, tvaMoisExpResult, monthlyExpResult, recentInvoicesResult, top5ClientsResult, top5ChargesResult, revN1Result, expN1Result] = await Promise.all([
      runQ('monthly_ca',
        `SELECT EXTRACT(MONTH FROM date)::int as month, EXTRACT(YEAR FROM date)::int as year, COALESCE(SUM(total),0) as revenue
         FROM invoices WHERE type='sale' AND status!='cancelled' AND date>=$2 AND company_id=$1
         GROUP BY EXTRACT(YEAR FROM date), EXTRACT(MONTH FROM date) ORDER BY year, month`,
        [companyId, twelveMonthsAgoStr]),
      runQ('creances_kpi',
        `SELECT
           COUNT(*) FILTER (WHERE due_date IS NOT NULL AND CURRENT_DATE - due_date::date > 30) as overdue_30_count,
           COALESCE(SUM(CASE WHEN due_date IS NOT NULL AND CURRENT_DATE - due_date::date > 30 THEN total ELSE 0 END), 0) as overdue_30_total,
           COALESCE(AVG(CASE WHEN due_date IS NOT NULL THEN GREATEST(0, CURRENT_DATE - due_date::date) ELSE 0 END), 0)::int as avg_delay
         FROM invoices WHERE type='sale' AND status IN ('sent','overdue') AND company_id=$1`,
        [companyId]),
      runQ('tva_month',
        `SELECT COALESCE(SUM(CASE WHEN type='sale' THEN tva_amount ELSE 0 END),0) as tva_collectee,
                COALESCE(SUM(CASE WHEN type='purchase' THEN tva_amount ELSE 0 END),0) as tva_deductible
         FROM invoices WHERE status!='cancelled' AND date>=$2 AND company_id=$1`,
        [companyId, startOfMonth]),
      runQ('tva_month_exp',
        `SELECT COALESCE(SUM(tva_amount),0) as tva_deductible_exp FROM expenses WHERE status!='cancelled' AND date>=$2 AND company_id=$1`,
        [companyId, startOfMonth]),
      runQ('monthly_exp',
        `SELECT EXTRACT(MONTH FROM date)::int as month, EXTRACT(YEAR FROM date)::int as year, COALESCE(SUM(total),0) as expenses
         FROM expenses WHERE status!='cancelled' AND date>=$2 AND company_id=$1
         GROUP BY EXTRACT(YEAR FROM date), EXTRACT(MONTH FROM date) ORDER BY year, month`,
        [companyId, twelveMonthsAgoStr]),
      runQ('recent_invoices',
        `SELECT i.invoice_number, i.date, i.total, i.status, i.type, COALESCE(c.name, '') as contact_name
         FROM invoices i LEFT JOIN contacts c ON c.id = i.contact_id
         WHERE i.company_id=$1 AND i.status != 'cancelled'
         ORDER BY i.date DESC, i.id DESC LIMIT 5`,
        [companyId]),
      runQ('top5_clients',
        `SELECT COALESCE(c.name, 'Divers') as client_name, COALESCE(SUM(i.total), 0) as ca
         FROM invoices i LEFT JOIN contacts c ON c.id = i.contact_id
         WHERE i.type='sale' AND i.status!='cancelled' AND i.date>=$2 AND i.date<=$3 AND i.company_id=$1
         GROUP BY c.name ORDER BY ca DESC LIMIT 5`,
        [companyId, startOfYear, endOfYear]),
      runQ('top5_charges',
        `SELECT COALESCE(category, 'Autres') as category, COALESCE(SUM(total), 0) as total
         FROM expenses WHERE status!='cancelled' AND date>=$2 AND date<=$3 AND company_id=$1
         GROUP BY category ORDER BY total DESC LIMIT 5`,
        [companyId, startOfYear, endOfYear]),
      runQ('rev_n1',
        `SELECT COALESCE(SUM(total), 0) as total FROM invoices WHERE type='sale' AND status!='cancelled' AND date>=$2 AND date<=$3 AND company_id=$1`,
        [companyId, startOfPrevYear, endOfPrevYear]),
      runQ('exp_n1',
        `SELECT COALESCE(SUM(total), 0) as total FROM expenses WHERE status!='cancelled' AND date>=$2 AND date<=$3 AND company_id=$1`,
        [companyId, startOfPrevYear, endOfPrevYear])
    ]);

    // Build monthly CA array (last 12 months, filling gaps with 0)
    const monthlyCa = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const m = d.getMonth() + 1;
      const y = d.getFullYear();
      const revRow = monthlyCaResult.rows.find(r => r.month === m && r.year === y);
      const expRow = monthlyExpResult.rows.find(r => r.month === m && r.year === y);
      monthlyCa.push({ month: m, year: y, revenue: safeFloat(revRow?.revenue), expenses: safeFloat(expRow?.expenses) });
    }

    // Trésorerie prévisionnelle: average monthly result over last 3 months × 3 months ahead
    const last3 = monthlyCa.slice(-3);
    const avgMonthlyResult = last3.length > 0
      ? last3.reduce((s, x) => s + (x.revenue - x.expenses), 0) / last3.length
      : 0;

    const tvaCollectee = safeFloat(tvaResult.rows[0]?.tva_collectee);
    const tvaDeductible = safeFloat(tvaResult.rows[0]?.tva_deductible_invoices) + safeFloat(tvaExpenseResult.rows[0]?.tva_deductible);
    const tvaDue = tvaCollectee - tvaDeductible;

    const tvaMoisCollectee = safeFloat(tvaMoisResult.rows[0]?.tva_collectee);
    const tvaMoisDeductible = safeFloat(tvaMoisResult.rows[0]?.tva_deductible) + safeFloat(tvaMoisExpResult.rows[0]?.tva_deductible_exp);

    console.log('[DASHBOARD] OK — sending response');
    res.json({
      revenue_year: safeFloat(revenueResult.rows[0]?.total),
      expenses_year: safeFloat(expenseResult.rows[0]?.total),
      revenue_month: safeFloat(monthRevenueResult.rows[0]?.total),
      expenses_month: safeFloat(monthExpenseResult.rows[0]?.total),
      profit_year: safeFloat(revenueResult.rows[0]?.total) - safeFloat(expenseResult.rows[0]?.total),
      unpaid_invoices_count: safeInt(unpaidInvoicesResult.rows[0]?.count),
      unpaid_invoices_total: safeFloat(unpaidInvoicesResult.rows[0]?.total),
      total_invoices: safeInt(invoiceCountResult.rows[0]?.count),
      tva_collectee: tvaCollectee,
      tva_deductible: tvaDeductible,
      tva_due: tvaDue,
      recent_entries: recentEntriesResult.rows || [],
      year: currentYear,
      month: currentMonth,
      // New KPI fields
      monthly_ca: monthlyCa,
      creances_avg_delay: safeInt(creancesKpiResult.rows[0]?.avg_delay),
      overdue_30_count: safeInt(creancesKpiResult.rows[0]?.overdue_30_count),
      overdue_30_total: safeFloat(creancesKpiResult.rows[0]?.overdue_30_total),
      tva_mois_collectee: tvaMoisCollectee,
      tva_mois_deductible: tvaMoisDeductible,
      tva_mois_estimee: tvaMoisCollectee - tvaMoisDeductible,
      recent_invoices: recentInvoicesResult.rows || [],
      // Gestion view extras
      top5_clients: top5ClientsResult.rows || [],
      top5_charges: top5ChargesResult.rows || [],
      revenue_n1: safeFloat(revN1Result.rows[0]?.total),
      expenses_n1: safeFloat(expN1Result.rows[0]?.total),
      profit_n1: safeFloat(revN1Result.rows[0]?.total) - safeFloat(expN1Result.rows[0]?.total),
      treso_prev: avgMonthlyResult * 3
    });
  } catch (err) {
    console.error('GET /api/dashboard error:', err.stack || err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ---- DASHBOARD COMPTABILITE KPIs ----
app.get('/api/dashboard/comptabilite', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Aucune entreprise sélectionnée' });

    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().getMonth() + 1;
    const startOfMonth = `${currentYear}-${String(currentMonth).padStart(2, '0')}-01`;
    const startOfYear = `${currentYear}-01-01`;
    const endOfYear = `${currentYear}-12-31`;

    const safeFloat = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
    const safeInt = (v) => { const n = parseInt(v, 10); return isNaN(n) ? 0 : n; };

    const [lettrageStatsResult, nonLettreesResult, derniereOdResult, tvaMoisResult, tvaMoisExpResult, ecrituresAttentePResult] = await Promise.all([
      // % lettrage: lettered lines / total lettrable lines (accounts 4x, 3x, 5x)
      pool.query(
        `SELECT
           COUNT(*) as total_lines,
           COUNT(*) FILTER (WHERE lettrage_code IS NOT NULL AND lettrage_code != '') as lettered_lines
         FROM journal_entry_lines jel
         JOIN journal_entries je ON je.id = jel.journal_entry_id
         WHERE je.company_id = $1
           AND (jel.account_code LIKE '3%' OR jel.account_code LIKE '4%' OR jel.account_code LIKE '5%')`,
        [companyId]),
      // Écritures non lettrées (tiers accounts 4x with debit/credit > 0)
      pool.query(
        `SELECT COUNT(DISTINCT je.id) as count
         FROM journal_entries je
         JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
         WHERE je.company_id = $1
           AND (jel.account_code LIKE '4%')
           AND (jel.lettrage_code IS NULL OR jel.lettrage_code = '')`,
        [companyId]),
      // Dernière OD (journal_type = 'OD')
      pool.query(
        `SELECT je.id, je.entry_number, je.date, je.description, je.total_debit
         FROM journal_entries je
         WHERE je.company_id = $1 AND je.journal_type = 'OD'
         ORDER BY je.date DESC, je.id DESC LIMIT 1`,
        [companyId]),
      // TVA mois collectée/déductible (invoices)
      pool.query(
        `SELECT COALESCE(SUM(CASE WHEN type='sale' THEN tva_amount ELSE 0 END),0) as tva_collectee,
                COALESCE(SUM(CASE WHEN type='purchase' THEN tva_amount ELSE 0 END),0) as tva_deductible
         FROM invoices WHERE status!='cancelled' AND date>=$2 AND company_id=$1`,
        [companyId, startOfMonth]),
      // TVA mois déductible (expenses)
      pool.query(
        `SELECT COALESCE(SUM(tva_amount),0) as tva_deductible_exp FROM expenses WHERE status!='cancelled' AND date>=$2 AND company_id=$1`,
        [companyId, startOfMonth]),
      // Écritures en attente (this month with no associated invoice/expense — OD only)
      pool.query(
        `SELECT COUNT(*) as count FROM journal_entries
         WHERE company_id=$1 AND date>=$2 AND journal_type='OD'`,
        [companyId, startOfMonth])
    ]);

    const totalLines = safeInt(lettrageStatsResult.rows[0]?.total_lines);
    const letteredLines = safeInt(lettrageStatsResult.rows[0]?.lettered_lines);
    const lettragePct = totalLines > 0 ? Math.round((letteredLines / totalLines) * 100) : 0;

    const tvaMoisCollectee = safeFloat(tvaMoisResult.rows[0]?.tva_collectee);
    const tvaMoisDeductible = safeFloat(tvaMoisResult.rows[0]?.tva_deductible) + safeFloat(tvaMoisExpResult.rows[0]?.tva_deductible_exp);

    res.json({
      lettrage_pct: lettragePct,
      lettered_lines: letteredLines,
      total_lettrable_lines: totalLines,
      ecritures_non_lettrees: safeInt(nonLettreesResult.rows[0]?.count),
      derniere_od: derniereOdResult.rows[0] || null,
      tva_mois_collectee: tvaMoisCollectee,
      tva_mois_deductible: tvaMoisDeductible,
      tva_mois_estimee: tvaMoisCollectee - tvaMoisDeductible,
      ecritures_attente: safeInt(ecrituresAttentePResult.rows[0]?.count),
      month: currentMonth,
      year: currentYear
    });
  } catch (err) {
    console.error('GET /api/dashboard/comptabilite error:', err.stack || err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ---- CLIENT DASHBOARD (standard users) ----

// Helper: compute next Moroccan fiscal deadlines
function computeMoroccanDeadlines(now) {
  const year = now.getFullYear();
  const deadlines = [];

  // TVA mensuelle: 20th of next month
  const nextMonthDate = new Date(now.getFullYear(), now.getMonth() + 1, 20);
  if (nextMonthDate > now) {
    deadlines.push({ label: 'TVA mensuelle', date: nextMonthDate.toISOString().split('T')[0], type: 'tva', daysLeft: Math.ceil((nextMonthDate - now) / 86400000) });
  }

  // TVA trimestrielle: 20 avril, 20 juillet, 20 octobre, 20 janvier next year
  [new Date(year,3,20), new Date(year,6,20), new Date(year,9,20), new Date(year+1,0,20)].forEach(d => {
    if (d > now) deadlines.push({ label: 'TVA trimestrielle', date: d.toISOString().split('T')[0], type: 'tva_tri', daysLeft: Math.ceil((d - now) / 86400000) });
  });

  // IS acomptes: 31 mars, 30 juin, 30 sep, 31 dec
  [
    { label: 'IS — 1er acompte', date: new Date(year,2,31) },
    { label: 'IS — 2e acompte', date: new Date(year,5,30) },
    { label: 'IS — 3e acompte', date: new Date(year,8,30) },
    { label: 'IS — 4e acompte', date: new Date(year,11,31) },
  ].forEach(item => {
    if (item.date > now) deadlines.push({ label: item.label, date: item.date.toISOString().split('T')[0], type: 'is', daysLeft: Math.ceil((item.date - now) / 86400000) });
  });

  // IR: 30 avril
  const ir = new Date(year, 3, 30);
  if (ir > now) deadlines.push({ label: 'Déclaration IR', date: ir.toISOString().split('T')[0], type: 'ir', daysLeft: Math.ceil((ir - now) / 86400000) });

  deadlines.sort((a, b) => new Date(a.date) - new Date(b.date));
  return deadlines.slice(0, 5);
}

// GET /api/client/dashboard — simplified KPIs for standard users
app.get('/api/client/dashboard', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(404).json({ error: 'Aucune entreprise trouvée' });

    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const startOfMonth = `${year}-${String(month).padStart(2,'0')}-01`;
    const startOfYear = `${year}-01-01`;
    const endOfYear = `${year}-12-31`;
    const sixMonthsAgo = new Date(now);
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
    sixMonthsAgo.setDate(1);
    const sixMonthsAgoStr = sixMonthsAgo.toISOString().split('T')[0];

    const [revMonth, expMonth, revYear, expYear, unpaid, monthlyRev, monthlyExp, unpaidList] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(total),0) as total FROM invoices WHERE type='sale' AND status!='cancelled' AND date>=$1 AND company_id=$2`, [startOfMonth, companyId]),
      pool.query(`SELECT COALESCE(SUM(total),0) as total FROM expenses WHERE status!='cancelled' AND date>=$1 AND company_id=$2`, [startOfMonth, companyId]),
      pool.query(`SELECT COALESCE(SUM(total),0) as total FROM invoices WHERE type='sale' AND status!='cancelled' AND date>=$1 AND date<=$2 AND company_id=$3`, [startOfYear, endOfYear, companyId]),
      pool.query(`SELECT COALESCE(SUM(total),0) as total FROM expenses WHERE status!='cancelled' AND date>=$1 AND date<=$2 AND company_id=$3`, [startOfYear, endOfYear, companyId]),
      pool.query(`SELECT COUNT(*) as count, COALESCE(SUM(total),0) as total FROM invoices WHERE type='sale' AND status IN ('sent','overdue') AND company_id=$1`, [companyId]),
      pool.query(`SELECT EXTRACT(MONTH FROM date)::int as month, EXTRACT(YEAR FROM date)::int as year, COALESCE(SUM(total),0) as revenue FROM invoices WHERE type='sale' AND status!='cancelled' AND company_id=$1 AND date>=$2 GROUP BY EXTRACT(YEAR FROM date), EXTRACT(MONTH FROM date) ORDER BY year, month`, [companyId, sixMonthsAgoStr]),
      pool.query(`SELECT EXTRACT(MONTH FROM date)::int as month, EXTRACT(YEAR FROM date)::int as year, COALESCE(SUM(total),0) as expenses FROM expenses WHERE status!='cancelled' AND company_id=$1 AND date>=$2 GROUP BY EXTRACT(YEAR FROM date), EXTRACT(MONTH FROM date) ORDER BY year, month`, [companyId, sixMonthsAgoStr]),
      pool.query(`SELECT i.invoice_number, i.date, i.due_date, i.total, c.name as client_name FROM invoices i LEFT JOIN contacts c ON c.id=i.contact_id WHERE i.type='sale' AND i.status IN ('sent','overdue') AND i.company_id=$1 ORDER BY i.due_date ASC NULLS LAST LIMIT 10`, [companyId]),
    ]);

    // Build 6-month cashflow
    const cashflow = [];
    let cumulative = 0;
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const m = d.getMonth() + 1;
      const y = d.getFullYear();
      const revRow = monthlyRev.rows.find(r => r.month === m && r.year === y);
      const expRow = monthlyExp.rows.find(r => r.month === m && r.year === y);
      const rev = parseFloat(revRow?.revenue || 0);
      const exp = parseFloat(expRow?.expenses || 0);
      cumulative += rev - exp;
      cashflow.push({ month: m, year: y, revenue: rev, expenses: exp, balance: cumulative });
    }

    // Compute days overdue for unpaid invoices
    const unpaidInvoices = unpaidList.rows.map(inv => {
      const daysOverdue = inv.due_date ? Math.max(0, Math.ceil((now - new Date(inv.due_date)) / 86400000)) : 0;
      return { ...inv, days_overdue: daysOverdue };
    });

    res.json({
      revenue_month: parseFloat(revMonth.rows[0].total),
      expenses_month: parseFloat(expMonth.rows[0].total),
      revenue_year: parseFloat(revYear.rows[0].total),
      expenses_year: parseFloat(expYear.rows[0].total),
      cashflow_ytd: parseFloat(revYear.rows[0].total) - parseFloat(expYear.rows[0].total),
      unpaid_count: parseInt(unpaid.rows[0].count),
      unpaid_total: parseFloat(unpaid.rows[0].total),
      cashflow_monthly: cashflow,
      unpaid_invoices: unpaidInvoices,
      fiscal_deadlines: computeMoroccanDeadlines(now),
      year, month
    });
  } catch (err) {
    console.error('GET /api/client/dashboard error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ---- OCR: EXTRACT INVOICE DATA FROM IMAGE/PDF ----
app.post('/api/ocr/invoice', requireAuth, ocrRateLimit, async (req, res) => {
  try {
    const { file_data, filename } = req.body;
    if (!file_data) return res.status(400).json({ error: 'Fichier requis' });

    // Validate it looks like a data URL
    if (!file_data.startsWith('data:')) {
      return res.status(400).json({ error: 'Format de fichier invalide' });
    }

    // Log payload size for debugging
    const payloadSizeKB = Math.round(file_data.length / 1024);
    console.log(`OCR request: file=${filename}, payload=${payloadSizeKB}KB`);

    // Reject overly large payloads that will fail at the proxy
    if (file_data.length > 4_000_000) {
      return res.status(400).json({ error: 'Image trop volumineuse pour l\'OCR. Reessayez avec une image plus petite ou un PDF.' });
    }

    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
    });

    const prompt = `Tu es un expert-comptable marocain. Analyse cette facture fournisseur et extrais TOUTES les informations disponibles au format JSON strict (sans markdown, sans commentaires, uniquement le JSON brut):
{
  "fournisseur_nom": "raison sociale ou nom du fournisseur (obligatoire)",
  "fournisseur_ice": "ICE du fournisseur (15 chiffres) si visible, sinon null",
  "numero_facture": "numero de la facture si visible, sinon null",
  "date_facture": "YYYY-MM-DD (date d'emission) si visible, sinon null",
  "date_echeance": "YYYY-MM-DD (date d'echeance/paiement) si visible, sinon null",
  "description": "objet ou libelle global de la facture",
  "lignes": [
    {
      "description": "description du produit ou service",
      "quantite": 1,
      "prix_unitaire_ht": 100.00,
      "tva_rate": 20,
      "compte_pcm": "6111"
    }
  ],
  "total_ht": 100.00,
  "total_tva": 20.00,
  "total_ttc": 120.00,
  "tva_rates": [20],
  "suggested_account": "6111"
}

REGLES IMPORTANTES:
- Extrais le nom COMPLET du fournisseur (raison sociale, pas juste le logo)
- L'ICE au Maroc = 15 chiffres, souvent precede de "ICE:" ou "I.C.E" ou "I.C.E N°"
- Si plusieurs taux de TVA sont presents dans la facture, mets TOUS les taux dans "tva_rates" (ex: [20, 14, 7])
- Le "total_tva" doit etre le montant TOTAL de TVA, meme si plusieurs taux
- Comptes PCM classes 6 courants: 6111=achats marchandises, 6121=matieres premieres, 6125=locations, 6131=frais transport, 6141=fournitures entretien, 6142=prestataires services, 6143=honoraires, 6145=frais juridiques, 6151=fournitures bureau, 6161=assurances, 6171=telecoms, 6181=documentation, 6191=publicite, 6200=autres charges ext.
- Choisis le "suggested_account" en fonction du contenu de la facture
- Si une valeur n'est pas visible, utilise null
- Les montants doivent etre des nombres, pas des chaines
Reponds UNIQUEMENT avec le JSON.`;

    // Try with detail: auto first, retry with detail: low if proxy fails
    let response;
    let lastErr;
    for (const detail of ['auto', 'low']) {
      try {
        console.log(`OCR attempt: detail=${detail}, payload=${payloadSizeKB}KB`);
        response = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [{
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: file_data,
                  detail
                }
              },
              { type: 'text', text: prompt }
            ]
          }],
          max_tokens: 2000
        });
        break; // success — exit retry loop
      } catch (retryErr) {
        lastErr = retryErr;
        console.error(`OCR attempt detail=${detail} failed:`, retryErr.message, JSON.stringify({ status: retryErr.status, code: retryErr.code }));
        if (retryErr.status !== 500) throw retryErr; // only retry on 500
      }
    }

    if (!response) {
      // Both attempts failed
      throw lastErr;
    }

    const rawText = response.choices[0]?.message?.content || '{}';
    let extracted = {};
    try {
      const cleaned = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      extracted = JSON.parse(cleaned);
    } catch (e) {
      // Return raw text for debugging
      return res.json({ extracted: {}, raw: rawText, parse_error: e.message });
    }

    res.json({ extracted });
  } catch (err) {
    console.error('POST /api/ocr/invoice error:', err.message);
    console.error('OCR error details:', JSON.stringify({ status: err.status, code: err.code, type: err.type, error: err.error, response: err.response?.body }));
    const userMsg = err.status === 500
      ? 'Le service OCR est temporairement indisponible. Reessayez dans quelques instants.'
      : ('Erreur OCR: ' + (err.message || 'Erreur inconnue'));
    res.status(err.status === 500 ? 503 : 500).json({ error: userMsg });
  }
});

// ---- INVOICE ATTACHMENTS ----
app.post('/api/invoices/:id/attachment', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { file_data, filename } = req.body;

    const inv = await pool.query('SELECT id FROM invoices WHERE id = $1 AND user_id = $2', [id, req.userId]);
    if (inv.rows.length === 0) return res.status(404).json({ error: 'Facture non trouvee' });

    if (!file_data) return res.status(400).json({ error: 'Fichier requis' });

    // ~10MB base64 limit
    if (file_data.length > 14_000_000) {
      return res.status(400).json({ error: 'Fichier trop volumineux (max 10MB)' });
    }

    const contentType = (file_data.match(/data:([^;]+)/) || [])[1] || 'application/octet-stream';

    // Replace existing attachment
    await pool.query('DELETE FROM invoice_attachments WHERE invoice_id = $1', [id]);

    const result = await pool.query(
      'INSERT INTO invoice_attachments (invoice_id, filename, content_type, file_data) VALUES ($1, $2, $3, $4) RETURNING id, filename, created_at',
      [id, filename || 'facture', contentType, file_data]
    );

    res.json({ attachment: result.rows[0] });
  } catch (err) {
    console.error('POST /api/invoices/:id/attachment error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/invoices/:id/attachment', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const inv = await pool.query('SELECT id FROM invoices WHERE id = $1 AND user_id = $2', [id, req.userId]);
    if (inv.rows.length === 0) return res.status(404).json({ error: 'Facture non trouvee' });

    const result = await pool.query(
      'SELECT filename, content_type, file_data FROM invoice_attachments WHERE invoice_id = $1',
      [id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Aucune piece jointe' });

    const att = result.rows[0];
    res.json({ attachment: { filename: att.filename, content_type: att.content_type, file_data: att.file_data } });
  } catch (err) {
    console.error('GET /api/invoices/:id/attachment error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Check if invoice has attachment (lightweight - no file data)
app.get('/api/invoices/:id/has-attachment', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT id, filename FROM invoice_attachments WHERE invoice_id = $1',
      [id]
    );
    res.json({ has_attachment: result.rows.length > 0, filename: result.rows[0]?.filename || null });
  } catch (err) {
    console.error('GET /api/invoices/:id/has-attachment error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ---- E-INVOICE XML EXPORT ----
// GET /api/invoices/:id/export?format=UBL-2.1  → application/xml download
// GET /api/invoices/:id/export?format=CII       → application/xml download
app.get('/api/invoices/:id/export', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const format = (req.query.format || '').toString().trim();

    if (!format) {
      return res.status(400).json({ error: 'Paramètre format requis (UBL-2.1 ou CII)' });
    }

    if (!SUPPORTED_FORMATS.includes(format)) {
      return res.status(400).json({
        error: `Format e-facture inconnu: "${format}". Formats disponibles: ${SUPPORTED_FORMATS.join(', ')}`
      });
    }

    // Security: verify invoice belongs to the authenticated user
    const ownerCheck = await pool.query(
      'SELECT id, invoice_number, company_id FROM invoices WHERE id = $1 AND user_id = $2',
      [id, req.userId]
    );
    if (ownerCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Facture non trouvée' });
    }

    // Build canonical + generate XML via the einvoice lib
    const { xml, canonical } = await generateEInvoice(id, format, pool);

    // Build filename: {company}_{invoice_number}_{FORMAT}.xml
    const companySlug = (canonical.supplier.name || 'company')
      .replace(/[^a-zA-Z0-9\u00C0-\u024F]/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 50);
    const invoiceSlug = (canonical.invoiceNumber || String(id))
      .replace(/[^a-zA-Z0-9-]/g, '_');
    const filename = `${companySlug}_${invoiceSlug}_${format.replace(/[^A-Z0-9]/g, '_')}.xml`;

    res.set('Content-Type', 'application/xml; charset=UTF-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.set('X-EInvoice-Format', format);
    res.set('X-EInvoice-Formats', SUPPORTED_FORMATS.join(', '));
    res.send(xml);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'Facture non trouvée' });
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error('GET /api/invoices/:id/export error:', err.message);
    res.status(500).json({ error: err.message || 'Erreur serveur' });
  }
});

// ---- TVA DECLARATION (SIMPL-TVA) ----
app.get('/api/tva/declaration', requireAuth, async (req, res) => {
  try {
    const { year, month, quarter } = req.query;
    if (!year) return res.status(400).json({ error: 'Annee requise' });

    let dateFrom, dateTo, periodLabel;
    const y = parseInt(year);

    if (month) {
      const m = parseInt(month);
      dateFrom = `${y}-${String(m).padStart(2, '0')}-01`;
      const lastDay = new Date(y, m, 0).getDate();
      dateTo = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      const monthNames = ['Janvier','Fevrier','Mars','Avril','Mai','Juin','Juillet','Aout','Septembre','Octobre','Novembre','Decembre'];
      periodLabel = `${monthNames[m - 1]} ${y}`;
    } else if (quarter) {
      const q = parseInt(quarter);
      const startMonth = (q - 1) * 3 + 1;
      const endMonth = q * 3;
      dateFrom = `${y}-${String(startMonth).padStart(2, '0')}-01`;
      const lastDay = new Date(y, endMonth, 0).getDate();
      dateTo = `${y}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      periodLabel = `T${q} ${y}`;
    } else {
      return res.status(400).json({ error: 'Mois ou trimestre requis' });
    }

    // Fetch company info using consistent getEffectiveCompanyId pattern
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Aucune entreprise sélectionnée' });
    const companyResult = await pool.query('SELECT * FROM companies WHERE id = $1', [companyId]);
    const company = companyResult.rows[0] || {};

    // TVA collectee: per-rate from sales invoice lines
    const collecteeResult = await pool.query(`
      SELECT
        il.tva_rate,
        SUM(il.quantity * il.unit_price) as base_ht,
        SUM(il.tva_amount) as tva_amount
      FROM invoice_lines il
      JOIN invoices i ON il.invoice_id = i.id
      WHERE i.company_id = $1
        AND i.type = 'sale'
        AND i.status != 'cancelled'
        AND i.date >= $2 AND i.date <= $3
        AND il.tva_rate > 0
      GROUP BY il.tva_rate
      ORDER BY il.tva_rate DESC
    `, [companyId, dateFrom, dateTo]);

    // TVA deductible sur achats: per-rate from purchase invoice lines
    const deductibleAchatsResult = await pool.query(`
      SELECT
        il.tva_rate,
        SUM(il.quantity * il.unit_price) as base_ht,
        SUM(il.tva_amount) as tva_amount
      FROM invoice_lines il
      JOIN invoices i ON il.invoice_id = i.id
      WHERE i.company_id = $1
        AND i.type = 'purchase'
        AND i.status != 'cancelled'
        AND i.date >= $2 AND i.date <= $3
        AND il.tva_rate > 0
      GROUP BY il.tva_rate
      ORDER BY il.tva_rate DESC
    `, [companyId, dateFrom, dateTo]);

    // TVA deductible sur depenses (charges)
    const deductibleDepensesResult = await pool.query(`
      SELECT
        tva_rate,
        SUM(amount) as base_ht,
        SUM(tva_amount) as tva_amount
      FROM expenses
      WHERE company_id = $1
        AND status != 'cancelled'
        AND date >= $2 AND date <= $3
        AND tva_rate > 0
        AND tva_amount > 0
      GROUP BY tva_rate
      ORDER BY tva_rate DESC
    `, [companyId, dateFrom, dateTo]);

    // Aggregate collectee by rate
    const collecteeByRate = {};
    for (const row of collecteeResult.rows) {
      const rate = parseFloat(row.tva_rate);
      collecteeByRate[rate] = {
        base_ht: Math.floor(parseFloat(row.base_ht) * 100) / 100,
        tva: Math.floor(parseFloat(row.tva_amount))
      };
    }

    // Aggregate deductible by rate (merge achats + depenses)
    const deductibleByRate = {};
    for (const row of deductibleAchatsResult.rows) {
      const rate = parseFloat(row.tva_rate);
      deductibleByRate[rate] = {
        base_ht: Math.floor(parseFloat(row.base_ht) * 100) / 100,
        tva: Math.floor(parseFloat(row.tva_amount))
      };
    }
    for (const row of deductibleDepensesResult.rows) {
      const rate = parseFloat(row.tva_rate);
      if (deductibleByRate[rate]) {
        deductibleByRate[rate].base_ht += Math.floor(parseFloat(row.base_ht) * 100) / 100;
        deductibleByRate[rate].tva += Math.floor(parseFloat(row.tva_amount));
      } else {
        deductibleByRate[rate] = {
          base_ht: Math.floor(parseFloat(row.base_ht) * 100) / 100,
          tva: Math.floor(parseFloat(row.tva_amount))
        };
      }
    }

    // Totals
    let totalCollecteeHT = 0, totalCollecteeTVA = 0;
    for (const v of Object.values(collecteeByRate)) {
      totalCollecteeHT += v.base_ht;
      totalCollecteeTVA += v.tva;
    }

    let totalDeductibleHT = 0, totalDeductibleTVA = 0;
    for (const v of Object.values(deductibleByRate)) {
      totalDeductibleHT += v.base_ht;
      totalDeductibleTVA += v.tva;
    }

    const tvaDue = Math.floor(totalCollecteeTVA - totalDeductibleTVA);

    res.json({
      period: periodLabel,
      date_from: dateFrom,
      date_to: dateTo,
      company,
      collectee: collecteeByRate,
      deductible: deductibleByRate,
      total_collectee_ht: Math.round(totalCollecteeHT * 100) / 100,
      total_collectee_tva: totalCollecteeTVA,
      total_deductible_ht: Math.round(totalDeductibleHT * 100) / 100,
      total_deductible_tva: totalDeductibleTVA,
      tva_due: tvaDue,
      is_credit: tvaDue < 0
    });
  } catch (err) {
    console.error('GET /api/tva/declaration error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ---- TVA SIMPL-DGI CSV EXPORT (per-invoice detail) ----
app.get('/api/tva/export-simpl-csv', requireAuth, async (req, res) => {
  try {
    const { year, month, quarter } = req.query;
    if (!year) return res.status(400).json({ error: 'Annee requise' });

    let dateFrom, dateTo, periodLabel;
    const y = parseInt(year);

    if (month) {
      const m = parseInt(month);
      dateFrom = `${y}-${String(m).padStart(2, '0')}-01`;
      const lastDay = new Date(y, m, 0).getDate();
      dateTo = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      const monthNames = ['Janvier','Fevrier','Mars','Avril','Mai','Juin','Juillet','Aout','Septembre','Octobre','Novembre','Decembre'];
      periodLabel = `${monthNames[m - 1]} ${y}`;
    } else if (quarter) {
      const q = parseInt(quarter);
      const startMonth = (q - 1) * 3 + 1;
      const endMonth = q * 3;
      dateFrom = `${y}-${String(startMonth).padStart(2, '0')}-01`;
      const lastDay = new Date(y, endMonth, 0).getDate();
      dateTo = `${y}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      periodLabel = `T${q} ${y}`;
    } else {
      return res.status(400).json({ error: 'Mois ou trimestre requis' });
    }

    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Aucune entreprise selectionnee' });
    const companyResult = await pool.query('SELECT * FROM companies WHERE id = $1', [companyId]);
    const company = companyResult.rows[0] || {};

    // --- TVA Collectee: per sale invoice, per TVA rate ---
    const collecteeResult = await pool.query(`
      SELECT
        i.invoice_number,
        TO_CHAR(i.date, 'DD/MM/YYYY') AS date_fmt,
        COALESCE(i.ice_client, co.ice, cl.ice, '') AS ice_client,
        COALESCE(co.name, cl.name, '') AS raison_sociale,
        il.tva_rate,
        ROUND(SUM(il.quantity * il.unit_price)::numeric, 2) AS base_ht,
        ROUND(SUM(il.tva_amount)::numeric, 2) AS tva_amount
      FROM invoices i
      JOIN invoice_lines il ON il.invoice_id = i.id
      LEFT JOIN contacts co ON i.contact_id = co.id
      LEFT JOIN clients cl ON i.client_id = cl.id
      WHERE i.company_id = $1
        AND i.type = 'sale'
        AND i.status != 'cancelled'
        AND i.date >= $2 AND i.date <= $3
        AND il.tva_rate > 0
      GROUP BY i.id, i.invoice_number, i.date, i.ice_client, co.ice, cl.ice, co.name, cl.name, il.tva_rate
      ORDER BY i.date, i.invoice_number
    `, [companyId, dateFrom, dateTo]);

    // --- TVA Deductible: per purchase invoice, per TVA rate ---
    const deductibleAchatsResult = await pool.query(`
      SELECT
        i.invoice_number,
        TO_CHAR(i.date, 'DD/MM/YYYY') AS date_fmt,
        COALESCE(i.ice_client, co.ice, '') AS ice_fournisseur,
        COALESCE(co.name, '') AS raison_sociale,
        il.tva_rate,
        ROUND(SUM(il.quantity * il.unit_price)::numeric, 2) AS base_ht,
        ROUND(SUM(il.tva_amount)::numeric, 2) AS tva_amount,
        '' AS num_paiement
      FROM invoices i
      JOIN invoice_lines il ON il.invoice_id = i.id
      LEFT JOIN contacts co ON i.contact_id = co.id
      WHERE i.company_id = $1
        AND i.type = 'purchase'
        AND i.status != 'cancelled'
        AND i.date >= $2 AND i.date <= $3
        AND il.tva_rate > 0
      GROUP BY i.id, i.invoice_number, i.date, i.ice_client, co.ice, co.name, il.tva_rate
      ORDER BY i.date, i.invoice_number
    `, [companyId, dateFrom, dateTo]);

    // --- TVA Deductible: expenses (single rate) ---
    const deductibleExpensesResult = await pool.query(`
      SELECT
        COALESCE(e.numero_facture, 'DEP-' || e.id::text) AS invoice_number,
        TO_CHAR(e.date, 'DD/MM/YYYY') AS date_fmt,
        COALESCE(e.supplier_ice, '') AS ice_fournisseur,
        COALESCE(e.fournisseur_nom, co.name, e.description, '') AS raison_sociale,
        e.tva_rate,
        ROUND(e.amount::numeric, 2) AS base_ht,
        ROUND(e.tva_amount::numeric, 2) AS tva_amount,
        '' AS num_paiement
      FROM expenses e
      LEFT JOIN contacts co ON e.contact_id = co.id
      WHERE e.company_id = $1
        AND e.status != 'cancelled'
        AND e.date >= $2 AND e.date <= $3
        AND e.tva_rate > 0
        AND e.tva_amount > 0
        AND (e.tva_rate_label IS NULL OR e.tva_rate_label != 'multitaux')
      ORDER BY e.date
    `, [companyId, dateFrom, dateTo]);

    // --- TVA Deductible: expenses with multi-rate supplier_invoice_lines ---
    const deductibleMultiResult = await pool.query(`
      SELECT
        COALESCE(e.numero_facture, 'DEP-' || e.id::text) AS invoice_number,
        TO_CHAR(e.date, 'DD/MM/YYYY') AS date_fmt,
        COALESCE(e.supplier_ice, '') AS ice_fournisseur,
        COALESCE(e.fournisseur_nom, co.name, e.description, '') AS raison_sociale,
        sil.tva_rate,
        ROUND(SUM(sil.amount_ht)::numeric, 2) AS base_ht,
        ROUND(SUM(sil.amount_tva)::numeric, 2) AS tva_amount,
        '' AS num_paiement
      FROM expenses e
      JOIN supplier_invoice_lines sil ON sil.invoice_id = e.id
      LEFT JOIN contacts co ON e.contact_id = co.id
      WHERE e.company_id = $1
        AND e.status != 'cancelled'
        AND e.date >= $2 AND e.date <= $3
        AND sil.tva_rate > 0
        AND sil.amount_tva > 0
      GROUP BY e.id, e.numero_facture, e.date, e.supplier_ice, e.fournisseur_nom, co.name, e.description, sil.tva_rate
      ORDER BY e.date
    `, [companyId, dateFrom, dateTo]);

    // Format helpers — comma as decimal separator, semicolon escaping
    const fmtAmt = (n) => Number(n || 0).toFixed(2).replace('.', ',');
    const fmtRate = (r) => `${parseFloat(r)}%`;
    const escCell = (s) => {
      const str = String(s || '');
      if (str.includes(';') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    };

    const rows = [];

    // Header block
    rows.push([`DECLARATION TVA SIMPL-DGI`, periodLabel, '', '', '', '', '', '']);
    rows.push([`Entreprise: ${company.name || ''}`, `ICE: ${company.ice || ''}`, `IF: ${company.idf || ''}`, `RC: ${company.rc || ''}`, '', '', '', '']);
    rows.push([`Periode: ${dateFrom} au ${dateTo}`, '', '', '', '', '', '', '']);
    rows.push([]);

    // Section A – TVA Collectée
    rows.push(['SECTION A - TVA COLLECTEE (EXIGIBLE)', '', '', '', '', '', '']);
    rows.push(['ICE Client', 'Raison Sociale', 'N° Facture', 'Date Facture', 'Base HT', 'Taux TVA', 'Montant TVA']);
    let totalCollecteeHT = 0, totalCollecteeTVA = 0;
    for (const row of collecteeResult.rows) {
      const baseHT = parseFloat(row.base_ht) || 0;
      const tvaMt = parseFloat(row.tva_amount) || 0;
      totalCollecteeHT += baseHT;
      totalCollecteeTVA += tvaMt;
      rows.push([
        row.ice_client || '',
        row.raison_sociale || '',
        row.invoice_number || '',
        row.date_fmt || '',
        fmtAmt(baseHT),
        fmtRate(row.tva_rate),
        fmtAmt(tvaMt)
      ]);
    }
    rows.push(['TOTAL SECTION A', '', '', '', fmtAmt(totalCollecteeHT), '', fmtAmt(totalCollecteeTVA)]);
    rows.push([]);

    // Section B – TVA Déductible
    rows.push(['SECTION B - TVA DEDUCTIBLE (RECUPERABLE)', '', '', '', '', '', '', '']);
    rows.push(['ICE Fournisseur', 'Raison Sociale', 'N° Facture', 'Date Facture', 'Base HT', 'Taux TVA', 'Montant TVA', 'N° Paiement']);
    let totalDeductibleHT = 0, totalDeductibleTVA = 0;
    const allDeductible = [
      ...deductibleAchatsResult.rows,
      ...deductibleExpensesResult.rows,
      ...deductibleMultiResult.rows
    ];
    for (const row of allDeductible) {
      const baseHT = parseFloat(row.base_ht) || 0;
      const tvaMt = parseFloat(row.tva_amount) || 0;
      totalDeductibleHT += baseHT;
      totalDeductibleTVA += tvaMt;
      rows.push([
        row.ice_fournisseur || '',
        row.raison_sociale || '',
        row.invoice_number || '',
        row.date_fmt || '',
        fmtAmt(baseHT),
        fmtRate(row.tva_rate),
        fmtAmt(tvaMt),
        row.num_paiement || ''
      ]);
    }
    rows.push(['TOTAL SECTION B', '', '', '', fmtAmt(totalDeductibleHT), '', fmtAmt(totalDeductibleTVA), '']);
    rows.push([]);

    // Section D – Résultat
    const tvaDue = totalCollecteeTVA - totalDeductibleTVA;
    rows.push(['SECTION D - RESULTAT NET', '', '', '', '', '', '']);
    rows.push(['TVA Collectee (A)', '', '', '', '', '', fmtAmt(totalCollecteeTVA)]);
    rows.push(['TVA Deductible (B)', '', '', '', '', '', fmtAmt(totalDeductibleTVA)]);
    rows.push([tvaDue >= 0 ? 'TVA DUE (A - B)' : 'CREDIT DE TVA (B - A)', '', '', '', '', '', fmtAmt(Math.abs(tvaDue))]);

    // Serialize to UTF-8 BOM + semicolon CSV
    const csv = rows.map(r => r.map(escCell).join(';')).join('\r\n');
    const filename = `TVA_SIMPL_${periodLabel.replace(/\s/g, '_')}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('\uFEFF' + csv);

  } catch (err) {
    console.error('GET /api/tva/export-simpl-csv error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ---- TVA DECLARATIONS ARCHIVE ----
// Save a TVA declaration record (auto-called after each computation)
app.post('/api/tva/declarations', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Aucune entreprise selectionnee' });

    const {
      year, month, quarter, regime, date_from, date_to, period_label,
      total_collectee_ht, total_collectee_tva,
      total_deductible_ht, total_deductible_tva,
      tva_due, is_credit,
      collectee_by_rate, deductible_by_rate
    } = req.body;

    if (!year || !regime || !date_from || !date_to) {
      return res.status(400).json({ error: 'Donnees manquantes' });
    }

    // Upsert: one record per company+year+month (or quarter)
    const existing = await pool.query(
      `SELECT id FROM tva_declarations WHERE company_id = $1 AND year = $2
       AND (month IS NOT DISTINCT FROM $3) AND (quarter IS NOT DISTINCT FROM $4)`,
      [companyId, year, month || null, quarter || null]
    );

    let result;
    if (existing.rows.length > 0) {
      result = await pool.query(
        `UPDATE tva_declarations SET
          regime=$1, date_from=$2, date_to=$3, period_label=$4,
          total_collectee_ht=$5, total_collectee_tva=$6,
          total_deductible_ht=$7, total_deductible_tva=$8,
          tva_due=$9, is_credit=$10,
          collectee_by_rate=$11, deductible_by_rate=$12,
          created_at=NOW()
         WHERE id=$13 RETURNING *`,
        [
          regime, date_from, date_to, period_label,
          total_collectee_ht || 0, total_collectee_tva || 0,
          total_deductible_ht || 0, total_deductible_tva || 0,
          tva_due || 0, is_credit || false,
          JSON.stringify(collectee_by_rate || {}),
          JSON.stringify(deductible_by_rate || {}),
          existing.rows[0].id
        ]
      );
    } else {
      result = await pool.query(
        `INSERT INTO tva_declarations
          (company_id, year, month, quarter, regime, date_from, date_to, period_label,
           total_collectee_ht, total_collectee_tva,
           total_deductible_ht, total_deductible_tva,
           tva_due, is_credit, collectee_by_rate, deductible_by_rate, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING *`,
        [
          companyId, year, month || null, quarter || null,
          regime, date_from, date_to, period_label,
          total_collectee_ht || 0, total_collectee_tva || 0,
          total_deductible_ht || 0, total_deductible_tva || 0,
          tva_due || 0, is_credit || false,
          JSON.stringify(collectee_by_rate || {}),
          JSON.stringify(deductible_by_rate || {}),
          req.session && req.session.userId ? req.session.userId : null
        ]
      );
    }

    res.json({ success: true, declaration: result.rows[0] });
  } catch (err) {
    console.error('POST /api/tva/declarations error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// List archived TVA declarations for the current company
app.get('/api/tva/declarations', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Aucune entreprise selectionnee' });

    const result = await pool.query(
      `SELECT id, year, month, quarter, regime, date_from, date_to, period_label,
              total_collectee_ht, total_collectee_tva,
              total_deductible_ht, total_deductible_tva,
              tva_due, is_credit, created_at
       FROM tva_declarations
       WHERE company_id = $1
       ORDER BY year DESC, COALESCE(month, quarter*3) DESC`,
      [companyId]
    );

    res.json({ declarations: result.rows });
  } catch (err) {
    console.error('GET /api/tva/declarations error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ---- BALANCE (Grand Livre summary) ----
app.get('/api/balance', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Aucune entreprise sélectionnée' });

    const { from, to } = req.query;
    let dateFilter = '';
    const params = [companyId];

    if (from) {
      params.push(from);
      dateFilter += ` AND je.date >= $${params.length}`;
    }
    if (to) {
      params.push(to);
      dateFilter += ` AND je.date <= $${params.length}`;
    }

    const result = await pool.query(`
      SELECT
        jel.account_code,
        jel.account_name,
        pa.class,
        pa.type,
        COALESCE(SUM(jel.debit), 0) as total_debit,
        COALESCE(SUM(jel.credit), 0) as total_credit,
        COALESCE(SUM(jel.debit), 0) - COALESCE(SUM(jel.credit), 0) as solde
      FROM journal_entry_lines jel
      JOIN journal_entries je ON jel.journal_entry_id = je.id
      LEFT JOIN pcm_accounts pa ON jel.account_code = pa.code
      WHERE je.company_id = $1 ${dateFilter}
      GROUP BY jel.account_code, jel.account_name, pa.class, pa.type
      ORDER BY jel.account_code ASC
    `, params);

    res.json({ balances: result.rows });
  } catch (err) {
    console.error('GET /api/balance error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ---- BALANCE GENERALE (Trial Balance) ----
app.get('/api/balance-generale', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Aucune entreprise sélectionnée' });

    // Support period=YYYY-MM, from/to, and date_debut/date_fin param names
    let from = req.query.from || req.query.date_debut;
    let to = req.query.to || req.query.date_fin;
    if (req.query.period) {
      const [py, pm] = req.query.period.split('-').map(Number);
      if (py && pm) {
        const lastDay = new Date(py, pm, 0).getDate();
        from = `${py}-${String(pm).padStart(2,'0')}-01`;
        to = `${py}-${String(pm).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
      }
    }
    const { compare } = req.query;

    // Period movements query
    const buildPeriodQuery = (dateFrom, dateTo) => {
      const params = [companyId];
      let dateFilter = '';
      if (dateFrom) { params.push(dateFrom); dateFilter += ` AND je.date >= $${params.length}`; }
      if (dateTo) { params.push(dateTo); dateFilter += ` AND je.date <= $${params.length}`; }
      const sql = `
        SELECT
          jel.account_code,
          COALESCE(pa.name, jel.account_name, jel.account_code) as account_name,
          pa.class,
          pa.type,
          COALESCE(SUM(jel.debit), 0) as total_debit,
          COALESCE(SUM(jel.credit), 0) as total_credit
        FROM journal_entry_lines jel
        JOIN journal_entries je ON jel.journal_entry_id = je.id
        LEFT JOIN pcm_accounts pa ON jel.account_code = pa.code
        WHERE je.company_id = $1 ${dateFilter}
        GROUP BY jel.account_code, pa.name, jel.account_name, pa.class, pa.type
        ORDER BY jel.account_code ASC
      `;
      return { sql, params };
    };

    // Opening balance query: all movements strictly BEFORE dateFrom
    const buildOpeningQuery = (dateBefore) => {
      const params = [companyId];
      let dateFilter = '';
      if (dateBefore) { params.push(dateBefore); dateFilter = ` AND je.date < $${params.length}`; }
      const sql = `
        SELECT
          jel.account_code,
          COALESCE(SUM(jel.debit), 0) - COALESCE(SUM(jel.credit), 0) as solde_ouverture
        FROM journal_entry_lines jel
        JOIN journal_entries je ON jel.journal_entry_id = je.id
        WHERE je.company_id = $1 ${dateFilter}
        GROUP BY jel.account_code
      `;
      return { sql, params };
    };

    const { sql, params } = buildPeriodQuery(from, to);
    const result = await pool.query(sql, params);

    // Opening balances (solde initial avant la période)
    const openingMap = {};
    if (from) {
      const { sql: openSql, params: openParams } = buildOpeningQuery(from);
      const openResult = await pool.query(openSql, openParams);
      for (const r of openResult.rows) {
        openingMap[r.account_code] = parseFloat(r.solde_ouverture) || 0;
      }
    }

    // Compute comparison period (N-1) if requested
    let prevRows = [];
    if (compare === 'true' && from && to) {
      const fromDate = new Date(from);
      const toDate = new Date(to);
      const prevFrom = new Date(fromDate);
      const prevTo = new Date(toDate);
      prevFrom.setFullYear(prevFrom.getFullYear() - 1);
      prevTo.setFullYear(prevTo.getFullYear() - 1);
      const prevFromStr = prevFrom.toISOString().split('T')[0];
      const prevToStr = prevTo.toISOString().split('T')[0];
      const { sql: prevSql, params: prevParams } = buildPeriodQuery(prevFromStr, prevToStr);
      const prevResult = await pool.query(prevSql, prevParams);
      prevRows = prevResult.rows;
    }

    // Build map of previous period by account_code
    const prevMap = {};
    for (const r of prevRows) {
      const pd = parseFloat(r.total_debit) || 0;
      const pc = parseFloat(r.total_credit) || 0;
      prevMap[r.account_code] = {
        total_debit: pd,
        total_credit: pc,
        solde: pd - pc
      };
    }

    // Group rows by PCM class
    const pcmClassNames = {
      '1': 'Classe 1 — Comptes de Financement Permanent',
      '2': 'Classe 2 — Comptes d\'Actif Immobilise',
      '3': 'Classe 3 — Comptes d\'Actif Circulant',
      '4': 'Classe 4 — Comptes de Passif Circulant',
      '5': 'Classe 5 — Comptes de Tresorerie',
      '6': 'Classe 6 — Comptes de Charges',
      '7': 'Classe 7 — Comptes de Produits',
      'other': 'Autres Comptes'
    };

    const grouped = {};
    let grandDebit = 0, grandCredit = 0;
    let grandSiDeb = 0, grandSiCre = 0, grandSfDeb = 0, grandSfCre = 0;

    for (const row of result.rows) {
      const pcmClass = row.class || row.account_code.charAt(0);
      const classKey = ['1','2','3','4','5','6','7'].includes(pcmClass) ? pcmClass : 'other';
      if (!grouped[classKey]) {
        grouped[classKey] = {
          class: classKey,
          label: pcmClassNames[classKey] || `Classe ${classKey}`,
          accounts: [],
          subtotal_debit: 0,
          subtotal_credit: 0,
          subtotal_si_deb: 0,
          subtotal_si_cre: 0,
          subtotal_sf_deb: 0,
          subtotal_sf_cre: 0
        };
      }
      const debit = parseFloat(row.total_debit) || 0;
      const credit = parseFloat(row.total_credit) || 0;

      // Opening balance (solde initial)
      const siNet = openingMap[row.account_code] || 0;
      const siDeb = siNet > 0 ? siNet : 0;
      const siCre = siNet < 0 ? Math.abs(siNet) : 0;

      // Final balance (solde final) = SI + Débit - Crédit
      const sfNet = siNet + debit - credit;
      const sfDeb = sfNet > 0 ? sfNet : 0;
      const sfCre = sfNet < 0 ? Math.abs(sfNet) : 0;

      // Period-only net (kept for backward compat / balance check)
      const periodNet = debit - credit;

      const prev = prevMap[row.account_code] || null;
      const variation = prev ? sfNet - prev.solde : null;
      const variationPct = prev && prev.solde !== 0 ? ((variation / Math.abs(prev.solde)) * 100) : null;

      grouped[classKey].accounts.push({
        account_code: row.account_code,
        account_name: row.account_name,
        total_debit: debit,
        total_credit: credit,
        si_deb: siDeb,
        si_cre: siCre,
        sf_deb: sfDeb,
        sf_cre: sfCre,
        // Legacy fields kept for compat
        solde_debiteur: periodNet > 0 ? periodNet : 0,
        solde_crediteur: periodNet < 0 ? Math.abs(periodNet) : 0,
        prev_debit: prev ? prev.total_debit : null,
        prev_credit: prev ? prev.total_credit : null,
        prev_solde_debiteur: prev ? (prev.solde > 0 ? prev.solde : 0) : null,
        prev_solde_crediteur: prev ? (prev.solde < 0 ? Math.abs(prev.solde) : 0) : null,
        variation,
        variation_pct: variationPct
      });
      grouped[classKey].subtotal_debit += debit;
      grouped[classKey].subtotal_credit += credit;
      grouped[classKey].subtotal_si_deb += siDeb;
      grouped[classKey].subtotal_si_cre += siCre;
      grouped[classKey].subtotal_sf_deb += sfDeb;
      grouped[classKey].subtotal_sf_cre += sfCre;
      grandDebit += debit;
      grandCredit += credit;
      grandSiDeb += siDeb;
      grandSiCre += siCre;
      grandSfDeb += sfDeb;
      grandSfCre += sfCre;
    }

    // Sort classes in PCM order
    const sortedGroups = Object.values(grouped).sort((a, b) => {
      const order = ['1','2','3','4','5','6','7','other'];
      return order.indexOf(a.class) - order.indexOf(b.class);
    });

    res.json({
      groups: sortedGroups,
      grand_total_debit: grandDebit,
      grand_total_credit: grandCredit,
      grand_si_deb: grandSiDeb,
      grand_si_cre: grandSiCre,
      grand_sf_deb: grandSfDeb,
      grand_sf_cre: grandSfCre,
      is_balanced: Math.abs(grandDebit - grandCredit) < 0.01,
      compare: compare === 'true'
    });
  } catch (err) {
    console.error('GET /api/balance-generale error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================================
// GRAND LIVRE
// ============================================================

app.get('/api/grand-livre', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Aucune entreprise sélectionnée' });

    // Support both legacy params (from/to) and new params (date_debut/date_fin)
    const from = req.query.date_debut || req.query.from;
    const to = req.query.date_fin || req.query.to;
    const { account_from, account_to, journal, account_search, unlettered_only, compte } = req.query;

    // Pagination at account level (max 100 per page)
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const per_page = Math.min(100, Math.max(1, parseInt(req.query.per_page) || 50));
    const format = req.query.format || 'json';

    const params = [companyId];
    let filters = '';

    if (from) { params.push(from); filters += ` AND je.date >= $${params.length}`; }
    if (to) { params.push(to); filters += ` AND je.date <= $${params.length}`; }
    // compte (exact account) takes precedence over account_from/to/search
    if (compte) {
      params.push(compte); filters += ` AND jel.account_code = $${params.length}`;
    } else {
      if (account_from) { params.push(account_from); filters += ` AND jel.account_code >= $${params.length}`; }
      if (account_to) { params.push(account_to); filters += ` AND jel.account_code <= $${params.length}`; }
      if (account_search) { params.push(account_search + '%'); filters += ` AND jel.account_code LIKE $${params.length}`; }
    }
    if (journal) { params.push(journal); filters += ` AND je.journal_type = $${params.length}`; }
    if (unlettered_only === '1') { filters += ` AND jel.lettrage_code IS NULL`; }

    const sql = `
      SELECT
        jel.id as line_id,
        jel.account_code,
        COALESCE(pa.name, jel.account_name, jel.account_code) as account_name,
        pa.class as pcm_class,
        je.date,
        je.journal_type,
        COALESCE(jel.description, je.description, je.reference, '') as libelle,
        COALESCE(jel.debit, 0) as debit,
        COALESCE(jel.credit, 0) as credit,
        je.id as journal_entry_id,
        je.reference,
        je.entry_number,
        jel.lettrage_code,
        COALESCE(jel.sort_order, 0) as sort_order
      FROM journal_entry_lines jel
      JOIN journal_entries je ON jel.journal_entry_id = je.id
      LEFT JOIN pcm_accounts pa ON jel.account_code = pa.code
      WHERE je.company_id = $1 ${filters}
      ORDER BY jel.account_code ASC, je.date ASC, je.id ASC, jel.sort_order ASC
    `;

    const result = await pool.query(sql, params);

    // Group by account
    const accountMap = {};
    for (const row of result.rows) {
      const key = row.account_code;
      if (!accountMap[key]) {
        accountMap[key] = {
          account_code: row.account_code,
          account_name: row.account_name,
          pcm_class: row.pcm_class || row.account_code.charAt(0),
          lines: [],
          total_debit: 0,
          total_credit: 0
        };
      }
      const debit = parseFloat(row.debit) || 0;
      const credit = parseFloat(row.credit) || 0;
      accountMap[key].total_debit += debit;
      accountMap[key].total_credit += credit;
      accountMap[key].lines.push({
        line_id: row.line_id,
        date: row.date,
        journal_type: row.journal_type,
        libelle: row.libelle || '',
        debit,
        credit,
        journal_entry_id: row.journal_entry_id,
        reference: row.reference,
        entry_number: row.entry_number,
        lettrage_code: row.lettrage_code || null
      });
    }

    // Compute report à nouveau (opening balance before the period start)
    const accountCodes = Object.keys(accountMap);
    if (from && accountCodes.length > 0) {
      const ranResult = await pool.query(
        `SELECT jel.account_code,
           COALESCE(SUM(jel.debit), 0) as ran_debit,
           COALESCE(SUM(jel.credit), 0) as ran_credit
         FROM journal_entry_lines jel
         JOIN journal_entries je ON jel.journal_entry_id = je.id
         WHERE je.company_id = $1 AND je.date < $2 AND jel.account_code = ANY($3)
         GROUP BY jel.account_code`,
        [companyId, from, accountCodes]
      );
      for (const row of ranResult.rows) {
        if (accountMap[row.account_code]) {
          const ranD = parseFloat(row.ran_debit) || 0;
          const ranC = parseFloat(row.ran_credit) || 0;
          accountMap[row.account_code].report_a_nouveau = ranD - ranC;
          accountMap[row.account_code].ran_debit = ranD;
          accountMap[row.account_code].ran_credit = ranC;
        }
      }
    }

    // Compute running balance per account (starts from report à nouveau)
    const allAccounts = Object.values(accountMap).map(acc => {
      const ran = acc.report_a_nouveau !== undefined ? acc.report_a_nouveau : 0;
      let runningBalance = ran;
      acc.lines = acc.lines.map(line => {
        runningBalance += line.debit - line.credit;
        return { ...line, solde_cumule: runningBalance };
      });
      acc.solde_final = acc.total_debit - acc.total_credit;
      acc.solde_final_avec_ran = ran + acc.solde_final;
      return acc;
    });

    // CSV format: return all accounts as a downloadable file
    if (format === 'csv') {
      const fmtN = (n) => (n === null || n === undefined) ? '' : Number(n).toFixed(2);
      const fmtDate = (dt) => {
        if (!dt) return '';
        const x = new Date(dt);
        return `${String(x.getDate()).padStart(2,'0')}/${String(x.getMonth()+1).padStart(2,'0')}/${x.getFullYear()}`;
      };
      const rows = [['Compte','Libellé Compte','Date','N° Pièce','Journal','Libellé Mouvement','Débit','Crédit','Solde Cumulé']];
      for (const acc of allAccounts) {
        if (acc.report_a_nouveau !== undefined) {
          const ran = acc.report_a_nouveau;
          rows.push([acc.account_code, acc.account_name || acc.account_code, '', 'RAN', '', 'Report à Nouveau',
            ran >= 0 ? fmtN(ran) : '', ran < 0 ? fmtN(Math.abs(ran)) : '', fmtN(ran)]);
        }
        for (const line of acc.lines) {
          rows.push([acc.account_code, acc.account_name || acc.account_code,
            fmtDate(line.date), line.entry_number || line.reference || '',
            line.journal_type || '', line.libelle || '',
            fmtN(line.debit), fmtN(line.credit), fmtN(line.solde_cumule)]);
        }
        rows.push([acc.account_code, 'TOTAL', '', '', '', '', fmtN(acc.total_debit), fmtN(acc.total_credit), fmtN(acc.solde_final_avec_ran)]);
        rows.push(['','','','','','','','','']);
      }
      const csvContent = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(';')).join('\r\n');
      const periodStr = (from && to) ? `${from}_${to}` : 'export';
      res.setHeader('Content-Type', 'text/csv;charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="Grand_Livre_${periodStr}.csv"`);
      return res.send('\uFEFF' + csvContent);
    }

    // JSON: paginate at account level
    const total_accounts = allAccounts.length;
    const total_pages = Math.ceil(total_accounts / per_page) || 1;
    const offset = (page - 1) * per_page;
    const paginatedAccounts = allAccounts.slice(offset, offset + per_page);

    res.json({
      accounts: paginatedAccounts,
      pagination: { page, per_page, total_accounts, total_pages, has_more: page < total_pages }
    });
  } catch (err) {
    console.error('GET /api/grand-livre error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================================
// LETTRAGE API
// ============================================================

// Helper: generate next lettrage code (AA, AB, ... AZ, BA, BB, ...)
async function getNextLettrageCode(companyId, client) {
  const db = client || pool;
  // Upsert a sequence row and atomically increment
  const result = await db.query(
    `INSERT INTO lettrage_sequences (company_id, next_index)
     VALUES ($1, 1)
     ON CONFLICT (company_id)
     DO UPDATE SET next_index = lettrage_sequences.next_index + 1
     RETURNING next_index`,
    [companyId]
  );
  const idx = result.rows[0].next_index - 1; // 0-based
  // Convert to AA-ZZ style (26*26 = 676 codes)
  const first = String.fromCharCode(65 + Math.floor(idx / 26) % 26);
  const second = String.fromCharCode(65 + (idx % 26));
  return first + second;
}

// GET /api/lettrage/lines/:account_code — all unlettered lines for manual lettrage
app.get('/api/lettrage/lines/:account_code', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company not found' });
    const { account_code } = req.params;
    const { from, to } = req.query;
    const params = [companyId, account_code];
    let dateFilter = '';
    if (from) { params.push(from); dateFilter += ` AND je.date >= $${params.length}`; }
    if (to) { params.push(to); dateFilter += ` AND je.date <= $${params.length}`; }

    const result = await pool.query(`
      SELECT
        jel.id as line_id,
        jel.account_code,
        je.date,
        je.journal_type,
        je.entry_number,
        je.reference,
        COALESCE(jel.description, je.description, je.reference, '') as libelle,
        COALESCE(jel.debit, 0) as debit,
        COALESCE(jel.credit, 0) as credit,
        jel.lettrage_code
      FROM journal_entry_lines jel
      JOIN journal_entries je ON jel.journal_entry_id = je.id
      WHERE je.company_id = $1
        AND jel.account_code = $2
        AND jel.lettrage_code IS NULL
        ${dateFilter}
      ORDER BY je.date ASC, je.id ASC, jel.sort_order ASC
    `, params);

    res.json({ lines: result.rows });
  } catch (err) {
    console.error('GET /api/lettrage/lines error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/lettrage/auto — run auto-lettrage on one or all eligible accounts
app.post('/api/lettrage/auto', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const companyId = await getEffectiveCompanyId(req, client);
    if (!companyId) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Company not found' }); }

    const { account_code } = req.body; // optional — if absent, run on 3421 & 4411

    const targetAccounts = account_code
      ? [account_code]
      : ['3421', '4411'];

    let totalMatched = 0;
    const matchedCodes = [];

    for (const acc of targetAccounts) {
      // Fetch all unlettered lines for this account, grouped by tiers reference
      // For simplicity: match exact debit/credit pairs (same amount, opposite side)
      const linesRes = await client.query(`
        SELECT
          jel.id as line_id,
          COALESCE(jel.debit, 0) as debit,
          COALESCE(jel.credit, 0) as credit,
          je.reference
        FROM journal_entry_lines jel
        JOIN journal_entries je ON jel.journal_entry_id = je.id
        WHERE je.company_id = $1
          AND jel.account_code = $2
          AND jel.lettrage_code IS NULL
        ORDER BY je.date ASC, je.id ASC
      `, [companyId, acc]);

      const lines = linesRes.rows;

      // Build debit and credit buckets keyed by amount
      // For each debit amount, find matching credit of same amount
      const debitBuckets = {}; // amount -> [line_id, ...]
      const creditBuckets = {};

      for (const line of lines) {
        const debit = parseFloat(line.debit);
        const credit = parseFloat(line.credit);
        if (debit > 0) {
          const key = debit.toFixed(2);
          if (!debitBuckets[key]) debitBuckets[key] = [];
          debitBuckets[key].push(line.line_id);
        }
        if (credit > 0) {
          const key = credit.toFixed(2);
          if (!creditBuckets[key]) creditBuckets[key] = [];
          creditBuckets[key].push(line.line_id);
        }
      }

      // Match pairs
      for (const [amount, debitIds] of Object.entries(debitBuckets)) {
        if (!creditBuckets[amount] || creditBuckets[amount].length === 0) continue;
        while (debitIds.length > 0 && creditBuckets[amount].length > 0) {
          const dId = debitIds.shift();
          const cId = creditBuckets[amount].shift();
          const code = await getNextLettrageCode(companyId, client);
          await client.query(
            `UPDATE journal_entry_lines SET lettrage_code = $1 WHERE id IN ($2, $3)`,
            [code, dId, cId]
          );
          matchedCodes.push({ code, line_ids: [dId, cId], account: acc });
          totalMatched++;
        }
      }
    }

    await client.query('COMMIT');
    res.json({
      success: true,
      matched: totalMatched,
      codes: matchedCodes,
      message: totalMatched > 0
        ? `${totalMatched} paire(s) lettrée(s) automatiquement`
        : 'Aucune paire à lettrer trouvée'
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/lettrage/auto error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally {
    client.release();
  }
});

// POST /api/lettrage/manual — apply lettrage to selected line IDs
app.post('/api/lettrage/manual', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const companyId = await getEffectiveCompanyId(req, client);
    if (!companyId) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Company not found' }); }

    const { line_ids, allow_partial } = req.body;
    if (!Array.isArray(line_ids) || line_ids.length < 2) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Sélectionnez au moins 2 lignes' });
    }

    // Verify ownership and fetch lines
    const placeholders = line_ids.map((_, i) => `$${i + 2}`).join(',');
    const linesRes = await client.query(`
      SELECT jel.id, jel.debit, jel.credit, jel.lettrage_code, je.company_id
      FROM journal_entry_lines jel
      JOIN journal_entries je ON jel.journal_entry_id = je.id
      WHERE je.company_id = $1 AND jel.id IN (${placeholders})
    `, [companyId, ...line_ids]);

    if (linesRes.rows.length !== line_ids.length) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Lignes introuvables ou accès refusé' });
    }

    // Check no line already lettered
    const alreadyLettered = linesRes.rows.filter(l => l.lettrage_code);
    if (alreadyLettered.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Certaines lignes sont déjà lettrées' });
    }

    // Compute debit/credit balance
    let totalDebit = 0;
    let totalCredit = 0;
    for (const line of linesRes.rows) {
      totalDebit += parseFloat(line.debit) || 0;
      totalCredit += parseFloat(line.credit) || 0;
    }

    const ecart = Math.abs(totalDebit - totalCredit);
    const TOLERANCE = 0.01;

    if (ecart > TOLERANCE && !allow_partial) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Déséquilibre de ${ecart.toFixed(2)} MAD. Utilisez le lettrage partiel pour continuer.`,
        ecart: ecart.toFixed(2),
        totalDebit: totalDebit.toFixed(2),
        totalCredit: totalCredit.toFixed(2)
      });
    }

    const code = await getNextLettrageCode(companyId, client);
    const idPlaceholders = line_ids.map((_, i) => `$${i + 2}`).join(',');
    await client.query(
      `UPDATE journal_entry_lines SET lettrage_code = $1 WHERE id IN (${idPlaceholders})`,
      [code, ...line_ids]
    );

    // If partial lettrage (ecart > 0), record the ecart info in code metadata
    // (No separate entry needed per spec — just flag in response)
    await client.query('COMMIT');
    res.json({
      success: true,
      code,
      line_ids,
      ecart: ecart > TOLERANCE ? ecart.toFixed(2) : null,
      message: ecart > TOLERANCE
        ? `Lettrage partiel appliqué (code ${code}, écart ${ecart.toFixed(2)} MAD)`
        : `Lettrage appliqué (code ${code})`
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/lettrage/manual error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally {
    client.release();
  }
});

// DELETE /api/lettrage/:code — remove lettrage (délettrage) for all lines sharing a code
app.delete('/api/lettrage/:code', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const companyId = await getEffectiveCompanyId(req, client);
    if (!companyId) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Company not found' }); }

    const { code } = req.params;
    if (!code || code.length > 10) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Code invalide' });
    }

    // Verify ownership before deletting
    const checkRes = await client.query(`
      SELECT jel.id
      FROM journal_entry_lines jel
      JOIN journal_entries je ON jel.journal_entry_id = je.id
      WHERE je.company_id = $1 AND jel.lettrage_code = $2
      LIMIT 1
    `, [companyId, code]);

    if (checkRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Code lettrage introuvable' });
    }

    const updateRes = await client.query(`
      UPDATE journal_entry_lines jel
      SET lettrage_code = NULL
      FROM journal_entries je
      WHERE jel.journal_entry_id = je.id
        AND je.company_id = $1
        AND jel.lettrage_code = $2
      RETURNING jel.id
    `, [companyId, code]);

    await client.query('COMMIT');
    res.json({
      success: true,
      deleted_count: updateRes.rows.length,
      message: `Lettrage ${code} supprimé (${updateRes.rows.length} ligne(s))`
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('DELETE /api/lettrage/:code error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally {
    client.release();
  }
});

// ============================================================
// NOTIFICATIONS API
// ============================================================

// GET /api/notifications — paginated list for current user
app.get('/api/notifications', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset = parseInt(req.query.offset) || 0;
    const result = await pool.query(
      `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [req.userId, limit, offset]
    );
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM notifications WHERE user_id = $1',
      [req.userId]
    );
    res.json({ notifications: result.rows, total: parseInt(countResult.rows[0].count) });
  } catch (err) {
    console.error('GET /api/notifications error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/notifications/unread-count — badge count
app.get('/api/notifications/unread-count', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false',
      [req.userId]
    );
    res.json({ count: parseInt(result.rows[0].count) });
  } catch (err) {
    console.error('GET /api/notifications/unread-count error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/notifications/:id/read — mark one as read
app.put('/api/notifications/:id/read', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await pool.query(
      'UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2',
      [id, req.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/notifications/:id/read error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/notifications/read-all — mark all as read
app.put('/api/notifications/read-all', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE notifications SET is_read = true WHERE user_id = $1',
      [req.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/notifications/read-all error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/notifications/preferences — get email prefs
app.get('/api/notifications/preferences', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM notification_preferences WHERE user_id = $1',
      [req.userId]
    );
    if (result.rows.length === 0) {
      res.json({ email_enabled: true, types_disabled: [] });
    } else {
      res.json({ email_enabled: result.rows[0].email_enabled, types_disabled: result.rows[0].types_disabled || [] });
    }
  } catch (err) {
    console.error('GET /api/notifications/preferences error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/notifications/preferences — update email prefs
app.put('/api/notifications/preferences', requireAuth, async (req, res) => {
  try {
    const { email_enabled, types_disabled } = req.body;
    await pool.query(
      `INSERT INTO notification_preferences (user_id, email_enabled, types_disabled, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         email_enabled = EXCLUDED.email_enabled,
         types_disabled = EXCLUDED.types_disabled,
         updated_at = NOW()`,
      [req.userId, email_enabled !== false, types_disabled || []]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/notifications/preferences error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================================
// CABINET / FIDUCIAIRE MODE
// ============================================================

// PUT /api/user/type — switch user to cabinet or standard mode
app.put('/api/user/type', requireAuth, async (req, res) => {
  try {
    const { user_type } = req.body;
    if (!['standard', 'cabinet'].includes(user_type)) {
      return res.status(400).json({ error: 'Type invalide. Valeurs acceptees: standard, cabinet' });
    }

    // Role exclusivity checks
    if (user_type === 'cabinet') {
      // Cannot switch to cabinet if already linked as a client (entreprise) to a dossier
      const clientLink = await pool.query(
        'SELECT id FROM companies WHERE client_user_id = $1 LIMIT 1',
        [req.userId]
      );
      if (clientLink.rows.length > 0) {
        return res.status(409).json({
          error: 'Ce compte est déjà associé comme client entreprise à un dossier. Un collaborateur ne peut pas être client et inversement.'
        });
      }
    }

    if (user_type === 'standard') {
      // Cannot switch to standard if active cabinet member of another cabinet
      const cabinetMembership = await pool.query(
        'SELECT id FROM cabinet_members WHERE member_user_id = $1 AND status = $2 LIMIT 1',
        [req.userId, 'active']
      );
      if (cabinetMembership.rows.length > 0) {
        return res.status(409).json({
          error: 'Ce compte est un collaborateur actif d\'un cabinet. Contactez l\'administrateur du cabinet pour retirer votre accès avant de changer de mode.'
        });
      }
    }

    // When activating cabinet mode, auto-assign admin role; when deactivating, clear role
    const cabinetRole = user_type === 'cabinet' ? 'admin' : null;
    await pool.query('UPDATE users SET user_type = $1, cabinet_role = $2 WHERE id = $3', [user_type, cabinetRole, req.userId]);
    res.json({ ok: true, user_type });
  } catch (err) {
    console.error('PUT /api/user/type error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/cabinet/dossiers — list all client dossiers for cabinet user
app.get('/api/cabinet/dossiers', requireAuth, async (req, res) => {
  try {
    const { search, collaborateur, chef_de_mission, forme_juridique, statut, pilote_pa, abonnement, expert_comptable, page = 1, limit = 50 } = req.query;

    const ownerId = req.cabinetOwnerId || req.userId;
    const conditions = ['c.user_id = $1'];
    const params = [ownerId];

    // For non-admin members: restrict to assigned dossiers only
    if (['comptable', 'assistant', 'chef_mission', 'collaborateur'].includes(req.cabinetRole)) {
      params.push(req.userId);
      conditions.push(`(c.collaborateur_id = $${params.length} OR c.chef_de_mission_id = $${params.length})`);
    }

    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      conditions.push(`LOWER(c.name) LIKE $${params.length}`);
    }
    if (collaborateur) {
      params.push(collaborateur);
      conditions.push(`c.collaborateur = $${params.length}`);
    }
    if (chef_de_mission) {
      params.push(chef_de_mission);
      conditions.push(`c.chef_de_mission = $${params.length}`);
    }
    if (forme_juridique) {
      params.push(forme_juridique);
      conditions.push(`c.forme_juridique = $${params.length}`);
    }
    if (statut) {
      params.push(statut);
      conditions.push(`c.statut = $${params.length}`);
    }
    if (pilote_pa) {
      params.push(pilote_pa);
      conditions.push(`c.pilote_pa = $${params.length}`);
    }
    if (abonnement) {
      params.push(abonnement);
      conditions.push(`c.abonnement = $${params.length}`);
    }
    if (expert_comptable) {
      params.push(expert_comptable);
      conditions.push(`c.expert_comptable = $${params.length}`);
    }

    const whereClause = conditions.join(' AND ');
    const countResult = await pool.query(`SELECT COUNT(*) FROM companies c WHERE ${whereClause}`, params);
    const total = parseInt(countResult.rows[0].count);

    const pageSize = Math.min(parseInt(limit) || 50, 100);
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * pageSize;
    params.push(pageSize, offset);

    // JOIN users to resolve FK-based names; COALESCE prefers the FK name over the legacy text field
    const result = await pool.query(
      `SELECT c.*,
         COALESCE(cu.name, c.collaborateur) as collaborateur,
         COALESCE(cmu.name, c.chef_de_mission) as chef_de_mission
       FROM companies c
       LEFT JOIN users cu ON cu.id = c.collaborateur_id
       LEFT JOIN users cmu ON cmu.id = c.chef_de_mission_id
       WHERE ${whereClause} ORDER BY c.name ASC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ dossiers: result.rows, total, page: parseInt(page) || 1, limit: pageSize });
  } catch (err) {
    console.error('GET /api/cabinet/dossiers error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/cabinet/dossiers/:id — full company details for the paramétrage drawer
app.get('/api/cabinet/dossiers/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const ownerId = req.cabinetOwnerId || req.userId;
    const result = await pool.query(
      `SELECT c.*,
         COALESCE(cu.name, c.collaborateur) AS collaborateur_name,
         COALESCE(cmu.name, c.chef_de_mission) AS chef_de_mission_name,
         eu.name AS expert_comptable_name_resolved,
         pu.name AS pilote_pa_name_resolved
       FROM companies c
       LEFT JOIN users cu ON cu.id = c.collaborateur_id
       LEFT JOIN users cmu ON cmu.id = c.chef_de_mission_id
       LEFT JOIN users eu ON eu.id = c.expert_comptable_id
       LEFT JOIN users pu ON pu.id = c.pilote_pa_id
       WHERE c.id = $1 AND c.user_id = $2`,
      [parseInt(id), ownerId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Dossier non trouvé' });
    res.json({ dossier: result.rows[0] });
  } catch (err) {
    console.error('GET /api/cabinet/dossiers/:id error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/cabinet/saisie — cockpit saisie: dossiers + aggregated production metrics
app.get('/api/cabinet/saisie', requireAuth, async (req, res) => {
  try {
    const { search, pilote_pa, frequence_tva, forme_juridique, banque_connectee, page = 1, limit = 100 } = req.query;
    const ownerId = req.cabinetOwnerId || req.userId;
    const conditions = ['c.user_id = $1'];
    const params = [ownerId];

    // Restrict non-admin members to their own dossiers
    if (['comptable', 'assistant', 'chef_mission', 'collaborateur'].includes(req.cabinetRole)) {
      params.push(req.userId);
      conditions.push(`(c.collaborateur_id = $${params.length} OR c.chef_de_mission_id = $${params.length})`);
    }

    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      conditions.push(`LOWER(c.name) LIKE $${params.length}`);
    }
    if (pilote_pa) {
      params.push(pilote_pa);
      conditions.push(`c.pilote_pa = $${params.length}`);
    }
    if (frequence_tva) {
      params.push(frequence_tva);
      conditions.push(`c.frequence_tva = $${params.length}`);
    }
    if (forme_juridique) {
      params.push(forme_juridique);
      conditions.push(`c.forme_juridique = $${params.length}`);
    }

    const whereClause = conditions.join(' AND ');
    const countResult = await pool.query(`SELECT COUNT(*) FROM companies c WHERE ${whereClause}`, params);
    const total = parseInt(countResult.rows[0].count);

    const pageSize = Math.min(parseInt(limit) || 100, 200);
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * pageSize;
    params.push(pageSize, offset);

    // Aggregate all production metrics per dossier in one query
    const result = await pool.query(
      `SELECT
         c.id,
         c.name,
         c.forme_juridique,
         c.type_comptabilite,
         c.frequence_tva,
         c.abonnement,
         c.pilote_pa,
         c.statut,
         COALESCE(cu.name, c.collaborateur) AS collaborateur,
         COALESCE(cmu.name, c.chef_de_mission) AS chef_de_mission,
         c.expert_comptable,
         c.collaborateur_id,
         c.chef_de_mission_id,
         c.expert_comptable_id,
         c.pilote_pa_id,
         COALESCE(c.categorie_fiscale, 'IS') AS categorie_fiscale,
         COALESCE(c.regime_fiscal, 'Normal') AS regime_fiscal,
         COALESCE(c.jour_tva, 20) AS jour_tva,
         COALESCE(c.date_cloture, '31/12') AS date_cloture,
         COALESCE(c.perimetre_mission, 'Tenue complète') AS perimetre_mission,
         c.ice, c.idf, c.rc, c.city,
         -- Bank connectivity
         (SELECT COUNT(*) FROM bank_accounts ba WHERE ba.company_id = c.id)::int AS nb_bank_accounts,
         -- Transactions to process
         (SELECT COUNT(*) FROM bank_transactions bt WHERE bt.company_id = c.id AND bt.match_status = 'unmatched')::int AS tx_a_traiter,
         -- Pre-processed transactions
         (SELECT COUNT(*) FROM bank_transactions bt WHERE bt.company_id = c.id AND bt.match_status IN ('auto_matched','manual_matched'))::int AS tx_pre,
         -- Total transactions for automation rate
         (SELECT COUNT(*) FROM bank_transactions bt WHERE bt.company_id = c.id)::int AS tx_total,
         -- Pending journal entries (unbalanced or recent)
         (SELECT COUNT(*) FROM journal_entries je WHERE je.company_id = c.id AND je.is_balanced = false)::int AS ecritures_attente,
         -- Supplier invoices pending
         (SELECT COUNT(*) FROM expenses e WHERE e.company_id = c.id AND e.status IN ('pending', 'approved'))::int AS factures_fournisseurs,
         -- Client invoices pending
         (SELECT COUNT(*) FROM invoices i WHERE i.company_id = c.id AND i.type = 'sale' AND i.status IN ('draft', 'sent', 'overdue'))::int AS factures_clients,
         -- Documents waiting for approval
         (SELECT COUNT(*) FROM cabinet_justificatif_requests cjr WHERE cjr.company_id = c.id AND cjr.status = 'pending')::int AS docs_approuver,
         -- Unread notifications/messages from cabinet
         (SELECT COUNT(*) FROM cabinet_messages cm WHERE cm.company_id = c.id AND cm.is_read = false)::int AS notifications_unread
       FROM companies c
       LEFT JOIN users cu ON cu.id = c.collaborateur_id
       LEFT JOIN users cmu ON cmu.id = c.chef_de_mission_id
       WHERE ${whereClause}
       ORDER BY c.name ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    // Apply post-query filter for banque_connectee if specified
    let dossiers = result.rows;
    if (banque_connectee === 'oui') {
      dossiers = dossiers.filter(d => d.nb_bank_accounts > 0);
    } else if (banque_connectee === 'non') {
      dossiers = dossiers.filter(d => d.nb_bank_accounts === 0);
    }

    // Compute automation rate
    dossiers = dossiers.map(d => ({
      ...d,
      banque_connectee: d.nb_bank_accounts > 0,
      automatisation: d.tx_total > 0 ? Math.round((d.tx_pre / d.tx_total) * 100) : null,
    }));

    res.json({ dossiers, total, page: parseInt(page) || 1, limit: pageSize });
  } catch (err) {
    console.error('GET /api/cabinet/saisie error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/cabinet/portefeuille — portfolio view: all dossiers with KPIs aggregated
app.get('/api/cabinet/portefeuille', requireAuth, async (req, res) => {
  try {
    const { search, collaborateur_id, page = 1, limit = 50 } = req.query;
    const ownerId = req.cabinetOwnerId || req.userId;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit) || 50));
    const offset = (pageNum - 1) * pageSize;

    // Build base WHERE clause (reusable for both page and full-portfolio queries)
    const baseConditions = ['c.user_id = $1'];
    const baseParams = [ownerId];

    // Non-admin members: restrict to assigned dossiers only
    if (['comptable', 'assistant', 'chef_mission', 'collaborateur'].includes(req.cabinetRole)) {
      baseParams.push(req.userId);
      baseConditions.push(`(c.collaborateur_id = $${baseParams.length} OR c.chef_de_mission_id = $${baseParams.length})`);
    } else if (collaborateur_id) {
      baseParams.push(parseInt(collaborateur_id));
      baseConditions.push(`(c.collaborateur_id = $${baseParams.length} OR c.chef_de_mission_id = $${baseParams.length})`);
    }

    if (search) {
      baseParams.push(`%${search.toLowerCase()}%`);
      baseConditions.push(`LOWER(c.name) LIKE $${baseParams.length}`);
    }

    const whereClause = baseConditions.join(' AND ');

    // Year start for YTD metrics
    const now = new Date();
    const yearStart = `${now.getFullYear()}-01-01`;

    // ── Count total (all dossiers including archived) ──────────────────
    const countResult = await pool.query(
      `SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE c.statut != 'archive') as actifs FROM companies c WHERE ${whereClause}`,
      baseParams
    );
    const total = parseInt(countResult.rows[0].total);
    const totalActifs = parseInt(countResult.rows[0].actifs);

    // ── Paginated dossier list ─────────────────────────────────────────
    const dossierResult = await pool.query(
      `SELECT c.id, c.name, c.ice, c.forme_juridique, c.statut,
         COALESCE(cu.name, c.collaborateur) as collaborateur,
         COALESCE(cmu.name, c.chef_de_mission) as chef_de_mission,
         c.type_comptabilite,
         COALESCE(c.abonnement, 'Collaboratif') as abonnement,
         COALESCE(c.frequence_tva, 'Mensuelle') as frequence_tva,
         c.bank_name,
         cu.id as collaborateur_user_id,
         cmu.id as chef_de_mission_user_id,
         COALESCE(c.categorie_fiscale, CASE
           WHEN c.forme_juridique ILIKE '%auto%entrepreneur%' OR c.forme_juridique ILIKE 'EI' THEN 'IR'
           ELSE 'IS' END) as categorie_fiscale,
         COALESCE(c.jour_tva, 20) as jour_tva,
         COALESCE(c.date_cloture, '31/12') as date_cloture,
         COALESCE(c.perimetre_mission, 'Tenue complète') as perimetre_mission,
         c.expert_comptable
       FROM companies c
       LEFT JOIN users cu ON cu.id = c.collaborateur_id
       LEFT JOIN users cmu ON cmu.id = c.chef_de_mission_id
       WHERE ${whereClause}
       ORDER BY c.name ASC
       LIMIT ${pageSize} OFFSET ${offset}`,
      baseParams
    );
    const dossiers = dossierResult.rows;

    // Empty result: still compute aggregate KPIs
    if (dossiers.length === 0) {
      return res.json({
        kpis: { total_dossiers: total, total_actifs: totalActifs, ca_total: 0, dossiers_lettrage_faible: 0, dossiers_tva_en_attente: 0 },
        dossiers: [],
        total, page: pageNum, limit: pageSize
      });
    }

    const dossierIds = dossiers.map(d => d.id);
    const idPlaceholders = dossierIds.map((_, i) => `$${i + 2}`).join(',');
    const idParams = [yearStart, ...dossierIds];

    // ── Bulk invoice KPIs (CA + TVA) ──────────────────────────────────
    const invoiceKpisResult = await pool.query(
      `SELECT
         company_id,
         COALESCE(SUM(CASE WHEN type='sale' AND status!='cancelled' THEN total ELSE 0 END), 0) as ca_ytd,
         COALESCE(SUM(CASE WHEN type='purchase' AND status!='cancelled' THEN total ELSE 0 END), 0) as achats_ytd,
         COALESCE(SUM(CASE WHEN type='sale' AND status!='cancelled' THEN tva_amount ELSE 0 END), 0) as tva_collectee,
         COALESCE(SUM(CASE WHEN type='purchase' AND status!='cancelled' THEN tva_amount ELSE 0 END), 0) as tva_deductible_inv
       FROM invoices
       WHERE date >= $1 AND company_id IN (${idPlaceholders})
       GROUP BY company_id`,
      idParams
    );
    const invoiceKpisMap = {};
    for (const row of invoiceKpisResult.rows) invoiceKpisMap[row.company_id] = row;

    // ── Bulk expense KPIs (charges + TVA déductible) ───────────────────
    const expenseKpisResult = await pool.query(
      `SELECT
         company_id,
         COALESCE(SUM(total), 0) as expenses_ytd,
         COALESCE(SUM(tva_amount), 0) as tva_deductible_exp
       FROM expenses
       WHERE date >= $1 AND company_id IN (${idPlaceholders}) AND status != 'cancelled'
       GROUP BY company_id`,
      idParams
    );
    const expenseKpisMap = {};
    for (const row of expenseKpisResult.rows) expenseKpisMap[row.company_id] = row;

    // ── Bulk supplier invoice transactions counts ──────────────────────
    const txCountResult = await pool.query(
      `SELECT
         company_id,
         COUNT(*) FILTER (WHERE invoice_status = 'a_traiter') as a_traiter,
         COUNT(*) FILTER (WHERE invoice_status = 'pre_traitee') as pre_traitee
       FROM expenses
       WHERE company_id IN (${dossierIds.map((_, i) => `$${i + 1}`).join(',')})
       GROUP BY company_id`,
      dossierIds
    );
    const txCountMap = {};
    for (const row of txCountResult.rows) txCountMap[row.company_id] = row;

    // ── Bulk lettrage stats (3421* = clients, 4411* = fournisseurs) ────
    const lettrageResult = await pool.query(
      `SELECT
         je.company_id,
         COUNT(*) as total_lines,
         COUNT(jel.lettrage_code) as lettered_lines
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       WHERE je.company_id IN (${dossierIds.map((_, i) => `$${i + 1}`).join(',')})
         AND (jel.account_code LIKE '3421%' OR jel.account_code LIKE '4411%')
       GROUP BY je.company_id`,
      dossierIds
    );
    const lettrageMap = {};
    for (const row of lettrageResult.rows) {
      const tot = parseInt(row.total_lines);
      const lettered = parseInt(row.lettered_lines);
      lettrageMap[row.company_id] = tot > 0 ? Math.round((lettered / tot) * 100) : null;
    }

    // ── Bulk last activity (most recent journal entry date) ────────────
    const activityResult = await pool.query(
      `SELECT company_id, MAX(date) as derniere_activite
       FROM journal_entries
       WHERE company_id IN (${dossierIds.map((_, i) => `$${i + 1}`).join(',')})
       GROUP BY company_id`,
      dossierIds
    );
    const activityMap = {};
    for (const row of activityResult.rows) activityMap[row.company_id] = row.derniere_activite;

    // ── Merge per-dossier data ─────────────────────────────────────────
    const enrichedDossiers = dossiers.map(d => {
      const inv = invoiceKpisMap[d.id] || {};
      const exp = expenseKpisMap[d.id] || {};
      const tx = txCountMap[d.id] || {};
      const caYtd = parseFloat(inv.ca_ytd || 0);
      const achatsYtd = parseFloat(inv.achats_ytd || 0);
      const expensesYtd = parseFloat(exp.expenses_ytd || 0);
      const chargesYtd = achatsYtd + expensesYtd;
      const resultatYtd = caYtd - chargesYtd;
      const tvaSolde = parseFloat(inv.tva_collectee || 0) - parseFloat(inv.tva_deductible_inv || 0) - parseFloat(exp.tva_deductible_exp || 0);
      const lettragePct = lettrageMap[d.id] !== undefined ? lettrageMap[d.id] : null;
      const derniereActivite = activityMap[d.id] || null;
      const transactionsATraiter = parseInt(tx.a_traiter || 0);
      const transactionsPreTraitees = parseInt(tx.pre_traitee || 0);
      const banqueConnectee = !!(d.bank_name);
      return { ...d, ca_ytd: caYtd, charges_ytd: chargesYtd, resultat_ytd: resultatYtd, tva_solde: tvaSolde, lettrage_pct: lettragePct, derniere_activite: derniereActivite, transactions_a_traiter: transactionsATraiter, transactions_pre_traitees: transactionsPreTraitees, banque_connectee: banqueConnectee };
    });

    // ── Aggregate KPIs on full portfolio ──────────────────────────────
    // Total CA (full set, not just current page)
    const fullCaParams = [...baseParams, yearStart];
    const fullCaResult = await pool.query(
      `SELECT COALESCE(SUM(i.total), 0) as ca_total
       FROM invoices i
       JOIN companies c ON c.id = i.company_id
       WHERE ${whereClause} AND i.type='sale' AND i.status!='cancelled' AND i.date >= $${fullCaParams.length}`,
      fullCaParams
    );
    const caTotal = parseFloat(fullCaResult.rows[0]?.ca_total || 0);

    // Dossiers avec lettrage < 80% (full portfolio)
    const fullLettrageResult = await pool.query(
      `SELECT je.company_id,
         COUNT(jel.lettrage_code) * 100.0 / NULLIF(COUNT(*), 0) as lettrage_pct
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       JOIN companies c ON c.id = je.company_id
       WHERE ${whereClause} AND (jel.account_code LIKE '3421%' OR jel.account_code LIKE '4411%')
       GROUP BY je.company_id
       HAVING COUNT(*) > 0`,
      baseParams
    );
    const dossiersLetFrageFaible = fullLettrageResult.rows.filter(r => parseFloat(r.lettrage_pct) < 80).length;

    // Dossiers avec TVA solde > 0 (TVA due, not yet cleared)
    const fullTvaParams = [...baseParams, yearStart];
    const fullTvaResult = await pool.query(
      `SELECT i.company_id
       FROM invoices i
       JOIN companies c ON c.id = i.company_id
       WHERE ${whereClause} AND i.status!='cancelled' AND i.date >= $${fullTvaParams.length}
       GROUP BY i.company_id
       HAVING SUM(CASE WHEN i.type='sale' THEN i.tva_amount ELSE -i.tva_amount END) > 0`,
      fullTvaParams
    );
    const dossiersTvaEnAttente = fullTvaResult.rows.length;

    res.json({
      kpis: {
        total_dossiers: total,
        total_actifs: totalActifs,
        ca_total: caTotal,
        dossiers_lettrage_faible: dossiersLetFrageFaible,
        dossiers_tva_en_attente: dossiersTvaEnAttente
      },
      dossiers: enrichedDossiers,
      total, page: pageNum, limit: pageSize
    });
  } catch (err) {
    console.error('GET /api/cabinet/portefeuille error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/cabinet/dossiers — create a new client dossier (admin only)
app.post('/api/cabinet/dossiers', requireAuth, requireCabinetRole(['admin']), async (req, res) => {
  try {
    const { name, forme_juridique, ice, idf, rc, cnss, address, city, phone, email,
            rib, bank_name, payment_conditions, type_comptabilite, collaborateur, chef_de_mission,
            collaborateur_id, chef_de_mission_id,
            pilote_pa, abonnement, expert_comptable, frequence_tva } = req.body;
    if (!name) return res.status(400).json({ error: 'La raison sociale est requise' });

    const ownerId = req.cabinetOwnerId || req.userId;
    const result = await pool.query(
      `INSERT INTO companies
         (name, forme_juridique, ice, idf, rc, cnss, address, city, phone, email,
          rib, bank_name, payment_conditions, type_comptabilite, collaborateur, chef_de_mission,
          collaborateur_id, chef_de_mission_id,
          pilote_pa, abonnement, expert_comptable, frequence_tva, statut, user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,'actif',$23)
       RETURNING *`,
      [name, forme_juridique || null, ice || null, idf || null, rc || null, cnss || null,
       address || null, city || null, phone || null, email || null,
       rib || null, bank_name || null, payment_conditions || null,
       type_comptabilite || 'Engagement', collaborateur || null, chef_de_mission || null,
       collaborateur_id || null, chef_de_mission_id || null,
       pilote_pa || null, abonnement || 'Collaboratif', expert_comptable || null,
       frequence_tva || 'Mensuelle', ownerId]
    );
    res.json({ dossier: result.rows[0] });
  } catch (err) {
    console.error('POST /api/cabinet/dossiers error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/cabinet/dossiers/:id — update a client dossier (admin only)
app.put('/api/cabinet/dossiers/:id', requireAuth, requireCabinetRole(['admin']), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, forme_juridique, ice, idf, rc, cnss, address, city, phone, email,
            rib, bank_name, payment_conditions, type_comptabilite, collaborateur, chef_de_mission,
            collaborateur_id, chef_de_mission_id, statut,
            pilote_pa, abonnement, expert_comptable, frequence_tva,
            // Paramétrage drawer fields
            categorie_fiscale, regime_fiscal, jour_tva, date_cloture, perimetre_mission,
            expert_comptable_id, pilote_pa_id } = req.body;
    if (!name) return res.status(400).json({ error: 'La raison sociale est requise' });

    const ownerId = req.cabinetOwnerId || req.userId;
    const result = await pool.query(
      `UPDATE companies SET
         name=$1, forme_juridique=$2, ice=$3, idf=$4, rc=$5, cnss=$6,
         address=$7, city=$8, phone=$9, email=$10,
         rib=$11, bank_name=$12, payment_conditions=$13,
         type_comptabilite=$14, collaborateur=$15, chef_de_mission=$16, statut=$17,
         collaborateur_id=$18, chef_de_mission_id=$19,
         pilote_pa=$20, abonnement=$21, expert_comptable=$22, frequence_tva=$23,
         categorie_fiscale=$24, regime_fiscal=$25, jour_tva=$26, date_cloture=$27,
         perimetre_mission=$28, expert_comptable_id=$29, pilote_pa_id=$30,
         updated_at=NOW()
       WHERE id=$31 AND user_id=$32
       RETURNING *`,
      [name, forme_juridique || null, ice || null, idf || null, rc || null, cnss || null,
       address || null, city || null, phone || null, email || null,
       rib || null, bank_name || null, payment_conditions || null,
       type_comptabilite || 'Engagement', collaborateur || null, chef_de_mission || null,
       statut || 'actif', collaborateur_id || null, chef_de_mission_id || null,
       pilote_pa || null, abonnement || 'Collaboratif', expert_comptable || null,
       frequence_tva || 'Mensuelle',
       categorie_fiscale || 'IS', regime_fiscal || 'Normal',
       jour_tva ? parseInt(jour_tva) : 20, date_cloture || '31/12',
       perimetre_mission || 'Tenue complète',
       expert_comptable_id || null, pilote_pa_id || null,
       id, ownerId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Dossier non trouve' });
    res.json({ dossier: result.rows[0] });
  } catch (err) {
    console.error('PUT /api/cabinet/dossiers/:id error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/cabinet/dossiers/:id/invite-client — send or resend client invitation email
app.post('/api/cabinet/dossiers/:id/invite-client', requireAuth, requireCabinetRole(['admin']), inviteRateLimit, async (req, res) => {
  try {
    const { id } = req.params;
    const ownerId = req.cabinetOwnerId || req.userId;

    // Get dossier info
    const dossierResult = await pool.query(
      'SELECT id, name, email, client_invitation_status, client_user_id FROM companies WHERE id = $1 AND user_id = $2',
      [id, ownerId]
    );
    if (dossierResult.rows.length === 0) return res.status(404).json({ error: 'Dossier non trouvé' });

    const dossier = dossierResult.rows[0];
    if (!dossier.email) return res.status(400).json({ error: 'Ce dossier n\'a pas d\'email client. Ajoutez un email avant d\'envoyer une invitation.' });

    // If client already has an accepted account, no need to send again
    if (dossier.client_invitation_status === 'accepted' && dossier.client_user_id) {
      return res.status(400).json({ error: 'Le client a déjà créé son espace. Vous pouvez réinitialiser l\'invitation depuis le dossier si besoin.' });
    }

    // Check for role conflict: cannot invite a cabinet collaborator as a client
    const conflictCheck = await pool.query(
      'SELECT id, user_type FROM users WHERE LOWER(email) = LOWER($1)',
      [dossier.email]
    );
    if (conflictCheck.rows.length > 0 && conflictCheck.rows[0].user_type === 'cabinet') {
      return res.status(409).json({
        error: 'Cette adresse email est déjà associée à un compte collaborateur de cabinet. Un collaborateur ne peut pas être client et inversement.',
        conflicting_role: 'cabinet'
      });
    }

    // Get cabinet name for email
    const cabinetResult = await pool.query('SELECT name, email FROM users WHERE id = $1', [ownerId]);
    const cabinetName = cabinetResult.rows[0]?.name || 'Votre cabinet';

    // Generate a secure token (32 random bytes = 64 hex chars)
    const token = require('crypto').randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    // Save token to dossier
    await pool.query(
      `UPDATE companies SET
         client_invitation_token = $1,
         client_invitation_expires_at = $2,
         client_invitation_status = 'pending'
       WHERE id = $3`,
      [token, expiresAt, id]
    );

    // Send invitation email
    const inviteUrl = `https://hissabpro.polsia.app/invite/${token}`;
    const subject = `${cabinetName} vous invite à rejoindre HissabPro`;
    const htmlBody = buildInvitationEmail(cabinetName, dossier.name, inviteUrl);
    await sendNotificationEmail(dossier.email, subject, htmlBody);

    res.json({ ok: true, invitation_status: 'pending', expires_at: expiresAt });
  } catch (err) {
    console.error('POST /api/cabinet/dossiers/:id/invite-client error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/cabinet/switch/:id — switch active company context (0 = clear)
app.post('/api/cabinet/switch/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const cookies = parseCookies(req);
    const token = cookies.session_token;

    const companyId = parseInt(id) === 0 ? null : parseInt(id);
    const ownerId = req.cabinetOwnerId || req.userId;
    if (companyId) {
      // Build ownership check — for comptable/assistant, also verify they're assigned to this dossier
      let checkQuery = 'SELECT id, name FROM companies WHERE id = $1 AND user_id = $2';
      let checkParams = [companyId, ownerId];
      if (req.cabinetRole === 'comptable' || req.cabinetRole === 'assistant') {
        checkParams.push(req.userId);
        checkQuery += ` AND (collaborateur_id = $${checkParams.length} OR chef_de_mission_id = $${checkParams.length})`;
      }
      const check = await pool.query(checkQuery, checkParams);
      if (check.rows.length === 0) return res.status(403).json({ error: 'Dossier non autorise' });
      await pool.query('UPDATE sessions SET active_company_id = $1 WHERE token = $2', [companyId, token]);
      res.json({ ok: true, active_company_id: companyId, name: check.rows[0].name });
    } else {
      await pool.query('UPDATE sessions SET active_company_id = NULL WHERE token = $1', [token]);
      res.json({ ok: true, active_company_id: null });
    }
  } catch (err) {
    console.error('POST /api/cabinet/switch/:id error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/cabinet/collaborateurs — list cabinet members (for assignment dropdowns) + legacy string names
app.get('/api/cabinet/collaborateurs', requireAuth, async (req, res) => {
  try {
    const ownerId = req.cabinetOwnerId || req.userId;
    // Return actual cabinet members (for role-based assignment)
    const membersResult = await pool.query(
      `SELECT u.id, u.name, u.email, cm.role
       FROM cabinet_members cm
       JOIN users u ON u.id = cm.member_user_id
       WHERE cm.cabinet_owner_id = $1 AND cm.status = 'active'
       ORDER BY u.name`,
      [ownerId]
    );
    // Also return legacy string-based names for backwards compat
    const result = await pool.query(
      `SELECT DISTINCT collaborateur FROM companies WHERE user_id = $1 AND collaborateur IS NOT NULL AND collaborateur != '' ORDER BY collaborateur`,
      [ownerId]
    );
    const chefResult = await pool.query(
      `SELECT DISTINCT chef_de_mission FROM companies WHERE user_id = $1 AND chef_de_mission IS NOT NULL AND chef_de_mission != '' ORDER BY chef_de_mission`,
      [ownerId]
    );
    res.json({
      members: membersResult.rows,
      collaborateurs: result.rows.map(r => r.collaborateur),
      chefs_de_mission: chefResult.rows.map(r => r.chef_de_mission)
    });
  } catch (err) {
    console.error('GET /api/cabinet/collaborateurs error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================================
// PHASE B — CABINET COLLABORATION (Messages, Documents, Justificatifs)
// ============================================================

// Helper: verify company belongs to cabinet (uses cabinetOwnerId for member support)
async function requireCabinetCompany(req, res) {
  const companyId = parseInt(req.params.company_id || req.body.company_id || req.query.company_id);
  if (!companyId) { res.status(400).json({ error: 'company_id requis' }); return null; }
  const ownerId = req.cabinetOwnerId || req.userId;
  let checkQuery = 'SELECT id FROM companies WHERE id = $1 AND user_id = $2';
  let checkParams = [companyId, ownerId];
  // Comptable/assistant: additionally verify they're assigned to this dossier
  if (req.cabinetRole === 'comptable' || req.cabinetRole === 'assistant') {
    checkParams.push(req.userId);
    checkQuery += ` AND (collaborateur_id = $${checkParams.length} OR chef_de_mission_id = $${checkParams.length})`;
  }
  const check = await pool.query(checkQuery, checkParams);
  if (check.rows.length === 0) { res.status(403).json({ error: 'Dossier non autorisé' }); return null; }
  return companyId;
}

// ---- MESSAGES / BOÎTE DE RÉCEPTION ----

// GET /api/cabinet/messages?company_id=X — list messages for a dossier
app.get('/api/cabinet/messages', requireAuth, async (req, res) => {
  try {
    const companyId = parseInt(req.query.company_id);
    if (!companyId) return res.status(400).json({ error: 'company_id requis' });
    const ownerId = req.cabinetOwnerId || req.userId;
    const check = await pool.query('SELECT id FROM companies WHERE id = $1 AND user_id = $2', [companyId, ownerId]);
    if (check.rows.length === 0) return res.status(403).json({ error: 'Dossier non autorisé' });

    const result = await pool.query(
      `SELECT m.*, array_agg(json_build_object('id', a.id, 'filename', a.filename, 'content_type', a.content_type) ORDER BY a.id) FILTER (WHERE a.id IS NOT NULL) as attachments
       FROM cabinet_messages m
       LEFT JOIN cabinet_message_attachments a ON a.message_id = m.id
       WHERE m.company_id = $1 AND m.cabinet_user_id = $2
       GROUP BY m.id
       ORDER BY m.created_at DESC
       LIMIT 100`,
      [companyId, ownerId]
    );
    res.json({ messages: result.rows });
  } catch (err) {
    console.error('GET /api/cabinet/messages error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/cabinet/messages — create a message
app.post('/api/cabinet/messages', requireAuth, async (req, res) => {
  try {
    const { company_id, message_type, content } = req.body;
    if (!company_id || !content) return res.status(400).json({ error: 'company_id et content requis' });

    const ownerId = req.cabinetOwnerId || req.userId;
    const check = await pool.query('SELECT id FROM companies WHERE id = $1 AND user_id = $2', [company_id, ownerId]);
    if (check.rows.length === 0) return res.status(403).json({ error: 'Dossier non autorisé' });

    const userResult = await pool.query('SELECT name, email FROM users WHERE id = $1', [req.userId]);
    const senderName = userResult.rows[0]?.name || userResult.rows[0]?.email || 'Cabinet';
    const type = ['demande', 'document', 'message'].includes(message_type) ? message_type : 'message';

    const result = await pool.query(
      `INSERT INTO cabinet_messages (company_id, cabinet_user_id, sender_user_id, sender_name, message_type, content)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [company_id, ownerId, req.userId, senderName, type, content.trim()]
    );

    // Notify client about new message
    const msgCompInfo = await pool.query('SELECT name FROM companies WHERE id = $1', [company_id]).catch(() => ({ rows: [] }));
    const msgCompName = msgCompInfo.rows[0]?.name || 'votre dossier';
    const preview = content.trim().length > 80 ? content.trim().substring(0, 80) + '...' : content.trim();
    notifyClient(req.userId, company_id, 'new_message',
      `💬 Nouveau message de ${senderName}`,
      `${senderName} vous a envoyé un message concernant ${msgCompName} : "${preview}"`,
      '/app#inbox'
    ).catch(() => {});

    res.status(201).json({ message: result.rows[0] });
  } catch (err) {
    console.error('POST /api/cabinet/messages error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/cabinet/messages/:id/read — mark as read
app.put('/api/cabinet/messages/:id/read', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const ownerId = req.cabinetOwnerId || req.userId;
    await pool.query(
      'UPDATE cabinet_messages SET is_read = true WHERE id = $1 AND cabinet_user_id = $2',
      [id, ownerId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/cabinet/messages/:id/read error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/cabinet/messages/read-all — mark all as read for a dossier
app.put('/api/cabinet/messages/read-all', requireAuth, async (req, res) => {
  try {
    const { company_id } = req.body;
    if (!company_id) return res.status(400).json({ error: 'company_id requis' });
    const ownerId = req.cabinetOwnerId || req.userId;
    await pool.query(
      'UPDATE cabinet_messages SET is_read = true WHERE company_id = $1 AND cabinet_user_id = $2',
      [company_id, ownerId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/cabinet/messages/read-all error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/cabinet/messages/:id — delete a message
app.delete('/api/cabinet/messages/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const ownerId = req.cabinetOwnerId || req.userId;
    await pool.query(
      'DELETE FROM cabinet_messages WHERE id = $1 AND cabinet_user_id = $2',
      [id, ownerId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/cabinet/messages/:id error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ---- DOCUMENTS ----

// GET /api/cabinet/documents?company_id=X — list documents for a dossier
app.get('/api/cabinet/documents', requireAuth, async (req, res) => {
  try {
    const companyId = parseInt(req.query.company_id);
    if (!companyId) return res.status(400).json({ error: 'company_id requis' });
    const ownerId = req.cabinetOwnerId || req.userId;
    const check = await pool.query('SELECT id FROM companies WHERE id = $1 AND user_id = $2', [companyId, ownerId]);
    if (check.rows.length === 0) return res.status(403).json({ error: 'Dossier non autorisé' });

    const { category, period_month, period_year } = req.query;
    let whereClause = 'WHERE d.company_id = $1 AND d.cabinet_user_id = $2';
    const params = [companyId, ownerId];
    let paramIdx = 3;

    if (category) { whereClause += ` AND d.category = $${paramIdx++}`; params.push(category); }
    if (period_month) { whereClause += ` AND d.period_month = $${paramIdx++}`; params.push(parseInt(period_month)); }
    if (period_year) { whereClause += ` AND d.period_year = $${paramIdx++}`; params.push(parseInt(period_year)); }

    const result = await pool.query(
      `SELECT id, company_id, cabinet_user_id, uploaded_by_user_id, uploader_name, filename,
              content_type, category, period_month, period_year, file_size, created_at
       FROM cabinet_documents d
       ${whereClause}
       ORDER BY d.created_at DESC
       LIMIT 200`,
      params
    );
    res.json({ documents: result.rows });
  } catch (err) {
    console.error('GET /api/cabinet/documents error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/cabinet/documents — upload a document
app.post('/api/cabinet/documents', requireAuth, async (req, res) => {
  try {
    const { company_id, filename, file_data, content_type, category, period_month, period_year } = req.body;
    if (!company_id || !filename || !file_data) return res.status(400).json({ error: 'company_id, filename, file_data requis' });

    const ownerId = req.cabinetOwnerId || req.userId;
    const check = await pool.query('SELECT id FROM companies WHERE id = $1 AND user_id = $2', [company_id, ownerId]);
    if (check.rows.length === 0) return res.status(403).json({ error: 'Dossier non autorisé' });

    if (file_data.length > 20 * 1024 * 1024) return res.status(400).json({ error: 'Fichier trop volumineux (max 15 Mo)' });

    const userResult = await pool.query('SELECT name, email FROM users WHERE id = $1', [req.userId]);
    const uploaderName = userResult.rows[0]?.name || userResult.rows[0]?.email || 'Cabinet';
    const cat = ['facture', 'releve_bancaire', 'justificatif', 'bulletin_paie', 'contrat', 'autre'].includes(category) ? category : 'autre';
    const fileSize = Math.round(file_data.length * 0.75); // approximate decoded bytes

    const result = await pool.query(
      `INSERT INTO cabinet_documents (company_id, cabinet_user_id, uploaded_by_user_id, uploader_name, filename, file_data, content_type, category, period_month, period_year, file_size)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id, company_id, filename, content_type, category, period_month, period_year, file_size, uploader_name, created_at`,
      [company_id, ownerId, req.userId, uploaderName, filename.trim(), file_data, content_type || 'application/octet-stream', cat,
       period_month ? parseInt(period_month) : null, period_year ? parseInt(period_year) : null, fileSize]
    );

    // Notify cabinet user (self) about document uploaded — useful as activity record
    const docCompInfo = await pool.query('SELECT name FROM companies WHERE id = $1', [company_id]).catch(() => ({ rows: [] }));
    const docCompName = docCompInfo.rows[0]?.name || 'dossier';
    notifyCabinet(req.userId, company_id, 'document_uploaded',
      '📄 Document ajouté',
      `Document "${filename.trim()}" ajouté dans le dossier ${docCompName}.`,
      '/app#documents'
    ).catch(() => {});

    res.status(201).json({ document: result.rows[0] });
  } catch (err) {
    console.error('POST /api/cabinet/documents error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/cabinet/documents/:id/download — download a document
app.get('/api/cabinet/documents/:id/download', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const ownerId = req.cabinetOwnerId || req.userId;
    const result = await pool.query(
      'SELECT * FROM cabinet_documents WHERE id = $1 AND cabinet_user_id = $2',
      [id, ownerId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Document non trouvé' });
    const doc = result.rows[0];
    // Return the data URL directly for client-side download
    res.json({ file_data: doc.file_data, filename: doc.filename, content_type: doc.content_type });
  } catch (err) {
    console.error('GET /api/cabinet/documents/:id/download error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/cabinet/documents/:id — delete a document
app.delete('/api/cabinet/documents/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const ownerId = req.cabinetOwnerId || req.userId;
    await pool.query('DELETE FROM cabinet_documents WHERE id = $1 AND cabinet_user_id = $2', [id, ownerId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/cabinet/documents/:id error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ---- DEMANDES DE JUSTIFICATIFS ----

// GET /api/cabinet/justificatifs?company_id=X — list requests
app.get('/api/cabinet/justificatifs', requireAuth, async (req, res) => {
  try {
    const companyId = parseInt(req.query.company_id);
    if (!companyId) return res.status(400).json({ error: 'company_id requis' });
    const ownerId = req.cabinetOwnerId || req.userId;
    const check = await pool.query('SELECT id FROM companies WHERE id = $1 AND user_id = $2', [companyId, ownerId]);
    if (check.rows.length === 0) return res.status(403).json({ error: 'Dossier non autorisé' });

    const result = await pool.query(
      `SELECT j.*, d.filename as document_filename, d.category as document_category
       FROM cabinet_justificatif_requests j
       LEFT JOIN cabinet_documents d ON d.id = j.document_id
       WHERE j.company_id = $1 AND j.cabinet_user_id = $2
       ORDER BY j.created_at DESC`,
      [companyId, ownerId]
    );
    res.json({ requests: result.rows });
  } catch (err) {
    console.error('GET /api/cabinet/justificatifs error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/cabinet/justificatifs — create a request (admin and comptable)
app.post('/api/cabinet/justificatifs', requireAuth, async (req, res) => {
  try {
    const { company_id, title, description, deadline } = req.body;
    if (!company_id || !title) return res.status(400).json({ error: 'company_id et title requis' });

    const ownerId = req.cabinetOwnerId || req.userId;
    const check = await pool.query('SELECT id FROM companies WHERE id = $1 AND user_id = $2', [company_id, ownerId]);
    if (check.rows.length === 0) return res.status(403).json({ error: 'Dossier non autorisé' });

    const userResult = await pool.query('SELECT name, email FROM users WHERE id = $1', [req.userId]);
    const requesterName = userResult.rows[0]?.name || userResult.rows[0]?.email || 'Cabinet';

    const result = await pool.query(
      `INSERT INTO cabinet_justificatif_requests (company_id, cabinet_user_id, requested_by_user_id, requester_name, title, description, deadline)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [company_id, ownerId, req.userId, requesterName, title.trim(), description || null, deadline || null]
    );

    // Notify client about new justificatif request
    const compInfo = await pool.query('SELECT name FROM companies WHERE id = $1', [company_id]).catch(() => ({ rows: [] }));
    const compName = compInfo.rows[0]?.name || 'votre dossier';
    notifyClient(req.userId, company_id, 'new_justificatif_request',
      '📋 Nouvelle demande de justificatif',
      `Votre cabinet vous demande de fournir un justificatif : "${title.trim()}" pour ${compName}.`,
      '/app#justificatifs'
    ).catch(() => {});

    res.status(201).json({ request: result.rows[0] });
  } catch (err) {
    console.error('POST /api/cabinet/justificatifs error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/cabinet/justificatifs/:id — update status or details (admin and comptable can validate)
app.put('/api/cabinet/justificatifs/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { status, title, description, deadline } = req.body;
    const validStatuses = ['pending', 'provided', 'validated'];
    if (status && !validStatuses.includes(status)) return res.status(400).json({ error: 'Statut invalide' });
    // Assistants cannot validate
    if (status === 'validated' && req.cabinetRole === 'assistant') {
      return res.status(403).json({ error: 'Les assistants ne peuvent pas valider les demandes' });
    }

    const ownerId = req.cabinetOwnerId || req.userId;
    const existing = await pool.query(
      'SELECT id FROM cabinet_justificatif_requests WHERE id = $1 AND cabinet_user_id = $2',
      [id, ownerId]
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Demande non trouvée' });

    const updates = [];
    const params = [];
    let idx = 1;
    if (status) { updates.push(`status = $${idx++}`); params.push(status); }
    if (title) { updates.push(`title = $${idx++}`); params.push(title.trim()); }
    if (description !== undefined) { updates.push(`description = $${idx++}`); params.push(description || null); }
    if (deadline !== undefined) { updates.push(`deadline = $${idx++}`); params.push(deadline || null); }
    updates.push(`updated_at = NOW()`);
    params.push(id);

    const result = await pool.query(
      `UPDATE cabinet_justificatif_requests SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );

    // Notify client when justificatif is validated
    if (status === 'validated' && result.rows[0]) {
      const jReq = result.rows[0];
      const valCompInfo = await pool.query('SELECT name FROM companies WHERE id = $1', [jReq.company_id]).catch(() => ({ rows: [] }));
      const valCompName = valCompInfo.rows[0]?.name || 'votre dossier';
      notifyClient(req.userId, jReq.company_id, 'justificatif_validated',
        '✅ Justificatif validé',
        `Votre justificatif "${jReq.title}" a été validé par votre cabinet pour ${valCompName}.`,
        '/app#justificatifs'
      ).catch(() => {});
    }

    res.json({ request: result.rows[0] });
  } catch (err) {
    console.error('PUT /api/cabinet/justificatifs/:id error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/cabinet/justificatifs/:id/respond — attach a document to a request
app.post('/api/cabinet/justificatifs/:id/respond', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { document_id } = req.body;
    if (!document_id) return res.status(400).json({ error: 'document_id requis' });

    const ownerId = req.cabinetOwnerId || req.userId;
    const existing = await pool.query(
      'SELECT id FROM cabinet_justificatif_requests WHERE id = $1 AND cabinet_user_id = $2',
      [id, ownerId]
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Demande non trouvée' });

    const result = await pool.query(
      `UPDATE cabinet_justificatif_requests SET document_id = $1, status = 'provided', updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [document_id, id]
    );
    res.json({ request: result.rows[0] });
  } catch (err) {
    console.error('POST /api/cabinet/justificatifs/:id/respond error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/cabinet/justificatifs/:id — delete a request (admin only)
app.delete('/api/cabinet/justificatifs/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const ownerId = req.cabinetOwnerId || req.userId;
    await pool.query(
      'DELETE FROM cabinet_justificatif_requests WHERE id = $1 AND cabinet_user_id = $2',
      [id, ownerId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/cabinet/justificatifs/:id error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/cabinet/collaboration/stats?company_id=X — unread messages + pending justificatifs count
app.get('/api/cabinet/collaboration/stats', requireAuth, async (req, res) => {
  try {
    const companyId = parseInt(req.query.company_id);
    if (!companyId) return res.status(400).json({ error: 'company_id requis' });
    const ownerId = req.cabinetOwnerId || req.userId;
    const check = await pool.query('SELECT id FROM companies WHERE id = $1 AND user_id = $2', [companyId, ownerId]);
    if (check.rows.length === 0) return res.status(403).json({ error: 'Dossier non autorisé' });

    const [unread, pending, docs] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM cabinet_messages WHERE company_id = $1 AND cabinet_user_id = $2 AND is_read = false', [companyId, ownerId]),
      pool.query('SELECT COUNT(*) FROM cabinet_justificatif_requests WHERE company_id = $1 AND cabinet_user_id = $2 AND status = \'pending\'', [companyId, ownerId]),
      pool.query('SELECT COUNT(*) FROM cabinet_documents WHERE company_id = $1 AND cabinet_user_id = $2', [companyId, ownerId])
    ]);
    res.json({
      unread_messages: parseInt(unread.rows[0].count),
      pending_justificatifs: parseInt(pending.rows[0].count),
      total_documents: parseInt(docs.rows[0].count)
    });
  } catch (err) {
    console.error('GET /api/cabinet/collaboration/stats error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================================
// CABINET MEMBERS (RBAC)
// ============================================================

// GET /api/cabinet/members — list all members of this cabinet (admin only)
app.get('/api/cabinet/members', requireAuth, requireCabinetRole(['admin']), async (req, res) => {
  try {
    const ownerId = req.cabinetOwnerId || req.userId;
    const result = await pool.query(
      `SELECT cm.id, cm.member_user_id, cm.role, cm.status, cm.invite_status, cm.invited_at, cm.created_at,
              u.name, u.email,
              (SELECT COUNT(*)::int FROM companies
               WHERE user_id = $1
                 AND (collaborateur_id = cm.member_user_id OR chef_de_mission_id = cm.member_user_id)
              ) as dossier_count
       FROM cabinet_members cm
       JOIN users u ON u.id = cm.member_user_id
       WHERE cm.cabinet_owner_id = $1
       ORDER BY cm.created_at ASC`,
      [ownerId]
    );
    res.json({ members: result.rows });
  } catch (err) {
    console.error('GET /api/cabinet/members error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/cabinet/members — invite a member (admin only)
app.post('/api/cabinet/members', requireAuth, requireCabinetRole(['admin']), inviteRateLimit, async (req, res) => {
  try {
    const { email, name, role } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requis' });
    const validRoles = ['comptable', 'assistant', 'chef_mission', 'collaborateur'];
    if (!validRoles.includes(role)) return res.status(400).json({ error: 'Rôle invalide (chef_mission, collaborateur, comptable ou assistant)' });

    const ownerId = req.cabinetOwnerId || req.userId;

    // Check if user exists
    let userResult = await pool.query('SELECT id, email, name, user_type FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    let memberId;

    if (userResult.rows.length > 0) {
      // User exists — check for role conflict (entreprise cannot become cabinet collaborator)
      const existingUser = userResult.rows[0];
      if (existingUser.user_type === 'standard') {
        return res.status(409).json({
          error: 'Cette adresse email est déjà associée à un compte entreprise. Un collaborateur ne peut pas être client et inversement.',
          conflicting_role: 'standard'
        });
      }
      memberId = existingUser.id;
      if (memberId === ownerId) return res.status(400).json({ error: 'Vous ne pouvez pas vous ajouter vous-même' });
    } else {
      // User doesn't exist — create account without password (set via invite link)
      const newUser = await pool.query(
        'INSERT INTO users (email, name, password_hash, user_type) VALUES (LOWER($1), $2, NULL, $3) RETURNING id',
        [email, name || null, 'cabinet']
      );
      memberId = newUser.rows[0].id;
    }

    // Check if already a member
    const existingMember = await pool.query(
      'SELECT id FROM cabinet_members WHERE cabinet_owner_id = $1 AND member_user_id = $2',
      [ownerId, memberId]
    );
    if (existingMember.rows.length > 0) {
      return res.status(409).json({ error: 'Cet utilisateur est déjà membre du cabinet' });
    }

    // Set user cabinet role and type
    await pool.query('UPDATE users SET cabinet_role = $1, user_type = $2 WHERE id = $3', [role, 'cabinet', memberId]);

    // Generate invite token (7-day expiry)
    const inviteToken = require('crypto').randomBytes(32).toString('hex');
    const inviteExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    // Create cabinet_members record with pending invite status
    const memberRecord = await pool.query(
      `INSERT INTO cabinet_members
         (cabinet_owner_id, member_user_id, role, status, invite_token, invite_expires_at, invite_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [ownerId, memberId, role, 'active', inviteToken, inviteExpires, 'pending']
    );

    // Get cabinet name for email
    const cabinetResult = await pool.query('SELECT name FROM users WHERE id = $1', [ownerId]);
    const cabinetName = cabinetResult.rows[0]?.name || 'Votre cabinet';
    const roleLabel = { chef_mission: 'Chef de mission', collaborateur: 'Collaborateur', comptable: 'Comptable', assistant: 'Assistant' }[role] || role;

    // Send invitation email
    const inviteUrl = `https://hissabpro.polsia.app/member-invite/${inviteToken}`;
    const inviteSubject = `${cabinetName} vous invite à rejoindre HissabPro`;
    const inviteHtml = buildMemberInviteEmail(cabinetName, name || email, roleLabel, inviteUrl);
    sendNotificationEmail(email, inviteSubject, inviteHtml).catch(() => {});

    res.status(201).json({
      member: { ...memberRecord.rows[0], email, name: name || email },
      invite_url: inviteUrl,
      invite_sent: true
    });
  } catch (err) {
    console.error('POST /api/cabinet/members error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/cabinet/members/:id — update role or status (admin only)
app.put('/api/cabinet/members/:id', requireAuth, requireCabinetRole(['admin']), async (req, res) => {
  try {
    const { id } = req.params;
    const { role, status } = req.body;
    const ownerId = req.cabinetOwnerId || req.userId;

    const validRoles = ['comptable', 'assistant', 'chef_mission', 'collaborateur'];
    const validStatuses = ['active', 'inactive'];
    if (role && !validRoles.includes(role)) return res.status(400).json({ error: 'Rôle invalide' });
    if (status && !validStatuses.includes(status)) return res.status(400).json({ error: 'Statut invalide' });

    const updates = [];
    const params = [];
    let idx = 1;
    if (role) { updates.push(`role = $${idx++}`); params.push(role); }
    if (status) { updates.push(`status = $${idx++}`); params.push(status); }
    if (updates.length === 0) return res.status(400).json({ error: 'Aucune modification' });

    params.push(id, ownerId);
    const result = await pool.query(
      `UPDATE cabinet_members SET ${updates.join(', ')} WHERE id = $${idx} AND cabinet_owner_id = $${idx + 1} RETURNING *, (SELECT email FROM users WHERE id = member_user_id) as email, (SELECT name FROM users WHERE id = member_user_id) as name`,
      params
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Membre non trouvé' });

    // Sync cabinet_role on users table
    const member = result.rows[0];
    if (role) await pool.query('UPDATE users SET cabinet_role = $1 WHERE id = $2', [role, member.member_user_id]);
    if (status === 'inactive') {
      // Remove active role and invalidate all sessions immediately
      await pool.query('UPDATE users SET cabinet_role = NULL WHERE id = $1', [member.member_user_id]);
      await pool.query('DELETE FROM sessions WHERE user_id = $1', [member.member_user_id]);
    } else if (status === 'active' && member.role) {
      await pool.query('UPDATE users SET cabinet_role = $1 WHERE id = $2', [member.role, member.member_user_id]);
    }

    res.json({ member: result.rows[0] });
  } catch (err) {
    console.error('PUT /api/cabinet/members/:id error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/cabinet/members/:id/resend-invite — resend invitation email (admin only)
app.post('/api/cabinet/members/:id/resend-invite', requireAuth, requireCabinetRole(['admin']), inviteRateLimit, async (req, res) => {
  try {
    const { id } = req.params;
    const ownerId = req.cabinetOwnerId || req.userId;

    const memberResult = await pool.query(
      `SELECT cm.*, u.email, u.name FROM cabinet_members cm
       JOIN users u ON u.id = cm.member_user_id
       WHERE cm.id = $1 AND cm.cabinet_owner_id = $2`,
      [id, ownerId]
    );
    if (memberResult.rows.length === 0) return res.status(404).json({ error: 'Membre non trouvé' });

    const member = memberResult.rows[0];

    // Generate new invite token
    const inviteToken = require('crypto').randomBytes(32).toString('hex');
    const inviteExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await pool.query(
      `UPDATE cabinet_members SET invite_token = $1, invite_expires_at = $2, invite_status = 'pending' WHERE id = $3`,
      [inviteToken, inviteExpires, id]
    );

    // Get cabinet name
    const cabinetResult = await pool.query('SELECT name FROM users WHERE id = $1', [ownerId]);
    const cabinetName = cabinetResult.rows[0]?.name || 'Votre cabinet';
    const roleLabel = { chef_mission: 'Chef de mission', collaborateur: 'Collaborateur', comptable: 'Comptable', assistant: 'Assistant' }[member.role] || member.role;

    const inviteUrl = `https://hissabpro.polsia.app/member-invite/${inviteToken}`;
    const inviteHtml = buildMemberInviteEmail(cabinetName, member.name || member.email, roleLabel, inviteUrl);
    sendNotificationEmail(member.email, `${cabinetName} vous invite à rejoindre HissabPro`, inviteHtml).catch(() => {});

    res.json({ ok: true, invite_url: inviteUrl });
  } catch (err) {
    console.error('POST /api/cabinet/members/:id/resend-invite error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/cabinet/members/:id — remove a member (admin only)
app.delete('/api/cabinet/members/:id', requireAuth, requireCabinetRole(['admin']), async (req, res) => {
  try {
    const { id } = req.params;
    const ownerId = req.cabinetOwnerId || req.userId;

    const member = await pool.query(
      'DELETE FROM cabinet_members WHERE id = $1 AND cabinet_owner_id = $2 RETURNING member_user_id',
      [id, ownerId]
    );
    if (member.rows.length === 0) return res.status(404).json({ error: 'Membre non trouvé' });

    // Clear their cabinet role
    await pool.query('UPDATE users SET cabinet_role = NULL WHERE id = $1', [member.rows[0].member_user_id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/cabinet/members/:id error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================================
// CABINET PERMISSIONS API
// ============================================================

// PERMISSIONS_MATRIX — cached in-memory, populated from DB on first call
let _rolesCache = null;
async function getRolesCache() {
  if (_rolesCache) return _rolesCache;
  const result = await pool.query('SELECT name, permissions FROM roles');
  const map = {};
  for (const row of result.rows) map[row.name] = row.permissions;
  _rolesCache = map;
  // Refresh every 10 minutes
  setTimeout(() => { _rolesCache = null; }, 10 * 60 * 1000);
  return map;
}

// GET /api/cabinet/permissions — return current user's permission matrix
// Used by frontend to know which nav items to show and which actions to allow
app.get('/api/cabinet/permissions', requireAuth, async (req, res) => {
  try {
    // Cabinet users: look up role from cabinet_role column
    if (req.userType === 'cabinet') {
      const role = req.cabinetRole;
      if (!role) return res.json({ permissions: {}, role: null });

      // Map cabinet_role values to roles table names
      const roleNameMap = {
        admin:        'admin_cabinet',
        chef_mission: 'chef_mission',
        collaborateur:'collaborateur',
        comptable:    'comptable',
        assistant:    'assistant'
      };
      const roleName = roleNameMap[role] || role;
      const cache = await getRolesCache();
      const permissions = cache[roleName] || {};
      return res.json({ permissions, role, role_name: roleName });
    }

    // Standard/client users — check company-level role (client_gerant or client_employe)
    if (req.userType === 'standard') {
      const cache = await getRolesCache();
      // Find which dossiers this user is a client of and what role they have
      const clientCompanies = await pool.query(
        `SELECT id, client_role FROM companies WHERE client_user_id = $1`,
        [req.userId]
      );
      if (clientCompanies.rows.length === 0) {
        return res.json({ permissions: {}, role: null });
      }
      // Return map of company_id -> permissions
      const dossierPerms = {};
      for (const row of clientCompanies.rows) {
        const clientRoleName = row.client_role === 'employe' ? 'client_employe' : 'client_gerant';
        dossierPerms[row.id] = cache[clientRoleName] || {};
      }
      return res.json({ permissions: cache['client_gerant'] || {}, role: 'client', dossier_permissions: dossierPerms });
    }

    res.json({ permissions: {}, role: null });
  } catch (err) {
    console.error('GET /api/cabinet/permissions error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/cabinet/members/:id/dossiers — list dossiers assigned to a member (admin only)
app.get('/api/cabinet/members/:id/dossiers', requireAuth, requireCabinetRole(['admin']), async (req, res) => {
  try {
    const { id } = req.params;
    const ownerId = req.cabinetOwnerId || req.userId;

    // Get the member's user_id
    const member = await pool.query(
      'SELECT member_user_id, role FROM cabinet_members WHERE id = $1 AND cabinet_owner_id = $2',
      [id, ownerId]
    );
    if (member.rows.length === 0) return res.status(404).json({ error: 'Membre non trouvé' });

    const memberUserId = member.rows[0].member_user_id;

    // Get all cabinet dossiers with assignment status for this member
    const result = await pool.query(
      `SELECT c.id, c.name,
              (c.collaborateur_id = $1 OR c.chef_de_mission_id = $1) as assigned
       FROM companies c
       WHERE c.user_id = $2
       ORDER BY c.name ASC`,
      [memberUserId, ownerId]
    );

    res.json({ dossiers: result.rows, member: member.rows[0] });
  } catch (err) {
    console.error('GET /api/cabinet/members/:id/dossiers error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/cabinet/members/:id/dossiers — update dossier assignments for a member (admin only)
// Body: { dossier_ids: [1, 2, 3] } — replaces all assignments
app.put('/api/cabinet/members/:id/dossiers', requireAuth, requireCabinetRole(['admin']), async (req, res) => {
  try {
    const { id } = req.params;
    const { dossier_ids } = req.body;
    if (!Array.isArray(dossier_ids)) return res.status(400).json({ error: 'dossier_ids doit être un tableau' });

    const ownerId = req.cabinetOwnerId || req.userId;

    // Get the member
    const member = await pool.query(
      'SELECT member_user_id, role FROM cabinet_members WHERE id = $1 AND cabinet_owner_id = $2',
      [id, ownerId]
    );
    if (member.rows.length === 0) return res.status(404).json({ error: 'Membre non trouvé' });

    const memberUserId = member.rows[0].member_user_id;
    const memberRole = member.rows[0].role;

    // Determine which column to use based on role
    const isChef = memberRole === 'chef_mission';
    const colToSet = isChef ? 'chef_de_mission_id' : 'collaborateur_id';
    const colToClear = isChef ? 'collaborateur_id' : 'chef_de_mission_id';

    // Validate all dossier_ids belong to this cabinet
    if (dossier_ids.length > 0) {
      const valid = await pool.query(
        `SELECT id FROM companies WHERE id = ANY($1::int[]) AND user_id = $2`,
        [dossier_ids, ownerId]
      );
      if (valid.rows.length !== dossier_ids.length) {
        return res.status(400).json({ error: 'Un ou plusieurs dossiers sont invalides' });
      }
    }

    // Clear this member from ALL companies in the cabinet
    await pool.query(
      `UPDATE companies SET collaborateur_id = NULL WHERE collaborateur_id = $1 AND user_id = $2`,
      [memberUserId, ownerId]
    );
    await pool.query(
      `UPDATE companies SET chef_de_mission_id = NULL WHERE chef_de_mission_id = $1 AND user_id = $2`,
      [memberUserId, ownerId]
    );

    // Assign to selected dossiers
    if (dossier_ids.length > 0) {
      await pool.query(
        `UPDATE companies SET ${colToSet} = $1 WHERE id = ANY($2::int[]) AND user_id = $3`,
        [memberUserId, dossier_ids, ownerId]
      );
    }

    // Return updated dossier list
    const updated = await pool.query(
      `SELECT c.id, c.name,
              (c.collaborateur_id = $1 OR c.chef_de_mission_id = $1) as assigned
       FROM companies c WHERE c.user_id = $2 ORDER BY c.name ASC`,
      [memberUserId, ownerId]
    );

    res.json({ ok: true, dossiers: updated.rows, assigned_count: dossier_ids.length });
  } catch (err) {
    console.error('PUT /api/cabinet/members/:id/dossiers error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/cabinet/members-with-dossiers — enriched member list including assigned dossier names
app.get('/api/cabinet/members-with-dossiers', requireAuth, requireCabinetRole(['admin']), async (req, res) => {
  try {
    const ownerId = req.cabinetOwnerId || req.userId;

    // Members with their assigned dossier names
    const result = await pool.query(
      `SELECT
          cm.id, cm.member_user_id, cm.role, cm.status, cm.invite_status, cm.invited_at, cm.created_at,
          u.name, u.email,
          COALESCE(
            json_agg(
              json_build_object('id', c.id, 'name', c.name)
              ORDER BY c.name
            ) FILTER (WHERE c.id IS NOT NULL),
            '[]'
          ) as dossiers,
          COUNT(c.id)::int as dossier_count
       FROM cabinet_members cm
       JOIN users u ON u.id = cm.member_user_id
       LEFT JOIN companies c ON c.user_id = $1
         AND (c.collaborateur_id = cm.member_user_id OR c.chef_de_mission_id = cm.member_user_id)
       WHERE cm.cabinet_owner_id = $1
       GROUP BY cm.id, u.name, u.email
       ORDER BY cm.created_at ASC`,
      [ownerId]
    );

    res.json({ members: result.rows });
  } catch (err) {
    console.error('GET /api/cabinet/members-with-dossiers error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================================
// CABINET CLIENT MANAGEMENT
// ============================================================

// Helper: check if user can access a specific client company
async function getCabinetClientAccessFilter(req) {
  const ownerId = req.cabinetOwnerId || req.userId;
  const conditions = ['c.user_id = $1'];
  const params = [ownerId];

  // For non-admin members: restrict to assigned dossiers only
  if (['comptable', 'assistant', 'chef_mission', 'collaborateur'].includes(req.cabinetRole)) {
    params.push(req.userId);
    conditions.push(`(c.collaborateur_id = $${params.length} OR c.chef_de_mission_id = $${params.length})`);
  }

  return { conditions, params };
}

// GET /api/cabinet/clients?search=&statut=&page=&limit= - list clients with stats
app.get('/api/cabinet/clients', requireAuth, async (req, res) => {
  try {
    const { search, statut, page = 1, limit = 50 } = req.query;
    const { conditions, params } = await getCabinetClientAccessFilter(req);

    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      conditions.push(`(LOWER(c.name) LIKE $${params.length} OR LOWER(c.email) LIKE $${params.length} OR LOWER(c.ice) LIKE $${params.length})`);
    }
    if (statut) {
      params.push(statut);
      conditions.push(`c.client_invitation_status = $${params.length}`);
    }

    const whereClause = conditions.join(' AND ');
    const countResult = await pool.query(`SELECT COUNT(*) FROM companies c WHERE ${whereClause}`, params);
    const total = parseInt(countResult.rows[0].count);

    const pageSize = Math.min(parseInt(limit) || 50, 100);
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * pageSize;
    params.push(pageSize, offset);

    // Get clients with stats
    const result = await pool.query(
      `SELECT c.id, c.name, c.email, c.ice, c.idf, c.rc, c.cnss, c.address, c.city, c.phone,
              c.client_invitation_status, c.client_invitation_expires_at, c.client_user_id,
              c.client_invitation_token,
              -- Stats
              (SELECT COUNT(*) FROM documents d WHERE d.company_id = c.id) as document_count,
              (SELECT COUNT(*) FROM justificatifs j WHERE j.company_id = c.id AND j.status = 'pending') as pending_requests,
              (SELECT COALESCE(SUM(total_ttc), 0) FROM invoices i WHERE i.company_id = c.id AND i.type = 'sale') as total_revenue,
              (SELECT MAX(j.created_at) FROM justificatifs j WHERE j.company_id = c.id) as last_request_at,
              -- Client user last login (from sessions)
              (SELECT MAX(s.expires_at) FROM sessions s WHERE s.user_id = c.client_user_id AND s.expires_at > NOW()) as last_login,
              -- Cabinet owner info
              u.name as cabinet_name,
              -- Assignment
              COALESCE(cmu.name, c.chef_de_mission) as chef_de_mission,
              c.statut as company_statut
       FROM companies c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN users cmu ON cmu.id = c.chef_de_mission_id
       WHERE ${whereClause}
       ORDER BY c.name ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ clients: result.rows, total, page: parseInt(page) || 1, limit: pageSize });
  } catch (err) {
    console.error('GET /api/cabinet/clients error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/cabinet/clients/:id - get client details
app.get('/api/cabinet/clients/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { conditions, params } = await getCabinetClientAccessFilter(req);
    params.push(id);
    conditions.push(`c.id = $${params.length}`);

    const result = await pool.query(
      `SELECT c.*,
              u.name as cabinet_name, u.email as cabinet_email,
              COALESCE(cmu.name, c.chef_de_mission) as chef_de_mission,
              COALESCE(cu.name, c.collaborateur) as collaborateur,
              -- Stats
              (SELECT COUNT(*) FROM documents d WHERE d.company_id = c.id) as document_count,
              (SELECT COUNT(*) FROM justificatifs j WHERE j.company_id = c.id AND j.status = 'pending') as pending_requests,
              (SELECT COUNT(*) FROM justificatifs j WHERE j.company_id = c.id) as total_requests,
              (SELECT COUNT(*) FROM messages m WHERE m.company_id = c.id) as message_count,
              (SELECT COALESCE(SUM(total_ttc), 0) FROM invoices i WHERE i.company_id = c.id AND i.type = 'sale') as total_revenue,
              (SELECT MAX(created_at) FROM sessions s WHERE s.user_id = c.client_user_id AND s.expires_at > NOW()) as last_login,
              -- User info if client exists
              cu.name as client_user_name, cu.email as client_user_email
       FROM companies c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN users cmu ON cmu.id = c.chef_de_mission_id
       LEFT JOIN users cu ON cu.id = c.collaborateur_id
       WHERE ${conditions.join(' AND ')}`,
      params
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Client non trouvé' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('GET /api/cabinet/clients/:id error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/cabinet/clients/:id - update client company info
app.put('/api/cabinet/clients/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, ice, idf, rc, cnss, address, city, phone, email,
            rib, bank_name, payment_conditions, chef_de_mission_id,
            collaborateur_id, forme_juridique, type_comptabilite,
            pilote_pa, abonnement } = req.body;
    if (!name) return res.status(400).json({ error: 'La raison sociale est requise' });

    const ownerId = req.cabinetOwnerId || req.userId;

    // Verify ownership
    const check = await pool.query(
      'SELECT id FROM companies WHERE id = $1 AND user_id = $2',
      [id, ownerId]
    );
    if (check.rows.length === 0) return res.status(403).json({ error: 'Non autorisé' });

    const result = await pool.query(
      `UPDATE companies SET
         name=$1, ice=$2, idf=$3, rc=$4, cnss=$5, address=$6, city=$7, phone=$8, email=$9,
         rib=$10, bank_name=$11, payment_conditions=$12,
         forme_juridique=$13, type_comptabilite=$14,
         chef_de_mission_id=$15, collaborateur_id=$16,
         pilote_pa=$17, abonnement=$18,
         updated_at=NOW()
       WHERE id=$19 AND user_id=$20
       RETURNING *`,
      [name, ice || null, idf || null, rc || null, cnss || null,
       address || null, city || null, phone || null, email || null,
       rib || null, bank_name || null, payment_conditions || null,
       forme_juridique || null, type_comptabilite || null,
       chef_de_mission_id || null, collaborateur_id || null,
       pilote_pa || null, abonnement || 'Collaboratif',
       id, ownerId]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Client non trouvé' });
    res.json({ client: result.rows[0] });
  } catch (err) {
    console.error('PUT /api/cabinet/clients/:id error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/cabinet/clients/:id/toggle-active - enable/disable client account
app.post('/api/cabinet/clients/:id/toggle-active', requireAuth, requireCabinetRole(['admin']), async (req, res) => {
  try {
    const { id } = req.params;
    const ownerId = req.cabinetOwnerId || req.userId;

    const clientResult = await pool.query(
      `SELECT c.id, c.name, c.client_invitation_status, c.client_user_id, c.user_id
       FROM companies c WHERE c.id = $1 AND c.user_id = $2`,
      [id, ownerId]
    );
    if (clientResult.rows.length === 0) return res.status(404).json({ error: 'Client non trouvé' });

    const client = clientResult.rows[0];
    const isCurrentlyActive = client.client_invitation_status === 'accepted';
    const newStatus = isCurrentlyActive ? 'disabled' : 'accepted';

    if (isCurrentlyActive) {
      // Disable: revoke client user access (clear client_user_id + set status to disabled)
      await pool.query(
        `UPDATE companies SET client_user_id = NULL, client_invitation_status = 'disabled', updated_at = NOW() WHERE id = $1`,
        [id]
      );
      res.json({ ok: true, status: 'disabled', message: 'Compte client désactivé. L\'accès a été coupé.' });
    } else {
      // Re-enable: set status back to accepted, but client_user_id remains null (client must re-login/create account)
      // Or if client_user_id was set and just disconnected, restore it
      await pool.query(
        `UPDATE companies SET client_invitation_status = 'accepted', updated_at = NOW() WHERE id = $1`,
        [id]
      );
      res.json({ ok: true, status: 'accepted', message: 'Compte client réactivé. Le client peut se reconnecter.' });
    }
  } catch (err) {
    console.error('POST /api/cabinet/clients/:id/toggle-active error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/cabinet/clients/:id/resend-invite - resend client invitation
app.post('/api/cabinet/clients/:id/resend-invite', requireAuth, requireCabinetRole(['admin']), inviteRateLimit, async (req, res) => {
  try {
    const { id } = req.params;
    const ownerId = req.cabinetOwnerId || req.userId;

    const clientResult = await pool.query(
      `SELECT c.id, c.name, c.email, c.client_invitation_status, c.user_id
       FROM companies c WHERE c.id = $1 AND c.user_id = $2`,
      [id, ownerId]
    );
    if (clientResult.rows.length === 0) return res.status(404).json({ error: 'Client non trouvé' });

    const client = clientResult.rows[0];
    if (!client.email) return res.status(400).json({ error: 'Ce client n\'a pas d\'email. Ajoutez un email avant d\'envoyer une invitation.' });

    // Check for role conflict
    const conflictCheck = await pool.query(
      'SELECT id, user_type FROM users WHERE LOWER(email) = LOWER($1)',
      [client.email]
    );
    if (conflictCheck.rows.length > 0 && conflictCheck.rows[0].user_type === 'cabinet') {
      return res.status(409).json({
        error: 'Cette adresse email est déjà associée à un compte collaborateur de cabinet.',
        conflicting_role: 'cabinet'
      });
    }

    // Get cabinet name
    const cabinetResult = await pool.query('SELECT name, email FROM users WHERE id = $1', [ownerId]);
    const cabinetName = cabinetResult.rows[0]?.name || 'Votre cabinet';

    // Generate new token
    const token = require('crypto').randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await pool.query(
      `UPDATE companies SET
         client_invitation_token = $1,
         client_invitation_expires_at = $2,
         client_invitation_status = 'pending',
         client_user_id = NULL
       WHERE id = $3`,
      [token, expiresAt, id]
    );

    // Send invitation email
    const inviteUrl = `https://hissabpro.polsia.app/invite.html?token=${token}`;
    const emailHtml = buildInvitationEmail(cabinetName, client.name, inviteUrl);
    await sendNotificationEmail(client.email, `Invitation HissabPro - ${client.name}`, emailHtml);

    res.json({ ok: true, invitation_status: 'pending', expires_at: expiresAt });
  } catch (err) {
    console.error('POST /api/cabinet/clients/:id/resend-invite error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/cabinet/clients - create client (generates dossier + sends invitation)
app.post('/api/cabinet/clients', requireAuth, requireCabinetRole(['admin']), async (req, res) => {
  try {
    const { name, email, ice, idf, rc, cnss, address, city, phone,
            rib, bank_name, payment_conditions, type_comptabilite,
            forme_juridique, collaborateur_id, chef_de_mission_id,
            pilote_pa, abonnement, expert_comptable, send_invite = true } = req.body;
    if (!name) return res.status(400).json({ error: 'La raison sociale est requise' });
    if (!email) return res.status(400).json({ error: 'L\'email du contact est requis' });

    const ownerId = req.cabinetOwnerId || req.userId;

    // Check for role conflict
    const conflictCheck = await pool.query(
      'SELECT id, user_type FROM users WHERE LOWER(email) = LOWER($1)',
      [email]
    );
    if (conflictCheck.rows.length > 0 && conflictCheck.rows[0].user_type === 'cabinet') {
      return res.status(409).json({
        error: 'Cette adresse email est déjà associée à un compte collaborateur de cabinet. Un collaborateur ne peut pas être client.',
        conflicting_role: 'cabinet'
      });
    }

    // Check if already has pending/accepted invitation
    const existingCheck = await pool.query(
      'SELECT id FROM companies WHERE user_id = $1 AND LOWER(email) = LOWER($2) AND client_invitation_status IN (\'pending\', \'accepted\')',
      [ownerId, email]
    );
    if (existingCheck.rows.length > 0) {
      return res.status(409).json({ error: 'Un client avec cet email existe déjà.' });
    }

    // Get cabinet name for email
    const cabinetResult = await pool.query('SELECT name, email FROM users WHERE id = $1', [ownerId]);
    const cabinetName = cabinetResult.rows[0]?.name || 'Votre cabinet';

    // Generate invitation token if send_invite
    let token = null;
    let expiresAt = null;
    let invitation_status = 'pending';
    if (send_invite) {
      token = require('crypto').randomBytes(32).toString('hex');
      expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    }

    // Create the dossier
    const result = await pool.query(
      `INSERT INTO companies
         (name, email, ice, idf, rc, cnss, address, city, phone,
          rib, bank_name, payment_conditions, type_comptabilite, forme_juridique,
          collaborateur_id, chef_de_mission_id,
          pilote_pa, abonnement, expert_comptable, statut, user_id,
          client_invitation_token, client_invitation_expires_at, client_invitation_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'actif',$20,$21,$22,$23)
       RETURNING *`,
      [name, email, ice || null, idf || null, rc || null, cnss || null,
       address || null, city || null, phone || null,
       rib || null, bank_name || null, payment_conditions || null,
       type_comptabilite || 'Engagement', forme_juridique || null,
       collaborateur_id || null, chef_de_mission_id || null,
       pilote_pa || null, abonnement || 'Collaboratif', expert_comptable || null,
       ownerId, token, expiresAt, invitation_status]
    );

    const client = result.rows[0];

    // Send invitation email if requested
    if (send_invite && token) {
      const inviteUrl = `https://hissabpro.polsia.app/invite.html?token=${token}`;
      const emailHtml = buildInvitationEmail(cabinetName, client.name, inviteUrl);
      await sendNotificationEmail(email, `Invitation HissabPro - ${client.name}`, emailHtml);
    }

    res.json({
      client,
      invitation_sent: send_invite,
      invitation_status: send_invite ? 'pending' : null
    });
  } catch (err) {
    console.error('POST /api/cabinet/clients error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================================
// CABINET BILLING — Facturation par dossier (49 DH HT/mois/dossier)
// ============================================================

// GET /api/cabinet/billing — get cabinet billing summary (status + dossiers × 49 DH)
app.get('/api/cabinet/billing', requireAuth, async (req, res) => {
  try {
    if (req.userType !== 'cabinet') {
      return res.json({ status: null, dossiers: [], total_dh: 0 });
    }
    const ownerId = req.cabinetOwnerId || req.userId;

    // Get cabinet billing record (status)
    const billingResult = await pool.query(
      `SELECT status, price_per_dossier, billing_start_date, notes, created_at, updated_at
       FROM cabinet_billing WHERE user_id = $1`,
      [ownerId]
    );
    const billing = billingResult.rows[0] || null;
    const status = billing ? billing.status : 'en_attente';
    const pricePerDossier = billing ? billing.price_per_dossier : CABINET_PRICE_PER_DOSSIER;

    // Get active dossiers with basic info
    const dossiersResult = await pool.query(
      `SELECT id, name, forme_juridique, type_comptabilite, statut
       FROM companies WHERE user_id = $1 AND statut != 'supprime'
       ORDER BY name ASC`,
      [ownerId]
    );
    const dossiers = dossiersResult.rows;
    const totalDh = dossiers.length * pricePerDossier;

    res.json({
      status,
      status_label: CABINET_STATUSES[status] ? CABINET_STATUSES[status].label : status,
      status_meta: CABINET_STATUSES[status] || null,
      price_per_dossier: pricePerDossier,
      dossiers,
      dossier_count: dossiers.length,
      total_dh_monthly: totalDh,
      billing_start_date: billing ? billing.billing_start_date : null,
    });
  } catch (err) {
    console.error('GET /api/cabinet/billing error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/cabinet/billing/status — update cabinet status (admin only)
app.post('/api/cabinet/billing/status', requireAuth, requireCabinetRole(['admin']), async (req, res) => {
  try {
    const ownerId = req.cabinetOwnerId || req.userId;
    const { status, notes } = req.body;
    if (!status || !CABINET_STATUSES[status]) {
      return res.status(400).json({ error: 'Statut invalide. Valeurs: en_attente, en_deploiement, actif' });
    }
    await pool.query(
      `INSERT INTO cabinet_billing (user_id, status, notes, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         status = EXCLUDED.status,
         notes = COALESCE(EXCLUDED.notes, cabinet_billing.notes),
         updated_at = NOW()`,
      [ownerId, status, notes || null]
    );
    res.json({ ok: true, status, status_label: CABINET_STATUSES[status].label });
  } catch (err) {
    console.error('POST /api/cabinet/billing/status error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================================
// CABINET ENTREPRISES VIEWS — Declarations + Prospects APIs
// ============================================================

// GET /api/cabinet/declarations-overview?year=YYYY
// Returns TVA declaration status for all cabinet client companies, per month
app.get('/api/cabinet/declarations-overview', requireAuth, async (req, res) => {
  try {
    const ownerId = req.cabinetOwnerId || req.userId;
    const year = parseInt(req.query.year) || new Date().getFullYear();

    // Get all cabinet client companies
    const companiesResult = await pool.query(
      `SELECT c.id, c.name,
              COALESCE(c.forme_juridique, 'SARL') as forme_juridique,
              COALESCE(c.frequence_tva, 'Mensuelle') as frequence_tva,
              cu.name as collaborateur_name,
              cmu.name as chef_de_mission_name
       FROM companies c
       LEFT JOIN users cu ON cu.id = c.collaborateur_id
       LEFT JOIN users cmu ON cmu.id = c.chef_de_mission_id
       WHERE c.user_id = $1 AND COALESCE(c.statut, 'actif') != 'supprime'
       ORDER BY c.name ASC`,
      [ownerId]
    );

    if (companiesResult.rows.length === 0) {
      return res.json({ companies: [], year });
    }

    const companyIds = companiesResult.rows.map(c => c.id);

    // Get all TVA declarations for these companies for this year
    const declsResult = await pool.query(
      `SELECT company_id, year, month, quarter, regime, tva_due, is_credit,
              total_collectee_tva, total_deductible_tva, period_label, created_at
       FROM tva_declarations
       WHERE company_id = ANY($1) AND year = $2
       ORDER BY company_id, month, quarter`,
      [companyIds, year]
    );

    // Build declaration map: { company_id: { 'm3': decl, 'q2': decl, ... } }
    const declMap = {};
    for (const decl of declsResult.rows) {
      if (!declMap[decl.company_id]) declMap[decl.company_id] = {};
      const key = decl.month ? `m${decl.month}` : `q${decl.quarter}`;
      declMap[decl.company_id][key] = {
        tva_due: parseFloat(decl.tva_due) || 0,
        is_credit: decl.is_credit,
        period_label: decl.period_label,
        created_at: decl.created_at
      };
    }

    const companies = companiesResult.rows.map(c => ({
      id: c.id,
      name: c.name,
      forme_juridique: c.forme_juridique,
      frequence_tva: c.frequence_tva,
      team: [c.collaborateur_name, c.chef_de_mission_name].filter(Boolean),
      declarations: declMap[c.id] || {}
    }));

    res.json({ companies, year });
  } catch (err) {
    console.error('GET /api/cabinet/declarations-overview error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/cabinet/is-acomptes-overview?year=YYYY
// Returns IS acomptes (advance payments) status for all cabinet client companies
app.get('/api/cabinet/is-acomptes-overview', requireAuth, async (req, res) => {
  try {
    const ownerId = req.cabinetOwnerId || req.userId;
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const prevYear = year - 1;

    // Get all cabinet client companies
    const companiesResult = await pool.query(
      `SELECT c.id, c.name,
              COALESCE(c.forme_juridique, 'SARL') as forme_juridique,
              cu.name as collaborateur_name,
              cmu.name as chef_de_mission_name
       FROM companies c
       LEFT JOIN users cu ON cu.id = c.collaborateur_id
       LEFT JOIN users cmu ON cmu.id = c.chef_de_mission_id
       WHERE c.user_id = $1 AND COALESCE(c.statut, 'actif') != 'supprime'
       ORDER BY c.name ASC`,
      [ownerId]
    );

    if (companiesResult.rows.length === 0) {
      return res.json({ companies: [], year });
    }

    const companyIds = companiesResult.rows.map(c => c.id);

    // Get IS declarations for previous year (basis for acomptes)
    const isResult = await pool.query(
      `SELECT isd.company_id, isd.is_du, isd.chiffre_affaires,
              isd.cotisation_minimale, fy.label as fiscal_year_label,
              fy.start_date, fy.end_date
       FROM is_declarations isd
       JOIN fiscal_years fy ON fy.id = isd.fiscal_year_id
       WHERE isd.company_id = ANY($1)
         AND EXTRACT(YEAR FROM fy.end_date) = $2
       ORDER BY isd.company_id, isd.id DESC`,
      [companyIds, prevYear]
    );

    // Build IS map: { company_id: latest_is_decl }
    const isMap = {};
    for (const row of isResult.rows) {
      if (!isMap[row.company_id]) {
        isMap[row.company_id] = {
          is_du: parseFloat(row.is_du) || 0,
          chiffre_affaires: parseFloat(row.chiffre_affaires) || 0,
          fiscal_year_label: row.fiscal_year_label
        };
      }
    }

    const now = new Date();
    // IS acompte due dates (Morocco): 31 March, 30 June, 30 Sep, 31 Dec
    const acompteDates = [
      { label: `31/03/${year}`, due: new Date(year, 2, 31), quarter: 1 },
      { label: `30/06/${year}`, due: new Date(year, 5, 30), quarter: 2 },
      { label: `30/09/${year}`, due: new Date(year, 8, 30), quarter: 3 },
      { label: `31/12/${year}`, due: new Date(year, 11, 31), quarter: 4 }
    ];

    const companies = companiesResult.rows.map(c => {
      const isDecl = isMap[c.id];
      const isAnnuel = isDecl ? isDecl.is_du : null;
      const acompteUnit = isAnnuel ? Math.round(isAnnuel / 4) : null;

      const acomptes = acompteDates.map(ad => {
        let statut, montant;
        if (!isDecl) {
          statut = 'non_calcule';
          montant = null;
        } else {
          montant = acompteUnit;
          statut = now > ad.due ? 'en_attente' : 'a_payer';
        }
        return {
          quarter: ad.quarter,
          date_due: ad.label,
          montant,
          statut
        };
      });

      return {
        id: c.id,
        name: c.name,
        forme_juridique: c.forme_juridique,
        team: [c.collaborateur_name, c.chef_de_mission_name].filter(Boolean),
        is_annuel_n1: isAnnuel,
        fiscal_year_label: isDecl ? isDecl.fiscal_year_label : null,
        acomptes
      };
    });

    res.json({ companies, year });
  } catch (err) {
    console.error('GET /api/cabinet/is-acomptes-overview error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/cabinet/cloture-overview
// Returns fiscal year closure status for all cabinet client companies
app.get('/api/cabinet/cloture-overview', requireAuth, async (req, res) => {
  try {
    const ownerId = req.cabinetOwnerId || req.userId;

    // Get all cabinet client companies with their latest fiscal year
    const result = await pool.query(
      `SELECT c.id, c.name,
              COALESCE(c.forme_juridique, 'SARL') as forme_juridique,
              cu.name as collaborateur_name,
              cmu.name as chef_de_mission_name,
              fy.id as fy_id, fy.label as fy_label,
              fy.start_date, fy.end_date, fy.status as fy_status,
              fy.closed_at,
              cby.name as closed_by_name
       FROM companies c
       LEFT JOIN users cu ON cu.id = c.collaborateur_id
       LEFT JOIN users cmu ON cmu.id = c.chef_de_mission_id
       LEFT JOIN LATERAL (
         SELECT * FROM fiscal_years fy2
         WHERE fy2.company_id = c.id
         ORDER BY fy2.end_date DESC
         LIMIT 1
       ) fy ON true
       LEFT JOIN users cby ON cby.id = fy.closed_by
       WHERE c.user_id = $1 AND COALESCE(c.statut, 'actif') != 'supprime'
       ORDER BY c.name ASC`,
      [ownerId]
    );

    const companies = result.rows.map(r => ({
      id: r.id,
      name: r.name,
      forme_juridique: r.forme_juridique,
      team: [r.collaborateur_name, r.chef_de_mission_name].filter(Boolean),
      fiscal_year: r.fy_id ? {
        id: r.fy_id,
        label: r.fy_label,
        start_date: r.start_date,
        end_date: r.end_date,
        status: r.fy_status,
        closed_at: r.closed_at,
        closed_by: r.closed_by_name
      } : null
    }));

    res.json({ companies });
  } catch (err) {
    console.error('GET /api/cabinet/cloture-overview error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── PROSPECTS CRUD ───────────────────────────────────────────────────────────

// GET /api/cabinet/prospects?statut=&search=
app.get('/api/cabinet/prospects', requireAuth, async (req, res) => {
  try {
    const ownerId = req.cabinetOwnerId || req.userId;
    const { statut, search } = req.query;
    const conditions = ['user_id = $1'];
    const params = [ownerId];

    if (statut) {
      params.push(statut);
      conditions.push(`statut_ldm = $${params.length}`);
    }
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      conditions.push(`(LOWER(raison_sociale) LIKE $${params.length} OR LOWER(COALESCE(interlocuteur,'')) LIKE $${params.length} OR LOWER(COALESCE(email,'')) LIKE $${params.length})`);
    }

    const result = await pool.query(
      `SELECT id, raison_sociale, interlocuteur, email, telephone,
              responsable, cabinet, a_faire, statut_ldm, notes, created_at
       FROM prospects
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC`,
      params
    );
    res.json({ prospects: result.rows });
  } catch (err) {
    console.error('GET /api/cabinet/prospects error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/cabinet/prospects
app.post('/api/cabinet/prospects', requireAuth, async (req, res) => {
  try {
    const ownerId = req.cabinetOwnerId || req.userId;
    const { raison_sociale, interlocuteur, email, telephone, responsable, cabinet, a_faire, notes } = req.body;
    if (!raison_sociale || !raison_sociale.trim()) {
      return res.status(400).json({ error: 'La raison sociale est requise' });
    }
    const result = await pool.query(
      `INSERT INTO prospects (user_id, raison_sociale, interlocuteur, email, telephone, responsable, cabinet, a_faire, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [ownerId, raison_sociale.trim(), interlocuteur || null, email || null, telephone || null,
       responsable || null, cabinet || null, a_faire || null, notes || null]
    );
    res.status(201).json({ prospect: result.rows[0] });
  } catch (err) {
    console.error('POST /api/cabinet/prospects error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/cabinet/prospects/:id
app.put('/api/cabinet/prospects/:id', requireAuth, async (req, res) => {
  try {
    const ownerId = req.cabinetOwnerId || req.userId;
    const { id } = req.params;
    const { raison_sociale, interlocuteur, email, telephone, responsable, cabinet, a_faire, statut_ldm, notes } = req.body;

    const VALID_STATUTS = ['en_discussion', 'ldm_envoyee', 'en_attente_signature', 'perdu'];
    if (statut_ldm && !VALID_STATUTS.includes(statut_ldm)) {
      return res.status(400).json({ error: 'Statut invalide' });
    }

    const result = await pool.query(
      `UPDATE prospects SET
         raison_sociale = COALESCE($3, raison_sociale),
         interlocuteur = COALESCE($4, interlocuteur),
         email = COALESCE($5, email),
         telephone = COALESCE($6, telephone),
         responsable = COALESCE($7, responsable),
         cabinet = COALESCE($8, cabinet),
         a_faire = COALESCE($9, a_faire),
         statut_ldm = COALESCE($10, statut_ldm),
         notes = COALESCE($11, notes),
         updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [id, ownerId, raison_sociale || null, interlocuteur || null, email || null,
       telephone || null, responsable || null, cabinet || null, a_faire || null,
       statut_ldm || null, notes || null]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Prospect introuvable' });
    }
    res.json({ prospect: result.rows[0] });
  } catch (err) {
    console.error('PUT /api/cabinet/prospects/:id error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/cabinet/prospects/:id
app.delete('/api/cabinet/prospects/:id', requireAuth, async (req, res) => {
  try {
    const ownerId = req.cabinetOwnerId || req.userId;
    const { id } = req.params;
    const result = await pool.query(
      `DELETE FROM prospects WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, ownerId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Prospect introuvable' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/cabinet/prospects/:id error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================================
// CABINET PARTNER REQUESTS — Formulaire "Devenir cabinet partenaire"
// ============================================================

// POST /api/partner-request — public form (no auth required)
app.post('/api/partner-request', async (req, res) => {
  try {
    const { cabinet_name, contact_name, email, phone, estimated_dossiers, city, message } = req.body;
    if (!cabinet_name || !contact_name || !email) {
      return res.status(400).json({ error: 'Nom du cabinet, responsable et email sont requis' });
    }
    // Basic email validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Email invalide' });
    }

    await pool.query(
      `INSERT INTO cabinet_partner_requests
        (cabinet_name, contact_name, email, phone, estimated_dossiers, city, message, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NOW(), NOW())`,
      [cabinet_name, contact_name, email, phone || null, estimated_dossiers || null, city || null, message || null]
    );

    // Notify HissabPro team
    const notifHtml = `
      <h2>Nouvelle demande partenaire cabinet</h2>
      <table cellpadding="6">
        <tr><td><strong>Cabinet</strong></td><td>${cabinet_name}</td></tr>
        <tr><td><strong>Responsable</strong></td><td>${contact_name}</td></tr>
        <tr><td><strong>Email</strong></td><td>${email}</td></tr>
        <tr><td><strong>Téléphone</strong></td><td>${phone || '—'}</td></tr>
        <tr><td><strong>Dossiers estimés</strong></td><td>${estimated_dossiers || '—'}</td></tr>
        <tr><td><strong>Ville</strong></td><td>${city || '—'}</td></tr>
        <tr><td><strong>Message</strong></td><td>${message || '—'}</td></tr>
      </table>
    `;
    sendNotificationEmail('hissabpro@polsia.app', `Nouvelle demande partenaire — ${cabinet_name}`, notifHtml).catch(() => {});

    res.json({ ok: true, message: 'Votre demande a été enregistrée. Notre équipe vous contactera sous 48h.' });
  } catch (err) {
    console.error('POST /api/partner-request error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/admin/partner-requests — admin view of partner requests
app.get('/api/admin/partner-requests', requireAuth, async (req, res) => {
  try {
    if (req.userType !== 'cabinet') return res.status(403).json({ error: 'Accès refusé' });
    const ownerId = req.cabinetOwnerId || req.userId;
    // Only the platform admin (user_id = 1) can access this
    const userResult = await pool.query(`SELECT email FROM users WHERE id = $1`, [ownerId]);
    const isAdmin = userResult.rows[0] && (userResult.rows[0].email === 'hissabpro@polsia.app' || ownerId === 1);
    if (!isAdmin) return res.status(403).json({ error: 'Accès refusé' });

    const result = await pool.query(
      `SELECT id, cabinet_name, contact_name, email, phone, estimated_dossiers, city, message, status, created_at
       FROM cabinet_partner_requests ORDER BY created_at DESC LIMIT 200`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('GET /api/admin/partner-requests error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================================
// CLIENT SUBSCRIPTIONS — Plans SaaS entreprises (99/199/499 DH)
// ============================================================

// GET /api/client/subscription — get company subscription
app.get('/api/client/subscription', requireAuth, async (req, res) => {
  try {
    const companyId = req.activeCompanyId || req.clientCompanyId;
    if (!companyId) return res.json({ plan: null, status: null });

    const result = await pool.query(
      `SELECT plan, status, started_at, expires_at, notes, created_at, updated_at
       FROM client_subscriptions WHERE company_id = $1`,
      [companyId]
    );
    const sub = result.rows[0] || null;
    const plan = sub ? sub.plan : 'starter';
    const planMeta = CLIENT_PLANS[plan] || CLIENT_PLANS.starter;

    res.json({
      plan,
      plan_label: planMeta.label,
      price_mad: planMeta.price_mad,
      status: sub ? sub.status : 'trial',
      started_at: sub ? sub.started_at : null,
      expires_at: sub ? sub.expires_at : null,
      all_plans: CLIENT_PLANS,
    });
  } catch (err) {
    console.error('GET /api/client/subscription error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/client/subscription — update plan (manual activation, admin only)
app.post('/api/client/subscription', requireAuth, async (req, res) => {
  try {
    // Allow cabinet admin or direct company user (owner role)
    const companyId = req.activeCompanyId || req.clientCompanyId;
    if (!companyId) return res.status(400).json({ error: 'Aucune entreprise active' });

    const { plan, status, notes } = req.body;
    if (!plan || !CLIENT_PLANS[plan]) {
      return res.status(400).json({ error: 'Plan invalide. Valeurs: starter, standard, premium' });
    }

    await pool.query(
      `INSERT INTO client_subscriptions (company_id, plan, status, started_at, notes, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), $4, NOW(), NOW())
       ON CONFLICT (company_id) DO UPDATE SET
         plan = EXCLUDED.plan,
         status = EXCLUDED.status,
         started_at = NOW(),
         notes = COALESCE(EXCLUDED.notes, client_subscriptions.notes),
         updated_at = NOW()`,
      [companyId, plan, status || 'active', notes || null]
    );

    const planMeta = CLIENT_PLANS[plan];
    res.json({ ok: true, plan, plan_label: planMeta.label, price_mad: planMeta.price_mad });
  } catch (err) {
    console.error('POST /api/client/subscription error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================================
// CLIENT PLAN — API routes (for entreprise/standard users)
// ============================================================

// GET /api/client/plan — return current plan + feature access map for the company
app.get('/api/client/plan', requireAuth, async (req, res) => {
  try {
    // Cabinets have unrestricted access — return a synthetic 'premium' response
    if (req.userType === 'cabinet') {
      return res.json({ plan: 'premium', cabinet: true, feature_access: Object.fromEntries(Object.keys(CLIENT_FEATURE_GATE).map(k => [k, true])) });
    }

    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) {
      return res.json({ plan: 'starter', feature_access: Object.fromEntries(Object.keys(CLIENT_FEATURE_GATE).map(k => [k, false])) });
    }

    const planKey = await getClientPlan(companyId);

    // Get full subscription record
    const subResult = await pool.query(
      `SELECT plan, status, started_at, expires_at, notes, created_at, updated_at
       FROM client_subscriptions WHERE company_id = $1`,
      [companyId]
    );
    const subscription = subResult.rows[0] || null;

    // Build feature access map
    const featureAccess = {};
    for (const [feature, requiredPlan] of Object.entries(CLIENT_FEATURE_GATE)) {
      featureAccess[feature] = CLIENT_PLAN_ORDER.indexOf(planKey) >= CLIENT_PLAN_ORDER.indexOf(requiredPlan);
    }

    res.json({
      plan: planKey,
      subscription,
      feature_access: featureAccess,
      feature_gate: CLIENT_FEATURE_GATE
    });
  } catch (err) {
    console.error('GET /api/client/plan error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/client/plan/access/:feature — check single feature access
app.get('/api/client/plan/access/:feature', requireAuth, async (req, res) => {
  try {
    if (req.userType === 'cabinet') return res.json({ allowed: true });
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.json({ allowed: false, plan: 'starter' });

    const plan = await getClientPlan(companyId);
    const feature = req.params.feature;
    const requiredPlan = CLIENT_FEATURE_GATE[feature];

    if (!requiredPlan) return res.json({ allowed: true, plan, feature });

    const allowed = CLIENT_PLAN_ORDER.indexOf(plan) >= CLIENT_PLAN_ORDER.indexOf(requiredPlan);
    res.json({ allowed, plan, feature, required_plan: allowed ? null : requiredPlan });
  } catch (err) {
    console.error('GET /api/client/plan/access error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/client/plan — set plan (admin activation, no Stripe for MVP)
// In production this would be behind admin auth; for MVP any authenticated owner can request
app.post('/api/client/plan', requireAuth, async (req, res) => {
  try {
    const { plan, status, expires_at, notes, company_id } = req.body;

    if (!plan || !CLIENT_PLAN_ORDER.includes(plan)) {
      return res.status(400).json({ error: 'Plan invalide. Valeurs: starter, standard, premium' });
    }

    // Determine target company
    const targetCompanyId = company_id || (await getEffectiveCompanyId(req));
    if (!targetCompanyId) return res.status(400).json({ error: 'Aucune entreprise trouvée' });

    // For standard users, they can only set their own company
    if (req.userType === 'standard') {
      const ownCompany = await getEffectiveCompanyId(req);
      if (parseInt(targetCompanyId) !== parseInt(ownCompany)) {
        return res.status(403).json({ error: 'Accès refusé' });
      }
    }

    const planStatus = status || 'active';

    await pool.query(
      `INSERT INTO client_subscriptions (company_id, plan, status, started_at, expires_at, notes, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), $4, $5, NOW(), NOW())
       ON CONFLICT (company_id) DO UPDATE SET
         plan = EXCLUDED.plan,
         status = EXCLUDED.status,
         started_at = CASE WHEN client_subscriptions.plan != EXCLUDED.plan THEN NOW() ELSE client_subscriptions.started_at END,
         expires_at = EXCLUDED.expires_at,
         notes = EXCLUDED.notes,
         updated_at = NOW()`,
      [targetCompanyId, plan, planStatus, expires_at || null, notes || null]
    );

    res.json({ ok: true, plan, status: planStatus, company_id: targetCompanyId });
  } catch (err) {
    console.error('POST /api/client/plan error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================================
// BANQUE — Bank accounts & transaction reconciliation
// ============================================================

// GET /api/bank/accounts — list bank accounts for active company
app.get('/api/bank/accounts', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'No company found' });
    const result = await pool.query(
      `SELECT * FROM bank_accounts WHERE company_id = $1 ORDER BY created_at ASC`,
      [companyId]
    );
    // Count unmatched transactions per account
    const counts = await pool.query(
      `SELECT bank_account_id, COUNT(*) as total,
              SUM(CASE WHEN match_status = 'unmatched' THEN 1 ELSE 0 END) as unmatched
       FROM bank_transactions WHERE company_id = $1 GROUP BY bank_account_id`,
      [companyId]
    );
    const countMap = {};
    counts.rows.forEach(r => { countMap[r.bank_account_id] = r; });
    const accounts = result.rows.map(a => ({
      ...a,
      total_transactions: countMap[a.id] ? parseInt(countMap[a.id].total) : 0,
      unmatched_count: countMap[a.id] ? parseInt(countMap[a.id].unmatched) : 0
    }));
    res.json(accounts);
  } catch (e) {
    console.error('GET /api/bank/accounts error:', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/bank/accounts — create bank account
app.post('/api/bank/accounts', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'No company found' });
    const { name, bank_name, account_number, rib, currency } = req.body;
    if (!name) return res.status(400).json({ error: 'Le nom est requis' });
    const result = await pool.query(
      `INSERT INTO bank_accounts (company_id, name, bank_name, account_number, rib, currency)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [companyId, name, bank_name || null, account_number || null, rib || null, currency || 'MAD']
    );
    res.json(result.rows[0]);
  } catch (e) {
    console.error('POST /api/bank/accounts error:', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/bank/accounts/:id — update bank account
app.put('/api/bank/accounts/:id', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'No company found' });
    const { name, bank_name, account_number, rib } = req.body;
    const result = await pool.query(
      `UPDATE bank_accounts SET name=$1, bank_name=$2, account_number=$3, rib=$4
       WHERE id=$5 AND company_id=$6 RETURNING *`,
      [name, bank_name || null, account_number || null, rib || null, req.params.id, companyId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Compte introuvable' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/bank/accounts/:id — delete bank account + its transactions
app.delete('/api/bank/accounts/:id', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'No company found' });
    await pool.query('DELETE FROM bank_transactions WHERE bank_account_id=$1 AND company_id=$2', [req.params.id, companyId]);
    await pool.query('DELETE FROM bank_accounts WHERE id=$1 AND company_id=$2', [req.params.id, companyId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/bank/transactions — list transactions with filters
app.get('/api/bank/transactions', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'No company found' });
    const { account_id, status, date_from, date_to } = req.query;
    const params = [companyId];
    let where = 'bt.company_id = $1';
    if (account_id) { params.push(account_id); where += ` AND bt.bank_account_id = $${params.length}`; }
    if (status) { params.push(status); where += ` AND bt.match_status = $${params.length}`; }
    if (date_from) { params.push(date_from); where += ` AND bt.transaction_date >= $${params.length}`; }
    if (date_to) { params.push(date_to); where += ` AND bt.transaction_date <= $${params.length}`; }
    const result = await pool.query(
      `SELECT bt.*,
              ba.name as account_name,
              i.invoice_number as matched_invoice_number, c_inv.name as matched_invoice_contact,
              e.description as matched_expense_description
       FROM bank_transactions bt
       LEFT JOIN bank_accounts ba ON ba.id = bt.bank_account_id
       LEFT JOIN invoices i ON i.id = bt.matched_invoice_id
       LEFT JOIN contacts c_inv ON c_inv.id = i.contact_id
       LEFT JOIN expenses e ON e.id = bt.matched_expense_id
       WHERE ${where}
       ORDER BY bt.transaction_date DESC, bt.id DESC
       LIMIT 500`,
      params
    );
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/bank/transactions error:', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/bank/import — parse CSV and import transactions
app.post('/api/bank/import', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'No company found' });
    const { account_id, csv_content, column_mapping } = req.body;
    if (!csv_content) return res.status(400).json({ error: 'CSV manquant' });
    if (!account_id) return res.status(400).json({ error: 'Compte bancaire requis' });

    // Verify account belongs to company
    const accCheck = await pool.query('SELECT id FROM bank_accounts WHERE id=$1 AND company_id=$2', [account_id, companyId]);
    if (!accCheck.rows.length) return res.status(403).json({ error: 'Compte introuvable' });

    // Parse CSV — handle ; and , separators, strip BOM
    const content = csv_content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length < 2) return res.status(400).json({ error: 'CSV vide ou invalide' });

    // Detect separator
    const sep = (lines[0].split(';').length > lines[0].split(',').length) ? ';' : ',';
    const headers = lines[0].split(sep).map(h => h.trim().replace(/^"(.+)"$/, '$1').toLowerCase());

    // Auto-detect column indices
    function findCol(names) {
      for (const n of names) {
        const idx = headers.findIndex(h => h.includes(n));
        if (idx !== -1) return idx;
      }
      return -1;
    }

    const mapping = column_mapping || {};
    const dateIdx   = mapping.date   !== undefined ? mapping.date   : findCol(['date', 'dat']);
    const labelIdx  = mapping.label  !== undefined ? mapping.label  : findCol(['libellé', 'libelle', 'désignation', 'designation', 'detail', 'motif', 'description', 'opération', 'operation']);
    const debitIdx  = mapping.debit  !== undefined ? mapping.debit  : findCol(['débit', 'debit', 'montant débit', 'montant debit', 'sortie']);
    const creditIdx = mapping.credit !== undefined ? mapping.credit : findCol(['crédit', 'credit', 'montant crédit', 'montant credit', 'entrée', 'entree']);
    const balanceIdx= mapping.balance!== undefined ? mapping.balance: findCol(['solde', 'balance', 'sold']);

    if (dateIdx === -1 || labelIdx === -1) {
      return res.status(400).json({
        error: 'Colonnes non détectées',
        headers,
        hint: 'Veuillez indiquer manuellement les colonnes Date et Libellé'
      });
    }

    function parseAmount(val) {
      if (!val || val.trim() === '' || val.trim() === '-') return null;
      // Remove spaces, thousand separators, replace comma decimal
      const clean = val.trim().replace(/\s/g, '').replace(/[^\d,.-]/g, '').replace(',', '.');
      const n = parseFloat(clean);
      return isNaN(n) ? null : Math.abs(n);
    }

    function parseDate(val) {
      if (!val) return null;
      val = val.trim().replace(/^"(.+)"$/, '$1');
      // Try DD/MM/YYYY
      const dmy = val.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
      if (dmy) return `${dmy[3]}-${dmy[2].padStart(2,'0')}-${dmy[1].padStart(2,'0')}`;
      // Try YYYY-MM-DD
      if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
      // Try DD-MM-YY
      const dmyShort = val.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2})$/);
      if (dmyShort) return `20${dmyShort[3]}-${dmyShort[2].padStart(2,'0')}-${dmyShort[1].padStart(2,'0')}`;
      return null;
    }

    const transactions = [];
    for (let i = 1; i < lines.length; i++) {
      const row = lines[i].split(sep).map(c => c.trim().replace(/^"(.+)"$/, '$1'));
      const dateStr = parseDate(row[dateIdx]);
      const label = row[labelIdx] || '';
      if (!dateStr || !label.trim()) continue;

      const debit  = debitIdx  !== -1 ? parseAmount(row[debitIdx])  : null;
      const credit = creditIdx !== -1 ? parseAmount(row[creditIdx]) : null;
      const balance= balanceIdx!== -1 ? parseAmount(row[balanceIdx]): null;

      // Skip rows with no movement
      if (!debit && !credit) continue;

      transactions.push({ dateStr, label, debit, credit, balance });
    }

    if (!transactions.length) return res.status(400).json({ error: 'Aucune transaction trouvée dans le CSV' });

    // Insert transactions (skip duplicates by date+label+debit+credit)
    let inserted = 0;
    let skipped = 0;
    const lastBalance = transactions[0].balance; // first row = most recent if descending
    const lastDate = transactions[0].dateStr;

    for (const tx of transactions) {
      // Check duplicate: same date, same label, same debit, same credit
      const dup = await pool.query(
        `SELECT id FROM bank_transactions WHERE company_id=$1 AND bank_account_id=$2
         AND transaction_date=$3 AND label=$4 AND debit IS NOT DISTINCT FROM $5 AND credit IS NOT DISTINCT FROM $6 LIMIT 1`,
        [companyId, account_id, tx.dateStr, tx.label, tx.debit, tx.credit]
      );
      if (dup.rows.length) { skipped++; continue; }
      await pool.query(
        `INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, label, debit, credit, balance)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [companyId, account_id, tx.dateStr, tx.label, tx.debit, tx.credit, tx.balance]
      );
      inserted++;
    }

    // Update account last import info
    if (lastBalance !== null && lastDate) {
      await pool.query(
        `UPDATE bank_accounts SET last_import_at=NOW(), last_balance=$1, last_balance_date=$2 WHERE id=$3`,
        [lastBalance, lastDate, account_id]
      );
    }

    res.json({ ok: true, inserted, skipped, total: transactions.length });
  } catch (e) {
    console.error('POST /api/bank/import error:', e.message);
    res.status(500).json({ error: 'Erreur serveur: ' + e.message });
  }
});

// POST /api/bank/auto-match — run auto-matching on unmatched transactions
app.post('/api/bank/auto-match', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'No company found' });
    const { account_id } = req.body;

    // Fetch unmatched transactions
    let txQuery = `SELECT * FROM bank_transactions WHERE company_id=$1 AND match_status='unmatched'`;
    const txParams = [companyId];
    if (account_id) { txParams.push(account_id); txQuery += ` AND bank_account_id=$${txParams.length}`; }
    const txResult = await pool.query(txQuery, txParams);
    const transactions = txResult.rows;

    // Fetch unpaid sales invoices (status sent or overdue)
    const invoices = await pool.query(
      `SELECT id, invoice_number, total AS total_ttc, date AS invoice_date, status FROM invoices
       WHERE company_id=$1 AND type='sale' AND status IN ('sent','overdue','draft')`,
      [companyId]
    );

    // Fetch expenses for matching
    const expenses = await pool.query(
      `SELECT id, description, total AS amount_ttc, date AS expense_date FROM expenses WHERE company_id=$1`,
      [companyId]
    );

    let matched = 0;
    for (const tx of transactions) {
      const txAmount = parseFloat(tx.credit || tx.debit || 0);
      const txDate = new Date(tx.transaction_date);
      let bestMatch = null;
      let bestScore = 0;

      if (tx.credit) {
        // Credit → look for sales invoice
        for (const inv of invoices.rows) {
          const invAmount = parseFloat(inv.total_ttc);
          const invDate = new Date(inv.invoice_date);
          const amountDiff = Math.abs(txAmount - invAmount);
          const daysDiff = Math.abs((txDate - invDate) / (1000 * 60 * 60 * 24));
          if (amountDiff <= 1 && daysDiff <= 30) {
            const score = Math.round(100 - (amountDiff * 50) - (daysDiff * 0.5));
            if (score > bestScore) { bestScore = score; bestMatch = { type: 'invoice', id: inv.id }; }
          }
        }
      } else if (tx.debit) {
        // Debit → look for expense
        for (const exp of expenses.rows) {
          const expAmount = parseFloat(exp.amount_ttc || 0);
          const expDate = new Date(exp.expense_date);
          const amountDiff = Math.abs(txAmount - expAmount);
          const daysDiff = Math.abs((txDate - expDate) / (1000 * 60 * 60 * 24));
          if (amountDiff <= 1 && daysDiff <= 30) {
            const score = Math.round(100 - (amountDiff * 50) - (daysDiff * 0.5));
            if (score > bestScore) { bestScore = score; bestMatch = { type: 'expense', id: exp.id }; }
          }
        }
      }

      if (bestMatch && bestScore >= 60) {
        const updateData = bestMatch.type === 'invoice'
          ? { matched_invoice_id: bestMatch.id, matched_expense_id: null }
          : { matched_invoice_id: null, matched_expense_id: bestMatch.id };
        await pool.query(
          `UPDATE bank_transactions SET match_status='auto_matched', match_confidence=$1,
           matched_invoice_id=$2, matched_expense_id=$3 WHERE id=$4`,
          [bestScore, updateData.matched_invoice_id, updateData.matched_expense_id, tx.id]
        );
        matched++;
      }
    }
    res.json({ ok: true, matched, total: transactions.length });
  } catch (e) {
    console.error('POST /api/bank/auto-match error:', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/bank/transactions/:id/match — manually match a transaction
app.put('/api/bank/transactions/:id/match', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'No company found' });
    const { invoice_id, expense_id } = req.body;
    const result = await pool.query(
      `UPDATE bank_transactions SET match_status='manual_matched', match_confidence=100,
       matched_invoice_id=$1, matched_expense_id=$2
       WHERE id=$3 AND company_id=$4 RETURNING *`,
      [invoice_id || null, expense_id || null, req.params.id, companyId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Transaction introuvable' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/bank/transactions/:id/ignore — mark as ignored
app.put('/api/bank/transactions/:id/ignore', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'No company found' });
    const result = await pool.query(
      `UPDATE bank_transactions SET match_status='ignored', matched_invoice_id=NULL, matched_expense_id=NULL
       WHERE id=$1 AND company_id=$2 RETURNING *`,
      [req.params.id, companyId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Transaction introuvable' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/bank/transactions/:id/match — unmatch a transaction
app.delete('/api/bank/transactions/:id/match', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'No company found' });
    const result = await pool.query(
      `UPDATE bank_transactions SET match_status='unmatched', match_confidence=NULL,
       matched_invoice_id=NULL, matched_expense_id=NULL
       WHERE id=$1 AND company_id=$2 RETURNING *`,
      [req.params.id, companyId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Transaction introuvable' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/bank/stats — summary stats for dashboard
app.get('/api/bank/stats', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'No company found' });
    // Latest balance across all accounts
    const balResult = await pool.query(
      `SELECT SUM(last_balance) as total_balance, MAX(last_import_at) as last_import
       FROM bank_accounts WHERE company_id=$1 AND last_balance IS NOT NULL`,
      [companyId]
    );
    // Unmatched count
    const unmatchedResult = await pool.query(
      `SELECT COUNT(*) as count FROM bank_transactions WHERE company_id=$1 AND match_status='unmatched'`,
      [companyId]
    );
    res.json({
      total_balance: balResult.rows[0]?.total_balance || null,
      last_import: balResult.rows[0]?.last_import || null,
      unmatched_count: parseInt(unmatchedResult.rows[0]?.count || 0)
    });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/bank/unmatched-invoices — invoices that can be matched
app.get('/api/bank/unmatched-invoices', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'No company found' });
    const result = await pool.query(
      `SELECT i.id, i.invoice_number, c.name AS contact_name, i.total AS total_ttc, i.date AS invoice_date, i.status, i.type
       FROM invoices i
       LEFT JOIN contacts c ON c.id = i.contact_id
       WHERE i.company_id=$1
         AND i.type='sale'
         AND i.status IN ('sent','overdue','draft')
         AND i.id NOT IN (SELECT matched_invoice_id FROM bank_transactions WHERE company_id=$1 AND matched_invoice_id IS NOT NULL AND match_status != 'unmatched')
       ORDER BY i.date DESC LIMIT 100`,
      [companyId]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/bank/unmatched-expenses — expenses that can be matched
app.get('/api/bank/unmatched-expenses', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'No company found' });
    const result = await pool.query(
      `SELECT e.id, e.description, e.total AS amount_ttc, e.date AS expense_date, c.name AS supplier_name
       FROM expenses e
       LEFT JOIN contacts c ON c.id = e.contact_id
       WHERE e.company_id=$1
         AND e.id NOT IN (SELECT matched_expense_id FROM bank_transactions WHERE company_id=$1 AND matched_expense_id IS NOT NULL AND match_status != 'unmatched')
       ORDER BY e.date DESC LIMIT 100`,
      [companyId]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================================
// BALANCE AGEE (Aged Receivables / Payables)
// ============================================================

// GET /api/balance-agee?type=client|fournisseur&date=YYYY-MM-DD&contact_id=N&unlettered_only=true
app.get('/api/balance-agee', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company not found' });

    const { type = 'client', contact_id, unlettered_only = 'true' } = req.query;
    const refDate = req.query.date || new Date().toISOString().split('T')[0];
    const onlyUnlettered = unlettered_only !== 'false';

    if (!['client', 'fournisseur'].includes(type)) {
      return res.status(400).json({ error: 'type doit être client ou fournisseur' });
    }

    const accountPrefix = type === 'client' ? '3421' : '4411';
    // clients: net = debit - credit (amount owed TO us)
    // fournisseurs: net = credit - debit (amount WE owe)
    const netExpr = type === 'client'
      ? '(jel.debit - jel.credit)'
      : '(jel.credit - jel.debit)';

    const params = [companyId, refDate, `${accountPrefix}%`];
    const lettrageFilter = onlyUnlettered ? 'AND jel.lettrage_code IS NULL' : '';

    let contactFilter = '';
    if (contact_id) {
      params.push(parseInt(contact_id, 10));
      contactFilter = `AND COALESCE(jel.tiers_id, c.id) = $${params.length}`;
    }

    // Source joins to resolve tiers name/id when not yet denormalized
    const sourceJoin = type === 'client'
      ? `LEFT JOIN invoices inv ON je.source_type = 'invoice' AND je.source_id = inv.id
         LEFT JOIN contacts c ON c.id = inv.contact_id`
      : `LEFT JOIN invoices inv ON je.source_type = 'invoice' AND je.source_id = inv.id AND inv.type = 'purchase'
         LEFT JOIN expenses exp ON je.source_type = 'expense' AND je.source_id = exp.id
         LEFT JOIN contacts c ON c.id = COALESCE(inv.contact_id, exp.contact_id)`;

    const result = await pool.query(`
      WITH raw_lines AS (
        SELECT
          COALESCE(jel.tiers_id, c.id)::text                                    AS tiers_key,
          COALESCE(
            jel.tiers_name,
            c.name,
            CASE WHEN jel.account_name LIKE 'Fournisseurs - %'
                 THEN TRIM(SUBSTRING(jel.account_name FROM 15))
                 ELSE NULL END,
            jel.description,
            'Tiers inconnu'
          )                                                                       AS tiers_name,
          COALESCE(jel.tiers_id, c.id)                                           AS tiers_id,
          je.date                                                                 AS entry_date,
          ${netExpr}                                                              AS net,
          ($2::date - je.date::date)::integer                                    AS days_old
        FROM journal_entry_lines jel
        JOIN journal_entries je ON je.id = jel.journal_entry_id
        ${sourceJoin}
        WHERE je.company_id = $1
          AND jel.account_code LIKE $3
          AND je.date <= $2::date
          ${lettrageFilter}
          ${contactFilter}
      ),
      grouped AS (
        SELECT
          tiers_key,
          MAX(tiers_name)                                                         AS tiers_name,
          MAX(tiers_id)                                                           AS tiers_id,
          SUM(net)                                                                AS total,
          SUM(CASE WHEN days_old <= 30 THEN net ELSE 0 END)                      AS bucket_0_30,
          SUM(CASE WHEN days_old > 30  AND days_old <= 60 THEN net ELSE 0 END)   AS bucket_30_60,
          SUM(CASE WHEN days_old > 60  AND days_old <= 90 THEN net ELSE 0 END)   AS bucket_60_90,
          SUM(CASE WHEN days_old > 90  THEN net ELSE 0 END)                      AS bucket_gt_90
        FROM raw_lines
        GROUP BY tiers_key
      )
      SELECT * FROM grouped
      WHERE total > 0.009
      ORDER BY total DESC
    `, params);

    const rows = result.rows.map(r => ({
      tiers_key:    r.tiers_key,
      tiers_name:   r.tiers_name,
      tiers_id:     r.tiers_id,
      total:        parseFloat(r.total        || 0),
      bucket_0_30:  parseFloat(r.bucket_0_30  || 0),
      bucket_30_60: parseFloat(r.bucket_30_60 || 0),
      bucket_60_90: parseFloat(r.bucket_60_90 || 0),
      bucket_gt_90: parseFloat(r.bucket_gt_90 || 0)
    }));

    const sum = (key) => rows.reduce((s, r) => s + r[key], 0);

    res.json({
      type,
      reference_date: refDate,
      rows,
      totals: {
        total:        sum('total'),
        bucket_0_30:  sum('bucket_0_30'),
        bucket_30_60: sum('bucket_30_60'),
        bucket_60_90: sum('bucket_60_90'),
        bucket_gt_90: sum('bucket_gt_90')
      }
    });
  } catch (e) {
    console.error('[BALANCE-AGEE]', e);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// STATIC FILES & SPA
// ============================================================

// ============================================================
// SEO LANDING PAGES
// ============================================================

// SEO landing page: logiciel comptabilité maroc
app.get('/logiciel-comptabilite-maroc', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.sendFile(path.join(__dirname, 'public', 'logiciel-comptabilite-maroc.html'));
});

// Waitlist pre-launch landing page
app.get('/waitlist', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.sendFile(path.join(__dirname, 'public', 'waitlist.html'));
});

// Sitemap.xml
app.get('/sitemap.xml', (req, res) => {
  const base = 'https://hissabpro.polsia.app';
  const today = new Date().toISOString().split('T')[0];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${base}/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${base}/logiciel-comptabilite-maroc</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>${base}/waitlist</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
</urlset>`;
  res.set('Content-Type', 'application/xml');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(xml);
});

// robots.txt
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(
    'User-agent: *\n' +
    'Allow: /\n' +
    'Allow: /waitlist\n' +
    'Allow: /logiciel-comptabilite-maroc\n' +
    'Disallow: /app/\n' +
    'Disallow: /api/\n' +
    'Disallow: /onboarding\n' +
    'Disallow: /invite/\n' +
    'Disallow: /member-invite/\n' +
    '\n' +
    'Sitemap: https://hissabpro.polsia.app/sitemap.xml\n'
  );
});

// Serve static files from public folder (no-cache for HTML to prevent stale frontend code)
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// Landing page with analytics beacon injected
app.get('/', (req, res) => {
  const slug = process.env.POLSIA_ANALYTICS_SLUG || '';
  const htmlPath = path.join(__dirname, 'public', 'index.html');

  if (fs.existsSync(htmlPath)) {
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace('__POLSIA_SLUG__', slug);
    res.type('html').send(html);
  } else {
    res.json({ message: 'HissabPro API' });
  }
});

// Login page
app.get('/login', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Onboarding wizard
app.get('/onboarding', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'onboarding.html'));
});

// App SPA - serve app.html for /app and all /app/* routes
app.get('/app', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.get('/app/*', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// Client invitation acceptance page
app.get('/invite/:token', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'invite.html'));
});

// Cabinet member invitation acceptance page
app.get('/member-invite/:token', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'member-invite.html'));
});

// ============================================================
// EMAIL QUEUE — Internal API for agent processing
// ============================================================

// GET /api/internal/email-queue — list pending emails (protected by API key)
app.get('/api/internal/email-queue', async (req, res) => {
  const key = req.headers['x-api-key'] || req.query.key;
  if (!key || key !== POLSIA_API_KEY_EMAIL) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const result = await pool.query(
      `SELECT id, to_email, subject, status, created_at FROM email_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT 50`
    );
    res.json({ pending: result.rows, count: result.rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/internal/email-queue/:id/sent — mark email as sent (protected by API key)
app.put('/api/internal/email-queue/:id/sent', async (req, res) => {
  const key = req.headers['x-api-key'] || req.query.key;
  if (!key || key !== POLSIA_API_KEY_EMAIL) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await pool.query(
      `UPDATE email_queue SET status = 'sent', sent_at = NOW() WHERE id = $1`,
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =============================================================================
// VENTE — CLIENTS API
// =============================================================================

// GET /api/vente/clients — list all clients for the company
app.get('/api/vente/clients', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company not found' });
    const result = await pool.query(
      `SELECT * FROM clients WHERE company_id = $1 ORDER BY name ASC`,
      [companyId]
    );
    res.json({ clients: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/vente/clients — create a new client
app.post('/api/vente/clients', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company not found' });
    const { name, ice, if_number, rc_number, address, city, postal_code, country, phone, email, website, rib, banque, conditions_paiement, notes } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Le nom est obligatoire' });
    const result = await pool.query(
      `INSERT INTO clients (company_id, name, ice, if_number, rc_number, address, city, postal_code, country, phone, email, website, rib, banque, conditions_paiement, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [companyId, name.trim(), ice||null, if_number||null, rc_number||null, address||null, city||null, postal_code||null, country||'Maroc', phone||null, email||null, website||null, rib||null, banque||null, conditions_paiement||'30j', notes||null]
    );
    res.status(201).json({ client: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/vente/clients/:id — update a client
app.put('/api/vente/clients/:id', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company not found' });
    const { name, ice, if_number, rc_number, address, city, postal_code, country, phone, email, website, rib, banque, conditions_paiement, notes } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Le nom est obligatoire' });
    const result = await pool.query(
      `UPDATE clients SET name=$1, ice=$2, if_number=$3, rc_number=$4, address=$5, city=$6, postal_code=$7, country=$8, phone=$9, email=$10, website=$11, rib=$12, banque=$13, conditions_paiement=$14, notes=$15, updated_at=NOW()
       WHERE id=$16 AND company_id=$17 RETURNING *`,
      [name.trim(), ice||null, if_number||null, rc_number||null, address||null, city||null, postal_code||null, country||'Maroc', phone||null, email||null, website||null, rib||null, banque||null, conditions_paiement||'30j', notes||null, req.params.id, companyId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Client non trouvé' });
    res.json({ client: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/vente/clients/:id — delete a client
app.delete('/api/vente/clients/:id', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company not found' });
    const result = await pool.query(
      `DELETE FROM clients WHERE id=$1 AND company_id=$2 RETURNING id`,
      [req.params.id, companyId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Client non trouvé' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/vente/clients/:id/contacts — list contacts for a client
app.get('/api/vente/clients/:id/contacts', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company not found' });
    const result = await pool.query(
      `SELECT * FROM client_contacts WHERE client_id=$1 AND company_id=$2 ORDER BY is_primary DESC, last_name ASC`,
      [req.params.id, companyId]
    );
    res.json({ contacts: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/vente/clients/:id/contacts — add a contact to a client
app.post('/api/vente/clients/:id/contacts', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company not found' });
    const { first_name, last_name, email, phone, title, is_primary, notes } = req.body;
    if (!first_name || !last_name) return res.status(400).json({ error: 'Prénom et nom obligatoires' });
    // If is_primary, unset existing primary contacts for this client
    if (is_primary) {
      await pool.query(`UPDATE client_contacts SET is_primary=false WHERE client_id=$1`, [req.params.id]);
    }
    const result = await pool.query(
      `INSERT INTO client_contacts (client_id, company_id, first_name, last_name, email, phone, title, is_primary, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.params.id, companyId, first_name.trim(), last_name.trim(), email||null, phone||null, title||null, !!is_primary, notes||null]
    );
    res.status(201).json({ contact: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/vente/clients/:id/contacts/:contactId — update a contact
app.put('/api/vente/clients/:id/contacts/:contactId', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company not found' });
    const { first_name, last_name, email, phone, title, is_primary, notes } = req.body;
    if (!first_name || !last_name) return res.status(400).json({ error: 'Prénom et nom obligatoires' });
    if (is_primary) {
      await pool.query(`UPDATE client_contacts SET is_primary=false WHERE client_id=$1`, [req.params.id]);
    }
    const result = await pool.query(
      `UPDATE client_contacts SET first_name=$1, last_name=$2, email=$3, phone=$4, title=$5, is_primary=$6, notes=$7, updated_at=NOW()
       WHERE id=$8 AND client_id=$9 AND company_id=$10 RETURNING *`,
      [first_name.trim(), last_name.trim(), email||null, phone||null, title||null, !!is_primary, notes||null, req.params.contactId, req.params.id, companyId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Contact non trouvé' });
    res.json({ contact: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =============================================================================
// VENTE — PRODUCTS API
// =============================================================================

// GET /api/vente/products — list all products for the company
app.get('/api/vente/products', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company not found' });
    const result = await pool.query(
      `SELECT * FROM products WHERE company_id=$1 ORDER BY name ASC`,
      [companyId]
    );
    res.json({ products: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/vente/products — create a new product
app.post('/api/vente/products', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company not found' });
    const { name, description, type, unit_price, tva_rate, unit, is_recurring, recurring_interval, is_active } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Le nom est obligatoire' });
    const validTypes = ['produit','service','abonnement'];
    if (!validTypes.includes(type)) return res.status(400).json({ error: 'Type invalide' });
    const validTva = [0,7,10,14,20];
    if (!validTva.includes(Number(tva_rate))) return res.status(400).json({ error: 'Taux TVA invalide' });
    const result = await pool.query(
      `INSERT INTO products (company_id, name, description, type, unit_price, tva_rate, unit, is_recurring, recurring_interval, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [companyId, name.trim(), description||null, type, Number(unit_price)||0, Number(tva_rate), unit||'unité', !!is_recurring, is_recurring&&recurring_interval?recurring_interval:null, is_active!==false]
    );
    res.status(201).json({ product: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/vente/products/:id — update a product
app.put('/api/vente/products/:id', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company not found' });
    const { name, description, type, unit_price, tva_rate, unit, is_recurring, recurring_interval, is_active } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Le nom est obligatoire' });
    const validTypes = ['produit','service','abonnement'];
    if (!validTypes.includes(type)) return res.status(400).json({ error: 'Type invalide' });
    const validTva = [0,7,10,14,20];
    if (!validTva.includes(Number(tva_rate))) return res.status(400).json({ error: 'Taux TVA invalide' });
    const result = await pool.query(
      `UPDATE products SET name=$1, description=$2, type=$3, unit_price=$4, tva_rate=$5, unit=$6, is_recurring=$7, recurring_interval=$8, is_active=$9, updated_at=NOW()
       WHERE id=$10 AND company_id=$11 RETURNING *`,
      [name.trim(), description||null, type, Number(unit_price)||0, Number(tva_rate), unit||'unité', !!is_recurring, is_recurring&&recurring_interval?recurring_interval:null, is_active!==false, req.params.id, companyId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Produit non trouvé' });
    res.json({ product: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/vente/products/:id — delete a product
app.delete('/api/vente/products/:id', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company not found' });
    const result = await pool.query(
      `DELETE FROM products WHERE id=$1 AND company_id=$2 RETURNING id`,
      [req.params.id, companyId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Produit non trouvé' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// VENTE — ABONNEMENTS (subscriptions)
// ═══════════════════════════════════════════════════════════════════════════

/** Calculate next invoice date given a start/current date + interval */
function calcNextInvoiceDate(fromDate, interval) {
  const d = new Date(fromDate);
  if (interval === 'mensuel') d.setMonth(d.getMonth() + 1);
  else if (interval === 'trimestriel') d.setMonth(d.getMonth() + 3);
  else if (interval === 'annuel') d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().split('T')[0];
}

/** Generate one invoice for an active subscription (called inside a BEGIN..COMMIT block) */
async function generateSubscriptionInvoice(pgClient, sub, companyId, userId) {
  const today = new Date().toISOString().split('T')[0];
  const year = new Date().getFullYear();
  const countResult = await pgClient.query(
    `SELECT COUNT(*) AS cnt FROM invoices WHERE type='sale' AND EXTRACT(YEAR FROM date)=$1 AND company_id=$2 AND (invoice_subtype IS NULL OR invoice_subtype != 'avoir')`,
    [year, companyId]
  );
  const num = parseInt(countResult.rows[0].cnt) + 1;
  const invoiceNumber = `F-${year}-${String(num).padStart(3, '0')}`;

  const subtotal = parseFloat(sub.amount);
  const tvaRate  = parseFloat(sub.tva_rate);
  const tvaAmount = subtotal * tvaRate / 100;
  const total = subtotal + tvaAmount;

  const clientRow = await pgClient.query('SELECT ice FROM clients WHERE id=$1', [sub.client_id]);
  const iceClient = clientRow.rows[0]?.ice || null;

  const invRes = await pgClient.query(
    `INSERT INTO invoices (company_id, subscription_id, invoice_number, type, date, subtotal, tva_amount, total, tva_rate, notes, ice_client, user_id)
     VALUES ($1,$2,$3,'sale',$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [companyId, sub.id, invoiceNumber, today, subtotal, tvaAmount, total, tvaRate,
     `Abonnement : ${sub.product_name}`, iceClient, userId]
  );
  const invoice = invRes.rows[0];

  await pgClient.query(
    `INSERT INTO invoice_lines (invoice_id, description, quantity, unit_price, tva_rate, tva_amount, total, account_code, sort_order)
     VALUES ($1,$2,1,$3,$4,$5,$6,'7124',0)`,
    [invoice.id, sub.product_name, subtotal, tvaRate, tvaAmount, total]
  );

  const jeRes = await pgClient.query(
    `INSERT INTO journal_entries (company_id, entry_number, date, journal_type, reference, description, source_type, source_id, total_debit, total_credit, user_id)
     VALUES ($1,$2,$3,'VE',$4,$5,'invoice',$6,$7,$8,$9) RETURNING id`,
    [companyId, `VE-${invoiceNumber}`, today, invoiceNumber,
     `Abonnement - ${sub.product_name}`, invoice.id, total, total, userId]
  );
  const journalId = jeRes.rows[0].id;

  await pgClient.query(
    `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order)
     VALUES ($1,'3421','Clients',$2,0,$3,0)`,
    [journalId, total, `Facture ${invoiceNumber}`]
  );
  await pgClient.query(
    `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order)
     VALUES ($1,'7124','Ventes de services produits au Maroc',0,$2,$3,1)`,
    [journalId, subtotal, `Abonnement - ${sub.product_name}`]
  );
  if (tvaAmount > 0) {
    await pgClient.query(
      `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order)
       VALUES ($1,'4455','Etat - TVA facturee',0,$2,$3,2)`,
      [journalId, tvaAmount, `TVA - Facture ${invoiceNumber}`]
    );
  }
  await pgClient.query('UPDATE invoices SET journal_entry_id=$1 WHERE id=$2', [journalId, invoice.id]);

  // Advance next_invoice_date; expire if past end_date
  const nextDate = calcNextInvoiceDate(sub.next_invoice_date, sub.interval);
  let newStatus = sub.status;
  if (sub.end_date && nextDate > sub.end_date) newStatus = 'expiré';
  await pgClient.query(
    `UPDATE subscriptions SET next_invoice_date=$1, last_invoice_id=$2, status=$3, updated_at=NOW() WHERE id=$4`,
    [nextDate, invoice.id, newStatus, sub.id]
  );

  return { invoice, invoiceNumber };
}

// GET /api/vente/subscriptions — list with optional filters
app.get('/api/vente/subscriptions', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company not found' });
    const { status, client_id, product_id } = req.query;
    let where = `s.company_id = $1`;
    const params = [companyId];
    if (status)     { params.push(status);     where += ` AND s.status = $${params.length}`; }
    if (client_id)  { params.push(client_id);  where += ` AND s.client_id = $${params.length}`; }
    if (product_id) { params.push(product_id); where += ` AND s.product_id = $${params.length}`; }
    const result = await pool.query(
      `SELECT s.*,
              c.name  AS client_name,  c.ice AS client_ice, c.email AS client_email,
              p.name  AS product_name, p.type AS product_type,
              (SELECT COUNT(*) FROM invoices i WHERE i.subscription_id = s.id) AS invoice_count
         FROM subscriptions s
         JOIN clients  c ON c.id = s.client_id
         JOIN products p ON p.id = s.product_id
        WHERE ${where}
        ORDER BY s.created_at DESC`,
      params
    );
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/vente/subscriptions — create
app.post('/api/vente/subscriptions', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company not found' });
    const { client_id, product_id, start_date, interval, amount, tva_rate, end_date, notes } = req.body;
    if (!client_id || !product_id || !start_date || !interval || amount == null) {
      return res.status(400).json({ error: 'Champs obligatoires manquants' });
    }
    if (!['mensuel','trimestriel','annuel'].includes(interval)) {
      return res.status(400).json({ error: 'Fréquence invalide' });
    }
    // Verify client belongs to company
    const clientCheck = await pool.query('SELECT id FROM clients WHERE id=$1 AND company_id=$2', [client_id, companyId]);
    if (!clientCheck.rows.length) return res.status(404).json({ error: 'Client introuvable' });
    // Verify product belongs to company
    const prodCheck = await pool.query('SELECT id FROM products WHERE id=$1 AND company_id=$2', [product_id, companyId]);
    if (!prodCheck.rows.length) return res.status(404).json({ error: 'Produit introuvable' });

    const nextDate = calcNextInvoiceDate(start_date, interval);
    const result = await pool.query(
      `INSERT INTO subscriptions (company_id, client_id, product_id, start_date, next_invoice_date, interval, amount, tva_rate, end_date, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [companyId, client_id, product_id, start_date, nextDate, interval,
       parseFloat(amount), parseFloat(tva_rate) || 20, end_date || null, notes || null]
    );
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/vente/subscriptions/:id — update / pause / resume / cancel
app.put('/api/vente/subscriptions/:id', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company not found' });
    const { status, amount, tva_rate, end_date, notes, next_invoice_date } = req.body;
    const allowed = ['actif','pausé','annulé','expiré'];
    if (status && !allowed.includes(status)) {
      return res.status(400).json({ error: 'Statut invalide' });
    }
    const fields = []; const params = [];
    if (status !== undefined)            { params.push(status);            fields.push(`status=$${params.length}`); }
    if (amount !== undefined)            { params.push(parseFloat(amount)); fields.push(`amount=$${params.length}`); }
    if (tva_rate !== undefined)          { params.push(parseFloat(tva_rate)); fields.push(`tva_rate=$${params.length}`); }
    if (end_date !== undefined)          { params.push(end_date || null);  fields.push(`end_date=$${params.length}`); }
    if (notes !== undefined)             { params.push(notes || null);     fields.push(`notes=$${params.length}`); }
    if (next_invoice_date !== undefined) { params.push(next_invoice_date); fields.push(`next_invoice_date=$${params.length}`); }
    if (!fields.length) return res.status(400).json({ error: 'Rien à mettre à jour' });
    fields.push('updated_at=NOW()');
    params.push(req.params.id, companyId);
    const result = await pool.query(
      `UPDATE subscriptions SET ${fields.join(',')} WHERE id=$${params.length-1} AND company_id=$${params.length} RETURNING *`,
      params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Abonnement introuvable' });
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/vente/subscriptions/:id
app.delete('/api/vente/subscriptions/:id', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company not found' });
    const result = await pool.query(
      'DELETE FROM subscriptions WHERE id=$1 AND company_id=$2 RETURNING id',
      [req.params.id, companyId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Abonnement introuvable' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/vente/subscriptions/:id/invoices — invoices generated by this subscription
app.get('/api/vente/subscriptions/:id/invoices', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company not found' });
    const result = await pool.query(
      `SELECT id, invoice_number, date, total, status
         FROM invoices
        WHERE subscription_id=$1 AND company_id=$2
        ORDER BY date DESC`,
      [req.params.id, companyId]
    );
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/vente/subscriptions/process-due — generate invoices for all due subscriptions
app.post('/api/vente/subscriptions/process-due', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const companyId = await getEffectiveCompanyId(req, client);
    if (!companyId) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Company not found' }); }
    const today = new Date().toISOString().split('T')[0];

    // Find due subscriptions with their product name
    const dueResult = await client.query(
      `SELECT s.*, p.name AS product_name
         FROM subscriptions s
         JOIN products p ON p.id = s.product_id
        WHERE s.company_id=$1 AND s.status='actif'
          AND s.next_invoice_date <= $2::date`,
      [companyId, today]
    );

    const generated = [];
    for (const sub of dueResult.rows) {
      try {
        const { invoiceNumber } = await generateSubscriptionInvoice(client, sub, companyId, req.userId);
        generated.push({ subscription_id: sub.id, invoice_number: invoiceNumber });
        // In-app notification
        createNotification(req.userId, companyId, 'subscription_invoice',
          'Facture d\'abonnement générée',
          `Facture ${invoiceNumber} générée pour ${sub.client_name || sub.client_id}`,
          '/app#view-abonnements'
        ).catch(() => {});
      } catch (innerErr) {
        console.error(`[SUBSCRIPTION] Failed to generate for sub ${sub.id}:`, innerErr.message);
      }
    }

    await client.query('COMMIT');
    res.json({ generated, count: generated.length });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// VENTE — PAIEMENTS CLIENTS
// ═══════════════════════════════════════════════════════════════════════════

/** Sync invoice status based on total payments received */
async function syncInvoicePaymentStatus(pgClient, invoiceId, companyId) {
  const invRes = await pgClient.query(
    'SELECT id, total, status, invoice_subtype FROM invoices WHERE id=$1 AND company_id=$2',
    [invoiceId, companyId]
  );
  if (!invRes.rows.length) return;
  const inv = invRes.rows[0];
  if (inv.status === 'cancelled' || inv.invoice_subtype === 'avoir') return;

  const paidRes = await pgClient.query(
    'SELECT COALESCE(SUM(amount), 0) AS total_paid FROM client_payments WHERE invoice_id=$1 AND company_id=$2',
    [invoiceId, companyId]
  );
  const totalPaid = parseFloat(paidRes.rows[0].total_paid);
  const invoiceTotal = parseFloat(inv.total);

  let newStatus;
  if (invoiceTotal > 0 && totalPaid >= invoiceTotal) {
    newStatus = 'paid';
  } else if (totalPaid > 0) {
    newStatus = 'partially_paid';
  } else {
    newStatus = (inv.status === 'paid' || inv.status === 'partially_paid') ? 'validated' : inv.status;
  }

  await pgClient.query('UPDATE invoices SET status=$1, updated_at=NOW() WHERE id=$2', [newStatus, invoiceId]);
}

// GET /api/vente/payments — list payments with filters + KPIs
app.get('/api/vente/payments', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company not found' });
    const { tab, client_id, method, date_from, date_to, search } = req.query;

    let where = 'WHERE cp.company_id = $1';
    const params = [companyId];

    if (tab === 'lies') { where += ' AND cp.invoice_id IS NOT NULL'; }
    else if (tab === 'non-lies') { where += ' AND cp.invoice_id IS NULL'; }
    if (client_id) { params.push(client_id); where += ` AND cp.client_id = $${params.length}`; }
    if (method) { params.push(method); where += ` AND cp.method = $${params.length}`; }
    if (date_from) { params.push(date_from); where += ` AND cp.date >= $${params.length}`; }
    if (date_to) { params.push(date_to); where += ` AND cp.date <= $${params.length}`; }
    if (search) {
      params.push(`%${search}%`);
      const idx = params.length;
      where += ` AND (cp.reference ILIKE $${idx} OR cl.name ILIKE $${idx} OR i.invoice_number ILIKE $${idx})`;
    }

    const result = await pool.query(
      `SELECT cp.*, cl.name AS client_name, i.invoice_number, i.total AS invoice_total
       FROM client_payments cp
       LEFT JOIN clients cl ON cl.id = cp.client_id
       LEFT JOIN invoices i ON i.id = cp.invoice_id
       ${where}
       ORDER BY cp.date DESC, cp.id DESC`,
      params
    );

    const kpiRes = await pool.query(
      `SELECT
         COALESCE(SUM(amount), 0) AS total_recu,
         COALESCE(SUM(CASE WHEN invoice_id IS NOT NULL THEN amount ELSE 0 END), 0) AS total_lies,
         COALESCE(SUM(CASE WHEN invoice_id IS NULL THEN amount ELSE 0 END), 0) AS total_non_lies,
         COUNT(*) AS count_total,
         COUNT(CASE WHEN invoice_id IS NOT NULL THEN 1 END) AS count_lies,
         COUNT(CASE WHEN invoice_id IS NULL THEN 1 END) AS count_non_lies
       FROM client_payments WHERE company_id = $1`,
      [companyId]
    );

    res.json({ payments: result.rows, kpis: kpiRes.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/vente/payments — create a payment (optionally linked to an invoice)
app.post('/api/vente/payments', requireAuth, async (req, res) => {
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    const companyId = await getEffectiveCompanyId(req, dbClient);
    if (!companyId) { await dbClient.query('ROLLBACK'); return res.status(400).json({ error: 'Company not found' }); }

    const { client_id, invoice_id, amount, date, method, reference, notes } = req.body;
    if (!amount || !date) { await dbClient.query('ROLLBACK'); return res.status(400).json({ error: 'Montant et date obligatoires' }); }

    if (client_id) {
      const cl = await dbClient.query('SELECT id FROM clients WHERE id=$1 AND company_id=$2', [client_id, companyId]);
      if (!cl.rows.length) { await dbClient.query('ROLLBACK'); return res.status(400).json({ error: 'Client invalide' }); }
    }
    if (invoice_id) {
      const inv = await dbClient.query('SELECT id FROM invoices WHERE id=$1 AND company_id=$2', [invoice_id, companyId]);
      if (!inv.rows.length) { await dbClient.query('ROLLBACK'); return res.status(400).json({ error: 'Facture invalide' }); }
    }

    const result = await dbClient.query(
      `INSERT INTO client_payments (company_id, client_id, invoice_id, amount, date, method, reference, notes, is_linked)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [companyId, client_id||null, invoice_id||null, parseFloat(amount), date, method||'virement', reference||null, notes||null, invoice_id ? true : false]
    );
    const payment = result.rows[0];

    if (invoice_id) {
      await syncInvoicePaymentStatus(dbClient, invoice_id, companyId);
    }

    await dbClient.query('COMMIT');
    res.status(201).json({ payment });
  } catch (e) {
    await dbClient.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    dbClient.release();
  }
});

// PUT /api/vente/payments/:id/link — link a payment to an invoice
app.put('/api/vente/payments/:id/link', requireAuth, async (req, res) => {
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    const companyId = await getEffectiveCompanyId(req, dbClient);
    if (!companyId) { await dbClient.query('ROLLBACK'); return res.status(400).json({ error: 'Company not found' }); }

    const { invoice_id } = req.body;
    if (!invoice_id) { await dbClient.query('ROLLBACK'); return res.status(400).json({ error: 'invoice_id obligatoire' }); }

    const pmtRes = await dbClient.query('SELECT id, invoice_id FROM client_payments WHERE id=$1 AND company_id=$2', [req.params.id, companyId]);
    if (!pmtRes.rows.length) { await dbClient.query('ROLLBACK'); return res.status(404).json({ error: 'Paiement non trouvé' }); }

    const invRes = await dbClient.query('SELECT id FROM invoices WHERE id=$1 AND company_id=$2', [invoice_id, companyId]);
    if (!invRes.rows.length) { await dbClient.query('ROLLBACK'); return res.status(400).json({ error: 'Facture invalide' }); }

    const oldInvoiceId = pmtRes.rows[0].invoice_id;

    await dbClient.query(
      `UPDATE client_payments SET invoice_id=$1, is_linked=true WHERE id=$2 AND company_id=$3`,
      [invoice_id, req.params.id, companyId]
    );

    if (oldInvoiceId && oldInvoiceId !== parseInt(invoice_id)) {
      await syncInvoicePaymentStatus(dbClient, oldInvoiceId, companyId);
    }
    await syncInvoicePaymentStatus(dbClient, invoice_id, companyId);

    await dbClient.query('COMMIT');
    const updated = await pool.query('SELECT * FROM client_payments WHERE id=$1', [req.params.id]);
    res.json({ payment: updated.rows[0] });
  } catch (e) {
    await dbClient.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    dbClient.release();
  }
});

// DELETE /api/vente/payments/:id/link — unlink payment from invoice
app.delete('/api/vente/payments/:id/link', requireAuth, async (req, res) => {
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    const companyId = await getEffectiveCompanyId(req, dbClient);
    if (!companyId) { await dbClient.query('ROLLBACK'); return res.status(400).json({ error: 'Company not found' }); }

    const pmtRes = await dbClient.query('SELECT id, invoice_id FROM client_payments WHERE id=$1 AND company_id=$2', [req.params.id, companyId]);
    if (!pmtRes.rows.length) { await dbClient.query('ROLLBACK'); return res.status(404).json({ error: 'Paiement non trouvé' }); }

    const oldInvoiceId = pmtRes.rows[0].invoice_id;

    await dbClient.query(
      `UPDATE client_payments SET invoice_id=NULL, is_linked=false WHERE id=$1 AND company_id=$2`,
      [req.params.id, companyId]
    );

    if (oldInvoiceId) {
      await syncInvoicePaymentStatus(dbClient, oldInvoiceId, companyId);
    }

    await dbClient.query('COMMIT');
    const updated = await pool.query('SELECT * FROM client_payments WHERE id=$1', [req.params.id]);
    res.json({ payment: updated.rows[0] });
  } catch (e) {
    await dbClient.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    dbClient.release();
  }
});

// DELETE /api/vente/payments/:id — delete a payment
app.delete('/api/vente/payments/:id', requireAuth, async (req, res) => {
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    const companyId = await getEffectiveCompanyId(req, dbClient);
    if (!companyId) { await dbClient.query('ROLLBACK'); return res.status(400).json({ error: 'Company not found' }); }

    const pmtRes = await dbClient.query('SELECT id, invoice_id FROM client_payments WHERE id=$1 AND company_id=$2', [req.params.id, companyId]);
    if (!pmtRes.rows.length) { await dbClient.query('ROLLBACK'); return res.status(404).json({ error: 'Paiement non trouvé' }); }
    const oldInvoiceId = pmtRes.rows[0].invoice_id;

    await dbClient.query('DELETE FROM client_payments WHERE id=$1', [req.params.id]);

    if (oldInvoiceId) {
      await syncInvoicePaymentStatus(dbClient, oldInvoiceId, companyId);
    }

    await dbClient.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await dbClient.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    dbClient.release();
  }
});

// GET /api/vente/clients/:id/balance — client balance (invoices + payments)
app.get('/api/vente/clients/:id/balance', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company not found' });

    const cl = await pool.query('SELECT * FROM clients WHERE id=$1 AND company_id=$2', [req.params.id, companyId]);
    if (!cl.rows.length) return res.status(404).json({ error: 'Client non trouvé' });

    const invRes = await pool.query(
      `SELECT i.id, i.invoice_number, i.date, i.due_date, i.total, i.status,
              COALESCE((SELECT SUM(amount) FROM client_payments WHERE invoice_id=i.id AND company_id=$2), 0) AS paid_amount
       FROM invoices i
       WHERE i.client_id=$1 AND i.company_id=$2 AND i.type='sale' AND (i.invoice_subtype IS NULL OR i.invoice_subtype != 'avoir')
       ORDER BY i.date DESC`,
      [req.params.id, companyId]
    );

    const pmtRes = await pool.query(
      `SELECT cp.*, i.invoice_number FROM client_payments cp
       LEFT JOIN invoices i ON i.id = cp.invoice_id
       WHERE cp.client_id=$1 AND cp.company_id=$2 ORDER BY cp.date DESC`,
      [req.params.id, companyId]
    );

    const totalInvoiced = invRes.rows.reduce((s, r) => s + parseFloat(r.total), 0);
    const totalPaid = pmtRes.rows.reduce((s, r) => s + parseFloat(r.amount), 0);

    res.json({
      client: cl.rows[0],
      invoices: invRes.rows,
      payments: pmtRes.rows,
      balance: {
        total_invoiced: totalInvoiced,
        total_paid: totalPaid,
        outstanding: totalInvoiced - totalPaid
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// VENTE — RELANCES (payment reminders)
// ═══════════════════════════════════════════════════════════════════════════

/** Compute overdue level from days overdue */
function overdueLevel(daysOverdue) {
  if (daysOverdue >= 60) return 'contentieux';
  if (daysOverdue >= 30) return 'mise_en_demeure';
  if (daysOverdue >= 15) return 'relance';
  return 'rappel';
}

// GET /api/vente/reminders — overdue invoices with their reminder status
app.get('/api/vente/reminders', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company not found' });
    const { status, level, client_id } = req.query;
    const today = new Date().toISOString().split('T')[0];

    // Build overdue invoice list with last reminder per invoice
    let extraWhere = '';
    const params = [companyId, today];
    if (client_id) { params.push(client_id); extraWhere += ` AND ov.client_id = $${params.length}`; }

    const result = await pool.query(
      `WITH overdue_invoices AS (
         SELECT i.id AS invoice_id,
                i.invoice_number,
                i.date AS invoice_date,
                i.due_date,
                i.total,
                i.subtotal,
                i.tva_amount,
                c.id   AS client_id,
                c.name AS client_name,
                c.email AS client_email,
                COALESCE(i.due_date, i.date + INTERVAL '30 days') AS effective_due_date,
                CURRENT_DATE - COALESCE(i.due_date, i.date + INTERVAL '30 days')::date AS days_overdue
           FROM invoices i
           LEFT JOIN clients c ON c.id = (
             SELECT client_id FROM reminders r2
              WHERE r2.invoice_id = i.id AND r2.company_id = i.company_id
              ORDER BY r2.created_at DESC LIMIT 1
           )
          WHERE i.company_id = $1
            AND i.type = 'sale'
            AND i.status NOT IN ('paid','cancelled')
            AND COALESCE(i.due_date, i.date + INTERVAL '30 days') < $2::date
       ),
       last_reminders AS (
         SELECT DISTINCT ON (r.invoice_id)
                r.invoice_id,
                r.id   AS reminder_id,
                r.channel AS last_channel,
                r.status  AS reminder_status,
                r.level   AS reminder_level,
                r.sent_at AS last_sent_at,
                r.notes   AS last_notes
           FROM reminders r
          WHERE r.company_id = $1
          ORDER BY r.invoice_id, r.created_at DESC
       )
       SELECT ov.*,
              lr.reminder_id,
              lr.last_channel,
              lr.reminder_status,
              lr.reminder_level,
              lr.last_sent_at,
              lr.last_notes,
              CASE
                WHEN lr.reminder_status = 'résolu'   THEN 'résolu'
                WHEN lr.reminder_status = 'répondu'  THEN 'répondu'
                WHEN lr.reminder_id IS NOT NULL       THEN 'relancé'
                ELSE 'à_relancer'
              END AS collection_status
         FROM overdue_invoices ov
         LEFT JOIN last_reminders lr ON lr.invoice_id = ov.invoice_id
        ORDER BY ov.days_overdue DESC`,
      params
    );

    let rows = result.rows;
    // Filter by collection_status if requested
    if (status)    rows = rows.filter(r => r.collection_status === status);
    if (level)     rows = rows.filter(r => overdueLevel(parseInt(r.days_overdue)) === level);

    // Add computed level
    rows = rows.map(r => ({
      ...r,
      computed_level: overdueLevel(parseInt(r.days_overdue))
    }));

    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/vente/reminders/stats — KPI summary
app.get('/api/vente/reminders/stats', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company not found' });

    const result = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE i.status NOT IN ('paid','cancelled') AND COALESCE(i.due_date, i.date + INTERVAL '30 days') < CURRENT_DATE AND i.type='sale') AS total_overdue,
         COALESCE(SUM(i.total) FILTER (WHERE i.status NOT IN ('paid','cancelled') AND COALESCE(i.due_date, i.date + INTERVAL '30 days') < CURRENT_DATE AND i.type='sale'), 0) AS total_amount,
         COUNT(*) FILTER (WHERE i.status NOT IN ('paid','cancelled') AND COALESCE(i.due_date, i.date + INTERVAL '30 days') BETWEEN CURRENT_DATE - INTERVAL '14 days' AND CURRENT_DATE - INTERVAL '7 days' AND i.type='sale') AS level_rappel,
         COUNT(*) FILTER (WHERE i.status NOT IN ('paid','cancelled') AND COALESCE(i.due_date, i.date + INTERVAL '30 days') BETWEEN CURRENT_DATE - INTERVAL '29 days' AND CURRENT_DATE - INTERVAL '15 days' AND i.type='sale') AS level_relance,
         COUNT(*) FILTER (WHERE i.status NOT IN ('paid','cancelled') AND COALESCE(i.due_date, i.date + INTERVAL '30 days') BETWEEN CURRENT_DATE - INTERVAL '59 days' AND CURRENT_DATE - INTERVAL '30 days' AND i.type='sale') AS level_mise_en_demeure,
         COUNT(*) FILTER (WHERE i.status NOT IN ('paid','cancelled') AND COALESCE(i.due_date, i.date + INTERVAL '30 days') < CURRENT_DATE - INTERVAL '60 days' AND i.type='sale') AS level_contentieux
       FROM invoices i
      WHERE i.company_id=$1`,
      [companyId]
    );

    // Resolved count
    const resolvedResult = await pool.query(
      `SELECT COUNT(DISTINCT invoice_id) AS resolved
         FROM reminders
        WHERE company_id=$1 AND status='résolu'`,
      [companyId]
    );

    const stats = result.rows[0];
    const totalOverdue = parseInt(stats.total_overdue) || 0;
    const resolved    = parseInt(resolvedResult.rows[0].resolved) || 0;

    res.json({
      total_overdue:         totalOverdue,
      total_amount:          parseFloat(stats.total_amount) || 0,
      level_rappel:          parseInt(stats.level_rappel) || 0,
      level_relance:         parseInt(stats.level_relance) || 0,
      level_mise_en_demeure: parseInt(stats.level_mise_en_demeure) || 0,
      level_contentieux:     parseInt(stats.level_contentieux) || 0,
      recovery_rate:         totalOverdue > 0 ? Math.round(resolved / totalOverdue * 100) : 0
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/vente/reminders — log a reminder action
app.post('/api/vente/reminders', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company not found' });
    const { invoice_id, client_id, channel, channel_other, notes, status,
            call_datetime, tracking_number, ar_received_date } = req.body;
    if (!invoice_id || !channel) {
      return res.status(400).json({ error: 'invoice_id et channel sont requis' });
    }
    const validChannels = ['email','telephone','whatsapp','physique','courrier_recommande_ar','autre'];
    if (!validChannels.includes(channel)) {
      return res.status(400).json({ error: 'Canal invalide' });
    }
    // Verify invoice belongs to company
    const invCheck = await pool.query(
      'SELECT id, due_date, date FROM invoices WHERE id=$1 AND company_id=$2',
      [invoice_id, companyId]
    );
    if (!invCheck.rows.length) return res.status(404).json({ error: 'Facture introuvable' });

    const inv = invCheck.rows[0];
    const dueDate = inv.due_date || new Date(new Date(inv.date).getTime() + 30*24*60*60*1000).toISOString().split('T')[0];
    const daysOverdue = Math.floor((new Date() - new Date(dueDate)) / (1000*60*60*24));
    const level = overdueLevel(daysOverdue);

    const rStatus = status || 'envoyé';
    const result = await pool.query(
      `INSERT INTO reminders (company_id, invoice_id, client_id, channel, channel_other, level, notes, status, sent_by, call_datetime, tracking_number, ar_received_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [companyId, invoice_id, client_id || null, channel, channel_other || null, level,
       notes || null, rStatus, req.userId,
       call_datetime || null, tracking_number || null, ar_received_date || null]
    );

    // Notification if resolved
    if (rStatus === 'résolu') {
      createNotification(req.userId, companyId, 'reminder_resolved',
        'Relance résolue',
        `La facture a été marquée comme résolue`,
        '/app#view-relances'
      ).catch(() => {});
    }

    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/vente/reminders/:id — update reminder status
app.put('/api/vente/reminders/:id', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company not found' });
    const { status, notes } = req.body;
    const valid = ['à_envoyer','envoyé','répondu','résolu'];
    if (status && !valid.includes(status)) {
      return res.status(400).json({ error: 'Statut invalide' });
    }
    const fields = [];
    const params = [];
    if (status !== undefined) { params.push(status); fields.push(`status=$${params.length}`); }
    if (notes !== undefined)  { params.push(notes);  fields.push(`notes=$${params.length}`); }
    if (!fields.length) return res.status(400).json({ error: 'Rien à mettre à jour' });
    params.push(req.params.id, companyId);
    const result = await pool.query(
      `UPDATE reminders SET ${fields.join(',')} WHERE id=$${params.length-1} AND company_id=$${params.length} RETURNING *`,
      params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Relance introuvable' });
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/vente/reminders/:invoice_id/history — all reminders for an invoice
app.get('/api/vente/reminders/:invoice_id/history', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company not found' });
    const result = await pool.query(
      `SELECT r.*, u.email AS sent_by_email
         FROM reminders r
         LEFT JOIN users u ON u.id = r.sent_by
        WHERE r.company_id=$1 AND r.invoice_id=$2
        ORDER BY r.created_at DESC`,
      [companyId, req.params.invoice_id]
    );
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/vente/reminders/send-email — send a reminder email to client
app.post('/api/vente/reminders/send-email', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company not found' });
    const { invoice_id, level: reqLevel, to_email, client_name, invoice_number, amount_ttc, due_date } = req.body;
    if (!invoice_id || !to_email) return res.status(400).json({ error: 'invoice_id et to_email requis' });

    // Get company details for legal mentions
    const compResult = await pool.query('SELECT name, ice, idf, rc, rib, bank_name, address, phone, email FROM companies WHERE id=$1', [companyId]);
    const comp = compResult.rows[0] || {};

    const lv = reqLevel || 'rappel';
    let subject = '';
    let bodyText = '';

    if (lv === 'rappel') {
      subject = `Rappel — Facture ${invoice_number} en attente de règlement`;
      bodyText = `
        <p>Madame, Monsieur,</p>
        <p>Nous nous permettons de vous rappeler que la facture <strong>${invoice_number}</strong> d'un montant de <strong>${amount_ttc} MAD TTC</strong>, dont la date d'échéance était le <strong>${due_date}</strong>, est toujours en attente de règlement.</p>
        <p>Si votre paiement a déjà été effectué, nous vous remercions de ne pas tenir compte de ce message.</p>
        <p>Dans le cas contraire, nous vous serions reconnaissants de bien vouloir procéder au règlement dans les meilleurs délais.</p>
        <p>Restant à votre disposition pour tout renseignement complémentaire.</p>
        <p>Cordialement,</p>`;
    } else if (lv === 'relance') {
      subject = `Relance — Facture ${invoice_number} impayée`;
      bodyText = `
        <p>Madame, Monsieur,</p>
        <p>Malgré notre précédente communication, nous constatons que la facture <strong>${invoice_number}</strong> d'un montant de <strong>${amount_ttc} MAD TTC</strong>, échue le <strong>${due_date}</strong>, demeure impayée.</p>
        <p>Conformément à nos conditions de paiement, nous vous demandons instamment de régulariser votre situation dans un délai de <strong>8 jours</strong> à compter de la date du présent courrier.</p>
        <p>Nos coordonnées bancaires pour virement :</p>
        ${comp.rib ? `<p><strong>RIB :</strong> ${comp.rib}${comp.bank_name ? ` — ${comp.bank_name}` : ''}</p>` : ''}
        <p>Veuillez agréer, Madame, Monsieur, l'expression de nos salutations distinguées.</p>`;
    } else if (lv === 'mise_en_demeure') {
      subject = `Mise en demeure — Facture ${invoice_number}`;
      bodyText = `
        <p>Madame, Monsieur,</p>
        <p>En l'absence de règlement de la facture <strong>${invoice_number}</strong> d'un montant de <strong>${amount_ttc} MAD TTC</strong>, échue le <strong>${due_date}</strong>, et malgré nos relances successives, nous nous voyons dans l'obligation de vous adresser la présente mise en demeure.</p>
        <p>Conformément aux articles 78 à 83 du Dahir des Obligations et Contrats (D.O.C.), vous êtes mis en demeure de procéder au règlement intégral de la somme due dans un délai de <strong>72 heures</strong> à compter de la réception du présent courrier.</p>
        <p>À défaut, nous nous réserverons le droit d'engager toute procédure de recouvrement judiciaire à votre encontre, incluant une action devant les tribunaux de commerce compétents, aux frais exclusifs du débiteur défaillant.</p>
        ${comp.rib ? `<p><strong>RIB :</strong> ${comp.rib}${comp.bank_name ? ` — ${comp.bank_name}` : ''}</p>` : ''}
        <p>Veuillez agréer, Madame, Monsieur, l'expression de nos salutations distinguées.</p>`;
    } else {
      subject = `Contentieux — Facture ${invoice_number}`;
      bodyText = `<p>Votre dossier a été transmis au service contentieux.</p>`;
    }

    const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;color:#111;max-width:600px;margin:0 auto;padding:24px;">
      <div style="border-bottom:2px solid #059669;padding-bottom:16px;margin-bottom:24px;">
        <h2 style="margin:0;color:#059669;">${comp.name || 'Votre fournisseur'}</h2>
        ${comp.ice ? `<p style="margin:4px 0;font-size:13px;">ICE : ${comp.ice}${comp.idf ? ` | IF : ${comp.idf}` : ''}${comp.rc ? ` | RC : ${comp.rc}` : ''}</p>` : ''}
        ${comp.address ? `<p style="margin:4px 0;font-size:13px;">${comp.address}</p>` : ''}
        ${comp.phone ? `<p style="margin:4px 0;font-size:13px;">Tél : ${comp.phone}</p>` : ''}
      </div>
      <p style="font-size:13px;color:#6b7280;">À l'attention de : <strong>${client_name || 'Le client'}</strong></p>
      ${bodyText}
      <div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af;">
        <p>${comp.name || ''} — ICE : ${comp.ice || 'N/A'} | IF : ${comp.idf || 'N/A'} | RC : ${comp.rc || 'N/A'}</p>
      </div>
    </body></html>`;

    await sendNotificationEmail(to_email, subject, html);

    // Log the reminder
    const invCheck = await pool.query('SELECT id, due_date, date FROM invoices WHERE id=$1 AND company_id=$2', [invoice_id, companyId]);
    if (invCheck.rows.length) {
      const inv = invCheck.rows[0];
      const dueDt = inv.due_date || new Date(new Date(inv.date).getTime() + 30*24*60*60*1000).toISOString().split('T')[0];
      const daysOver = Math.floor((new Date() - new Date(dueDt)) / (1000*60*60*24));
      await pool.query(
        `INSERT INTO reminders (company_id, invoice_id, channel, level, notes, status, sent_by)
         VALUES ($1,$2,'email',$3,$4,'envoyé',$5)`,
        [companyId, invoice_id, overdueLevel(daysOver), `Email envoyé à ${to_email} — ${subject}`, req.userId]
      );
    }

    res.json({ ok: true, subject });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// VENTE — AVOIRS (credit notes)
// ============================================================

// GET /api/vente/avoirs — list avoirs for the company
app.get('/api/vente/avoirs', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company not found' });
    const { status, search, date_from, date_to } = req.query;

    let where = `WHERE i.company_id = $1 AND i.invoice_subtype = 'avoir'`;
    const params = [companyId];

    if (status && status !== 'all') {
      params.push(status);
      where += ` AND i.status = $${params.length}`;
    }
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      where += ` AND (LOWER(i.invoice_number) LIKE $${params.length} OR LOWER(COALESCE(cl.name, co.name, c.name, '')) LIKE $${params.length})`;
    }
    if (date_from) { params.push(date_from); where += ` AND i.date >= $${params.length}`; }
    if (date_to)   { params.push(date_to);   where += ` AND i.date <= $${params.length}`; }

    const result = await pool.query(`
      SELECT
        i.id, i.invoice_number, i.date, i.status, i.invoice_subtype,
        i.total, i.subtotal, i.tva_amount, i.avoir_id,
        orig.invoice_number AS original_invoice_number,
        COALESCE(cl.name, co.name, c.name) AS client_name,
        i.client_id
      FROM invoices i
      LEFT JOIN contacts c ON i.contact_id = c.id
      LEFT JOIN companies co ON i.contact_id = co.id
      LEFT JOIN clients cl ON i.client_id = cl.id
      LEFT JOIN invoices orig ON i.avoir_id = orig.id
      ${where}
      ORDER BY i.date DESC, i.id DESC
    `, params);

    res.json({ avoirs: result.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/vente/avoirs/:id — get single avoir with lines
app.get('/api/vente/avoirs/:id', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company not found' });
    const result = await pool.query(`
      SELECT i.*, orig.invoice_number AS original_invoice_number,
        COALESCE(cl.name, co.name, c.name) AS client_name
      FROM invoices i
      LEFT JOIN contacts c ON i.contact_id = c.id
      LEFT JOIN companies co ON i.contact_id = co.id
      LEFT JOIN clients cl ON i.client_id = cl.id
      LEFT JOIN invoices orig ON i.avoir_id = orig.id
      WHERE i.id = $1 AND i.company_id = $2 AND i.invoice_subtype = 'avoir'
    `, [req.params.id, companyId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Avoir introuvable' });
    const lines = await pool.query(`SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY id ASC`, [req.params.id]);
    res.json({ avoir: result.rows[0], lines: lines.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// VENTE — SUIVI DES PAIEMENTS
// ============================================================

// GET /api/vente/suivi-paiements — invoices with payment status + KPIs
app.get('/api/vente/suivi-paiements', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company not found' });
    const { search, client_id, date_from, date_to, payment_status } = req.query;

    let where = `WHERE i.company_id = $1 AND i.type IN ('sale','vente') AND COALESCE(i.invoice_subtype,'standard') != 'avoir' AND i.status NOT IN ('draft','cancelled')`;
    const params = [companyId];

    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      where += ` AND (LOWER(i.invoice_number) LIKE $${params.length} OR LOWER(COALESCE(cl.name, co.name, c.name, '')) LIKE $${params.length})`;
    }
    if (client_id) { params.push(client_id); where += ` AND i.client_id = $${params.length}`; }
    if (date_from) { params.push(date_from); where += ` AND i.date >= $${params.length}`; }
    if (date_to)   { params.push(date_to);   where += ` AND i.date <= $${params.length}`; }

    const result = await pool.query(`
      SELECT
        i.id, i.invoice_number, i.date,
        COALESCE(i.due_date, i.date + INTERVAL '30 days') AS due_date,
        i.status, i.total, i.client_id,
        COALESCE(cl.name, co.name, c.name, 'Client inconnu') AS client_name,
        COALESCE(
          (SELECT SUM(cp.amount) FROM client_payments cp WHERE cp.invoice_id = i.id AND cp.status = 'reçu'), 0
        ) AS paid_amount,
        i.total - COALESCE(
          (SELECT SUM(cp.amount) FROM client_payments cp WHERE cp.invoice_id = i.id AND cp.status = 'reçu'), 0
        ) AS remaining_amount,
        CASE
          WHEN i.status = 'paid' THEN 'paid'
          WHEN i.status = 'partiellement_payée' THEN 'partial'
          WHEN COALESCE(i.due_date, i.date + INTERVAL '30 days') < CURRENT_DATE THEN 'overdue'
          ELSE 'unpaid'
        END AS payment_status,
        GREATEST(0, EXTRACT(DAY FROM (CURRENT_DATE - COALESCE(i.due_date, i.date + INTERVAL '30 days')))::int) AS days_overdue
      FROM invoices i
      LEFT JOIN contacts c ON i.contact_id = c.id
      LEFT JOIN companies co ON i.contact_id = co.id
      LEFT JOIN clients cl ON i.client_id = cl.id
      ${where}
      ORDER BY
        CASE WHEN i.status = 'paid' THEN 4
             WHEN COALESCE(i.due_date, i.date + INTERVAL '30 days') < CURRENT_DATE THEN 1
             WHEN i.status = 'partiellement_payée' THEN 2 ELSE 3 END ASC,
        i.date DESC
    `, params);

    let invoices = result.rows;
    if (payment_status && payment_status !== 'all') {
      invoices = invoices.filter(i => i.payment_status === payment_status);
    }

    const totalFacture  = invoices.reduce((s, i) => s + parseFloat(i.total || 0), 0);
    const totalEncaisse = invoices.reduce((s, i) => s + parseFloat(i.paid_amount || 0), 0);
    const totalDu       = invoices.reduce((s, i) => s + Math.max(0, parseFloat(i.remaining_amount || 0)), 0);
    const totalEnRetard = invoices.filter(i => i.payment_status === 'overdue').reduce((s, i) => s + parseFloat(i.remaining_amount || 0), 0);

    res.json({
      invoices,
      kpis: {
        total_facture:  Math.round(totalFacture  * 100) / 100,
        total_encaisse: Math.round(totalEncaisse * 100) / 100,
        total_du:       Math.round(totalDu       * 100) / 100,
        total_en_retard:Math.round(totalEnRetard * 100) / 100,
        count_unpaid:   invoices.filter(i => i.payment_status === 'unpaid').length,
        count_partial:  invoices.filter(i => i.payment_status === 'partial').length,
        count_overdue:  invoices.filter(i => i.payment_status === 'overdue').length,
        count_paid:     invoices.filter(i => i.payment_status === 'paid').length,
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// IMMOBILISATIONS (ASSETS) — Phase 2.5
// ============================================================

// ---- Helper: compute depreciation schedule ----
function computeDepreciationSchedule(asset) {
  const {
    acquisition_value, residual_value, depreciation_years,
    depreciation_method, service_date
  } = asset;

  const val       = parseFloat(acquisition_value) || 0;
  const residual  = parseFloat(residual_value)    || 0;
  const years     = parseInt(depreciation_years)  || 1;
  const svcDate   = new Date(service_date);
  const firstYear = svcDate.getFullYear();

  // Prorata for first year (days remaining in calendar year / 365)
  const yearEnd   = new Date(firstYear, 11, 31);
  const msInYear  = 365 * 24 * 60 * 60 * 1000;
  const daysLeft  = Math.round((yearEnd - svcDate) / (24 * 60 * 60 * 1000)) + 1;
  const prorata1  = Math.min(daysLeft / 365, 1);

  // Degressive coefficient
  let degrCoef = 1;
  if (depreciation_method === 'degressive') {
    if (years >= 7)      degrCoef = 3;
    else if (years >= 5) degrCoef = 2;
    else                 degrCoef = 1.5;
  }

  const linearRate = 1 / years;
  const degrRate   = linearRate * degrCoef;

  const rows = [];
  let vnaStart = val;
  let cumulated = 0;

  for (let i = 0; i < years; i++) {
    const year     = firstYear + i;
    const isFirst  = i === 0;
    const isLast   = i === years - 1;

    let dotation;

    if (depreciation_method === 'linear') {
      const base = (val - residual) * linearRate;
      dotation = isFirst ? base * prorata1 : base;
    } else {
      // Degressive
      const remainingYears = years - i;
      const linearDot  = (vnaStart - residual) / remainingYears;
      const degrDot    = vnaStart * degrRate * (isFirst ? prorata1 : 1);
      dotation = Math.max(linearDot, degrDot);
    }

    // Cap at VNA to never go below residual
    dotation = Math.min(dotation, vnaStart - residual);
    dotation = Math.round(dotation * 100) / 100;

    cumulated += dotation;
    cumulated  = Math.round(cumulated * 100) / 100;

    const vnaEnd = Math.max(Math.round((vnaStart - dotation) * 100) / 100, residual);

    rows.push({
      fiscal_year:         year,
      start_vna:           Math.round(vnaStart * 100) / 100,
      depreciation_amount: dotation,
      cumulated,
      end_vna:             vnaEnd
    });

    vnaStart = vnaEnd;
    if (vnaStart <= residual) break;
  }

  return rows;
}

// ---- Save depreciation schedule ----
async function saveDepreciationSchedule(client, assetId, rows) {
  await client.query('DELETE FROM asset_depreciations WHERE asset_id = $1', [assetId]);
  for (const r of rows) {
    await client.query(
      `INSERT INTO asset_depreciations (asset_id, fiscal_year, start_vna, depreciation_amount, cumulated, end_vna)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [assetId, r.fiscal_year, r.start_vna, r.depreciation_amount, r.cumulated, r.end_vna]
    );
  }
}

// GET /api/assets — listing with filters
app.get('/api/assets', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company required' });

    const { category, status, year_from, year_to } = req.query;
    const params = [companyId];
    let where = 'WHERE a.company_id = $1';
    let idx = 2;

    if (category) { where += ` AND a.category = $${idx++}`; params.push(category); }
    if (status)   { where += ` AND a.status = $${idx++}`;   params.push(status); }
    if (year_from){ where += ` AND EXTRACT(YEAR FROM a.acquisition_date) >= $${idx++}`; params.push(parseInt(year_from)); }
    if (year_to)  { where += ` AND EXTRACT(YEAR FROM a.acquisition_date) <= $${idx++}`; params.push(parseInt(year_to)); }

    const result = await pool.query(`
      SELECT
        a.*,
        COALESCE(SUM(d.depreciation_amount), 0) AS cumulated_depreciation,
        a.acquisition_value - COALESCE(SUM(d.depreciation_amount), 0) AS current_vna
      FROM assets a
      LEFT JOIN asset_depreciations d ON d.asset_id = a.id
      ${where}
      GROUP BY a.id
      ORDER BY a.acquisition_date DESC, a.id DESC
    `, params);

    // Totals
    const totals = result.rows.reduce((acc, r) => {
      acc.total_value       += parseFloat(r.acquisition_value) || 0;
      acc.total_depreciation += parseFloat(r.cumulated_depreciation) || 0;
      acc.total_vna         += parseFloat(r.current_vna) || 0;
      return acc;
    }, { total_value: 0, total_depreciation: 0, total_vna: 0 });

    res.json({ assets: result.rows, totals });
  } catch (e) { console.error('[ASSETS GET]', e); res.status(500).json({ error: e.message }); }
});

// GET /api/assets/depreciation-summary?year=YYYY — récap annuel par catégorie
app.get('/api/assets/depreciation-summary', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company required' });
    const year = parseInt(req.query.year) || new Date().getFullYear();

    const result = await pool.query(`
      SELECT
        a.category,
        COUNT(a.id)::int AS nb_assets,
        SUM(a.acquisition_value) AS total_brut,
        COALESCE(SUM(d_all.cumulated), 0) AS total_amort_cumule,
        SUM(a.acquisition_value) - COALESCE(SUM(d_all.cumulated), 0) AS total_vna,
        COALESCE(SUM(d_year.depreciation_amount), 0) AS dotation_exercice
      FROM assets a
      LEFT JOIN (
        SELECT asset_id, SUM(depreciation_amount) AS cumulated
        FROM asset_depreciations GROUP BY asset_id
      ) d_all ON d_all.asset_id = a.id
      LEFT JOIN asset_depreciations d_year ON d_year.asset_id = a.id AND d_year.fiscal_year = $2
      WHERE a.company_id = $1
      GROUP BY a.category
      ORDER BY a.category
    `, [companyId, year]);

    const totals = result.rows.reduce((acc, r) => {
      acc.total_brut         += parseFloat(r.total_brut) || 0;
      acc.total_amort_cumule += parseFloat(r.total_amort_cumule) || 0;
      acc.total_vna          += parseFloat(r.total_vna) || 0;
      acc.dotation_exercice  += parseFloat(r.dotation_exercice) || 0;
      return acc;
    }, { total_brut: 0, total_amort_cumule: 0, total_vna: 0, dotation_exercice: 0 });

    res.json({ rows: result.rows, totals, year });
  } catch (e) { console.error('[ASSETS SUMMARY]', e); res.status(500).json({ error: e.message }); }
});

// GET /api/assets/:id — single asset detail
app.get('/api/assets/:id', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company required' });

    const assetRes = await pool.query(
      'SELECT * FROM assets WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (!assetRes.rows.length) return res.status(404).json({ error: 'Not found' });

    const scheduleRes = await pool.query(
      'SELECT * FROM asset_depreciations WHERE asset_id = $1 ORDER BY fiscal_year',
      [req.params.id]
    );

    res.json({ asset: assetRes.rows[0], schedule: scheduleRes.rows });
  } catch (e) { console.error('[ASSETS GET ID]', e); res.status(500).json({ error: e.message }); }
});

// GET /api/assets/:id/depreciation-schedule
app.get('/api/assets/:id/depreciation-schedule', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company required' });

    const assetRes = await pool.query(
      'SELECT * FROM assets WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (!assetRes.rows.length) return res.status(404).json({ error: 'Not found' });
    const asset = assetRes.rows[0];

    // Always recompute on demand
    const rows = computeDepreciationSchedule(asset);
    res.json({ schedule: rows });
  } catch (e) { console.error('[ASSETS SCHEDULE]', e); res.status(500).json({ error: e.message }); }
});

// POST /api/assets — create asset
app.post('/api/assets', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company required' });

    const {
      designation, category, account_code,
      acquisition_date, service_date,
      acquisition_value, residual_value,
      depreciation_years, depreciation_method,
      status, invoice_id, location, notes
    } = req.body;

    if (!designation || !category || !account_code || !acquisition_date || !service_date || !acquisition_value) {
      return res.status(400).json({ error: 'Champs obligatoires manquants' });
    }

    const insertRes = await pool.query(
      `INSERT INTO assets
         (company_id, designation, category, account_code, acquisition_date, service_date,
          acquisition_value, residual_value, depreciation_years, depreciation_method,
          status, invoice_id, location, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        companyId, designation, category, account_code,
        acquisition_date, service_date,
        parseFloat(acquisition_value) || 0,
        parseFloat(residual_value) || 0,
        parseInt(depreciation_years) || 5,
        depreciation_method || 'linear',
        status || 'active',
        invoice_id || null,
        location || null,
        notes || null
      ]
    );

    const asset = insertRes.rows[0];
    const schedule = computeDepreciationSchedule(asset);
    await saveDepreciationSchedule(pool, asset.id, schedule);

    res.json({ asset, schedule });
  } catch (e) { console.error('[ASSETS POST]', e); res.status(500).json({ error: e.message }); }
});

// PUT /api/assets/:id — update asset
app.put('/api/assets/:id', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company required' });

    const existing = await pool.query(
      'SELECT id FROM assets WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Not found' });

    const {
      designation, category, account_code,
      acquisition_date, service_date,
      acquisition_value, residual_value,
      depreciation_years, depreciation_method,
      status, invoice_id, location, notes
    } = req.body;

    const updateRes = await pool.query(
      `UPDATE assets SET
         designation=$1, category=$2, account_code=$3,
         acquisition_date=$4, service_date=$5,
         acquisition_value=$6, residual_value=$7,
         depreciation_years=$8, depreciation_method=$9,
         status=$10, invoice_id=$11, location=$12, notes=$13,
         updated_at=NOW()
       WHERE id=$14 AND company_id=$15
       RETURNING *`,
      [
        designation, category, account_code,
        acquisition_date, service_date,
        parseFloat(acquisition_value) || 0,
        parseFloat(residual_value) || 0,
        parseInt(depreciation_years) || 5,
        depreciation_method || 'linear',
        status || 'active',
        invoice_id || null,
        location || null,
        notes || null,
        req.params.id, companyId
      ]
    );

    const asset = updateRes.rows[0];
    const schedule = computeDepreciationSchedule(asset);
    await saveDepreciationSchedule(pool, asset.id, schedule);

    res.json({ asset, schedule });
  } catch (e) { console.error('[ASSETS PUT]', e); res.status(500).json({ error: e.message }); }
});

// DELETE /api/assets/:id
app.delete('/api/assets/:id', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company required' });

    const result = await pool.query(
      'DELETE FROM assets WHERE id = $1 AND company_id = $2 RETURNING id',
      [req.params.id, companyId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });

    res.json({ ok: true });
  } catch (e) { console.error('[ASSETS DELETE]', e); res.status(500).json({ error: e.message }); }
});

// GET /api/assets/export/csv
app.get('/api/assets/export/csv', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company required' });

    const result = await pool.query(`
      SELECT
        a.designation, a.category, a.account_code,
        a.acquisition_date, a.service_date,
        a.acquisition_value, a.residual_value,
        a.depreciation_years, a.depreciation_method, a.status,
        a.location,
        COALESCE(SUM(d.depreciation_amount), 0) AS cumulated_depreciation,
        a.acquisition_value - COALESCE(SUM(d.depreciation_amount), 0) AS current_vna
      FROM assets a
      LEFT JOIN asset_depreciations d ON d.asset_id = a.id
      WHERE a.company_id = $1
      GROUP BY a.id
      ORDER BY a.acquisition_date DESC
    `, [companyId]);

    const rows = result.rows;
    const headers = [
      'Désignation','Catégorie','Compte PCM','Date acquisition','Date mise en service',
      'Valeur acquisition','Valeur résiduelle','Durée (ans)','Mode amort.',
      'Amort. cumulé','VNA','Statut','Localisation'
    ];

    const csv = [
      headers.join(';'),
      ...rows.map(r => [
        r.designation, r.category, r.account_code,
        r.acquisition_date ? r.acquisition_date.toISOString().split('T')[0] : '',
        r.service_date     ? r.service_date.toISOString().split('T')[0]     : '',
        r.acquisition_value, r.residual_value,
        r.depreciation_years, r.depreciation_method,
        parseFloat(r.cumulated_depreciation).toFixed(2),
        parseFloat(r.current_vna).toFixed(2),
        r.status, r.location || ''
      ].map(v => `"${String(v).replace(/"/g,'""')}"`).join(';'))
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="immobilisations.csv"');
    res.send('\uFEFF' + csv); // BOM for Excel
  } catch (e) { console.error('[ASSETS CSV]', e); res.status(500).json({ error: e.message }); }
});

// ============================================================
// PHASE 2.6 — DOTATIONS AUTO + CESSION / REBUT
// ============================================================

// PCM marocain: category → { dep_account, dep_name, expense_account, expense_name }
const ASSET_ACCOUNT_MAPPINGS = {
  'frais-etablissement':   { dep_account: '2811', dep_name: 'Amort. frais d\'établissement',       expense_account: '6191', expense_name: 'DEA des frais d\'établissement' },
  'brevets-logiciels':     { dep_account: '2820', dep_name: 'Amort. immobilisations incorporelles', expense_account: '6193', expense_name: 'DEA des immobilisations incorporelles' },
  'constructions':         { dep_account: '2832', dep_name: 'Amort. constructions',                 expense_account: '6194', expense_name: 'DEA des immobilisations corporelles' },
  'materiel-outillage':    { dep_account: '2833', dep_name: 'Amort. matériel & outillage',          expense_account: '6194', expense_name: 'DEA des immobilisations corporelles' },
  'materiel-transport':    { dep_account: '2834', dep_name: 'Amort. matériel de transport',         expense_account: '6194', expense_name: 'DEA des immobilisations corporelles' },
  'mobilier-bureau':       { dep_account: '2835', dep_name: 'Amort. mobilier de bureau',            expense_account: '6194', expense_name: 'DEA des immobilisations corporelles' },
  'materiel-informatique': { dep_account: '2836', dep_name: 'Amort. matériel informatique',         expense_account: '6193', expense_name: 'DEA des immobilisations incorporelles' },
  'agencements':           { dep_account: '2831', dep_name: 'Amort. agencements & installations',   expense_account: '6194', expense_name: 'DEA des immobilisations corporelles' },
};

// POST /api/assets/generate-depreciations
// Without confirm:true → returns preview only
// With confirm:true → creates OD journal entries
app.post('/api/assets/generate-depreciations', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company required' });

    const { period, year, month, confirm } = req.body;
    if (!period || !year) return res.status(400).json({ error: 'period et year sont requis' });
    if (!['annual', 'monthly'].includes(period)) return res.status(400).json({ error: 'period doit être annual ou monthly' });
    if (period === 'monthly' && (!month || month < 1 || month > 12)) {
      return res.status(400).json({ error: 'month requis pour period mensuelle (1-12)' });
    }

    const targetYear  = parseInt(year);
    const targetMonth = period === 'monthly' ? parseInt(month) : null;

    // Get active assets with their scheduled dotation for the target year
    const assetsRes = await pool.query(
      `SELECT a.*, COALESCE(d.depreciation_amount, 0) AS annual_dotation
       FROM assets a
       LEFT JOIN asset_depreciations d ON d.asset_id = a.id AND d.fiscal_year = $2
       WHERE a.company_id = $1 AND a.status = 'active' AND a.depreciation_years > 0
       ORDER BY a.designation`,
      [companyId, targetYear]
    );

    const items = assetsRes.rows
      .filter(a => parseFloat(a.annual_dotation) > 0)
      .map(a => {
        const annualDot  = parseFloat(a.annual_dotation) || 0;
        const dotation   = period === 'monthly' ? Math.round((annualDot / 12) * 100) / 100 : annualDot;
        const mapping    = ASSET_ACCOUNT_MAPPINGS[a.category] || {};
        const periodLabel= period === 'monthly' ? `${String(targetMonth).padStart(2,'0')}/${targetYear}` : `${targetYear}`;
        return {
          asset_id:    a.id,
          designation: a.designation,
          category:    a.category,
          account_code:a.account_code,
          dep_account: mapping.dep_account || '2839',
          dep_name:    mapping.dep_name    || 'Amortissements',
          exp_account: mapping.expense_account || '6194',
          exp_name:    mapping.expense_name    || 'DEA immobilisations',
          annual_dotation: annualDot,
          dotation,
          period_label: periodLabel,
        };
      });

    const total = Math.round(items.reduce((s, i) => s + i.dotation, 0) * 100) / 100;

    if (!confirm) return res.json({ preview: items, total, nb: items.length });

    // Create journal entries
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const createdEntries = [];
      for (const item of items) {
        if (item.dotation <= 0) continue;
        const dateStr  = period === 'monthly'
          ? `${targetYear}-${String(targetMonth).padStart(2,'0')}-28`
          : `${targetYear}-12-31`;
        const seqRes   = await client.query(
          `SELECT COUNT(*)+1 AS seq FROM journal_entries WHERE company_id=$1 AND journal_type='OD'`, [companyId]
        );
        const entryNum = `OD-AM-${period==='monthly'?String(targetMonth).padStart(2,'0'):''}${targetYear}-${String(seqRes.rows[0].seq).padStart(4,'0')}`;
        const libelle  = `Dotation amortissement ${item.designation} - ${item.period_label}`;
        const jRes = await client.query(
          `INSERT INTO journal_entries
             (company_id, entry_number, date, journal_type, reference, description, source_type, source_id, total_debit, total_credit, user_id)
           VALUES ($1,$2,$3,'OD',$4,$5,'asset_depreciation',$6,$7,$8,$9) RETURNING id`,
          [companyId, entryNum, dateStr, `AM-${targetYear}`, libelle, item.asset_id, item.dotation, item.dotation, req.userId]
        );
        const jId = jRes.rows[0].id;
        // Débit 619x — DEA
        await client.query(
          `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order)
           VALUES ($1,$2,$3,$4,0,$5,0)`,
          [jId, item.exp_account, item.exp_name, item.dotation, libelle]
        );
        // Crédit 28xx — Amortissement
        await client.query(
          `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order)
           VALUES ($1,$2,$3,0,$4,$5,1)`,
          [jId, item.dep_account, item.dep_name, item.dotation, libelle]
        );
        createdEntries.push({ entry_id: jId, entry_number: entryNum, asset_id: item.asset_id, dotation: item.dotation });
      }
      await client.query('COMMIT');
      res.json({ ok: true, entries_created: createdEntries.length, total, entries: createdEntries });
    } catch (e) {
      await client.query('ROLLBACK'); throw e;
    } finally { client.release(); }
  } catch (e) { console.error('[ASSETS GEN-DEP]', e); res.status(500).json({ error: e.message }); }
});

// POST /api/assets/:id/dispose — cession d'immobilisation
app.post('/api/assets/:id/dispose', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company required' });
    const { date, sale_price } = req.body;
    if (!date || sale_price === undefined) return res.status(400).json({ error: 'date et sale_price sont requis' });

    const assetRes = await pool.query('SELECT * FROM assets WHERE id=$1 AND company_id=$2', [req.params.id, companyId]);
    if (!assetRes.rows.length) return res.status(404).json({ error: 'Immobilisation introuvable' });
    const asset = assetRes.rows[0];
    if (asset.status !== 'active') return res.status(400).json({ error: 'Seules les immobilisations en service peuvent être cédées' });

    const depRes = await pool.query(
      'SELECT COALESCE(SUM(depreciation_amount),0) AS total_dep FROM asset_depreciations WHERE asset_id=$1', [asset.id]
    );
    const totalDep   = parseFloat(depRes.rows[0].total_dep) || 0;
    const acqValue   = parseFloat(asset.acquisition_value) || 0;
    const vna        = Math.round(Math.max(acqValue - totalDep, 0) * 100) / 100;
    const salePrice  = Math.round((parseFloat(sale_price) || 0) * 100) / 100;
    const plusValue  = Math.round((salePrice - vna) * 100) / 100;
    const mapping    = ASSET_ACCOUNT_MAPPINGS[asset.category] || {};
    const depAccount = mapping.dep_account || '2839';
    const depName    = mapping.dep_name    || 'Amortissements';
    const dateStr    = (String(date)).includes('T') ? date.split('T')[0] : date;
    const libelle    = `Cession immobilisation: ${asset.designation}`;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const seqRes = await client.query(
        `SELECT COUNT(*)+1 AS seq FROM journal_entries WHERE company_id=$1 AND journal_type='OD'`, [companyId]
      );
      const entryNum = `OD-CS-${dateStr.replace(/-/g,'').substring(0,6)}-${String(seqRes.rows[0].seq).padStart(4,'0')}`;
      const totalDebit  = Math.round((totalDep + vna + salePrice) * 100) / 100;
      const totalCredit = Math.round((acqValue + salePrice) * 100) / 100;
      const jRes = await client.query(
        `INSERT INTO journal_entries
           (company_id, entry_number, date, journal_type, reference, description, source_type, source_id, total_debit, total_credit, user_id)
         VALUES ($1,$2,$3,'OD',$4,$5,'asset_disposal',$6,$7,$8,$9) RETURNING id`,
        [companyId, entryNum, dateStr, `CS-${asset.id}`, libelle, asset.id, totalDebit, totalCredit, req.userId]
      );
      const jId = jRes.rows[0].id;
      let sort = 0;
      if (totalDep > 0) {
        await client.query(
          `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order) VALUES ($1,$2,$3,$4,0,$5,$6)`,
          [jId, depAccount, depName, totalDep, libelle, sort++]
        );
      }
      if (vna > 0) {
        await client.query(
          `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order) VALUES ($1,'6513','VNA des immobilisations cédées',$2,0,$3,$4)`,
          [jId, vna, libelle, sort++]
        );
      }
      await client.query(
        `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order) VALUES ($1,$2,$3,0,$4,$5,$6)`,
        [jId, asset.account_code, `Immob.: ${asset.designation}`, acqValue, libelle, sort++]
      );
      if (salePrice > 0) {
        await client.query(
          `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order) VALUES ($1,'3481','Créances sur cessions d\'immobilisations',$2,0,$3,$4)`,
          [jId, salePrice, libelle, sort++]
        );
        await client.query(
          `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order) VALUES ($1,'7513','Produits de cessions des immobilisations',0,$2,$3,$4)`,
          [jId, salePrice, libelle, sort++]
        );
      }
      await client.query(`UPDATE assets SET status='sold', updated_at=NOW() WHERE id=$1`, [asset.id]);
      await client.query('COMMIT');
      res.json({ ok: true, entry_id: jId, entry_number: entryNum, acq_value: acqValue, total_dep: totalDep, vna, sale_price: salePrice, plus_value: plusValue });
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch (e) { console.error('[ASSETS DISPOSE]', e); res.status(500).json({ error: e.message }); }
});

// POST /api/assets/:id/scrap — mise au rebut
app.post('/api/assets/:id/scrap', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company required' });
    const { date, reason } = req.body;
    if (!date) return res.status(400).json({ error: 'date est requis' });

    const assetRes = await pool.query('SELECT * FROM assets WHERE id=$1 AND company_id=$2', [req.params.id, companyId]);
    if (!assetRes.rows.length) return res.status(404).json({ error: 'Immobilisation introuvable' });
    const asset = assetRes.rows[0];
    if (asset.status !== 'active') return res.status(400).json({ error: 'Seules les immobilisations en service peuvent être mises au rebut' });

    const depRes = await pool.query(
      'SELECT COALESCE(SUM(depreciation_amount),0) AS total_dep FROM asset_depreciations WHERE asset_id=$1', [asset.id]
    );
    const totalDep   = parseFloat(depRes.rows[0].total_dep) || 0;
    const acqValue   = parseFloat(asset.acquisition_value) || 0;
    const vna        = Math.round(Math.max(acqValue - totalDep, 0) * 100) / 100;
    const mapping    = ASSET_ACCOUNT_MAPPINGS[asset.category] || {};
    const depAccount = mapping.dep_account || '2839';
    const depName    = mapping.dep_name    || 'Amortissements';
    const dateStr    = (String(date)).includes('T') ? date.split('T')[0] : date;
    const libelle    = `Mise au rebut: ${asset.designation}${reason ? ' — ' + reason : ''}`;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const seqRes = await client.query(
        `SELECT COUNT(*)+1 AS seq FROM journal_entries WHERE company_id=$1 AND journal_type='OD'`, [companyId]
      );
      const entryNum = `OD-RB-${dateStr.replace(/-/g,'').substring(0,6)}-${String(seqRes.rows[0].seq).padStart(4,'0')}`;
      const totalAmt = Math.round((totalDep + vna) * 100) / 100;
      const jRes = await client.query(
        `INSERT INTO journal_entries
           (company_id, entry_number, date, journal_type, reference, description, source_type, source_id, total_debit, total_credit, user_id)
         VALUES ($1,$2,$3,'OD',$4,$5,'asset_scrap',$6,$7,$8,$9) RETURNING id`,
        [companyId, entryNum, dateStr, `RB-${asset.id}`, libelle, asset.id, totalAmt, acqValue, req.userId]
      );
      const jId = jRes.rows[0].id;
      let sort = 0;
      if (totalDep > 0) {
        await client.query(
          `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order) VALUES ($1,$2,$3,$4,0,$5,$6)`,
          [jId, depAccount, depName, totalDep, libelle, sort++]
        );
      }
      if (vna > 0) {
        await client.query(
          `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order) VALUES ($1,'6513','VNA des immobilisations mises au rebut',$2,0,$3,$4)`,
          [jId, vna, libelle, sort++]
        );
      }
      await client.query(
        `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order) VALUES ($1,$2,$3,0,$4,$5,$6)`,
        [jId, asset.account_code, `Immob.: ${asset.designation}`, acqValue, libelle, sort++]
      );
      await client.query(
        `UPDATE assets SET status='scrapped', notes=CASE WHEN notes IS NULL THEN $2 ELSE notes||' | Rebut: '||$2 END, updated_at=NOW() WHERE id=$1`,
        [asset.id, reason || '']
      );
      await client.query('COMMIT');
      res.json({ ok: true, entry_id: jId, entry_number: entryNum, acq_value: acqValue, total_dep: totalDep, vna });
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch (e) { console.error('[ASSETS SCRAP]', e); res.status(500).json({ error: e.message }); }
});

// ============================================================
// GLOBAL SEARCH
// ============================================================
app.get('/api/search', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json({ results: {} });

    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.json({ results: {} });

    const pattern = `%${q}%`;

    const [invoicesRes, contactsRes, journalRes, expensesRes, accountsRes, dossiersRes] = await Promise.all([
      // Factures (ventes)
      pool.query(
        `SELECT i.id, i.invoice_number, i.total_ttc as amount, i.date, i.status, i.type,
                c.name as contact_name
         FROM invoices i
         LEFT JOIN contacts c ON c.id = i.contact_id
         WHERE i.company_id = $1 AND i.type = 'sale' AND (
           i.invoice_number ILIKE $2 OR c.name ILIKE $2
         )
         ORDER BY i.date DESC LIMIT 5`,
        [companyId, pattern]
      ),
      // Contacts
      pool.query(
        `SELECT id, name, ice, type, email
         FROM contacts
         WHERE company_id = $1 AND (name ILIKE $2 OR ice ILIKE $2 OR email ILIKE $2)
         ORDER BY name LIMIT 5`,
        [companyId, pattern]
      ),
      // Journal entries
      pool.query(
        `SELECT id, entry_number, description, date, total_debit, journal_type
         FROM journal_entries
         WHERE company_id = $1 AND (description ILIKE $2 OR entry_number ILIKE $2 OR reference ILIKE $2)
         ORDER BY date DESC LIMIT 5`,
        [companyId, pattern]
      ),
      // Expenses (factures fournisseurs)
      pool.query(
        `SELECT e.id, e.description, e.total, e.date, e.status,
                c.name as contact_name
         FROM expenses e
         LEFT JOIN contacts c ON c.id = e.contact_id
         WHERE e.company_id = $1 AND (e.description ILIKE $2 OR c.name ILIKE $2)
         ORDER BY e.date DESC LIMIT 5`,
        [companyId, pattern]
      ),
      // PCM Accounts
      pool.query(
        `SELECT id, code, name, class
         FROM pcm_accounts
         WHERE (code ILIKE $1 OR name ILIKE $1) AND is_active = true
         ORDER BY code LIMIT 5`,
        [pattern]
      ),
      // Cabinet dossiers
      req.userType === 'cabinet'
        ? pool.query(
            `SELECT cd.id, cd.name
             FROM cabinet_dossiers cd
             WHERE cd.cabinet_owner_id = $1 AND cd.name ILIKE $2
             ORDER BY cd.name LIMIT 5`,
            [req.cabinetOwnerId, pattern]
          )
        : Promise.resolve({ rows: [] })
    ]);

    res.json({
      results: {
        factures: invoicesRes.rows,
        contacts: contactsRes.rows,
        ecritures: journalRes.rows,
        depenses: expensesRes.rows,
        comptes: accountsRes.rows,
        dossiers: dossiersRes.rows
      }
    });
  } catch (e) {
    console.error('[SEARCH]', e);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// CLÔTURE D'EXERCICE — Phase 2.4
// ============================================================

// GET /api/exercices — list fiscal years for current company
app.get('/api/exercices', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Aucune entreprise sélectionnée' });
    const result = await pool.query(
      `SELECT fy.*, u.name as closed_by_name
       FROM fiscal_years fy
       LEFT JOIN users u ON u.id = fy.closed_by
       WHERE fy.company_id = $1
       ORDER BY fy.start_date DESC`,
      [companyId]
    );
    res.json({ exercices: result.rows });
  } catch (err) {
    console.error('GET /api/exercices error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/exercices — create new fiscal year
app.post('/api/exercices', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Aucune entreprise sélectionnée' });
    const { label, start_date, end_date } = req.body;
    if (!label || !start_date || !end_date) {
      return res.status(400).json({ error: 'label, start_date et end_date sont requis' });
    }
    // Check no overlapping open exercice
    const existing = await pool.query(
      `SELECT id FROM fiscal_years WHERE company_id = $1 AND status != 'cloture'
       AND (start_date <= $2::date AND end_date >= $3::date)`,
      [companyId, end_date, start_date]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Un exercice ouvert chevauche déjà cette période' });
    }
    const result = await pool.query(
      `INSERT INTO fiscal_years (company_id, label, start_date, end_date, status)
       VALUES ($1, $2, $3, $4, 'ouvert') RETURNING *`,
      [companyId, label, start_date, end_date]
    );
    res.json({ exercice: result.rows[0] });
  } catch (err) {
    console.error('POST /api/exercices error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/cloture/pre-checks?exercice_id=X — run pre-closure checks
app.get('/api/cloture/pre-checks', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Aucune entreprise sélectionnée' });
    const { exercice_id } = req.query;
    if (!exercice_id) return res.status(400).json({ error: 'exercice_id requis' });
    const fyRes = await pool.query(
      `SELECT * FROM fiscal_years WHERE id = $1 AND company_id = $2`,
      [exercice_id, companyId]
    );
    if (fyRes.rows.length === 0) return res.status(404).json({ error: 'Exercice non trouvé' });
    const fy = fyRes.rows[0];
    const checks = [];

    // 1. Balance Générale équilibrée
    const balRes = await pool.query(`
      SELECT
        COALESCE(SUM(jel.debit), 0) as total_debit,
        COALESCE(SUM(jel.credit), 0) as total_credit
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.journal_entry_id
      WHERE je.company_id = $1 AND je.date BETWEEN $2 AND $3
        AND je.journal_type != 'RAN'
    `, [companyId, fy.start_date, fy.end_date]);
    const totDebit = parseFloat(balRes.rows[0].total_debit);
    const totCredit = parseFloat(balRes.rows[0].total_credit);
    const balanceDiff = Math.abs(totDebit - totCredit);
    checks.push({
      key: 'balance_equilibree',
      label: 'Balance Générale équilibrée',
      status: balanceDiff < 0.01 ? 'ok' : 'error',
      detail: balanceDiff < 0.01
        ? `Débit = Crédit = ${totDebit.toLocaleString('fr-MA', { minimumFractionDigits: 2 })} MAD`
        : `Déséquilibre de ${balanceDiff.toFixed(2)} MAD (Débit: ${totDebit.toFixed(2)}, Crédit: ${totCredit.toFixed(2)})`,
      blocking: true
    });

    // 2. Factures de la période validées
    const draftInvRes = await pool.query(`
      SELECT COUNT(*) as cnt FROM invoices
      WHERE company_id = $1 AND status = 'draft' AND date BETWEEN $2 AND $3
    `, [companyId, fy.start_date, fy.end_date]);
    const draftInvCount = parseInt(draftInvRes.rows[0].cnt);
    checks.push({
      key: 'factures_validees',
      label: 'Toutes les factures validées',
      status: draftInvCount === 0 ? 'ok' : 'warning',
      detail: draftInvCount === 0
        ? 'Aucune facture en brouillon'
        : `${draftInvCount} facture(s) en brouillon non validée(s)`,
      blocking: false
    });

    // 3. Rapprochement bancaire
    let unreconCount = 0;
    try {
      const unreconRes = await pool.query(`
        SELECT COUNT(*) as cnt FROM bank_transactions
        WHERE company_id = $1 AND date BETWEEN $2 AND $3 AND reconciled = false
      `, [companyId, fy.start_date, fy.end_date]);
      unreconCount = parseInt(unreconRes.rows[0].cnt);
    } catch (_e) { unreconCount = 0; }
    checks.push({
      key: 'rapprochement_bancaire',
      label: 'Rapprochement bancaire à jour',
      status: unreconCount === 0 ? 'ok' : 'warning',
      detail: unreconCount === 0
        ? 'Toutes les transactions bancaires sont rapprochées'
        : `${unreconCount} transaction(s) non rapprochée(s)`,
      blocking: false
    });

    // 4. Lettrage clients
    let unlettered = 0;
    try {
      const letterageRes = await pool.query(`
        SELECT COUNT(*) as cnt
        FROM journal_entry_lines jel
        JOIN journal_entries je ON je.id = jel.journal_entry_id
        WHERE je.company_id = $1 AND je.date BETWEEN $2 AND $3
          AND jel.account_code LIKE '3421%'
          AND jel.lettrage_code IS NULL AND jel.credit > 0
      `, [companyId, fy.start_date, fy.end_date]);
      unlettered = parseInt(letterageRes.rows[0].cnt);
    } catch (_e) { unlettered = 0; }
    checks.push({
      key: 'lettrage',
      label: 'Lettrage clients/fournisseurs effectué',
      status: unlettered === 0 ? 'ok' : 'warning',
      detail: unlettered === 0
        ? 'Tous les règlements clients sont lettrés'
        : `${unlettered} règlement(s) clients non lettrés`,
      blocking: false
    });

    // 5. Écritures de la période
    const totalEntriesRes = await pool.query(`
      SELECT COUNT(*) as cnt FROM journal_entries
      WHERE company_id = $1 AND date BETWEEN $2 AND $3
    `, [companyId, fy.start_date, fy.end_date]);
    const totalEntries = parseInt(totalEntriesRes.rows[0].cnt);
    checks.push({
      key: 'tva_declaree',
      label: 'Écritures comptables de la période',
      status: totalEntries > 0 ? 'ok' : 'warning',
      detail: totalEntries > 0
        ? `${totalEntries} écriture(s) comptable(s) enregistrée(s)`
        : 'Aucune écriture dans la période — vérifiez les déclarations TVA',
      blocking: false
    });

    // 6. Exercice déjà clôturé?
    if (fy.status === 'cloture') {
      checks.push({
        key: 'already_closed',
        label: 'Statut de l\'exercice',
        status: 'error',
        detail: `Cet exercice a déjà été clôturé le ${new Date(fy.closed_at).toLocaleDateString('fr-MA')}`,
        blocking: true
      });
    }

    const hasBlockingError = checks.some(c => c.status === 'error' && c.blocking);
    res.json({ checks, can_continue: !hasBlockingError, exercice: fy });
  } catch (err) {
    console.error('GET /api/cloture/pre-checks error:', err.message);
    res.status(500).json({ error: 'Erreur serveur: ' + err.message });
  }
});

// GET /api/cloture/resultat?exercice_id=X — calculate net result
app.get('/api/cloture/resultat', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Aucune entreprise sélectionnée' });
    const { exercice_id } = req.query;
    if (!exercice_id) return res.status(400).json({ error: 'exercice_id requis' });
    const fyRes = await pool.query(
      `SELECT * FROM fiscal_years WHERE id = $1 AND company_id = $2`,
      [exercice_id, companyId]
    );
    if (fyRes.rows.length === 0) return res.status(404).json({ error: 'Exercice non trouvé' });
    const fy = fyRes.rows[0];

    // Class 7: Produits — net = credit - debit
    const prodsRes = await pool.query(`
      SELECT jel.account_code,
        COALESCE(jel.account_name, pa.name) as account_name,
        COALESCE(SUM(jel.credit), 0) as total_credit,
        COALESCE(SUM(jel.debit), 0) as total_debit
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.journal_entry_id
      LEFT JOIN pcm_accounts pa ON pa.code = jel.account_code
      WHERE je.company_id = $1 AND je.date BETWEEN $2 AND $3
        AND jel.account_code LIKE '7%' AND je.journal_type != 'RAN'
      GROUP BY jel.account_code, jel.account_name, pa.name
      ORDER BY jel.account_code
    `, [companyId, fy.start_date, fy.end_date]);

    // Class 6: Charges — net = debit - credit
    const chargesRes = await pool.query(`
      SELECT jel.account_code,
        COALESCE(jel.account_name, pa.name) as account_name,
        COALESCE(SUM(jel.debit), 0) as total_debit,
        COALESCE(SUM(jel.credit), 0) as total_credit
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.journal_entry_id
      LEFT JOIN pcm_accounts pa ON pa.code = jel.account_code
      WHERE je.company_id = $1 AND je.date BETWEEN $2 AND $3
        AND jel.account_code LIKE '6%' AND je.journal_type != 'RAN'
      GROUP BY jel.account_code, jel.account_name, pa.name
      ORDER BY jel.account_code
    `, [companyId, fy.start_date, fy.end_date]);

    let totalProduits = 0;
    for (const row of prodsRes.rows) {
      totalProduits += parseFloat(row.total_credit) - parseFloat(row.total_debit);
    }
    let totalCharges = 0;
    for (const row of chargesRes.rows) {
      totalCharges += parseFloat(row.total_debit) - parseFloat(row.total_credit);
    }
    const resultat = totalProduits - totalCharges;

    res.json({
      exercice: fy,
      total_produits: totalProduits,
      total_charges: totalCharges,
      resultat,
      is_benefice: resultat >= 0,
      produits_detail: prodsRes.rows,
      charges_detail: chargesRes.rows
    });
  } catch (err) {
    console.error('GET /api/cloture/resultat error:', err.message);
    res.status(500).json({ error: 'Erreur serveur: ' + err.message });
  }
});

// GET /api/cloture/preview-ran?exercice_id=X — preview RAN entries
app.get('/api/cloture/preview-ran', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Aucune entreprise sélectionnée' });
    const { exercice_id } = req.query;
    if (!exercice_id) return res.status(400).json({ error: 'exercice_id requis' });
    const fyRes = await pool.query(
      `SELECT * FROM fiscal_years WHERE id = $1 AND company_id = $2`,
      [exercice_id, companyId]
    );
    if (fyRes.rows.length === 0) return res.status(404).json({ error: 'Exercice non trouvé' });
    const fy = fyRes.rows[0];

    const bsRes = await pool.query(`
      SELECT
        jel.account_code,
        COALESCE(jel.account_name, pa.name) as account_name,
        COALESCE(SUM(jel.debit), 0) as total_debit,
        COALESCE(SUM(jel.credit), 0) as total_credit,
        pa.class as account_class,
        pa.type as account_type
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.journal_entry_id
      LEFT JOIN pcm_accounts pa ON pa.code = jel.account_code
      WHERE je.company_id = $1 AND je.date BETWEEN $2 AND $3
        AND jel.account_code ~ '^[1-5]'
        AND je.journal_type != 'RAN'
      GROUP BY jel.account_code, jel.account_name, pa.class, pa.type, pa.name
      HAVING ABS(COALESCE(SUM(jel.debit), 0) - COALESCE(SUM(jel.credit), 0)) > 0.005
      ORDER BY jel.account_code
    `, [companyId, fy.start_date, fy.end_date]);

    const ranEntries = bsRes.rows.map(row => {
      const debit = parseFloat(row.total_debit);
      const credit = parseFloat(row.total_credit);
      const solde = debit - credit;
      const isDebiteur = solde > 0;
      return {
        account_code: row.account_code,
        account_name: row.account_name || row.account_code,
        account_class: row.account_class,
        solde: Math.abs(solde),
        sens: isDebiteur ? 'debiteur' : 'crediteur',
        new_year_debit: isDebiteur ? row.account_code : '1181',
        new_year_credit: isDebiteur ? '1181' : row.account_code,
        amount: Math.abs(solde)
      };
    });

    res.json({
      exercice: fy,
      ran_entries: ranEntries,
      total_actif: ranEntries.filter(e => e.sens === 'debiteur').reduce((s, e) => s + e.amount, 0),
      total_passif: ranEntries.filter(e => e.sens === 'crediteur').reduce((s, e) => s + e.amount, 0)
    });
  } catch (err) {
    console.error('GET /api/cloture/preview-ran error:', err.message);
    res.status(500).json({ error: 'Erreur serveur: ' + err.message });
  }
});

// POST /api/cloture/executer — execute fiscal year closure (IRREVERSIBLE)
app.post('/api/cloture/executer', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const companyId = await getEffectiveCompanyId(req, client);
    if (!companyId) { client.release(); return res.status(400).json({ error: 'Aucune entreprise sélectionnée' }); }
    const { exercice_id, od_entries } = req.body;
    if (!exercice_id) return res.status(400).json({ error: 'exercice_id requis' });

    await client.query('BEGIN');

    const fyRes = await client.query(
      `SELECT * FROM fiscal_years WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [exercice_id, companyId]
    );
    if (fyRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Exercice non trouvé' });
    }
    const fy = fyRes.rows[0];
    if (fy.status === 'cloture') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Cet exercice est déjà clôturé' });
    }

    // Mark as en_cloture
    await client.query(`UPDATE fiscal_years SET status = 'en_cloture' WHERE id = $1`, [exercice_id]);

    // Step 1: Save OD inventaire entries
    if (od_entries && od_entries.length > 0) {
      for (const od of od_entries) {
        if (!od.lines || od.lines.length < 2) continue;
        let totalD = 0, totalC = 0;
        od.lines.forEach(l => { totalD += parseFloat(l.debit) || 0; totalC += parseFloat(l.credit) || 0; });
        if (Math.abs(totalD - totalC) > 0.01) continue;
        const cntRes = await client.query(
          `SELECT COUNT(*) as cnt FROM journal_entries WHERE journal_type = 'OD' AND company_id = $1`, [companyId]
        );
        const odNum = `OD-${new Date(fy.end_date).getFullYear()}-CL-${String(parseInt(cntRes.rows[0].cnt) + 1).padStart(3, '0')}`;
        const jeRes = await client.query(
          `INSERT INTO journal_entries (company_id, entry_number, date, journal_type, description, total_debit, total_credit, user_id, source_type, fiscal_year_id)
           VALUES ($1, $2, $3, 'OD', $4, $5, $6, $7, 'cloture', $8) RETURNING id`,
          [companyId, odNum, fy.end_date, od.description || 'OD clôture', totalD, totalC, req.userId, exercice_id]
        );
        const jeId = jeRes.rows[0].id;
        for (let i = 0; i < od.lines.length; i++) {
          const line = od.lines[i];
          const accRes = await client.query('SELECT name FROM pcm_accounts WHERE code = $1', [line.account_code]);
          const accName = accRes.rows.length > 0 ? accRes.rows[0].name : line.account_name || line.account_code;
          await client.query(
            `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [jeId, line.account_code, accName, parseFloat(line.debit) || 0, parseFloat(line.credit) || 0, line.description || '', i]
          );
        }
      }
    }

    // Step 2: Calculate result
    const class7 = await client.query(`
      SELECT COALESCE(SUM(jel.credit - jel.debit), 0) as net_produits
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.journal_entry_id
      WHERE je.company_id = $1 AND je.date BETWEEN $2 AND $3
        AND jel.account_code LIKE '7%' AND je.journal_type != 'RAN'
    `, [companyId, fy.start_date, fy.end_date]);

    const class6 = await client.query(`
      SELECT COALESCE(SUM(jel.debit - jel.credit), 0) as net_charges
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.journal_entry_id
      WHERE je.company_id = $1 AND je.date BETWEEN $2 AND $3
        AND jel.account_code LIKE '6%' AND je.journal_type != 'RAN'
    `, [companyId, fy.start_date, fy.end_date]);

    const totalProduits = parseFloat(class7.rows[0].net_produits);
    const totalCharges = parseFloat(class6.rows[0].net_charges);
    const resultat = totalProduits - totalCharges;
    const isBenefice = resultat >= 0;
    const absResultat = Math.abs(resultat);

    // Step 3: Create result OD entry
    if (absResultat > 0.005) {
      const compteResultat = isBenefice ? '1191' : '1199';
      const crRes = await client.query('SELECT name FROM pcm_accounts WHERE code = $1', [compteResultat]);
      const crName = crRes.rows.length > 0 ? crRes.rows[0].name : compteResultat;

      const class67 = await client.query(`
        SELECT jel.account_code,
          COALESCE(jel.account_name, pa.name) as account_name,
          COALESCE(SUM(jel.debit), 0) as total_debit,
          COALESCE(SUM(jel.credit), 0) as total_credit
        FROM journal_entry_lines jel
        JOIN journal_entries je ON je.id = jel.journal_entry_id
        LEFT JOIN pcm_accounts pa ON pa.code = jel.account_code
        WHERE je.company_id = $1 AND je.date BETWEEN $2 AND $3
          AND (jel.account_code LIKE '6%' OR jel.account_code LIKE '7%')
          AND je.journal_type != 'RAN'
        GROUP BY jel.account_code, jel.account_name, pa.name
        HAVING ABS(COALESCE(SUM(jel.debit), 0) - COALESCE(SUM(jel.credit), 0)) > 0.005
        ORDER BY jel.account_code
      `, [companyId, fy.start_date, fy.end_date]);

      const cntRes = await client.query(
        `SELECT COUNT(*) as cnt FROM journal_entries WHERE company_id = $1 AND source_type = 'cloture'`, [companyId]
      );
      const resNum = `OD-${new Date(fy.end_date).getFullYear()}-RES-${String(parseInt(cntRes.rows[0].cnt) + 1).padStart(3, '0')}`;
      const resJe = await client.query(
        `INSERT INTO journal_entries (company_id, entry_number, date, journal_type, description, total_debit, total_credit, user_id, source_type, fiscal_year_id)
         VALUES ($1, $2, $3, 'OD', $4, $5, $6, $7, 'cloture', $8) RETURNING id`,
        [companyId, resNum, fy.end_date,
          isBenefice ? `Bénéfice net de l'exercice — clôture ${new Date(fy.end_date).getFullYear()}` : `Perte nette de l'exercice — clôture ${new Date(fy.end_date).getFullYear()}`,
          absResultat, absResultat, req.userId, exercice_id]
      );
      const resJeId = resJe.rows[0].id;

      let lineSort = 0;
      for (const acc of class67.rows) {
        const d = parseFloat(acc.total_debit);
        const c = parseFloat(acc.total_credit);
        const solde = d - c;
        if (Math.abs(solde) < 0.005) continue;
        await client.query(
          `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [resJeId, acc.account_code, acc.account_name || acc.account_code,
            solde < 0 ? Math.abs(solde) : 0,
            solde > 0 ? Math.abs(solde) : 0,
            `Clôture ${acc.account_code}`, lineSort++]
        );
      }
      // Result account line
      await client.query(
        `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [resJeId, compteResultat, crName,
          isBenefice ? 0 : absResultat,
          isBenefice ? absResultat : 0,
          `Résultat de l'exercice ${new Date(fy.end_date).getFullYear()}`, lineSort]
      );
    }

    // Step 4: Create RAN entries for balance sheet accounts
    const bsBalances = await client.query(`
      SELECT jel.account_code,
        COALESCE(jel.account_name, pa.name) as account_name,
        COALESCE(SUM(jel.debit), 0) as total_debit,
        COALESCE(SUM(jel.credit), 0) as total_credit
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.journal_entry_id
      LEFT JOIN pcm_accounts pa ON pa.code = jel.account_code
      WHERE je.company_id = $1 AND je.date BETWEEN $2 AND $3
        AND jel.account_code ~ '^[1-5]'
        AND je.journal_type != 'RAN'
      GROUP BY jel.account_code, jel.account_name, pa.name
      HAVING ABS(COALESCE(SUM(jel.debit), 0) - COALESCE(SUM(jel.credit), 0)) > 0.005
      ORDER BY jel.account_code
    `, [companyId, fy.start_date, fy.end_date]);

    if (bsBalances.rows.length > 0) {
      let ranTotalDebit = 0, ranTotalCredit = 0;
      const ranLines = [];
      for (const acc of bsBalances.rows) {
        const d = parseFloat(acc.total_debit);
        const c = parseFloat(acc.total_credit);
        const solde = d - c;
        if (Math.abs(solde) < 0.005) continue;
        const isDebiteur = solde > 0;
        ranLines.push({
          account_code: acc.account_code,
          account_name: acc.account_name || acc.account_code,
          debit: isDebiteur ? Math.abs(solde) : 0,
          credit: isDebiteur ? 0 : Math.abs(solde)
        });
        if (isDebiteur) ranTotalDebit += Math.abs(solde);
        else ranTotalCredit += Math.abs(solde);
      }
      if (ranLines.length > 0) {
        const ranNum = `RAN-${new Date(fy.end_date).getFullYear()}-001`;
        const ranJe = await client.query(
          `INSERT INTO journal_entries (company_id, entry_number, date, journal_type, description, total_debit, total_credit, user_id, source_type, fiscal_year_id)
           VALUES ($1, $2, $3, 'RAN', $4, $5, $6, $7, 'cloture', $8) RETURNING id`,
          [companyId, ranNum, fy.end_date,
            `Report à nouveau — exercice ${new Date(fy.end_date).getFullYear()}`,
            ranTotalDebit, ranTotalCredit, req.userId, exercice_id]
        );
        const ranJeId = ranJe.rows[0].id;
        for (let i = 0; i < ranLines.length; i++) {
          const line = ranLines[i];
          await client.query(
            `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [ranJeId, line.account_code, line.account_name, line.debit, line.credit, `RAN ${line.account_code}`, i]
          );
        }
      }
    }

    // Step 5: Lock all journal entries for the period
    await client.query(`
      UPDATE journal_entries
      SET is_locked = true, fiscal_year_id = $3
      WHERE company_id = $1
        AND date BETWEEN $2::date AND $4::date
        AND (fiscal_year_id IS NULL OR fiscal_year_id = $3)
    `, [companyId, fy.start_date, exercice_id, fy.end_date]);

    // Step 6: Mark fiscal year as closed
    await client.query(`
      UPDATE fiscal_years
      SET status = 'cloture', closed_at = NOW(), closed_by = $2
      WHERE id = $1
    `, [exercice_id, req.userId]);

    await client.query('COMMIT');

    res.json({
      success: true,
      message: `Exercice ${fy.label} clôturé avec succès`,
      resultat,
      is_benefice: isBenefice
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/cloture/executer error:', err.message);
    res.status(500).json({ error: 'Erreur serveur: ' + err.message });
  } finally {
    client.release();
  }
});

// ============================================================
// BILAN COMPTABLE PCM (format réglementaire DGI)
// ============================================================
app.get('/api/bilan', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Aucune entreprise sélectionnée' });
    const { fiscal_year_id } = req.query;
    if (!fiscal_year_id) return res.status(400).json({ error: 'fiscal_year_id est requis' });

    const fyRes = await pool.query(
      `SELECT * FROM fiscal_years WHERE id = $1 AND company_id = $2`,
      [fiscal_year_id, companyId]
    );
    if (fyRes.rows.length === 0) return res.status(404).json({ error: 'Exercice non trouvé' });
    const fy = fyRes.rows[0];

    // Cumulative balances up to a given date (balance sheet approach)
    const getBalances = async (toDate) => {
      const result = await pool.query(`
        SELECT
          jel.account_code,
          COALESCE(SUM(jel.debit), 0)  AS total_debit,
          COALESCE(SUM(jel.credit), 0) AS total_credit
        FROM journal_entry_lines jel
        JOIN journal_entries je ON je.id = jel.journal_entry_id
        WHERE je.company_id = $1
          AND je.date <= $2::date
        GROUP BY jel.account_code
      `, [companyId, toDate]);
      const map = {};
      for (const r of result.rows) {
        const debit  = parseFloat(r.total_debit)  || 0;
        const credit = parseFloat(r.total_credit) || 0;
        map[r.account_code] = { debit, credit, solde: debit - credit };
      }
      return map;
    };

    // PCM → Bilan Mapping
    const ACTIF_IMMOBILISE = [
      { key: 'non_valeurs',      label: 'Immobilisations en non-valeurs',  brut: ['211','212','213','214','215','217','218','219'], amort: ['2811','2812','2813','2814','2815','2817','2818','2819'] },
      { key: 'incorporelles',    label: 'Immobilisations incorporelles',    brut: ['221','222','223','224','225','226','227','228'],  amort: ['2821','2822','2823','2824','2825','2826','2827','2828'] },
      { key: 'corporelles',      label: 'Immobilisations corporelles',      brut: ['231','232','233','234','235','236','237','238'],  amort: ['2831','2832','2833','2834','2835','2836','2837','2838'] },
      { key: 'financieres',      label: 'Immobilisations financières',      brut: ['241','242','243','244','245','246','247','248'],  amort: ['2941','2942','2943','2944','2945','2946','2947','2948'] },
      { key: 'ecart_actif_immo', label: 'Écarts de conversion - Actif',    brut: ['271','272','273','274','275','276','277','278'],  amort: [] }
    ];
    const ACTIF_CIRCULANT = [
      { key: 'stocks',           label: 'Stocks',                           brut: ['31','32','33'],  amort: ['391','392','393'] },
      { key: 'creances',         label: "Créances de l'actif circulant",    brut: ['34'],            amort: ['394','395'] },
      { key: 'tvp',              label: 'Titres et valeurs de placement',   brut: ['35'],            amort: ['396'] },
      { key: 'ecart_actif_circ', label: 'Écarts de conversion - Actif',    brut: ['37'],            amort: [] }
    ];
    const TRESO_ACTIF = [
      { key: 'treso_actif',      label: 'Trésorerie - Actif',              brut: ['51'],            amort: [] }
    ];
    const FIN_PERMANENT = [
      { key: 'cap_propres',      label: 'Capitaux propres',                 prefixes: ['111','112','113','114','115','116','117','118','119'] },
      { key: 'cap_assimiles',    label: 'Capitaux propres assimilés',       prefixes: ['131','132','133','134','135','136','137','138'] },
      { key: 'dettes_fin',       label: 'Dettes de financement',            prefixes: ['141','142','143','144','145','146','147','148'] },
      { key: 'prov_durables',    label: 'Provisions durables',              prefixes: ['151','152','153','154','155','156','157','158'] },
      { key: 'ecart_passif_fp',  label: 'Écarts de conversion - Passif',   prefixes: ['171','172','173','174','175','176','177','178'] }
    ];
    const PASSIF_CIRCULANT = [
      { key: 'dettes_pc',        label: 'Dettes du passif circulant',       prefixes: ['44','45','46','48'] },
      { key: 'prov_risques',     label: 'Autres provisions pour risques',   prefixes: ['49'] },
      { key: 'ecart_passif_pc',  label: 'Écarts de conversion - Passif',   prefixes: ['47'] }
    ];
    const TRESO_PASSIF = [
      { key: 'treso_passif',     label: 'Trésorerie - Passif',              prefixes: ['55'] }
    ];

    // Helpers
    const sumBrut  = (bal, pfxs) => Object.entries(bal).reduce((t,[c,b]) => pfxs.some(p=>c.startsWith(p)) ? t + Math.max(0, b.solde)  : t, 0);
    const sumAmort = (bal, pfxs) => Object.entries(bal).reduce((t,[c,b]) => pfxs.some(p=>c.startsWith(p)) ? t + Math.max(0,-b.solde)  : t, 0);
    const sumPassif= (bal, pfxs) => Object.entries(bal).reduce((t,[c,b]) => pfxs.some(p=>c.startsWith(p)) ? t + Math.max(0,-b.solde)  : t, 0);

    const buildActif  = (sections, bal) => sections.map(s => {
      const brut  = sumBrut(bal,  s.brut);
      const amort = s.amort.length ? sumAmort(bal, s.amort) : 0;
      return { key: s.key, label: s.label, brut, amort, net: Math.max(0, brut - amort) };
    });
    const buildPassif = (sections, bal) => sections.map(s => ({
      key: s.key, label: s.label, valeur: sumPassif(bal, s.prefixes)
    }));

    // Compute N
    const balN = await getBalances(fy.end_date);

    // Compute N-1: prefer previous fiscal year end, fallback to -1 year
    const prevFyRes = await pool.query(
      `SELECT end_date FROM fiscal_years WHERE company_id = $1 AND end_date < $2 ORDER BY end_date DESC LIMIT 1`,
      [companyId, fy.start_date]
    );
    const prevToDate = prevFyRes.rows.length > 0
      ? prevFyRes.rows[0].end_date
      : (() => { const d = new Date(fy.end_date); d.setFullYear(d.getFullYear()-1); return d.toISOString().split('T')[0]; })();
    const balN1 = await getBalances(prevToDate);

    // Build sections
    const aiN  = buildActif(ACTIF_IMMOBILISE, balN);
    const aiN1 = buildActif(ACTIF_IMMOBILISE, balN1);
    const acN  = buildActif(ACTIF_CIRCULANT, balN);
    const acN1 = buildActif(ACTIF_CIRCULANT, balN1);
    const taN  = buildActif(TRESO_ACTIF, balN);
    const taN1 = buildActif(TRESO_ACTIF, balN1);
    const fpN  = buildPassif(FIN_PERMANENT, balN);
    const fpN1 = buildPassif(FIN_PERMANENT, balN1);
    const pcN  = buildPassif(PASSIF_CIRCULANT, balN);
    const pcN1 = buildPassif(PASSIF_CIRCULANT, balN1);
    const tpN  = buildPassif(TRESO_PASSIF, balN);
    const tpN1 = buildPassif(TRESO_PASSIF, balN1);

    // Totals
    const sum = (arr, k) => arr.reduce((s,r) => s + (r[k]||0), 0);
    const totAiBrutN = sum(aiN,'brut'), totAiAmortN = sum(aiN,'amort'), totAiNetN = sum(aiN,'net'), totAiNetN1 = sum(aiN1,'net');
    const totAcBrutN = sum(acN,'brut'), totAcAmortN = sum(acN,'amort'), totAcNetN = sum(acN,'net'), totAcNetN1 = sum(acN1,'net');
    const totTaNetN = sum(taN,'net'), totTaNetN1 = sum(taN1,'net');
    const totActifBrut = totAiBrutN + totAcBrutN + sum(taN,'brut');
    const totActifAmort = totAiAmortN + totAcAmortN;
    const totActifNetN = totAiNetN + totAcNetN + totTaNetN;
    const totActifNetN1 = totAiNetN1 + totAcNetN1 + totTaNetN1;

    const totFpN = sum(fpN,'valeur'), totFpN1 = sum(fpN1,'valeur');
    const totPcN = sum(pcN,'valeur'), totPcN1 = sum(pcN1,'valeur');
    const totTpN = sum(tpN,'valeur'), totTpN1 = sum(tpN1,'valeur');
    const totPassifN = totFpN + totPcN + totTpN;
    const totPassifN1 = totFpN1 + totPcN1 + totTpN1;

    res.json({
      exercice: fy,
      actif: {
        immobilise: {
          sections: aiN.map((s,i) => ({ ...s, brut_n1: aiN1[i].brut, amort_n1: aiN1[i].amort, net_n1: aiN1[i].net })),
          total_brut: totAiBrutN, total_amort: totAiAmortN, total_net: totAiNetN, total_net_n1: totAiNetN1
        },
        circulant: {
          sections: acN.map((s,i) => ({ ...s, brut_n1: acN1[i].brut, amort_n1: acN1[i].amort, net_n1: acN1[i].net })),
          total_brut: totAcBrutN, total_amort: totAcAmortN, total_net: totAcNetN, total_net_n1: totAcNetN1
        },
        tresorerie: {
          sections: taN.map((s,i) => ({ ...s, net_n1: taN1[i].net })),
          total_net: totTaNetN, total_net_n1: totTaNetN1
        },
        total_brut: totActifBrut, total_amort: totActifAmort,
        total_net: totActifNetN, total_net_n1: totActifNetN1
      },
      passif: {
        financement_permanent: {
          sections: fpN.map((s,i) => ({ ...s, valeur_n1: fpN1[i].valeur })),
          total: totFpN, total_n1: totFpN1
        },
        circulant: {
          sections: pcN.map((s,i) => ({ ...s, valeur_n1: pcN1[i].valeur })),
          total: totPcN, total_n1: totPcN1
        },
        tresorerie: {
          sections: tpN.map((s,i) => ({ ...s, valeur_n1: tpN1[i].valeur })),
          total: totTpN, total_n1: totTpN1
        },
        total: totPassifN, total_n1: totPassifN1
      },
      is_balanced: Math.abs(totActifNetN - totPassifN) < 1
    });
  } catch (err) {
    console.error('GET /api/bilan error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================================
// COMPTE DE PRODUITS ET CHARGES (CPC) — PCM marocain
// ============================================================
app.get('/api/cpc', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Aucune entreprise sélectionnée' });
    const { fiscal_year_id } = req.query;
    if (!fiscal_year_id) return res.status(400).json({ error: 'fiscal_year_id est requis' });

    const fyRes = await pool.query(
      `SELECT * FROM fiscal_years WHERE id = $1 AND company_id = $2`,
      [fiscal_year_id, companyId]
    );
    if (fyRes.rows.length === 0) return res.status(404).json({ error: 'Exercice non trouvé' });
    const fy = fyRes.rows[0];

    // Period flows (CPC uses flows over a date range, not cumulative)
    const getFlows = async (fromDate, toDate) => {
      const result = await pool.query(`
        SELECT
          jel.account_code,
          COALESCE(SUM(jel.debit), 0)  AS total_debit,
          COALESCE(SUM(jel.credit), 0) AS total_credit
        FROM journal_entry_lines jel
        JOIN journal_entries je ON je.id = jel.journal_entry_id
        WHERE je.company_id = $1
          AND je.date >= $2::date
          AND je.date <= $3::date
        GROUP BY jel.account_code
      `, [companyId, fromDate, toDate]);
      const map = {};
      for (const r of result.rows) {
        map[r.account_code] = {
          debit:  parseFloat(r.total_debit)  || 0,
          credit: parseFloat(r.total_credit) || 0
        };
      }
      return map;
    };

    // Revenue lines: net credit surplus (class 7)
    const sumRevenue = (flows, prefixes) =>
      Object.entries(flows).reduce((t, [code, b]) =>
        prefixes.some(p => code.startsWith(p)) ? t + Math.max(0, b.credit - b.debit) : t, 0);

    // Expense lines: net debit surplus (class 6)
    const sumExpense = (flows, prefixes) =>
      Object.entries(flows).reduce((t, [code, b]) =>
        prefixes.some(p => code.startsWith(p)) ? t + Math.max(0, b.debit - b.credit) : t, 0);

    // PCM → CPC mapping (figé)
    const CPC_PRODUITS_EXPL = [
      { key: 'ventes_marchandises',        label: 'Ventes de marchandises (711)',                  prefixes: ['711'] },
      { key: 'ventes_biens_services',      label: 'Ventes de biens et services produits (712)',   prefixes: ['712'] },
      { key: 'variation_stocks',           label: 'Variation de stocks de produits (713)',         prefixes: ['713'] },
      { key: 'immo_produites',             label: "Immobilisations produites par l'entr. (714)",   prefixes: ['714'] },
      { key: 'subventions_exploitation',   label: "Subventions d'exploitation (716)",              prefixes: ['716'] },
      { key: 'autres_produits_expl',       label: "Autres produits d'exploitation (718)",          prefixes: ['718'] },
      { key: 'reprises_exploitation',      label: "Reprises d'exploitation, transferts (719)",     prefixes: ['719'] },
    ];
    const CPC_CHARGES_EXPL = [
      { key: 'achats_revendus',            label: 'Achats revendus de marchandises (611)',         prefixes: ['611'] },
      { key: 'achats_consommes',           label: 'Achats consommés de matières (612)',            prefixes: ['612'] },
      { key: 'autres_charges_ext',         label: 'Autres charges externes (613/614)',             prefixes: ['613', '614'] },
      { key: 'impots_taxes',               label: 'Impôts et taxes (616)',                         prefixes: ['616'] },
      { key: 'charges_personnel',          label: 'Charges de personnel (617)',                    prefixes: ['617'] },
      { key: 'autres_charges_expl',        label: "Autres charges d'exploitation (618)",           prefixes: ['618'] },
      { key: 'dotations_exploitation',     label: "Dotations d'exploitation (619)",                prefixes: ['619'] },
    ];

    // Compute N
    const flowsN = await getFlows(fy.start_date, fy.end_date);

    // Compute N-1: prefer previous fiscal year, fallback to -1 year
    const prevFyRes = await pool.query(
      `SELECT * FROM fiscal_years WHERE company_id = $1 AND end_date < $2 ORDER BY end_date DESC LIMIT 1`,
      [companyId, fy.start_date]
    );
    let flowsN1 = {};
    if (prevFyRes.rows.length > 0) {
      const pfy = prevFyRes.rows[0];
      flowsN1 = await getFlows(pfy.start_date, pfy.end_date);
    } else {
      const d0 = new Date(fy.start_date), d1 = new Date(fy.end_date);
      d0.setFullYear(d0.getFullYear() - 1); d1.setFullYear(d1.getFullYear() - 1);
      flowsN1 = await getFlows(d0.toISOString().split('T')[0], d1.toISOString().split('T')[0]);
    }

    const buildProduits = (sections, flows) =>
      sections.map(s => ({ key: s.key, label: s.label, valeur: sumRevenue(flows, s.prefixes) }));
    const buildCharges = (sections, flows) =>
      sections.map(s => ({ key: s.key, label: s.label, valeur: sumExpense(flows, s.prefixes) }));
    const total = arr => arr.reduce((t, r) => t + r.valeur, 0);

    const peN  = buildProduits(CPC_PRODUITS_EXPL, flowsN);
    const peN1 = buildProduits(CPC_PRODUITS_EXPL, flowsN1);
    const ceN  = buildCharges(CPC_CHARGES_EXPL,  flowsN);
    const ceN1 = buildCharges(CPC_CHARGES_EXPL,  flowsN1);

    const totPeN  = total(peN),  totPeN1  = total(peN1);
    const totCeN  = total(ceN),  totCeN1  = total(ceN1);
    const reN  = totPeN  - totCeN;
    const reN1 = totPeN1 - totCeN1;

    const pfN  = sumRevenue(flowsN,  ['73']), pfN1  = sumRevenue(flowsN1, ['73']);
    const cfN  = sumExpense(flowsN,  ['63']), cfN1  = sumExpense(flowsN1, ['63']);
    const rfN  = pfN  - cfN,  rfN1  = pfN1  - cfN1;

    const rcN  = reN  + rfN,  rcN1  = reN1  + rfN1;

    const pncN  = sumRevenue(flowsN,  ['75']), pncN1  = sumRevenue(flowsN1, ['75']);
    const cncN  = sumExpense(flowsN,  ['65']), cncN1  = sumExpense(flowsN1, ['65']);
    const rncN  = pncN  - cncN,  rncN1  = pncN1  - cncN1;

    const raiN  = rcN  + rncN,  raiN1  = rcN1  + rncN1;
    const irsN  = sumExpense(flowsN,  ['670']), irsN1  = sumExpense(flowsN1, ['670']);
    const rnetN = raiN  - irsN,  rnetN1 = raiN1  - irsN1;

    res.json({
      exercice: fy,
      produits_exploitation: {
        lignes:    peN.map((r, i) => ({ ...r, valeur_n1: peN1[i].valeur })),
        total:    totPeN,
        total_n1: totPeN1
      },
      charges_exploitation: {
        lignes:    ceN.map((r, i) => ({ ...r, valeur_n1: ceN1[i].valeur })),
        total:    totCeN,
        total_n1: totCeN1
      },
      resultat_exploitation:  { n: reN,   n1: reN1  },
      produits_financiers:    { n: pfN,   n1: pfN1  },
      charges_financieres:    { n: cfN,   n1: cfN1  },
      resultat_financier:     { n: rfN,   n1: rfN1  },
      resultat_courant:       { n: rcN,   n1: rcN1  },
      produits_non_courants:  { n: pncN,  n1: pncN1 },
      charges_non_courantes:  { n: cncN,  n1: cncN1 },
      resultat_non_courant:   { n: rncN,  n1: rncN1 },
      resultat_avant_impot:   { n: raiN,  n1: raiN1 },
      impot_sur_resultats:    { n: irsN,  n1: irsN1 },
      resultat_net:           { n: rnetN, n1: rnetN1 }
    });
  } catch (err) {
    console.error('GET /api/cpc error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// CPC — CSV export
app.get('/api/cpc/export/csv', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Aucune entreprise sélectionnée' });
    const { fiscal_year_id } = req.query;
    if (!fiscal_year_id) return res.status(400).json({ error: 'fiscal_year_id est requis' });

    // Re-use the CPC computation logic via internal fetch
    const protocol = req.protocol;
    const host = req.get('host');
    const cookie = req.headers.cookie || '';
    const dataRes = await fetch(`${protocol}://${host}/api/cpc?fiscal_year_id=${fiscal_year_id}`, {
      headers: { cookie }
    });
    if (!dataRes.ok) return res.status(dataRes.status).json({ error: 'Erreur calcul CPC' });
    const d = await dataRes.json();
    const fy = d.exercice;

    const fmt = (n) => (n === null || n === undefined ? '0' : Number(n).toFixed(2)).replace('.', ',');

    const rows = [
      ['Rubrique', `N (${fy.label})`, 'N-1'],
      ['I - PRODUITS D\'EXPLOITATION', '', ''],
      ...d.produits_exploitation.lignes.map(r => [r.label, fmt(r.valeur), fmt(r.valeur_n1)]),
      ['TOTAL I', fmt(d.produits_exploitation.total), fmt(d.produits_exploitation.total_n1)],
      ['', '', ''],
      ['II - CHARGES D\'EXPLOITATION', '', ''],
      ...d.charges_exploitation.lignes.map(r => [r.label, fmt(r.valeur), fmt(r.valeur_n1)]),
      ['TOTAL II', fmt(d.charges_exploitation.total), fmt(d.charges_exploitation.total_n1)],
      ['', '', ''],
      ['III - RÉSULTAT D\'EXPLOITATION (I - II)', fmt(d.resultat_exploitation.n), fmt(d.resultat_exploitation.n1)],
      ['', '', ''],
      ['IV - PRODUITS FINANCIERS (73)', fmt(d.produits_financiers.n), fmt(d.produits_financiers.n1)],
      ['V - CHARGES FINANCIÈRES (63)', fmt(d.charges_financieres.n), fmt(d.charges_financieres.n1)],
      ['VI - RÉSULTAT FINANCIER (IV - V)', fmt(d.resultat_financier.n), fmt(d.resultat_financier.n1)],
      ['', '', ''],
      ['VII - RÉSULTAT COURANT (III + VI)', fmt(d.resultat_courant.n), fmt(d.resultat_courant.n1)],
      ['', '', ''],
      ['VIII - PRODUITS NON COURANTS (75)', fmt(d.produits_non_courants.n), fmt(d.produits_non_courants.n1)],
      ['IX - CHARGES NON COURANTES (65)', fmt(d.charges_non_courantes.n), fmt(d.charges_non_courantes.n1)],
      ['X - RÉSULTAT NON COURANT (VIII - IX)', fmt(d.resultat_non_courant.n), fmt(d.resultat_non_courant.n1)],
      ['', '', ''],
      ['XI - RÉSULTAT AVANT IMPÔT (VII + X)', fmt(d.resultat_avant_impot.n), fmt(d.resultat_avant_impot.n1)],
      ['XII - IMPÔT SUR LES RÉSULTATS (670)', fmt(d.impot_sur_resultats.n), fmt(d.impot_sur_resultats.n1)],
      ['', '', ''],
      ['XIII - RÉSULTAT NET (XI - XII)', fmt(d.resultat_net.n), fmt(d.resultat_net.n1)],
    ];

    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\n');
    const filename = `CPC_${(fy.label || 'export').replace(/\s/g, '_')}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('\uFEFF' + csv);
  } catch (err) {
    console.error('GET /api/cpc/export/csv error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================================
// ESG — ÉTAT DES SOLDES DE GESTION (TFR + CAF)
// ============================================================
app.get('/api/esg', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Aucune entreprise sélectionnée' });
    const { fiscal_year_id } = req.query;
    if (!fiscal_year_id) return res.status(400).json({ error: 'fiscal_year_id est requis' });

    const fyRes = await pool.query(
      `SELECT * FROM fiscal_years WHERE id = $1 AND company_id = $2`,
      [fiscal_year_id, companyId]
    );
    if (fyRes.rows.length === 0) return res.status(404).json({ error: 'Exercice non trouvé' });
    const fy = fyRes.rows[0];

    // Period flows (same logic as CPC)
    const getFlows = async (fromDate, toDate) => {
      const result = await pool.query(`
        SELECT
          jel.account_code,
          COALESCE(SUM(jel.debit), 0)  AS total_debit,
          COALESCE(SUM(jel.credit), 0) AS total_credit
        FROM journal_entry_lines jel
        JOIN journal_entries je ON je.id = jel.journal_entry_id
        WHERE je.company_id = $1
          AND je.date >= $2::date
          AND je.date <= $3::date
        GROUP BY jel.account_code
      `, [companyId, fromDate, toDate]);
      const map = {};
      for (const r of result.rows) {
        map[r.account_code] = {
          debit:  parseFloat(r.total_debit)  || 0,
          credit: parseFloat(r.total_credit) || 0
        };
      }
      return map;
    };

    // Revenue lines: net credit surplus (class 7)
    const sumRevenue = (flows, prefixes) =>
      Object.entries(flows).reduce((t, [code, b]) =>
        prefixes.some(p => code.startsWith(p)) ? t + Math.max(0, b.credit - b.debit) : t, 0);

    // Expense lines: net debit surplus (class 6)
    const sumExpense = (flows, prefixes) =>
      Object.entries(flows).reduce((t, [code, b]) =>
        prefixes.some(p => code.startsWith(p)) ? t + Math.max(0, b.debit - b.credit) : t, 0);

    // N and N-1 flows
    const flowsN = await getFlows(fy.start_date, fy.end_date);

    const prevFyRes = await pool.query(
      `SELECT * FROM fiscal_years WHERE company_id = $1 AND end_date < $2 ORDER BY end_date DESC LIMIT 1`,
      [companyId, fy.start_date]
    );
    let flowsN1 = {};
    if (prevFyRes.rows.length > 0) {
      const pfy = prevFyRes.rows[0];
      flowsN1 = await getFlows(pfy.start_date, pfy.end_date);
    } else {
      const d0 = new Date(fy.start_date), d1 = new Date(fy.end_date);
      d0.setFullYear(d0.getFullYear() - 1); d1.setFullYear(d1.getFullYear() - 1);
      flowsN1 = await getFlows(d0.toISOString().split('T')[0], d1.toISOString().split('T')[0]);
    }

    // Helper: compute TFR for a given flows set
    const computeTfr = (flows) => {
      const ventesMarch    = sumRevenue(flows, ['711']);
      const achatsRevendus = sumExpense(flows, ['611']);
      const margeBrute     = ventesMarch - achatsRevendus;

      const production     = sumRevenue(flows, ['712', '713', '714']);
      const consommation   = sumExpense(flows, ['612', '613', '614']);
      const valeurAjoutee  = margeBrute + production - consommation;

      const subventions    = sumRevenue(flows, ['716']);
      const impotsTaxes    = sumExpense(flows, ['616']);
      const chargesPersonnel = sumExpense(flows, ['617']);
      const ebe            = valeurAjoutee + subventions - impotsTaxes - chargesPersonnel;

      const autresProdExpl  = sumRevenue(flows, ['718']);
      const autresChargesExpl = sumExpense(flows, ['618']);
      const reprisesExpl    = sumRevenue(flows, ['719']);
      const dotationsExpl   = sumExpense(flows, ['619']);
      const resultatExpl    = ebe + autresProdExpl - autresChargesExpl + reprisesExpl - dotationsExpl;

      const produitsFinanc  = sumRevenue(flows, ['73']);
      const chargesFinanc   = sumExpense(flows, ['63']);
      const resultatFinanc  = produitsFinanc - chargesFinanc;

      const resultatCourant = resultatExpl + resultatFinanc;

      const produitsNC      = sumRevenue(flows, ['75']);
      const chargesNC       = sumExpense(flows, ['65']);
      const resultatNC      = produitsNC - chargesNC;

      const impot           = sumExpense(flows, ['670']);
      const resultatNet     = resultatCourant + resultatNC - impot;

      return {
        ventes_marchandises:   ventesMarch,
        achats_revendus:       achatsRevendus,
        marge_brute:           margeBrute,
        production:            production,
        consommation:          consommation,
        valeur_ajoutee:        valeurAjoutee,
        subventions:           subventions,
        impots_taxes:          impotsTaxes,
        charges_personnel:     chargesPersonnel,
        ebe:                   ebe,
        autres_produits_expl:  autresProdExpl,
        autres_charges_expl:   autresChargesExpl,
        reprises_expl:         reprisesExpl,
        dotations_expl:        dotationsExpl,
        resultat_expl:         resultatExpl,
        produits_financiers:   produitsFinanc,
        charges_financieres:   chargesFinanc,
        resultat_financier:    resultatFinanc,
        resultat_courant:      resultatCourant,
        produits_nc:           produitsNC,
        charges_nc:            chargesNC,
        resultat_nc:           resultatNC,
        impot:                 impot,
        resultat_net:          resultatNet
      };
    };

    // Helper: compute CAF for a given flows set and resultat_net
    const computeCaf = (flows, resultatNet) => {
      const dotationsExpl    = sumExpense(flows, ['619']);
      const dotationsFinanc  = sumExpense(flows, ['639']);
      const dotationsNC      = sumExpense(flows, ['659']);
      const reprisesExpl     = sumRevenue(flows, ['719']);
      const reprisesFinanc   = sumRevenue(flows, ['739']);
      const reprisesNC       = sumRevenue(flows, ['759']);
      const vnaCessions      = sumExpense(flows, ['651']);
      const produitsCessions = sumRevenue(flows, ['751']);
      // Distribution bénéfices: compte 4462 debit (dividendes versés)
      const distribution     = sumExpense(flows, ['4462']);

      const caf = resultatNet
        + dotationsExpl + dotationsFinanc + dotationsNC
        - reprisesExpl - reprisesFinanc - reprisesNC
        + vnaCessions - produitsCessions;

      const autofinancement = caf - distribution;

      return {
        resultat_net:       resultatNet,
        dotations_expl:     dotationsExpl,
        dotations_financ:   dotationsFinanc,
        dotations_nc:       dotationsNC,
        reprises_expl:      reprisesExpl,
        reprises_financ:    reprisesFinanc,
        reprises_nc:        reprisesNC,
        vna_cessions:       vnaCessions,
        produits_cessions:  produitsCessions,
        caf:                caf,
        distribution:       distribution,
        autofinancement:    autofinancement
      };
    };

    const tfrN  = computeTfr(flowsN);
    const tfrN1 = computeTfr(flowsN1);
    const cafN  = computeCaf(flowsN,  tfrN.resultat_net);

    res.json({
      exercice: fy,
      tfr: {
        n:  tfrN,
        n1: tfrN1
      },
      caf: cafN
    });
  } catch (err) {
    console.error('GET /api/esg error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ESG — CSV export
app.get('/api/esg/export/csv', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Aucune entreprise sélectionnée' });
    const { fiscal_year_id } = req.query;
    if (!fiscal_year_id) return res.status(400).json({ error: 'fiscal_year_id est requis' });

    const protocol = req.protocol;
    const host = req.get('host');
    const cookie = req.headers.cookie || '';
    const dataRes = await fetch(`${protocol}://${host}/api/esg?fiscal_year_id=${fiscal_year_id}`, {
      headers: { cookie }
    });
    if (!dataRes.ok) return res.status(dataRes.status).json({ error: 'Erreur calcul ESG' });
    const d = await dataRes.json();
    const fy = d.exercice;
    const t = d.tfr.n;
    const t1 = d.tfr.n1;
    const c = d.caf;

    const fmt = (n) => (n === null || n === undefined ? '0' : Number(n).toFixed(2)).replace('.', ',');

    const rows = [
      ['TABLEAU DE FORMATION DES RÉSULTATS (TFR)', `N (${fy.label})`, 'N-1'],
      ['1. Ventes de marchandises (711)',                fmt(t.ventes_marchandises), fmt(t1.ventes_marchandises)],
      ['2. - Achats revendus de marchandises (611)',     fmt(t.achats_revendus),     fmt(t1.achats_revendus)],
      ['= MARGE BRUTE SUR VENTES EN L\'ÉTAT',            fmt(t.marge_brute),         fmt(t1.marge_brute)],
      ['', '', ''],
      ['3. + Production de l\'exercice (712+713+714)',    fmt(t.production),          fmt(t1.production)],
      ['4. - Consommation de l\'exercice (612+613+614)', fmt(t.consommation),        fmt(t1.consommation)],
      ['= VALEUR AJOUTÉE',                              fmt(t.valeur_ajoutee),      fmt(t1.valeur_ajoutee)],
      ['', '', ''],
      ['5. + Subventions d\'exploitation (716)',          fmt(t.subventions),         fmt(t1.subventions)],
      ['6. - Impôts et taxes (616)',                    fmt(t.impots_taxes),        fmt(t1.impots_taxes)],
      ['7. - Charges de personnel (617)',               fmt(t.charges_personnel),   fmt(t1.charges_personnel)],
      ['= EXCÉDENT BRUT D\'EXPLOITATION (EBE)',          fmt(t.ebe),                 fmt(t1.ebe)],
      ['', '', ''],
      ['8. + Autres produits d\'exploitation (718)',     fmt(t.autres_produits_expl), fmt(t1.autres_produits_expl)],
      ['9. - Autres charges d\'exploitation (618)',      fmt(t.autres_charges_expl), fmt(t1.autres_charges_expl)],
      ['10. + Reprises d\'exploitation (719)',           fmt(t.reprises_expl),       fmt(t1.reprises_expl)],
      ['11. - Dotations d\'exploitation (619)',          fmt(t.dotations_expl),      fmt(t1.dotations_expl)],
      ['= RÉSULTAT D\'EXPLOITATION',                    fmt(t.resultat_expl),       fmt(t1.resultat_expl)],
      ['', '', ''],
      ['12. + Résultat financier (73-63)',               fmt(t.resultat_financier),  fmt(t1.resultat_financier)],
      ['= RÉSULTAT COURANT',                            fmt(t.resultat_courant),    fmt(t1.resultat_courant)],
      ['', '', ''],
      ['13. + Résultat non courant (75-65)',             fmt(t.resultat_nc),         fmt(t1.resultat_nc)],
      ['14. - Impôt sur les résultats (670)',            fmt(t.impot),               fmt(t1.impot)],
      ['= RÉSULTAT NET DE L\'EXERCICE',                 fmt(t.resultat_net),        fmt(t1.resultat_net)],
      ['', '', ''],
      ['CAPACITÉ D\'AUTOFINANCEMENT (CAF)', `N (${fy.label})`, ''],
      ['Résultat net de l\'exercice',                   fmt(c.resultat_net), ''],
      ['+ Dotations d\'exploitation (619)',              fmt(c.dotations_expl), ''],
      ['+ Dotations financières (639)',                  fmt(c.dotations_financ), ''],
      ['+ Dotations non courantes (659)',                fmt(c.dotations_nc), ''],
      ['- Reprises d\'exploitation (719)',               fmt(c.reprises_expl), ''],
      ['- Reprises financières (739)',                   fmt(c.reprises_financ), ''],
      ['- Reprises non courantes (759)',                 fmt(c.reprises_nc), ''],
      ['+ VNA des immobilisations cédées (651)',         fmt(c.vna_cessions), ''],
      ['- Produits de cession des immobilisations (751)',fmt(c.produits_cessions), ''],
      ['= CAPACITÉ D\'AUTOFINANCEMENT (CAF)',           fmt(c.caf), ''],
      ['- Distribution de bénéfices (4462)',             fmt(c.distribution), ''],
      ['= AUTOFINANCEMENT',                             fmt(c.autofinancement), ''],
    ];

    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\n');
    const filename = `ESG_${(fy.label || 'export').replace(/\s/g, '_')}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('\uFEFF' + csv);
  } catch (err) {
    console.error('GET /api/esg/export/csv error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================================
// TRÉSORERIE PRÉVISIONNELLE (Phase 4.1)
// ============================================================

// Helper: add months to a date (returns new Date)
function addMonthsToDate(date, months) {
  const d = new Date(date);
  const targetMonth = d.getMonth() + months;
  d.setMonth(targetMonth);
  return d;
}

// Helper: expand a recurring event from firstDate to endDate
function expandRecurringDates(firstDate, frequency, startDate, endDate) {
  const intervalMonths = { 'mensuel': 1, 'trimestriel': 3, 'annuel': 12 }[frequency] || 1;
  const dates = [];
  let current = new Date(firstDate);
  // Advance to first occurrence >= today's projection window start
  while (current < startDate) {
    current = addMonthsToDate(current, intervalMonths);
  }
  while (current <= endDate) {
    dates.push(new Date(current));
    current = addMonthsToDate(current, intervalMonths);
  }
  return dates;
}

// Helper: get ISO week label "S{n} (dd-dd/MM)"
function getWeekBucket(date, projectionStart) {
  const ms = date.getTime() - projectionStart.getTime();
  return Math.floor(ms / (7 * 24 * 60 * 60 * 1000));
}

function formatDateRange(weekStart, weekEnd) {
  const months = ['jan','fév','mar','avr','mai','juin','juil','aoû','sep','oct','nov','déc'];
  const s = weekStart, e = weekEnd;
  if (s.getMonth() === e.getMonth()) {
    return `${s.getDate()}-${e.getDate()} ${months[s.getMonth()]}`;
  }
  return `${s.getDate()} ${months[s.getMonth()]}-${e.getDate()} ${months[e.getMonth()]}`;
}

// GET /api/tresorerie/previsionnel?months=6&threshold=0
app.get('/api/tresorerie/previsionnel', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Aucune entreprise sélectionnée' });

    const months = Math.min(Math.max(parseInt(req.query.months) || 6, 1), 24);
    const alertThreshold = parseFloat(req.query.threshold) || 0;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const endDate = addMonthsToDate(today, months);

    // ── 1. Starting balance (sum of bank accounts last_balance) ─────────────
    const balResult = await pool.query(
      `SELECT COALESCE(SUM(last_balance), 0) as total_balance
       FROM bank_accounts WHERE company_id = $1 AND last_balance IS NOT NULL`,
      [companyId]
    );
    const startingBalance = parseFloat(balResult.rows[0]?.total_balance || 0);

    // ── 2. Unpaid client invoices (encaissements) ────────────────────────────
    const clientInvoiceResult = await pool.query(
      `SELECT i.id, i.invoice_number, i.total,
              COALESCE(i.due_date, i.date + INTERVAL '30 days') as echeance,
              COALESCE(c.name, co.name, 'Client') as label
       FROM invoices i
       LEFT JOIN contacts co ON co.id = i.contact_id
       LEFT JOIN clients c ON c.id = i.client_id
       WHERE i.company_id = $1
         AND i.type = 'sale'
         AND i.status NOT IN ('paid','cancelled','avoir','annulée')
         AND COALESCE(i.due_date, i.date + INTERVAL '30 days') BETWEEN $2 AND $3`,
      [companyId, today, endDate]
    );

    // ── 3. Unpaid supplier invoices/expenses (décaissements) ─────────────────
    // From invoices table (type=purchase)
    const supplierInvoiceResult = await pool.query(
      `SELECT i.id, i.invoice_number, i.total,
              COALESCE(i.due_date, i.date + INTERVAL '30 days') as echeance,
              COALESCE(co.name, 'Fournisseur') as label
       FROM invoices i
       LEFT JOIN contacts co ON co.id = i.contact_id
       WHERE i.company_id = $1
         AND i.type = 'purchase'
         AND i.status NOT IN ('paid','cancelled')
         AND COALESCE(i.due_date, i.date + INTERVAL '30 days') BETWEEN $2 AND $3`,
      [companyId, today, endDate]
    );

    // From expenses table (factures fournisseurs avec date_echeance)
    const expensesResult = await pool.query(
      `SELECT e.id, e.description as label, e.total,
              COALESCE(e.date_echeance, e.date + INTERVAL '30 days') as echeance
       FROM expenses e
       WHERE e.company_id = $1
         AND e.status NOT IN ('paid','cancelled')
         AND COALESCE(e.date_echeance, NULL) IS NOT NULL
         AND e.date_echeance BETWEEN $2 AND $3`,
      [companyId, today, endDate]
    );

    // ── 4. Active subscriptions (recurring encaissements) ────────────────────
    const subscriptionsResult = await pool.query(
      `SELECT s.id, s.amount, s.tva_rate, s.interval, s.next_invoice_date,
              COALESCE(c.name, 'Client') as client_name,
              p.name as product_name
       FROM subscriptions s
       LEFT JOIN clients c ON c.id = s.client_id
       LEFT JOIN products p ON p.id = s.product_id
       WHERE s.company_id = $1
         AND s.status = 'actif'
         AND s.next_invoice_date IS NOT NULL`,
      [companyId]
    );

    // ── 5. Recurring charges ─────────────────────────────────────────────────
    const chargesResult = await pool.query(
      `SELECT id, label, amount, frequency, direction, next_date
       FROM recurring_charges
       WHERE company_id = $1 AND is_active = true`,
      [companyId]
    );

    // ── Build events list ────────────────────────────────────────────────────
    const events = [];

    // Client invoices → encaissements
    for (const inv of clientInvoiceResult.rows) {
      events.push({
        date: new Date(inv.echeance),
        label: `${inv.invoice_number} – ${inv.label}`,
        amount: parseFloat(inv.total),
        direction: 'encaissement',
        type: 'invoice_client',
        ref_id: inv.id
      });
    }

    // Supplier invoices → décaissements
    for (const inv of supplierInvoiceResult.rows) {
      events.push({
        date: new Date(inv.echeance),
        label: `${inv.invoice_number} – ${inv.label}`,
        amount: parseFloat(inv.total),
        direction: 'decaissement',
        type: 'invoice_fournisseur',
        ref_id: inv.id
      });
    }

    // Expenses → décaissements
    for (const exp of expensesResult.rows) {
      events.push({
        date: new Date(exp.echeance),
        label: exp.label,
        amount: parseFloat(exp.total),
        direction: 'decaissement',
        type: 'expense',
        ref_id: exp.id
      });
    }

    // Subscriptions → recurring encaissements
    for (const sub of subscriptionsResult.rows) {
      const subDates = expandRecurringDates(
        sub.next_invoice_date,
        sub.interval,
        today,
        endDate
      );
      const ttcAmount = parseFloat(sub.amount) * (1 + parseFloat(sub.tva_rate) / 100);
      for (const d of subDates) {
        events.push({
          date: d,
          label: `Abonnement – ${sub.product_name} (${sub.client_name})`,
          amount: ttcAmount,
          direction: 'encaissement',
          type: 'subscription',
          ref_id: sub.id
        });
      }
    }

    // Recurring charges → encaissements or décaissements
    for (const charge of chargesResult.rows) {
      const chargeDates = expandRecurringDates(
        charge.next_date,
        charge.frequency,
        today,
        endDate
      );
      for (const d of chargeDates) {
        events.push({
          date: d,
          label: charge.label,
          amount: parseFloat(charge.amount),
          direction: charge.direction,
          type: 'recurring_charge',
          ref_id: charge.id
        });
      }
    }

    // ── Group events by week ─────────────────────────────────────────────────
    // Calculate total number of weeks
    const totalDays = Math.ceil((endDate - today) / (24 * 60 * 60 * 1000));
    const totalWeeks = Math.ceil(totalDays / 7);

    const weekData = [];
    for (let w = 0; w < totalWeeks; w++) {
      const weekStart = new Date(today);
      weekStart.setDate(today.getDate() + w * 7);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 6);
      if (weekEnd > endDate) weekEnd.setTime(endDate.getTime());

      weekData.push({
        week_number: w + 1,
        week_label: `S${w + 1} (${formatDateRange(weekStart, weekEnd)})`,
        week_start: weekStart.toISOString().split('T')[0],
        week_end: weekEnd.toISOString().split('T')[0],
        balance_start: 0,
        encaissements: 0,
        decaissements: 0,
        balance_end: 0,
        events: []
      });
    }

    // Assign events to weeks
    for (const evt of events) {
      if (evt.date < today || evt.date > endDate) continue;
      const weekIdx = getWeekBucket(evt.date, today);
      if (weekIdx >= 0 && weekIdx < totalWeeks) {
        const week = weekData[weekIdx];
        if (evt.direction === 'encaissement') {
          week.encaissements += evt.amount;
        } else {
          week.decaissements += evt.amount;
        }
        week.events.push({
          date: evt.date.toISOString().split('T')[0],
          label: evt.label,
          amount: evt.amount,
          direction: evt.direction,
          type: evt.type
        });
      }
    }

    // Compute running balance
    let runningBalance = startingBalance;
    const chartLabels = [];
    const chartBalance = [];
    const chartEncaissements = [];
    const chartDecaissements = [];
    const alertPeriods = [];

    for (const week of weekData) {
      week.balance_start = Math.round(runningBalance * 100) / 100;
      runningBalance += week.encaissements - week.decaissements;
      week.balance_end = Math.round(runningBalance * 100) / 100;
      week.encaissements = Math.round(week.encaissements * 100) / 100;
      week.decaissements = Math.round(week.decaissements * 100) / 100;

      chartLabels.push(week.week_label);
      chartBalance.push(week.balance_end);
      chartEncaissements.push(week.encaissements);
      chartDecaissements.push(week.decaissements);

      if (week.balance_end < alertThreshold) {
        alertPeriods.push({ week: week.week_label, balance: week.balance_end });
      }
    }

    const totalEncaissements = weekData.reduce((s, w) => s + w.encaissements, 0);
    const totalDecaissements = weekData.reduce((s, w) => s + w.decaissements, 0);

    res.json({
      months,
      start_date: today.toISOString().split('T')[0],
      end_date: endDate.toISOString().split('T')[0],
      alert_threshold: alertThreshold,
      starting_balance: Math.round(startingBalance * 100) / 100,
      weeks: weekData,
      chart_data: {
        labels: chartLabels,
        balance: chartBalance,
        encaissements: chartEncaissements,
        decaissements: chartDecaissements
      },
      summary: {
        total_encaissements: Math.round(totalEncaissements * 100) / 100,
        total_decaissements: Math.round(totalDecaissements * 100) / 100,
        projected_final_balance: Math.round(runningBalance * 100) / 100,
        alert_periods: alertPeriods,
        alert_count: alertPeriods.length
      }
    });
  } catch (err) {
    console.error('GET /api/tresorerie/previsionnel error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/tresorerie/charges-recurrentes
app.get('/api/tresorerie/charges-recurrentes', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Aucune entreprise sélectionnée' });
    const result = await pool.query(
      `SELECT * FROM recurring_charges WHERE company_id = $1 ORDER BY direction, label`,
      [companyId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('GET /api/tresorerie/charges-recurrentes error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/tresorerie/charges-recurrentes
app.post('/api/tresorerie/charges-recurrentes', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Aucune entreprise sélectionnée' });
    const { label, amount, frequency, direction, next_date, notes } = req.body;
    if (!label || !amount || !next_date) {
      return res.status(422).json({ error: 'Libellé, montant et prochaine date obligatoires' });
    }
    const validFrequencies = ['mensuel', 'trimestriel', 'annuel'];
    const validDirections = ['encaissement', 'decaissement'];
    if (!validFrequencies.includes(frequency)) return res.status(422).json({ error: 'Fréquence invalide' });
    if (!validDirections.includes(direction)) return res.status(422).json({ error: 'Direction invalide' });

    const result = await pool.query(
      `INSERT INTO recurring_charges (company_id, label, amount, frequency, direction, next_date, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [companyId, label.trim(), parseFloat(amount), frequency, direction, next_date, notes || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /api/tresorerie/charges-recurrentes error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/tresorerie/charges-recurrentes/:id
app.put('/api/tresorerie/charges-recurrentes/:id', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Aucune entreprise sélectionnée' });
    const { label, amount, frequency, direction, next_date, notes, is_active } = req.body;
    const validFrequencies = ['mensuel', 'trimestriel', 'annuel'];
    const validDirections = ['encaissement', 'decaissement'];
    if (frequency && !validFrequencies.includes(frequency)) return res.status(422).json({ error: 'Fréquence invalide' });
    if (direction && !validDirections.includes(direction)) return res.status(422).json({ error: 'Direction invalide' });

    const result = await pool.query(
      `UPDATE recurring_charges SET
         label = COALESCE($1, label),
         amount = COALESCE($2, amount),
         frequency = COALESCE($3, frequency),
         direction = COALESCE($4, direction),
         next_date = COALESCE($5, next_date),
         notes = COALESCE($6, notes),
         is_active = COALESCE($7, is_active),
         updated_at = NOW()
       WHERE id = $8 AND company_id = $9
       RETURNING *`,
      [
        label ? label.trim() : null,
        amount !== undefined ? parseFloat(amount) : null,
        frequency || null,
        direction || null,
        next_date || null,
        notes !== undefined ? notes : null,
        is_active !== undefined ? is_active : null,
        req.params.id,
        companyId
      ]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Charge introuvable' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PUT /api/tresorerie/charges-recurrentes error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/tresorerie/charges-recurrentes/:id
app.delete('/api/tresorerie/charges-recurrentes/:id', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Aucune entreprise sélectionnée' });
    const result = await pool.query(
      'DELETE FROM recurring_charges WHERE id=$1 AND company_id=$2 RETURNING id',
      [req.params.id, companyId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Charge introuvable' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/tresorerie/charges-recurrentes error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================================
// EFFETS DE COMMERCE — Phase 4.2
// ============================================================

// GET /api/effets — list effects with optional filters
app.get('/api/effets', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Aucune entreprise sélectionnée' });

    const { status, type, due_from, due_to, page, per_page } = req.query;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const perPage = Math.min(200, Math.max(1, parseInt(per_page) || 50));
    const offset = (pageNum - 1) * perPage;

    const params = [companyId];
    let where = 'WHERE e.company_id = $1';
    let idx = 2;

    if (status)   { where += ` AND e.status = $${idx++}`;    params.push(status); }
    if (type)     { where += ` AND e.type = $${idx++}`;      params.push(type); }
    if (due_from) { where += ` AND e.due_date >= $${idx++}`; params.push(due_from); }
    if (due_to)   { where += ` AND e.due_date <= $${idx++}`; params.push(due_to); }

    const today = new Date().toISOString().split('T')[0];
    const weekLater = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Totals from full dataset (aggregate, not paginated)
    const totalsResult = await pool.query(
      `SELECT e.status, COUNT(*) as count, SUM(e.amount) as amount
       FROM effects e ${where} GROUP BY e.status`,
      params
    );
    const totals = {};
    for (const r of totalsResult.rows) {
      totals[r.status] = { count: parseInt(r.count), amount: parseFloat(r.amount) || 0 };
    }

    // Count total for pagination
    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM effects e ${where}`,
      params
    );
    const total = parseInt(countResult.rows[0].total);

    // Paginated data with urgency CASE
    const todayIdx = idx;
    const weekLaterIdx = idx + 1;
    const limitIdx = idx + 2;
    const offsetIdx = idx + 3;

    const dataResult = await pool.query(`
      SELECT e.*,
        c.name as contact_name,
        CASE
          WHEN e.status NOT IN ('encaisse','impaye') AND e.due_date < $${todayIdx} THEN 'overdue'
          WHEN e.status NOT IN ('encaisse','impaye') AND e.due_date BETWEEN $${todayIdx} AND $${weekLaterIdx} THEN 'due_soon'
          ELSE 'normal'
        END as urgency
      FROM effects e
      LEFT JOIN contacts c ON c.id = e.contact_id
      ${where}
      ORDER BY e.due_date ASC, e.id DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `, [...params, today, weekLater, perPage, offset]);

    res.json({
      effects: dataResult.rows,
      totals,
      pagination: {
        page: pageNum,
        per_page: perPage,
        total,
        total_pages: Math.ceil(total / perPage)
      }
    });
  } catch (err) {
    console.error('GET /api/effets error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/effets — create effect
app.post('/api/effets', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Aucune entreprise sélectionnée' });

    const { type, contact_id, amount, creation_date, due_date, status, invoice_id, bank, notes } = req.body;
    if (!type || !amount || !creation_date || !due_date) {
      return res.status(400).json({ error: 'type, amount, creation_date, due_date sont obligatoires' });
    }
    if (!['LC', 'BAO'].includes(type)) {
      return res.status(400).json({ error: 'type doit être LC ou BAO' });
    }

    const result = await pool.query(
      `INSERT INTO effects (company_id, user_id, type, contact_id, amount, creation_date, due_date, status, invoice_id, bank, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [companyId, req.userId, type, contact_id || null, parseFloat(amount), creation_date, due_date,
       status || 'portefeuille', invoice_id || null, bank || null, notes || null]
    );
    res.json({ effect: result.rows[0] });
  } catch (err) {
    console.error('POST /api/effets error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/effets/:id — update effect
app.put('/api/effets/:id', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Aucune entreprise sélectionnée' });

    const { type, contact_id, amount, creation_date, due_date, status, invoice_id, bank, notes } = req.body;

    const result = await pool.query(
      `UPDATE effects SET
         type=$1, contact_id=$2, amount=$3, creation_date=$4, due_date=$5,
         status=$6, invoice_id=$7, bank=$8, notes=$9, updated_at=NOW()
       WHERE id=$10 AND company_id=$11 RETURNING *`,
      [type, contact_id || null, parseFloat(amount), creation_date, due_date,
       status, invoice_id || null, bank || null, notes || null,
       req.params.id, companyId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Effet introuvable' });
    res.json({ effect: result.rows[0] });
  } catch (err) {
    console.error('PUT /api/effets/:id error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/effets/:id/status — change status + optional accounting entry
app.put('/api/effets/:id/status', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const companyId = await getEffectiveCompanyId(req, client);
    if (!companyId) { client.release(); return res.status(400).json({ error: 'Aucune entreprise sélectionnée' }); }

    const { status, date } = req.body;
    if (!status) return res.status(400).json({ error: 'status requis' });

    const effetRes = await client.query('SELECT * FROM effects WHERE id=$1 AND company_id=$2', [req.params.id, companyId]);
    if (!effetRes.rows.length) { client.release(); return res.status(404).json({ error: 'Effet introuvable' }); }
    const effet = effetRes.rows[0];

    await client.query('BEGIN');

    // Update status
    await client.query('UPDATE effects SET status=$1, updated_at=NOW() WHERE id=$2', [status, effet.id]);

    // Generate accounting entry based on transition
    let entryCreated = null;
    const entryDate = date || new Date().toISOString().split('T')[0];
    const contactName = (await client.query('SELECT name FROM contacts WHERE id=$1', [effet.contact_id])).rows[0]?.name || 'Tiers';

    const getSeq = async () => {
      const r = await client.query(`SELECT COUNT(*)+1 AS seq FROM journal_entries WHERE company_id=$1 AND journal_type='OD'`, [companyId]);
      return String(r.rows[0].seq).padStart(4, '0');
    };

    const createEntry = async (desc, lines) => {
      const totalD = lines.reduce((s, l) => s + (l.debit || 0), 0);
      const totalC = lines.reduce((s, l) => s + (l.credit || 0), 0);
      const seq = await getSeq();
      const num = `OD-EF-${entryDate.replace(/-/g, '').substring(0, 6)}-${seq}`;
      const je = await client.query(
        `INSERT INTO journal_entries (company_id, entry_number, date, journal_type, description, total_debit, total_credit, user_id, source_type, source_id)
         VALUES ($1,$2,$3,'OD',$4,$5,$6,$7,'effect',$8) RETURNING id`,
        [companyId, num, entryDate, desc, totalD, totalC, req.userId, effet.id]
      );
      const jeId = je.rows[0].id;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        await client.query(
          `INSERT INTO journal_entry_lines (journal_entry_id, account_code, account_name, debit, credit, description, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [jeId, l.account, l.name, l.debit || 0, l.credit || 0, desc, i]
        );
      }
      return { entry_number: num, entry_id: jeId };
    };

    const oldStatus = effet.status;
    const amount = parseFloat(effet.amount);

    // LC réception: portefeuille → remis_encaissement → 3425↔3421
    if (oldStatus === 'portefeuille' && status === 'remis_encaissement' && effet.type === 'LC') {
      entryCreated = await createEntry(`Remise LC à l'encaissement — ${contactName}`, [
        { account: '3425', name: 'Clients — Effets à recevoir', debit: amount, credit: 0 },
        { account: '3421', name: 'Clients', debit: 0, credit: amount }
      ]);
    }
    // Encaissement: remis_encaissement → encaisse → 5141↔3425
    else if (oldStatus === 'remis_encaissement' && status === 'encaisse') {
      entryCreated = await createEntry(`Encaissement effet — ${contactName}`, [
        { account: '5141', name: 'Banques (encaissements)', debit: amount, credit: 0 },
        { account: '3425', name: 'Clients — Effets à recevoir', debit: 0, credit: amount }
      ]);
    }
    // Impayé: → impaye → 3421↔3425
    else if (status === 'impaye' && (oldStatus === 'remis_encaissement' || oldStatus === 'portefeuille')) {
      entryCreated = await createEntry(`Effet impayé — ${contactName}`, [
        { account: '3421', name: 'Clients', debit: amount, credit: 0 },
        { account: '3425', name: 'Clients — Effets à recevoir', debit: 0, credit: amount }
      ]);
    }

    await client.query('COMMIT');
    res.json({ ok: true, effect_id: effet.id, new_status: status, entry: entryCreated });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('PUT /api/effets/:id/status error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally { client.release(); }
});

// DELETE /api/effets/:id
app.delete('/api/effets/:id', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Aucune entreprise sélectionnée' });
    const result = await pool.query(
      'DELETE FROM effects WHERE id=$1 AND company_id=$2 RETURNING id',
      [req.params.id, companyId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Effet introuvable' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/effets/:id error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/effets/export/csv
app.get('/api/effets/export/csv', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Aucune entreprise sélectionnée' });

    const result = await pool.query(`
      SELECT e.type, e.amount, e.creation_date, e.due_date, e.status, e.bank, e.notes,
             c.name as contact_name
      FROM effects e
      LEFT JOIN contacts c ON c.id = e.contact_id
      WHERE e.company_id = $1
      ORDER BY e.due_date ASC
    `, [companyId]);

    const STATUS_LABELS = {
      portefeuille: 'En portefeuille',
      remis_encaissement: 'Remis à l\'encaissement',
      encaisse: 'Encaissé',
      impaye: 'Impayé',
      escompte: 'Escompté'
    };

    const headers = ['Type','Tiers','Montant','Date création','Date échéance','Statut','Banque','Notes'];
    const csv = [
      headers.join(';'),
      ...result.rows.map(r => [
        r.type, r.contact_name || '',
        parseFloat(r.amount).toFixed(2),
        r.creation_date ? r.creation_date.toISOString().split('T')[0] : '',
        r.due_date ? r.due_date.toISOString().split('T')[0] : '',
        STATUS_LABELS[r.status] || r.status,
        r.bank || '', r.notes || ''
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(';'))
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="effets-commerce.csv"');
    res.send('\uFEFF' + csv);
  } catch (err) {
    console.error('GET /api/effets/export/csv error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================================
// IS — IMPÔT SUR LES SOCIÉTÉS — Phase 3.5
// ============================================================

// Pre-filled DGI réintégrations & déductions
const IS_DEFAULT_REINTEGRATIONS = [
  { code: 'R01', label: 'Amendes et pénalités fiscales', amount: 0 },
  { code: 'R02', label: 'Charges non justifiées', amount: 0 },
  { code: 'R03', label: 'Charges sur exercices antérieurs', amount: 0 },
  { code: 'R04', label: 'Cadeaux dépassant 100 MAD/bénéficiaire', amount: 0 },
  { code: 'R05', label: 'Impôts sur le résultat comptabilisé', amount: 0 },
];
const IS_DEFAULT_DEDUCTIONS = [
  { code: 'D01', label: 'Dividendes reçus (abattement 100%)', amount: 0 },
  { code: 'D02', label: 'Plus-values exonérées', amount: 0 },
  { code: 'D03', label: 'Déficits reportables des exercices antérieurs', amount: 0 },
  { code: 'D04', label: 'Amortissements réputés différés', amount: 0 },
];

// Barème IS 2024+ (art. 19 CGI)
function computeIsFromBareme(resultatFiscal) {
  if (resultatFiscal <= 0) return 0;
  let is = 0;
  const brackets = [
    { up: 300000,   rate: 0.10 },
    { up: 1000000,  rate: 0.20 },
    { up: Infinity, rate: 0.3100 },
  ];
  let remaining = resultatFiscal;
  let prev = 0;
  for (const bracket of brackets) {
    const slice = Math.min(remaining, bracket.up - prev);
    if (slice <= 0) break;
    is += slice * bracket.rate;
    remaining -= slice;
    prev = bracket.up;
    if (remaining <= 0) break;
  }
  return Math.round(is * 100) / 100;
}

// GET /api/is?fiscal_year_id=X — calculate IS preview
app.get('/api/is', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Aucune entreprise sélectionnée' });
    const { fiscal_year_id } = req.query;
    if (!fiscal_year_id) return res.status(400).json({ error: 'fiscal_year_id requis' });

    const fyRes = await pool.query('SELECT * FROM fiscal_years WHERE id=$1 AND company_id=$2', [fiscal_year_id, companyId]);
    if (!fyRes.rows.length) return res.status(404).json({ error: 'Exercice non trouvé' });
    const fy = fyRes.rows[0];

    // Get résultat comptable from CPC (Class 7 − Class 6)
    const class7 = await pool.query(`
      SELECT COALESCE(SUM(jel.credit - jel.debit), 0) as net
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.journal_entry_id
      WHERE je.company_id = $1 AND je.date BETWEEN $2 AND $3
        AND jel.account_code LIKE '7%' AND je.journal_type != 'RAN'
    `, [companyId, fy.start_date, fy.end_date]);

    const class6 = await pool.query(`
      SELECT COALESCE(SUM(jel.debit - jel.credit), 0) as net
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.journal_entry_id
      WHERE je.company_id = $1 AND je.date BETWEEN $2 AND $3
        AND jel.account_code LIKE '6%' AND je.journal_type != 'RAN'
    `, [companyId, fy.start_date, fy.end_date]);

    const resultatComptable = parseFloat(class7.rows[0].net) - parseFloat(class6.rows[0].net);

    // Get CA (compte 71xx + 72xx + 73xx ventes)
    const caRes = await pool.query(`
      SELECT COALESCE(SUM(jel.credit - jel.debit), 0) as ca
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.journal_entry_id
      WHERE je.company_id = $1 AND je.date BETWEEN $2 AND $3
        AND jel.account_code LIKE '71%' AND je.journal_type != 'RAN'
    `, [companyId, fy.start_date, fy.end_date]);
    const chiffreAffaires = parseFloat(caRes.rows[0].ca) || 0;

    // Check for existing saved declaration
    const savedRes = await pool.query(
      'SELECT * FROM is_declarations WHERE company_id=$1 AND fiscal_year_id=$2 ORDER BY id DESC LIMIT 1',
      [companyId, fiscal_year_id]
    );
    const saved = savedRes.rows[0] || null;

    const reintegrations = saved ? saved.reintegrations : IS_DEFAULT_REINTEGRATIONS;
    const deductions = saved ? saved.deductions : IS_DEFAULT_DEDUCTIONS;

    const totalReint = reintegrations.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
    const totalDeduc = deductions.reduce((s, d) => s + (parseFloat(d.amount) || 0), 0);
    const resultatFiscal = Math.max(0, resultatComptable + totalReint - totalDeduc);
    const isCalcule = computeIsFromBareme(resultatFiscal);
    const cotisationMinimale = Math.round(chiffreAffaires * 0.0025 * 100) / 100;
    const isDu = Math.max(isCalcule, cotisationMinimale);
    const isCotisationMinimaleApplied = cotisationMinimale > isCalcule;

    res.json({
      exercice: fy,
      resultat_comptable: Math.round(resultatComptable * 100) / 100,
      chiffre_affaires: Math.round(chiffreAffaires * 100) / 100,
      reintegrations,
      deductions,
      total_reintegrations: Math.round(totalReint * 100) / 100,
      total_deductions: Math.round(totalDeduc * 100) / 100,
      resultat_fiscal: Math.round(resultatFiscal * 100) / 100,
      is_calcule: isCalcule,
      cotisation_minimale: cotisationMinimale,
      is_du: isDu,
      is_cotisation_minimale_applied: isCotisationMinimaleApplied,
      saved_declaration: saved,
      default_reintegrations: IS_DEFAULT_REINTEGRATIONS,
      default_deductions: IS_DEFAULT_DEDUCTIONS
    });
  } catch (err) {
    console.error('GET /api/is error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/is — save IS declaration
app.post('/api/is', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Aucune entreprise sélectionnée' });
    const { fiscal_year_id, reintegrations, deductions } = req.body;
    if (!fiscal_year_id) return res.status(400).json({ error: 'fiscal_year_id requis' });

    const fyRes = await pool.query('SELECT * FROM fiscal_years WHERE id=$1 AND company_id=$2', [fiscal_year_id, companyId]);
    if (!fyRes.rows.length) return res.status(404).json({ error: 'Exercice non trouvé' });
    const fy = fyRes.rows[0];

    // Recalculate all values server-side
    const class7 = await pool.query(`
      SELECT COALESCE(SUM(jel.credit - jel.debit), 0) as net
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.journal_entry_id
      WHERE je.company_id = $1 AND je.date BETWEEN $2 AND $3
        AND jel.account_code LIKE '7%' AND je.journal_type != 'RAN'
    `, [companyId, fy.start_date, fy.end_date]);
    const class6 = await pool.query(`
      SELECT COALESCE(SUM(jel.debit - jel.credit), 0) as net
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.journal_entry_id
      WHERE je.company_id = $1 AND je.date BETWEEN $2 AND $3
        AND jel.account_code LIKE '6%' AND je.journal_type != 'RAN'
    `, [companyId, fy.start_date, fy.end_date]);
    const caRes = await pool.query(`
      SELECT COALESCE(SUM(jel.credit - jel.debit), 0) as ca
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.journal_entry_id
      WHERE je.company_id = $1 AND je.date BETWEEN $2 AND $3
        AND jel.account_code LIKE '71%' AND je.journal_type != 'RAN'
    `, [companyId, fy.start_date, fy.end_date]);

    const resultatComptable = parseFloat(class7.rows[0].net) - parseFloat(class6.rows[0].net);
    const chiffreAffaires = parseFloat(caRes.rows[0].ca) || 0;
    const totalReint = (reintegrations || []).reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
    const totalDeduc = (deductions || []).reduce((s, d) => s + (parseFloat(d.amount) || 0), 0);
    const resultatFiscal = Math.max(0, resultatComptable + totalReint - totalDeduc);
    const isCalcule = computeIsFromBareme(resultatFiscal);
    const cotisationMinimale = Math.round(chiffreAffaires * 0.0025 * 100) / 100;
    const isDu = Math.max(isCalcule, cotisationMinimale);

    const result = await pool.query(
      `INSERT INTO is_declarations (company_id, fiscal_year_id, resultat_comptable, reintegrations, deductions, resultat_fiscal, chiffre_affaires, is_calcule, cotisation_minimale, is_du)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [companyId, fiscal_year_id,
       Math.round(resultatComptable * 100) / 100,
       JSON.stringify(reintegrations || []),
       JSON.stringify(deductions || []),
       Math.round(resultatFiscal * 100) / 100,
       Math.round(chiffreAffaires * 100) / 100,
       isCalcule, cotisationMinimale, isDu]
    );

    res.json({ declaration: result.rows[0] });
  } catch (err) {
    console.error('POST /api/is error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/is/declarations — history of IS declarations
app.get('/api/is/declarations', requireAuth, async (req, res) => {
  try {
    const companyId = await getEffectiveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Aucune entreprise sélectionnée' });
    const result = await pool.query(
      `SELECT d.*, fy.label as exercice_label, fy.start_date, fy.end_date
       FROM is_declarations d
       JOIN fiscal_years fy ON fy.id = d.fiscal_year_id
       WHERE d.company_id = $1
       ORDER BY d.created_at DESC`,
      [companyId]
    );
    res.json({ declarations: result.rows });
  } catch (err) {
    console.error('GET /api/is/declarations error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================================
// CABINET PARTNER REQUESTS (landing page form)
// ============================================================
app.post('/api/cabinet-partenaire-request', express.json(), async (req, res) => {
  try {
    const { cabinet_name, contact_name, email, phone, estimated_dossiers, city, message } = req.body || {};
    if (!cabinet_name || !contact_name || !email) {
      return res.status(400).json({ error: 'Champs obligatoires manquants (cabinet_name, contact_name, email)' });
    }

    // Store in DB
    const result = await pool.query(
      `INSERT INTO cabinet_partner_requests (cabinet_name, contact_name, email, phone, estimated_dossiers, city, message, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending') RETURNING id`,
      [cabinet_name, contact_name, email, phone || null, estimated_dossiers || null, city || null, message || null]
    );

    // Notify team
    const notifHtml = buildEmailHtml(
      'Nouvelle demande cabinet partenaire',
      `<strong>${cabinet_name}</strong> (${contact_name} — ${email}) souhaite rejoindre le réseau HissabPro.<br><br>
       Dossiers estimés: ${estimated_dossiers || 'non précisé'}<br>
       Ville: ${city || 'non précisée'}<br>
       Téléphone: ${phone || 'non précisé'}<br>
       Message: ${message || '—'}<br><br>
       Demande #${result.rows[0].id}`,
      null
    );
    await sendNotificationEmail('hissabpro@polsia.app', `[Partenaire] ${cabinet_name} — nouvelle demande`, notifHtml);

    // Confirm to applicant
    const confirmHtml = buildEmailHtml(
      'Votre demande a été reçue',
      `Bonjour ${contact_name},<br><br>
       Nous avons bien reçu la demande de partenariat du cabinet <strong>${cabinet_name}</strong>.<br>
       Notre équipe vous contactera dans les 48 heures pour discuter des prochaines étapes.<br><br>
       Tarif cabinet partenaire : <strong>49 DH HT / mois / dossier client actif</strong>.`,
      null
    );
    await sendNotificationEmail(email, 'HissabPro — Demande de partenariat cabinet reçue', confirmHtml);

    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error('POST /api/cabinet-partenaire-request error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================================
// WAITLIST — Pre-launch email collection
// ============================================================

// Rate limiter for waitlist (max 3 signups per IP per hour)
const waitlistRateLimit = createRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3,
  message: () => "Trop d'inscriptions depuis cette adresse IP, réessayez dans 1 heure"
});

app.post('/api/waitlist', waitlistRateLimit, express.json(), async (req, res) => {
  try {
    const { email, profile_type } = req.body || {};
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Adresse email invalide' });
    }
    const emailNorm = email.trim().toLowerCase().slice(0, 255);
    const profileNorm = ['entrepreneur', 'pme', 'cabinet', 'freelance', 'autre'].includes(profile_type)
      ? profile_type : null;

    // Deduplication: ON CONFLICT DO NOTHING
    const result = await pool.query(
      `INSERT INTO waitlist_subscribers (email, profile_type)
       VALUES ($1, $2)
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [emailNorm, profileNorm]
    );

    const isNew = result.rows.length > 0;

    // Send internal notification for new subscribers only
    if (isNew) {
      const notifHtml = buildEmailHtml(
        'Nouvelle inscription liste d\'attente',
        `<strong>${emailNorm}</strong> vient de rejoindre la liste d'attente HissabPro.<br><br>
         Profil : ${profileNorm || 'non précisé'}`,
        null
      );
      await sendNotificationEmail('hissabpro@polsia.app', `[Waitlist] ${emailNorm}`, notifHtml);
    }

    res.json({ success: true, new: isNew });
  } catch (err) {
    console.error('POST /api/waitlist error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.listen(port, () => {
  const transport = POSTMARK_SERVER_TOKEN ? 'Postmark API' : POLSIA_EMAIL_PROXY_URL ? 'Polsia proxy' : 'NONE (queuing to DB)';
  console.log(`HissabPro server running on port ${port}`);
  console.log(`[EMAIL] Transport: ${transport}`);
});

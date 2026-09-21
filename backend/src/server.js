const path = require('path');
const crypto = require('crypto');
const https = require('https');
const fs = require('fs/promises');
const fsSync = require('fs');
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const dotenv = require('dotenv');
const admin = require('firebase-admin');
const PDFDocument = require('pdfkit');
const selfsigned = require('selfsigned');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const app = express();
const BACKEND_ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 3001;
const USE_HTTPS = String(process.env.USE_HTTPS || 'true').toLowerCase() !== 'false';
const HTTPS_PORT = Number(process.env.HTTPS_PORT || PORT);
const DEFAULT_REFERRAL_HANDLE = 'actarus';
const FRONTEND_ROOT = path.join(__dirname, '..', '..', 'frontend', 'dist');
const TLS_CERT_DIR = path.join(__dirname, '..', 'certs');
const TLS_KEY_PATH = path.join(TLS_CERT_DIR, 'localhost-key.pem');
const TLS_CERT_PATH = path.join(TLS_CERT_DIR, 'localhost-cert.pem');
const USERS_FILE = path.join(__dirname, '..', 'data', 'users.json');
const TRANSACTIONS_FILE = path.join(__dirname, '..', 'data', 'transactions.json');
const CONVERSATIONS_FILE = path.join(__dirname, '..', 'data', 'conversations.json');
function resolveServiceAccountPath(rawPath) {
  if (!rawPath) return null;
  if (path.isAbsolute(rawPath)) return rawPath;
  return path.resolve(BACKEND_ROOT, rawPath);
}

const FIREBASE_SERVICE_ACCOUNT_PATH = resolveServiceAccountPath(
  process.env.FIREBASE_SERVICE_ACCOUNT_PATH || process.env.GOOGLE_APPLICATION_CREDENTIALS
);

let adminDb = null;
let adminStorageBucket = null;

try {
  if (FIREBASE_SERVICE_ACCOUNT_PATH && fsSync.existsSync(FIREBASE_SERVICE_ACCOUNT_PATH)) {
    const serviceAccount = JSON.parse(fsSync.readFileSync(FIREBASE_SERVICE_ACCOUNT_PATH, 'utf8'));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'midgen-u6gv0i.firebasestorage.app'
    });
    adminDb = admin.firestore();
    adminStorageBucket = admin.storage().bucket();
    console.log('Firebase Admin initialisé (Firestore server-side actif).');
  } else {
    console.warn('Service account Firebase non configure. Definissez FIREBASE_SERVICE_ACCOUNT_PATH ou GOOGLE_APPLICATION_CREDENTIALS vers un JSON local non versionne.');
  }
} catch (error) {
  console.warn('Firebase Admin non initialisé, fallback JSON uniquement:', error.message);
}

const COINGECKO_MAP = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  USDT: 'tether',
  USDC: 'usd-coin',
  TON: 'the-open-network'
};

const APP_SETTINGS_COLLECTION = 'app_settings';
const APP_SETTINGS_DOC_ID = 'global';
const ALLOW_DEV_X_USER_ID = String(process.env.ALLOW_DEV_X_USER_ID || 'false').toLowerCase() === 'true';
const DEFAULT_APP_SETTINGS = {
  commissionStandardPct: 7.5,
  commissionPlatformPct: 6,
  guaranteeDurationsHours: [4, 24, 168, 336],
  dealExpirationHours: 48,
  sellerInactivityTimeoutHours: 48
};
const APP_SETTINGS_CACHE_TTL_MS = Number(process.env.APP_SETTINGS_CACHE_TTL_MS || 30_000);
const ADMIN_ROLE_CACHE_TTL_MS = Number(process.env.ADMIN_ROLE_CACHE_TTL_MS || 60_000);
const AUTOMATION_INTERVAL_MS = Number(process.env.AUTOMATION_INTERVAL_MS || 300000);
let _automationJobRunning = false;
let _automationTimer = null;
const _appSettingsCache = {
  settings: null,
  fetchedAt: 0
};
const _adminRoleCache = new Map();

app.use(cors());
app.use(compression());
app.use(express.json({ limit: '25mb' }));

function normalizeHandle(rawHandle) {
  const handle = String(rawHandle || '').trim();
  const withoutAt = handle.startsWith('@') ? handle.slice(1) : handle;
  return withoutAt.toLowerCase();
}

function toMillis(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value?.toMillis === 'function') {
    return value.toMillis();
  }
  if (typeof value?.seconds === 'number') {
    return value.seconds * 1000;
  }
  if (typeof value?._seconds === 'number') {
    return value._seconds * 1000;
  }
  return null;
}

function normalizeBlockchainPlatform(rawPlatform) {
  const platform = String(rawPlatform || '').trim().toLowerCase();
  if (platform === 'ethereum') {
    return { key: 'ethereum', network: 'Ethereum' };
  }
  return { key: 'solana', network: 'Solana' };
}

function normalizeAffiliationRecord(record = {}) {
  const dateDebut = toMillis(record['dateDébut'] ?? record.dateDebut);
  const dateFinRaw = record['dateFin'] ?? record.dateFin;
  const dateFin = dateFinRaw === null ? null : toMillis(dateFinRaw);

  return {
    ...record,
    ['dateDébut']: dateDebut,
    ['dateFin']: dateFin
  };
}

function sanitizeAppSettings(raw = {}) {
  const commissionStandardPct = Number(raw.commissionStandardPct);
  const commissionPlatformPct = Number(raw.commissionPlatformPct);
  const dealExpirationHours = Number(raw.dealExpirationHours);
  const sellerInactivityTimeoutHours = Number(raw.sellerInactivityTimeoutHours);
  const rawGuarantee = Array.isArray(raw.guaranteeDurationsHours)
    ? raw.guaranteeDurationsHours
    : String(raw.guaranteeDurationsHours || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean);

  const guaranteeDurationsHours = rawGuarantee
    .map(value => Number(value))
    .filter(value => Number.isFinite(value) && value > 0)
    .map(value => Math.round(value));

  return {
    commissionStandardPct: Number.isFinite(commissionStandardPct) && commissionStandardPct >= 0 ? commissionStandardPct : DEFAULT_APP_SETTINGS.commissionStandardPct,
    commissionPlatformPct: Number.isFinite(commissionPlatformPct) && commissionPlatformPct >= 0 ? commissionPlatformPct : DEFAULT_APP_SETTINGS.commissionPlatformPct,
    guaranteeDurationsHours: guaranteeDurationsHours.length ? [...new Set(guaranteeDurationsHours)].sort((a, b) => a - b) : DEFAULT_APP_SETTINGS.guaranteeDurationsHours,
    dealExpirationHours: Number.isFinite(dealExpirationHours) && dealExpirationHours > 0 ? Math.round(dealExpirationHours) : DEFAULT_APP_SETTINGS.dealExpirationHours,
    sellerInactivityTimeoutHours: Number.isFinite(sellerInactivityTimeoutHours) && sellerInactivityTimeoutHours > 0 ? Math.round(sellerInactivityTimeoutHours) : DEFAULT_APP_SETTINGS.sellerInactivityTimeoutHours
  };
}

async function getEffectiveAppSettings() {
  if (!adminDb) return { ...DEFAULT_APP_SETTINGS };

  const now = Date.now();
  const cacheIsFresh = _appSettingsCache.settings && (now - _appSettingsCache.fetchedAt) < APP_SETTINGS_CACHE_TTL_MS;
  if (cacheIsFresh) {
    return { ..._appSettingsCache.settings };
  }

  try {
    const ref = adminDb.collection(APP_SETTINGS_COLLECTION).doc(APP_SETTINGS_DOC_ID);
    const doc = await ref.get();
    if (!doc.exists) {
      const defaults = { ...DEFAULT_APP_SETTINGS, updatedAt: Date.now() };
      await ref.set(defaults, { merge: true });
      _appSettingsCache.settings = { ...DEFAULT_APP_SETTINGS };
      _appSettingsCache.fetchedAt = now;
      return { ...DEFAULT_APP_SETTINGS };
    }
    const sanitized = sanitizeAppSettings({ ...DEFAULT_APP_SETTINGS, ...doc.data() });
    _appSettingsCache.settings = { ...sanitized };
    _appSettingsCache.fetchedAt = now;
    return sanitized;
  } catch (error) {
    console.warn('Impossible de charger app_settings pour automatisation:', error.message);
    return { ...DEFAULT_APP_SETTINGS };
  }
}

function getTransactionLastActivityMillis(transaction = {}) {
  const updatedAt = toMillis(transaction.updatedAt);
  const createdAt = toMillis(transaction.datecreation) ?? toMillis(transaction.createdAt);
  const timelineMax = Array.isArray(transaction.timeline)
    ? transaction.timeline.reduce((max, item) => {
      const t = toMillis(item?.time);
      return t && t > max ? t : max;
    }, 0)
    : 0;

  return Math.max(updatedAt || 0, timelineMax || 0, createdAt || 0);
}

function timelineHasMarker(transaction = {}, markerStatus) {
  return Array.isArray(transaction.timeline)
    && transaction.timeline.some(item => String(item?.status || '').trim() === markerStatus);
}

function appendTimelineEvent(transaction = {}, event) {
  const timeline = Array.isArray(transaction.timeline) ? [...transaction.timeline] : [];
  timeline.push(event);
  return timeline;
}

async function runAutomatedStatusJobs() {
  if (!adminDb || _automationJobRunning) return;
  _automationJobRunning = true;

  try {
    const settings = await getEffectiveAppSettings();
    const dealExpirationMs = Number(settings.dealExpirationHours || 0) * 3600000;
    const sellerInactivityMs = Number(settings.sellerInactivityTimeoutHours || 0) * 3600000;
    const now = Date.now();

    if (dealExpirationMs <= 0 && sellerInactivityMs <= 0) {
      _automationJobRunning = false;
      return;
    }

    const snapshot = await adminDb.collection('transactions').get();
    let pendingExpired = 0;
    let sellerTimeoutDisputes = 0;

    for (const doc of snapshot.docs) {
      const tx = doc.data() || {};
      const statut = String(tx.statut || '').trim();
      let updatePayload = null;

      if (dealExpirationMs > 0 && statut === 'En attente') {
        const createdAt = toMillis(tx.datecreation) ?? toMillis(tx.createdAt) ?? 0;
        if (createdAt > 0 && (now - createdAt) >= dealExpirationMs) {
          const marker = 'auto-expired-pending';
          const timeline = timelineHasMarker(tx, marker)
            ? (Array.isArray(tx.timeline) ? tx.timeline : [])
            : appendTimelineEvent(tx, {
              status: marker,
              time: now,
              label: `Expiration automatique: transaction non confirmée après ${settings.dealExpirationHours}h`
            });

          updatePayload = {
            statut: 'Refusé',
            updatedAt: now,
            timeline
          };
          pendingExpired += 1;
        }
      }

      if (!updatePayload && sellerInactivityMs > 0 && statut === 'Déposer les documents') {
        const lastActivity = getTransactionLastActivityMillis(tx);
        if (lastActivity > 0 && (now - lastActivity) >= sellerInactivityMs) {
          const marker = 'auto-seller-inactivity';
          const timeline = timelineHasMarker(tx, marker)
            ? (Array.isArray(tx.timeline) ? tx.timeline : [])
            : appendTimelineEvent(tx, {
              status: marker,
              time: now,
              label: `Litige automatique: inactivité vendeur après ${settings.sellerInactivityTimeoutHours}h`
            });

          updatePayload = {
            statut: 'Litige',
            disputeSeenByAdmin: false,
            updatedAt: now,
            timeline
          };
          sellerTimeoutDisputes += 1;
        }
      }

      if (!updatePayload && statut === 'Garantie') {
        const guaranteeExpiresAt = toMillis(tx.guaranteeExpiresAt);
        if (guaranteeExpiresAt && now >= guaranteeExpiresAt) {
          const marker = 'auto-guarantee-expired';
          const timeline = timelineHasMarker(tx, marker)
            ? (Array.isArray(tx.timeline) ? tx.timeline : [])
            : appendTimelineEvent(tx, {
              status: marker,
              time: now,
              label: 'Période de garantie expirée — passage automatique à Noter'
            });
          updatePayload = { statut: 'Noter', updatedAt: now, timeline };
        }
      }

      if (updatePayload) {
        await doc.ref.set(updatePayload, { merge: true });
      }
    }

    if (pendingExpired > 0 || sellerTimeoutDisputes > 0) {
      console.log(`[automation] Expirations auto: ${pendingExpired}, Litiges inactivité vendeur: ${sellerTimeoutDisputes}`);
    }
  } catch (error) {
    console.warn('Erreur moteur automatisation statuts:', error.message);
  } finally {
    _automationJobRunning = false;
  }
}

function startAutomatedStatusEngine() {
  if (!adminDb) {
    console.warn('Automatisation statuts inactive: Firestore indisponible.');
    return;
  }
  if (_automationTimer) return;

  runAutomatedStatusJobs();
  _automationTimer = setInterval(runAutomatedStatusJobs, AUTOMATION_INTERVAL_MS);
  console.log(`[automation] Moteur statuts actif (intervalle: ${AUTOMATION_INTERVAL_MS}ms)`);
}

async function readUsersFile() {
  // Firebase-only: local JSON files are no longer used as data source
  return [];
}

async function writeUsersFile(users) {
  // Firebase-only: local JSON writes disabled
}

async function readTransactionsFile() {
  // Firebase-only: local JSON files are no longer used as data source
  return [];
}

async function writeTransactionsFile(transactions) {
  // Firebase-only: local JSON writes disabled
}

async function readConversationsFile() {
  // Firebase-only: local JSON files are no longer used as data source
  return [];
}

async function writeConversationsFile(conversations) {
  // Firebase-only: local JSON writes disabled
}

// ============ AUTH HELPERS ============
const ADMIN_UIDS = String(process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
const ADMIN_LOGIN_MAX_FAILED_ATTEMPTS = Number(process.env.ADMIN_LOGIN_MAX_FAILED_ATTEMPTS || 3);
const ADMIN_LOGIN_LOCKOUT_MS = Number(process.env.ADMIN_LOGIN_LOCKOUT_MS || 20 * 60 * 1000);
const adminLoginAttemptsByIp = new Map();

function resolveRequestIp(req) {
  const xForwardedFor = String(req.headers['x-forwarded-for'] || '').trim();
  const firstForwarded = xForwardedFor.split(',')[0].trim();
  const rawIp = firstForwarded || String(req.ip || req.socket?.remoteAddress || '').trim() || 'unknown';
  return rawIp.replace(/^::ffff:/, '');
}

function getAdminLoginGuardState(ip) {
  const state = adminLoginAttemptsByIp.get(ip);
  if (!state) {
    return { failedAttempts: 0, blockedUntil: 0, attemptsRemaining: ADMIN_LOGIN_MAX_FAILED_ATTEMPTS };
  }
  const now = Date.now();
  if (Number(state.blockedUntil || 0) <= now && Number(state.failedAttempts || 0) <= 0) {
    adminLoginAttemptsByIp.delete(ip);
    return { failedAttempts: 0, blockedUntil: 0, attemptsRemaining: ADMIN_LOGIN_MAX_FAILED_ATTEMPTS };
  }
  const failedAttempts = Number(state.failedAttempts || 0);
  const blockedUntil = Number(state.blockedUntil || 0);
  return {
    failedAttempts,
    blockedUntil,
    attemptsRemaining: Math.max(0, ADMIN_LOGIN_MAX_FAILED_ATTEMPTS - failedAttempts)
  };
}

function clearAdminLoginGuard(ip) {
  adminLoginAttemptsByIp.delete(ip);
}

function registerAdminLoginFailure(ip) {
  const now = Date.now();
  const state = adminLoginAttemptsByIp.get(ip) || { failedAttempts: 0, blockedUntil: 0 };

  if (Number(state.blockedUntil || 0) > now) {
    return {
      blocked: true,
      blockedUntil: Number(state.blockedUntil),
      remainingMs: Number(state.blockedUntil) - now,
      failedAttempts: Number(state.failedAttempts || ADMIN_LOGIN_MAX_FAILED_ATTEMPTS),
      attemptsRemaining: 0
    };
  }

  if (Number(state.blockedUntil || 0) <= now) {
    state.blockedUntil = 0;
  }

  state.failedAttempts = Number(state.failedAttempts || 0) + 1;
  if (state.failedAttempts >= ADMIN_LOGIN_MAX_FAILED_ATTEMPTS) {
    state.failedAttempts = ADMIN_LOGIN_MAX_FAILED_ATTEMPTS;
    state.blockedUntil = now + ADMIN_LOGIN_LOCKOUT_MS;
  }

  adminLoginAttemptsByIp.set(ip, state);

  const blocked = Number(state.blockedUntil || 0) > now;
  return {
    blocked,
    blockedUntil: Number(state.blockedUntil || 0),
    remainingMs: blocked ? Number(state.blockedUntil) - now : 0,
    failedAttempts: Number(state.failedAttempts || 0),
    attemptsRemaining: Math.max(0, ADMIN_LOGIN_MAX_FAILED_ATTEMPTS - Number(state.failedAttempts || 0))
  };
}

function getAdminLoginLock(ip) {
  const state = getAdminLoginGuardState(ip);
  const now = Date.now();
  const blocked = Number(state.blockedUntil || 0) > now;
  return {
    blocked,
    blockedUntil: Number(state.blockedUntil || 0),
    remainingMs: blocked ? Number(state.blockedUntil) - now : 0,
    failedAttempts: Number(state.failedAttempts || 0),
    attemptsRemaining: Number(state.attemptsRemaining || ADMIN_LOGIN_MAX_FAILED_ATTEMPTS)
  };
}

async function resolveCallerIsAdmin(uid) {
  if (!uid) return false;
  if (ADMIN_UIDS.includes(uid)) return true;

  const now = Date.now();
  const cached = _adminRoleCache.get(uid);
  if (cached && (now - Number(cached.fetchedAt || 0)) < ADMIN_ROLE_CACHE_TTL_MS) {
    return !!cached.isAdmin;
  }

  let isAdmin = false;
  if (adminDb) {
    try {
      const doc = await adminDb.collection('admin_users').doc(uid).get();
      if (doc.exists && doc.data()?.isAdmin === true) isAdmin = true;
    } catch (_) {}

    if (!isAdmin) {
      const adminMarkers = new Set(['admin', 'administrateur', 'administrator']);
      const toMarker = (value) => String(value || '').trim().toLowerCase();

      const hasAdminMarker = (profile = {}) => {
        if (profile?.isAdmin === true) return true;
        if (adminMarkers.has(toMarker(profile?.admin))) return true;
        if (adminMarkers.has(toMarker(profile?.role))) return true;
        if (adminMarkers.has(toMarker(profile?.userRole))) return true;
        return false;
      };

      try {
        const userDoc = await adminDb.collection('users').doc(uid).get();
        if (userDoc.exists && hasAdminMarker(userDoc.data())) {
          isAdmin = true;
        }
      } catch (_) {}
    }
  }
  _adminRoleCache.set(uid, { isAdmin, fetchedAt: now });
  return isAdmin;
}

function ensureAuthProviderAvailable(res) {
  if (adminDb || ALLOW_DEV_X_USER_ID) return true;
  res.status(503).json({ ok: false, message: 'Authentification serveur indisponible.' });
  return false;
}

async function resolveConversationAccess(conversationId, callerUid) {
  const normalizedConversationId = String(conversationId || '').trim();
  const normalizedCallerUid = String(callerUid || '').trim();
  if (!normalizedConversationId || !normalizedCallerUid) {
    return { ok: false, participants: [], isAdmin: false };
  }

  const isAdmin = await resolveCallerIsAdmin(normalizedCallerUid);
  let participants = [];

  if (adminDb) {
    const convDoc = await adminDb.collection('conversations').doc(normalizedConversationId).get();
    if (!convDoc.exists) {
      return { ok: false, participants: [], isAdmin };
    }
    participants = Array.isArray(convDoc.data()?.participants)
      ? convDoc.data().participants.map(value => String(value || '').trim()).filter(Boolean)
      : [];
  } else {
    const conversations = await readConversationsFile();
    const conversation = conversations.find(item => String(item.id || '').trim() === normalizedConversationId);
    if (!conversation) {
      return { ok: false, participants: [], isAdmin };
    }
    participants = Array.isArray(conversation.participants)
      ? conversation.participants.map(value => String(value || '').trim()).filter(Boolean)
      : [];
  }

  return {
    ok: isAdmin || participants.includes(normalizedCallerUid),
    participants,
    isAdmin
  };
}

async function requireAuth(req, res, next) {
  if (!ensureAuthProviderAvailable(res)) return;
  if (!adminDb) {
    const devUid = String(req.headers['x-user-id'] || '').trim();
    if (!devUid) {
      return res.status(401).json({ ok: false, message: 'Token d\'authentification manquant.' });
    }
    req.callerUid = devUid;
    return next();
  }
  const authHeader = String(req.headers.authorization || '').trim();
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, message: 'Token d\'authentification manquant.' });
  }
  const idToken = authHeader.slice(7);
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.callerUid = decoded.uid;
    return next();
  } catch (_err) {
    return res.status(401).json({ ok: false, message: 'Token invalide ou expiré.' });
  }
}

async function requireAdmin(req, res, next) {
  if (!ensureAuthProviderAvailable(res)) return;
  if (!adminDb) {
    const devUid = String(req.headers['x-user-id'] || '').trim();
    if (!devUid) return res.status(401).json({ ok: false, message: 'Token d\'authentification manquant.' });
    req.callerUid = devUid;
  } else {
    const authHeader = String(req.headers.authorization || '').trim();
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ ok: false, message: 'Token d\'authentification manquant.' });
    }
    try {
      const decoded = await admin.auth().verifyIdToken(authHeader.slice(7));
      req.callerUid = decoded.uid;
    } catch (_err) {
      return res.status(401).json({ ok: false, message: 'Token invalide ou expiré.' });
    }
  }
  const isAdm = await resolveCallerIsAdmin(req.callerUid);
  if (!isAdm) return res.status(403).json({ ok: false, message: 'Accès réservé aux administrateurs.' });
  return next();
}

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const uid = String(req.callerUid || '').trim();
    const isAdmin = await resolveCallerIsAdmin(uid);
    return res.json({ ok: true, uid, isAdmin });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur lecture profil auth.', error: error.message });
  }
});

app.get('/api/admin/login-check', async (req, res) => {
  if (!ensureAuthProviderAvailable(res)) return;
  const ip = resolveRequestIp(req);
  const currentLock = getAdminLoginLock(ip);

  if (currentLock.blocked) {
    return res.status(429).json({
      ok: false,
      message: 'Trop de tentatives infructueuses. Réessayez plus tard.',
      guard: currentLock
    });
  }

  let callerUid = '';
  if (!adminDb) {
    callerUid = String(req.headers['x-user-id'] || '').trim();
    if (!callerUid) {
      const failure = registerAdminLoginFailure(ip);
      const status = failure.blocked ? 429 : 401;
      return res.status(status).json({
        ok: false,
        message: failure.blocked
          ? 'Trop de tentatives infructueuses. Réessayez plus tard.'
          : 'Token d\'authentification manquant.',
        guard: failure
      });
    }
  } else {
    const authHeader = String(req.headers.authorization || '').trim();
    if (!authHeader.startsWith('Bearer ')) {
      const failure = registerAdminLoginFailure(ip);
      const status = failure.blocked ? 429 : 401;
      return res.status(status).json({
        ok: false,
        message: failure.blocked
          ? 'Trop de tentatives infructueuses. Réessayez plus tard.'
          : 'Token d\'authentification manquant.',
        guard: failure
      });
    }
    try {
      const decoded = await admin.auth().verifyIdToken(authHeader.slice(7));
      callerUid = String(decoded.uid || '').trim();
    } catch (_err) {
      const failure = registerAdminLoginFailure(ip);
      const status = failure.blocked ? 429 : 401;
      return res.status(status).json({
        ok: false,
        message: failure.blocked
          ? 'Trop de tentatives infructueuses. Réessayez plus tard.'
          : 'Token invalide ou expiré.',
        guard: failure
      });
    }
  }

  const isAdmin = await resolveCallerIsAdmin(callerUid);
  if (!isAdmin) {
    const failure = registerAdminLoginFailure(ip);
    const status = failure.blocked ? 429 : 403;
    return res.status(status).json({
      ok: false,
      message: failure.blocked
        ? 'Trop de tentatives infructueuses. Réessayez plus tard.'
        : 'Accès réservé aux administrateurs.',
      guard: failure
    });
  }

  clearAdminLoginGuard(ip);
  return res.json({ ok: true, uid: callerUid, isAdmin: true, guard: getAdminLoginLock(ip) });
});

// Fetch transaction + resolve caller role (acheteur | vendeur | null)
async function fetchTxAndRole(transactionId, callerUid) {
  let tx = null;
  if (adminDb) {
    const doc = await adminDb.collection('transactions').doc(transactionId).get();
    if (doc.exists) tx = { id: doc.id, ...doc.data() };
  }
  if (!tx) {
    const local = await readTransactionsFile();
    tx = local.find(t => String(t.id || '').trim() === transactionId) || null;
  }
  if (!tx) return { tx: null, role: null };
  const acheteurId = String(tx.acheteur || '').trim();
  const vendeurId = String(tx.vendeur || '').trim();
  let role = null;
  if (acheteurId && acheteurId === callerUid) role = 'acheteur';
  else if (vendeurId && vendeurId === callerUid) role = 'vendeur';
  return { tx, role };
}

// Apply update payload to Firestore + local JSON
async function applyTransactionUpdate(transactionId, updatePayload) {
  let updated = false;
  if (adminDb) {
    const docRef = adminDb.collection('transactions').doc(transactionId);
    const doc = await docRef.get();
    if (doc.exists) { await docRef.update(updatePayload); updated = true; }
  }
  const local = await readTransactionsFile();
  const idx = local.findIndex(t => String(t.id || '').trim() === transactionId);
  if (idx >= 0) { Object.assign(local[idx], updatePayload); await writeTransactionsFile(local); updated = true; }
  return updated;
}

async function upsertUserAffiliation({ idLogin, parrainHandle }) {
  const normalizedReferral = normalizeHandle(parrainHandle);
  if (!idLogin || !normalizedReferral) return;

  if (adminDb) {
    const userRef = adminDb.collection('users').doc(idLogin);
    const affiliationsRef = userRef.collection('affiliations');
    const now = Date.now();

    const activeSnapshot = await affiliationsRef.where('dateFin', '==', null).get();
    if (!activeSnapshot.empty) {
      await Promise.all(activeSnapshot.docs.map(doc => doc.ref.set({
        dateFin: now
      }, { merge: true })));
    }

    await affiliationsRef.add({
      parrainHandle: normalizedReferral,
      ['dateDébut']: admin.firestore.FieldValue.serverTimestamp(),
      ['dateFin']: null
    });
  }

  const users = await readUsersFile();
  const idx = users.findIndex(user => String(user.id_login || user.id || '').trim() === String(idLogin).trim());
  if (idx >= 0) {
    const now = Date.now();
    const existingAffiliations = Array.isArray(users[idx].affiliations) ? users[idx].affiliations : [];
    const closedAffiliations = existingAffiliations.map(item => {
      if (item && item.dateFin === null) {
        return { ...item, dateFin: now };
      }
      return item;
    });

    closedAffiliations.push({
      parrainHandle: normalizedReferral,
      ['dateDébut']: now,
      ['dateFin']: null
    });

    users[idx].affiliations = closedAffiliations;
    users[idx].parrainHandle = normalizedReferral;
    await writeUsersFile(users);
  }
}

async function resolveUsersByIdLogin(ids) {
  const wantedIds = ids.map(id => String(id || '').trim()).filter(Boolean);
  const map = new Map();

  if (adminDb) {
    await Promise.all(wantedIds.map(async (id) => {
      const doc = await adminDb.collection('users').doc(id).get();
      if (doc.exists) {
        map.set(id, { id: doc.id, ...doc.data() });
        return;
      }

      const byIdLogin = await adminDb
        .collection('users')
        .where('id_login', '==', id)
        .limit(1)
        .get();

      if (!byIdLogin.empty) {
        const found = byIdLogin.docs[0];
        map.set(id, { id: found.id, ...found.data() });
      }
    }));
  }

  const localUsers = await readUsersFile();
  wantedIds.forEach(id => {
    if (map.has(id)) return;
    const user = localUsers.find(u => String(u.id_login || u.id || '').trim() === id);
    if (user) map.set(id, user);
  });

  return map;
}

function getNormalizedUserHandle(user) {
  const nestedHandle = user?.profile?.handle || user?.account?.handle;
  return normalizeHandle(
    user?.handle
    || user?.Handle
    || user?.user_handle
    || user?.username
    || user?.userName
    || nestedHandle
    || ''
  );
}

function getUserDisplayName(user, fallback = '') {
  return String(
    user?.Name
    || user?.name
    || user?.displayName
    || user?.mail
    || user?.email
    || fallback
    || ''
  ).trim();
}

function getUserEmail(user, fallback = '') {
  return String(
    user?.mail
    || user?.email
    || user?.Email
    || fallback
    || ''
  ).trim();
}

function sanitizeRatingComment(value) {
  return String(value || '').trim().slice(0, 1000);
}

function toRatingValue(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) return null;
  if (score < 0 || score > 100) return null;
  return Math.round(score * 100) / 100;
}

function buildNotationDocId(transactionId, fromIdLogin) {
  return `${String(transactionId || '').trim()}__${String(fromIdLogin || '').trim()}`;
}

async function recalculateUserReputation(targetIdLogin) {
  const normalizedTarget = String(targetIdLogin || '').trim();
  if (!normalizedTarget) return null;

  let average = null;

  if (adminDb) {
    const notesSnapshot = await adminDb
      .collection('users')
      .doc(normalizedTarget)
      .collection('notations')
      .get();

    const scores = notesSnapshot.docs
      .map(doc => toRatingValue(doc.data()?.score))
      .filter(score => score !== null);

    average = scores.length > 0
      ? Number((scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(2))
      : 0;

    await adminDb.collection('users').doc(normalizedTarget).set({
      ['réputation']: average,
      reputation: average
    }, { merge: true });
  }

  const users = await readUsersFile();
  const userIdx = users.findIndex(user => String(user.id_login || user.id || '').trim() === normalizedTarget);
  if (userIdx >= 0) {
    const userNotations = Array.isArray(users[userIdx].notations)
      ? users[userIdx].notations
      : [];

    const localScores = userNotations
      .map(note => toRatingValue(note?.score))
      .filter(score => score !== null);

    const localAverage = localScores.length > 0
      ? Number((localScores.reduce((sum, score) => sum + score, 0) / localScores.length).toFixed(2))
      : 0;

    users[userIdx]['réputation'] = localAverage;
    users[userIdx].reputation = localAverage;
    await writeUsersFile(users);

    if (average === null) average = localAverage;
  }

  return average;
}

async function ensureConversationForTransactionData({ transactionId, buyerIdLogin, sellerIdLogin, senderIdLogin }) {
  const users = await resolveUsersByIdLogin([buyerIdLogin, sellerIdLogin, senderIdLogin]);
  const buyer = users.get(buyerIdLogin);
  const seller = users.get(sellerIdLogin);
  const sender = users.get(senderIdLogin);

  if (!buyer || !seller) {
    throw new Error('Participants introuvables dans users.');
  }

  const buyerHandle = getNormalizedUserHandle(buyer);
  const sellerHandle = getNormalizedUserHandle(seller);
  const senderHandle = getNormalizedUserHandle(sender);

  const safeBuyerHandle = buyerHandle || normalizeHandle(buyerIdLogin);
  const safeSellerHandle = sellerHandle || normalizeHandle(sellerIdLogin);
  const safeSenderHandle = senderHandle
    || (senderIdLogin === buyerIdLogin ? safeBuyerHandle : '')
    || (senderIdLogin === sellerIdLogin ? safeSellerHandle : '')
    || safeBuyerHandle;

  const participants = [buyerIdLogin, sellerIdLogin]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .sort();
  const transactionSuffix = transactionId ? `__tx__${transactionId}` : '';
  const conversationId = `${participants.join('__')}${transactionSuffix}`;
  const now = Date.now();
  const initialText = transactionId
    ? `Conversation démarrée pour la transaction ${transactionId}`
    : 'Conversation démarrée';

  let created = false;

  if (adminDb) {
    const convRef = adminDb.collection('conversations').doc(conversationId);
    const convDoc = await convRef.get();

    if (!convDoc.exists) {
      await convRef.set({
        participants,
        transactionId,
        lastMessage: initialText,
        lastMessageAt: now,
        lastMessageSenderId: safeSenderHandle,
        createdAt: now
      });

      await convRef.collection('messages').add({
        senderId: safeSenderHandle,
        text: initialText,
        createdAt: now,
        type: 'text',
        seenBy: [safeSenderHandle]
      });

      created = true;
    } else {
      await convRef.set({
        participants,
        transactionId,
        lastMessageAt: now
      }, { merge: true });
    }
  }

  const conversations = await readConversationsFile();
  const existingIndex = conversations.findIndex(c => String(c.id || '').trim() === conversationId);

  if (existingIndex === -1) {
    conversations.push({
      id: conversationId,
      participants,
      transactionId,
      lastMessage: initialText,
      lastMessageAt: now,
      lastMessageSenderId: safeSenderHandle,
      createdAt: now,
      messages: [{
        id: `msg-${now}`,
        senderId: safeSenderHandle,
        text: initialText,
        createdAt: now,
        type: 'text',
        seenBy: [safeSenderHandle]
      }]
    });
    await writeConversationsFile(conversations);
    created = true;
  } else {
    conversations[existingIndex].participants = participants;
    conversations[existingIndex].transactionId = transactionId;
    await writeConversationsFile(conversations);
  }

  return { conversationId, created, participants, senderHandle: safeSenderHandle };
}

function buildContractPdfBuffer({ transaction, buyer, seller }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 42, size: 'A4' });
    const chunks = [];

    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const tx = transaction || {};
    const createdAt = toMillis(tx.datecreation) ?? Date.now();
    const title = String(tx.titre || 'Transaction').trim();

    const writeLine = (label, value) => {
      doc.font('Helvetica-Bold').fontSize(10).text(`${label}: `, { continued: true });
      doc.font('Helvetica').fontSize(10).text(String(value || '-'));
    };

    doc.font('Helvetica-Bold').fontSize(18).text('Contrat de transaction OFM', { align: 'center' });
    doc.moveDown(0.7);
    doc.font('Helvetica').fontSize(10).text(`Document généré le ${new Date().toLocaleString('fr-FR')}`, { align: 'center' });
    doc.moveDown(1);

    doc.font('Helvetica-Bold').fontSize(13).text('Informations transaction');
    doc.moveDown(0.4);
    writeLine('ID transaction', tx.id || tx.dbTransactionId || '-');
    writeLine('Titre', title);
    writeLine('Statut', tx.statut || '-');
    writeLine('Crypto paiement', tx.cryptopaiement || '-');
    writeLine('Montant', `${Number(tx.montant || 0).toFixed(2)} €`);
    writeLine('Période de garantie', `${Number(tx.garantieperiode || 0)} heures`);
    writeLine('Date création', new Date(createdAt).toLocaleString('fr-FR'));
    writeLine('Initiateur (id_login)', tx.initiateur || '-');
    writeLine('Wallet vendeur EVM', tx.walletVendeurEvm || '-');
    writeLine('Wallet vendeur Phantom', tx.walletVendeurPhantom || '-');
    doc.moveDown(1);

    doc.font('Helvetica-Bold').fontSize(13).text('Engagement acheteur');
    doc.moveDown(0.4);
    writeLine('Texte', tx.engagementAcheteur || '-');
    doc.moveDown(1);

    doc.font('Helvetica-Bold').fontSize(13).text('Engagement vendeur');
    doc.moveDown(0.4);
    writeLine('Texte', tx.engagementVendeur || '-');
    doc.moveDown(1);

    doc.font('Helvetica-Bold').fontSize(13).text('Informations acheteur');
    doc.moveDown(0.4);
    writeLine('Nom', getUserDisplayName(buyer, tx.acheteur_name || tx.acheteur));
    writeLine('Email', getUserEmail(buyer, ''));
    writeLine('Handle', String(buyer?.handle || '').trim() ? `@${normalizeHandle(buyer?.handle)}` : '-');
    writeLine('Réputation', String(buyer?.['réputation'] ?? buyer?.reputation ?? '-'));
    doc.moveDown(1);

    doc.font('Helvetica-Bold').fontSize(13).text('Informations vendeur');
    doc.moveDown(0.4);
    writeLine('Nom', getUserDisplayName(seller, tx.vendeur_name || tx.vendeur));
    writeLine('Email', getUserEmail(seller, ''));
    writeLine('Handle', String(seller?.handle || '').trim() ? `@${normalizeHandle(seller?.handle)}` : '-');
    writeLine('Réputation', String(seller?.['réputation'] ?? seller?.reputation ?? '-'));
    doc.moveDown(1.2);

    doc.font('Helvetica').fontSize(9).fillColor('#444444').text('Ce document est généré automatiquement lors du passage à l\'étape "Signer contrat".', { align: 'left' });
    doc.end();
  });
}

function dataUrlToBuffer(dataUrl) {
  const raw = String(dataUrl || '').trim();
  if (!raw.startsWith('data:image/')) {
    throw new Error('Signature invalide (format image attendu).');
  }
  const base64Part = raw.includes(',') ? raw.split(',').pop() : '';
  if (!base64Part) {
    throw new Error('Signature invalide (données manquantes).');
  }
  return Buffer.from(base64Part, 'base64');
}

function buildSignedContractPdfBuffer({ transaction, buyer, seller, buyerSignatureBuffer, sellerSignatureBuffer, proofHash }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 42, size: 'A4' });
    const chunks = [];

    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const tx = transaction || {};
    const createdAt = toMillis(tx.datecreation) ?? Date.now();
    const writeLine = (label, value) => {
      doc.font('Helvetica-Bold').fontSize(10).text(`${label}: `, { continued: true });
      doc.font('Helvetica').fontSize(10).text(String(value || '-'));
    };

    doc.font('Helvetica-Bold').fontSize(18).text('Contrat signé OFM', { align: 'center' });
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(10).text(`Signé le ${new Date().toLocaleString('fr-FR')}`, { align: 'center' });
    doc.moveDown(1);

    doc.font('Helvetica-Bold').fontSize(13).text('Informations transaction');
    doc.moveDown(0.35);
    writeLine('ID transaction', tx.id || tx.dbTransactionId || '-');
    writeLine('Titre', tx.titre || 'Transaction');
    writeLine('Statut', tx.statut || 'Signer contrat');
    writeLine('Crypto paiement', tx.cryptopaiement || '-');
    writeLine('Montant', `${Number(tx.montant || 0).toFixed(2)} €`);
    writeLine('Période de garantie', `${Number(tx.garantieperiode || 0)} heures`);
    writeLine('Date création', new Date(createdAt).toLocaleString('fr-FR'));
    writeLine('Initiateur (id_login)', tx.initiateur || '-');
    writeLine('Wallet vendeur EVM', tx.walletVendeurEvm || '-');
    writeLine('Wallet vendeur Phantom', tx.walletVendeurPhantom || '-');
    doc.moveDown(1);

    doc.font('Helvetica-Bold').fontSize(13).text('Engagement acheteur');
    doc.moveDown(0.35);
    writeLine('Texte', tx.engagementAcheteur || '-');
    doc.moveDown(1);

    doc.font('Helvetica-Bold').fontSize(13).text('Engagement vendeur');
    doc.moveDown(0.35);
    writeLine('Texte', tx.engagementVendeur || '-');
    doc.moveDown(1);

    doc.font('Helvetica-Bold').fontSize(13).text('Informations acheteur');
    doc.moveDown(0.35);
    writeLine('Nom', getUserDisplayName(buyer, tx.acheteur_name || tx.acheteur));
    writeLine('Email', getUserEmail(buyer, ''));
    writeLine('Handle', String(buyer?.handle || '').trim() ? `@${normalizeHandle(buyer?.handle)}` : '-');
    writeLine('Réputation', String(buyer?.['réputation'] ?? buyer?.reputation ?? '-'));
    doc.moveDown(1);

    doc.font('Helvetica-Bold').fontSize(13).text('Informations vendeur');
    doc.moveDown(0.35);
    writeLine('Nom', getUserDisplayName(seller, tx.vendeur_name || tx.vendeur));
    writeLine('Email', getUserEmail(seller, ''));
    writeLine('Handle', String(seller?.handle || '').trim() ? `@${normalizeHandle(seller?.handle)}` : '-');
    writeLine('Réputation', String(seller?.['réputation'] ?? seller?.reputation ?? '-'));
    doc.moveDown(0.9);

    doc.font('Helvetica-Bold').fontSize(12).text('Signature Acheteur');
    doc.moveDown(0.2);
    doc.image(buyerSignatureBuffer, { fit: [260, 95], align: 'left' });
    doc.moveDown(0.9);

    doc.font('Helvetica-Bold').fontSize(12).text('Signature Vendeur');
    doc.moveDown(0.2);
    doc.image(sellerSignatureBuffer, { fit: [260, 95], align: 'left' });
    doc.moveDown(0.9);

    doc.font('Helvetica-Bold').fontSize(11).text('Preuve juridique (hash blockchain)');
    doc.moveDown(0.25);
    doc.font('Helvetica').fontSize(9).text(`Hash: ${proofHash}`);
    doc.font('Helvetica').fontSize(9).text('Empreinte cryptographique ancrée pour preuve d\'intégrité documentaire.');

    doc.end();
  });
}

async function appendConversationMessage({ conversationId, message, lastMessage, lastMessageSenderId }) {
  let found = false;

  if (adminDb) {
    const convRef = adminDb.collection('conversations').doc(conversationId);
    const convDoc = await convRef.get();
    if (convDoc.exists) {
      const newDoc = await convRef.collection('messages').add(message);
      await convRef.update({
        lastMessage,
        lastMessageAt: message.createdAt,
        lastMessageSenderId
      });
      message.id = newDoc.id;
      found = true;
    }
  }

  const conversations = await readConversationsFile();
  const index = conversations.findIndex(c => String(c.id || '').trim() === conversationId);
  if (index >= 0) {
    const localMessage = { id: message.id || `msg-${message.createdAt}`, ...message };
    const currentMessages = Array.isArray(conversations[index].messages) ? conversations[index].messages : [];
    conversations[index].messages = [...currentMessages, localMessage];
    conversations[index].lastMessage = lastMessage;
    conversations[index].lastMessageAt = message.createdAt;
    conversations[index].lastMessageSenderId = lastMessageSenderId;
    await writeConversationsFile(conversations);
    found = true;
  }

  if (!found) {
    throw new Error('Conversation introuvable.');
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'ofm-escrow-pro-backend' });
});

app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    let users = [];

    if (adminDb) {
      const snapshot = await adminDb.collection('users').get();
      users = await Promise.all(snapshot.docs.map(async (doc) => {
        const userData = { id: doc.id, ...doc.data() };
        try {
          const affiliationsSnapshot = await adminDb
            .collection('users')
            .doc(doc.id)
            .collection('affiliations')
            .orderBy('dateDébut', 'desc')
            .get();

          userData.affiliations = affiliationsSnapshot.docs
            .map(affDoc => normalizeAffiliationRecord({ id: affDoc.id, ...affDoc.data() }));
        } catch (_error) {
          userData.affiliations = Array.isArray(userData.affiliations)
            ? userData.affiliations.map(item => normalizeAffiliationRecord(item))
            : [];
        }
        return userData;
      }));
    }

    const localUsers = await readUsersFile();
    if (users.length === 0) {
      users = localUsers;
    } else {
      const existingIds = new Set(users.map(u => String(u.id_login || u.id || '')));
      localUsers.forEach(u => {
        const uid = String(u.id_login || u.id || '');
        if (uid && !existingIds.has(uid)) users.push(u);
      });
    }

    return res.json({ ok: true, users });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur lecture utilisateurs.', error: error.message });
  }
});

app.get('/api/users/handle/:handle', async (req, res) => {
  try {
    const normalized = normalizeHandle(req.params.handle);

    if (!normalized) {
      return res.status(400).json({ ok: false, message: 'Handle manquant.' });
    }

    if (adminDb) {
      const snapshot = await adminDb
        .collection('users')
        .where('handle', '==', normalized)
        .limit(1)
        .get();

      if (!snapshot.empty) {
        const doc = snapshot.docs[0];
        return res.json({ ok: true, user: { id: doc.id, ...doc.data() } });
      }
    }

    const users = await readUsersFile();

    const user = users.find(u => String(u.handle || '').toLowerCase() === normalized.toLowerCase());

    if (!user) {
      return res.status(404).json({ ok: false, message: 'Utilisateur introuvable.' });
    }

    return res.json({ ok: true, user });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur backend users.', error: error.message });
  }
});

app.get('/api/users/id-login/:idLogin', async (req, res) => {
  try {
    const idLogin = String(req.params.idLogin || '').trim();
    if (!idLogin) {
      return res.status(400).json({ ok: false, message: 'id_login manquant.' });
    }

    if (adminDb) {
      const doc = await adminDb.collection('users').doc(idLogin).get();
      if (doc.exists) {
        const userData = { id: doc.id, ...doc.data() };
        const affiliationsSnapshot = await adminDb
          .collection('users')
          .doc(idLogin)
          .collection('affiliations')
          .orderBy('dateDébut', 'desc')
          .get();

        userData.affiliations = affiliationsSnapshot.docs
          .map(affDoc => normalizeAffiliationRecord({ id: affDoc.id, ...affDoc.data() }));
        return res.json({ ok: true, user: userData });
      }

      const snapshot = await adminDb
        .collection('users')
        .where('id_login', '==', idLogin)
        .limit(1)
        .get();

      if (!snapshot.empty) {
        const found = snapshot.docs[0];
        const userData = { id: found.id, ...found.data() };
        const affiliationsSnapshot = await adminDb
          .collection('users')
          .doc(found.id)
          .collection('affiliations')
          .orderBy('dateDébut', 'desc')
          .get();

        userData.affiliations = affiliationsSnapshot.docs
          .map(affDoc => normalizeAffiliationRecord({ id: affDoc.id, ...affDoc.data() }));
        return res.json({ ok: true, user: userData });
      }
    }

    const users = await readUsersFile();
    const user = users.find(u => String(u.id_login || u.id || '').trim() === idLogin);

    if (!user) {
      return res.status(404).json({ ok: false, message: 'Utilisateur introuvable.' });
    }

    return res.json({ ok: true, user });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur lecture utilisateur.', error: error.message });
  }
});

app.post('/api/users', requireAuth, async (req, res) => {
  try {
    const name = String(req.body?.Name || '').trim();
    const normalizedHandle = normalizeHandle(req.body?.handle);
    const normalizedReferralRaw = normalizeHandle(req.body?.parrainHandle || req.body?.codeParrain || '');
    const normalizedReferral = normalizedReferralRaw || DEFAULT_REFERRAL_HANDLE;
    const idLogin = String(req.body?.id_login || req.body?.id || '').trim();
    const mail = String(req.body?.mail || req.body?.email || '').trim();
    const reputationValue = Number(req.body?.['réputation'] ?? 100);

    if (!name || !normalizedHandle || !idLogin || !mail) {
      return res.status(400).json({ ok: false, message: 'Champs requis manquants (Name, handle, id_login, mail).' });
    }
    if (idLogin !== String(req.callerUid || '').trim()) {
      return res.status(403).json({ ok: false, message: 'id_login doit correspondre à l\'utilisateur authentifié.' });
    }

    const users = await readUsersFile();

    if (adminDb) {
      const existingFirestore = await adminDb
        .collection('users')
        .where('handle', '==', normalizedHandle)
        .limit(1)
        .get();

      if (!existingFirestore.empty) {
        return res.status(409).json({ ok: false, message: 'Handle déjà utilisé.' });
      }
    }

    const exists = users.some(
      user => String(user.handle || '').toLowerCase() === normalizedHandle.toLowerCase()
    );
    if (exists) {
      return res.status(409).json({ ok: false, message: 'Handle déjà utilisé.' });
    }

    if (normalizedReferral) {
      if (normalizedReferral === normalizedHandle) {
        return res.status(400).json({ ok: false, message: 'Le code parrain ne peut pas être votre propre handle.' });
      }

      let referralExists = false;

      if (adminDb) {
        const referralFirestore = await adminDb
          .collection('users')
          .where('handle', '==', normalizedReferral)
          .limit(1)
          .get();

        referralExists = !referralFirestore.empty;
      }

      if (!referralExists) {
        referralExists = users.some(
          user => String(user.handle || '').toLowerCase() === normalizedReferral.toLowerCase()
        );
      }

      if (!referralExists) {
        return res.status(400).json({ ok: false, message: 'Code parrain invalide: handle introuvable.' });
      }
    }

    const newUser = {
      id: idLogin,
      handle: normalizedHandle,
      parrainHandle: normalizedReferral,
      email: mail,
      Name: name,
      id_login: idLogin,
      mail,
      'réputation': 100,
      affiliations: []
    };

    if (adminDb) {
      await adminDb.collection('users').doc(idLogin).set({
        Name: newUser.Name,
        handle: newUser.handle,
        parrainHandle: newUser.parrainHandle,
        id_login: newUser.id_login,
        mail: newUser.mail,
        réputation: newUser['réputation']
      });

      if (newUser.parrainHandle) {
        await adminDb
          .collection('users')
          .doc(idLogin)
          .collection('affiliations')
          .doc('active')
          .set({
            parrainHandle: newUser.parrainHandle,
            'dateDébut': admin.firestore.FieldValue.serverTimestamp(),
            'dateFin': null
          }, { merge: true });
      }
    }

    const existsById = users.some(user => String(user.id || user.id_login || '') === idLogin);
    if (!existsById) {
      users.push(newUser);
      await writeUsersFile(users);
    }

    if (normalizedReferral) {
      await upsertUserAffiliation({ idLogin, parrainHandle: normalizedReferral });
    }

    return res.status(201).json({ ok: true, user: newUser });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur création utilisateur backend.', error: error.message });
  }
});

app.patch('/api/users/:idLogin/profile', async (req, res) => {
  try {
    const idLogin = String(req.params.idLogin || '').trim();
    const parrainHandleRaw = String(req.body?.parrainHandle || '').trim();
    const normalizedReferral = normalizeHandle(parrainHandleRaw);

    if (!idLogin) {
      return res.status(400).json({ ok: false, message: 'id_login manquant.' });
    }

    let currentUser = null;
    if (adminDb) {
      const userDoc = await adminDb.collection('users').doc(idLogin).get();
      if (userDoc.exists) {
        currentUser = { id: userDoc.id, ...userDoc.data() };
      }
    }

    if (!currentUser) {
      const users = await readUsersFile();
      currentUser = users.find(u => String(u.id_login || u.id || '').trim() === idLogin) || null;
    }

    if (!currentUser) {
      return res.status(404).json({ ok: false, message: 'Utilisateur introuvable.' });
    }

    if (!normalizedReferral) {
      return res.status(400).json({ ok: false, message: 'Code parrain manquant.' });
    }

    const currentHandle = normalizeHandle(currentUser.handle || '');
    if (normalizedReferral === currentHandle) {
      return res.status(400).json({ ok: false, message: 'Le code parrain ne peut pas être votre propre handle.' });
    }

    let referralExists = false;

    if (adminDb) {
      const refSnapshot = await adminDb
        .collection('users')
        .where('handle', '==', normalizedReferral)
        .limit(1)
        .get();
      referralExists = !refSnapshot.empty;
    }

    if (!referralExists) {
      const users = await readUsersFile();
      referralExists = users.some(u => normalizeHandle(u.handle || '') === normalizedReferral);
    }

    if (!referralExists) {
      return res.status(400).json({ ok: false, message: 'Code parrain invalide: handle introuvable.' });
    }

    if (adminDb) {
      await adminDb.collection('users').doc(idLogin).set({
        parrainHandle: normalizedReferral
      }, { merge: true });
    }

    const users = await readUsersFile();
    const idx = users.findIndex(u => String(u.id_login || u.id || '').trim() === idLogin);
    if (idx >= 0) {
      users[idx].parrainHandle = normalizedReferral;
      await writeUsersFile(users);
    }

    await upsertUserAffiliation({ idLogin, parrainHandle: normalizedReferral });

    return res.json({ ok: true, idLogin, parrainHandle: normalizedReferral });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur mise à jour profil utilisateur.', error: error.message });
  }
});

app.get('/api/app-settings', async (_req, res) => {
  try {
    if (!adminDb) {
      return res.status(503).json({ ok: false, message: 'Firestore indisponible.' });
    }
    const settings = await getEffectiveAppSettings();
    const updatedAt = _appSettingsCache.fetchedAt || Date.now();
    return res.json({ ok: true, settings: { ...settings, updatedAt } });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur lecture paramètres application.', error: error.message });
  }
});

app.put('/api/app-settings', requireAdmin, async (req, res) => {
  try {
    if (!adminDb) {
      return res.status(503).json({ ok: false, message: 'Firestore indisponible.' });
    }

    const sanitized = sanitizeAppSettings(req.body || {});
    const payload = {
      ...sanitized,
      updatedAt: Date.now(),
      updatedBy: req.callerUid || null
    };

    await adminDb.collection(APP_SETTINGS_COLLECTION).doc(APP_SETTINGS_DOC_ID).set(payload, { merge: true });
    _appSettingsCache.settings = { ...sanitized };
    _appSettingsCache.fetchedAt = Date.now();
    return res.json({ ok: true, settings: payload });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur sauvegarde paramètres application.', error: error.message });
  }
});

app.post('/api/transactions/calculate-fees', async (_req, res) => {
  try {
    const sellerAmount = Number(_req.body?.sellerAmount);
    if (!Number.isFinite(sellerAmount) || sellerAmount <= 0) {
      return res.status(400).json({ ok: false, message: 'sellerAmount invalide (nombre positif attendu).' });
    }
    const settings = await getEffectiveAppSettings();
    const commissionPct = Number(settings.commissionStandardPct);
    const commissionRate = Number.isFinite(commissionPct) && commissionPct >= 0 ? commissionPct / 100 : 0.075;
    const commission = Number((sellerAmount * commissionRate).toFixed(2));
    const totalAmount = Number((sellerAmount + commission).toFixed(2));
    return res.json({ ok: true, sellerAmount, commission, commissionPct, totalAmount });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur calcul frais.', error: error.message });
  }
});

app.post('/api/transactions', async (req, res) => {
  try {
    const buyerIdLogin = String(req.body?.buyerIdLogin || '').trim();
    const buyerNameFromRequest = String(req.body?.buyerName || '').trim();
    const buyerMailFromRequest = String(req.body?.buyerMail || '').trim();
    const counterpartyHandle = normalizeHandle(req.body?.counterpartyHandle);
    const titre = String(req.body?.titre || '').trim();
    const cryptopaiement = String(req.body?.cryptopaiement || '').trim();
    const normalizedCrypto = cryptopaiement.toUpperCase();
    const platformMeta = normalizeBlockchainPlatform(req.body?.blockchainPlatform || req.body?.plateformeBlockchain || req.body?.network);
    const sellerAmountRaw = Number(req.body?.sellerAmount);
    const montantRaw = Number(req.body?.montant);
    const garantieperiode = Number(req.body?.garantieperiode);
    const isBuyerRole = req.body?.isBuyerRole !== false;

    if (!buyerIdLogin || !counterpartyHandle || !titre || !cryptopaiement) {
      return res.status(400).json({ ok: false, message: 'Champs requis manquants (buyerIdLogin, counterpartyHandle, titre, cryptopaiement).' });
    }
    if (normalizedCrypto !== 'SOL') {
      return res.status(400).json({ ok: false, message: 'Seules les transactions SOL sont autorisées.' });
    }

    // Prefer server-side fee computation when sellerAmount is provided
    let montant;
    if (Number.isFinite(sellerAmountRaw) && sellerAmountRaw > 0) {
      const settings = await getEffectiveAppSettings();
      const commissionPct = Number(settings.commissionStandardPct);
      const commissionRate = Number.isFinite(commissionPct) && commissionPct >= 0 ? commissionPct / 100 : 0.075;
      montant = Number((sellerAmountRaw + sellerAmountRaw * commissionRate).toFixed(2));
    } else {
      montant = montantRaw;
    }

    if (!Number.isFinite(montant) || montant <= 0) {
      return res.status(400).json({ ok: false, message: 'Montant invalide (fournissez sellerAmount ou montant).' });
    }
    if (!Number.isFinite(garantieperiode) || garantieperiode <= 0) {
      return res.status(400).json({ ok: false, message: 'Période de garantie invalide.' });
    }

    let buyerUser = null;
    let counterpartyUser = null;

    if (adminDb) {
      const buyerDoc = await adminDb.collection('users').doc(buyerIdLogin).get();
      if (buyerDoc.exists) buyerUser = { id: buyerDoc.id, ...buyerDoc.data() };

      const counterpartySnapshot = await adminDb
        .collection('users')
        .where('handle', '==', counterpartyHandle)
        .limit(1)
        .get();

      if (!counterpartySnapshot.empty) {
        const doc = counterpartySnapshot.docs[0];
        counterpartyUser = { id: doc.id, ...doc.data() };
      }
    }

    const users = await readUsersFile();

    if (!buyerUser) {
      const fallbackBuyer = users.find(u => String(u.id_login || u.id || '').trim() === buyerIdLogin);
      if (fallbackBuyer) buyerUser = fallbackBuyer;
    }

    if (!counterpartyUser) {
      const fallbackCounterparty = users.find(u => normalizeHandle(u.handle) === counterpartyHandle);
      if (fallbackCounterparty) counterpartyUser = fallbackCounterparty;
    }

    if (!buyerUser) {
      const autoBuyer = {
        id: buyerIdLogin,
        id_login: buyerIdLogin,
        Name: buyerNameFromRequest || buyerIdLogin,
        mail: buyerMailFromRequest || '',
        email: buyerMailFromRequest || ''
      };

      if (adminDb) {
        await adminDb.collection('users').doc(buyerIdLogin).set({
          id_login: autoBuyer.id_login,
          Name: autoBuyer.Name,
          mail: autoBuyer.mail,
          email: autoBuyer.email
        }, { merge: true });
      }

      const existsById = users.some(u => String(u.id_login || u.id || '').trim() === buyerIdLogin);
      if (!existsById) {
        users.push(autoBuyer);
        await writeUsersFile(users);
      }

      buyerUser = autoBuyer;
    }
    if (!counterpartyUser) {
      return res.status(404).json({ ok: false, message: 'Contrepartie introuvable dans users (handle).' });
    }

    const buyerIdFromUsers = String(buyerUser.id_login || buyerUser.id || '').trim();
    const counterpartyIdFromUsers = String(counterpartyUser.id_login || counterpartyUser.id || '').trim();

    if (!buyerIdFromUsers || !counterpartyIdFromUsers) {
      return res.status(400).json({ ok: false, message: 'id_login manquant dans users.' });
    }

    const now = Date.now();
    const transactionPayload = {
      initiateur: buyerIdLogin,
      acheteur: isBuyerRole ? buyerIdFromUsers : counterpartyIdFromUsers,
      vendeur: isBuyerRole ? counterpartyIdFromUsers : buyerIdFromUsers,
      titre,
      cryptopaiement: normalizedCrypto,
      blockchainPlatform: platformMeta.key,
      network: platformMeta.network,
      montant,
      garantieperiode,
      guaranteeStartedAt: null,
      guaranteeExpiresAt: null,
      engagementAcheteur: '',
      engagementVendeur: '',
      statut: 'En attente',
      datecreation: now
    };

    let transactionId = `TX-${Date.now()}`;
    if (adminDb) {
      const docRef = await adminDb.collection('transactions').add(transactionPayload);
      transactionId = docRef.id;
    }

    const transactions = await readTransactionsFile();
    transactions.push({ id: transactionId, ...transactionPayload });
    await writeTransactionsFile(transactions);

    return res.status(201).json({ ok: true, transaction: { id: transactionId, ...transactionPayload } });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur création transaction.', error: error.message });
  }
});

app.get('/api/transactions', requireAuth, async (req, res) => {
  try {
    const userIdLogin = String(req.query?.userIdLogin || '').trim();
    const callerUid = String(req.callerUid || '').trim();
    const isAdmin = await resolveCallerIsAdmin(callerUid);

    if (!userIdLogin && !isAdmin) {
      return res.status(403).json({ ok: false, message: 'Accès refusé.' });
    }

    if (userIdLogin && !isAdmin && userIdLogin !== callerUid) {
      return res.status(403).json({ ok: false, message: 'Accès refusé.' });
    }

    let transactions = [];

    if (adminDb) {
      const snapshot = await adminDb.collection('transactions').get();
      transactions = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    }

    const localTransactions = await readTransactionsFile();
    if (transactions.length === 0) {
      transactions = localTransactions;
    } else {
      const existingIds = new Set(transactions.map(t => String(t.id)));
      localTransactions.forEach(tx => {
        if (!existingIds.has(String(tx.id))) transactions.push(tx);
      });
    }

    if (userIdLogin) {
      transactions = transactions.filter(tx =>
        String(tx.acheteur || '').trim() === userIdLogin ||
        String(tx.vendeur || '').trim() === userIdLogin
      );
    }

    const usersByIdLogin = new Map();

    if (adminDb) {
      const usersSnapshot = await adminDb.collection('users').get();
      usersSnapshot.docs.forEach(doc => {
        const data = doc.data() || {};
        const idLogin = String(data.id_login || doc.id || '').trim();
        if (!idLogin) return;
        const name = String(data.Name || data.mail || data.email || idLogin).trim();
        usersByIdLogin.set(idLogin, name);
      });
    }

    const localUsers = await readUsersFile();
    localUsers.forEach(user => {
      const idLogin = String(user.id_login || user.id || '').trim();
      if (!idLogin || usersByIdLogin.has(idLogin)) return;
      const name = String(user.Name || user.mail || user.email || idLogin).trim();
      usersByIdLogin.set(idLogin, name);
    });

    transactions = transactions.map(tx => {
      const acheteurId = String(tx.acheteur || '').trim();
      const vendeurId = String(tx.vendeur || '').trim();
      const datecreation = toMillis(tx.datecreation) ?? Date.now();
      const guaranteeStartedAt = toMillis(tx.guaranteeStartedAt) ?? null;
      const guaranteeExpiresAt = toMillis(tx.guaranteeExpiresAt) ?? null;

      return {
        ...tx,
        datecreation,
        guaranteeStartedAt,
        guaranteeExpiresAt,
        acheteur_name: usersByIdLogin.get(acheteurId) || acheteurId,
        vendeur_name: usersByIdLogin.get(vendeurId) || vendeurId
      };
    });

    return res.json({ ok: true, transactions });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur lecture transactions.', error: error.message });
  }
});

app.get('/api/transactions/:id', async (req, res) => {
  try {
    const transactionId = String(req.params.id || '').trim();
    if (!transactionId) {
      return res.status(400).json({ ok: false, message: 'ID transaction manquant.' });
    }

    let transaction = null;

    if (adminDb) {
      const doc = await adminDb.collection('transactions').doc(transactionId).get();
      if (doc.exists) {
        transaction = { id: doc.id, ...doc.data() };
      }
    }

    if (!transaction) {
      const localTransactions = await readTransactionsFile();
      transaction = localTransactions.find(tx => String(tx.id || '').trim() === transactionId) || null;
    }

    if (!transaction) {
      return res.status(404).json({ ok: false, message: 'Transaction introuvable.' });
    }

    const usersByIdLogin = new Map();

    if (adminDb) {
      const usersSnapshot = await adminDb.collection('users').get();
      usersSnapshot.docs.forEach(doc => {
        const data = doc.data() || {};
        const idLogin = String(data.id_login || doc.id || '').trim();
        if (!idLogin) return;
        const name = String(data.Name || data.mail || data.email || idLogin).trim();
        usersByIdLogin.set(idLogin, name);
      });
    }

    const localUsers = await readUsersFile();
    localUsers.forEach(user => {
      const idLogin = String(user.id_login || user.id || '').trim();
      if (!idLogin || usersByIdLogin.has(idLogin)) return;
      const name = String(user.Name || user.mail || user.email || idLogin).trim();
      usersByIdLogin.set(idLogin, name);
    });

    const acheteurId = String(transaction.acheteur || '').trim();
    const vendeurId = String(transaction.vendeur || '').trim();

    const enrichedTransaction = {
      ...transaction,
      datecreation: toMillis(transaction.datecreation) ?? Date.now(),
      guaranteeStartedAt: toMillis(transaction.guaranteeStartedAt) ?? null,
      guaranteeExpiresAt: toMillis(transaction.guaranteeExpiresAt) ?? null,
      acheteur_name: usersByIdLogin.get(acheteurId) || acheteurId,
      vendeur_name: usersByIdLogin.get(vendeurId) || vendeurId
    };

    return res.json({ ok: true, transaction: enrichedTransaction });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur lecture transaction.', error: error.message });
  }
});

app.patch('/api/transactions/:id/dispute-seen', async (req, res) => {
  try {
    const transactionId = String(req.params.id || '').trim();
    if (!transactionId) {
      return res.status(400).json({ ok: false, message: 'ID transaction manquant.' });
    }

    let updated = false;

    if (adminDb) {
      const docRef = adminDb.collection('transactions').doc(transactionId);
      const doc = await docRef.get();
      if (doc.exists) {
        await docRef.update({ disputeSeenByAdmin: true });
        updated = true;
      }
    }

    const localTransactions = await readTransactionsFile();
    const idx = localTransactions.findIndex(tx => String(tx.id || '').trim() === transactionId);
    if (idx >= 0) {
      localTransactions[idx].disputeSeenByAdmin = true;
      await writeTransactionsFile(localTransactions);
      updated = true;
    }

    if (!updated) {
      return res.status(404).json({ ok: false, message: 'Transaction introuvable.' });
    }

    return res.json({ ok: true, id: transactionId, disputeSeenByAdmin: true });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur mise à jour dispute-seen.', error: error.message });
  }
});

app.patch('/api/transactions/:id/statut', async (req, res) => {
  try {
    const transactionId = String(req.params.id || '').trim();
    const statut = String(req.body?.statut || '').trim();
    const guaranteeStartedAtRaw = req.body?.guaranteeStartedAt;
    const guaranteeExpiresAtRaw = req.body?.guaranteeExpiresAt;
    const guaranteeStartedAt = guaranteeStartedAtRaw === null || guaranteeStartedAtRaw === undefined || guaranteeStartedAtRaw === ''
      ? null
      : Number(guaranteeStartedAtRaw);
    const guaranteeExpiresAt = guaranteeExpiresAtRaw === null || guaranteeExpiresAtRaw === undefined || guaranteeExpiresAtRaw === ''
      ? null
      : Number(guaranteeExpiresAtRaw);
    const allowed = [
      'En attente',
      'Configurer',
      'Valider contrat',
      'Signer contrat',
      'Déposer les fonds',
      'Déposer les documents',
      'Garantie',
      'Noter',
      'Terminer',
      'Accepté',
      'Refusé',
      'LOCKED',
      'Litige',
      'RELEASED',
      'REFUNDED'
    ];

    if (!transactionId) {
      return res.status(400).json({ ok: false, message: 'ID transaction manquant.' });
    }

    if (!allowed.includes(statut)) {
      return res.status(400).json({ ok: false, message: 'Statut invalide.' });
    }

    if (guaranteeStartedAt !== null && (!Number.isFinite(guaranteeStartedAt) || guaranteeStartedAt <= 0)) {
      return res.status(400).json({ ok: false, message: 'guaranteeStartedAt invalide.' });
    }

    if (guaranteeExpiresAt !== null && (!Number.isFinite(guaranteeExpiresAt) || guaranteeExpiresAt <= 0)) {
      return res.status(400).json({ ok: false, message: 'guaranteeExpiresAt invalide.' });
    }

    if (guaranteeStartedAt !== null && guaranteeExpiresAt !== null && guaranteeExpiresAt <= guaranteeStartedAt) {
      return res.status(400).json({ ok: false, message: 'guaranteeExpiresAt doit être supérieur à guaranteeStartedAt.' });
    }

    const updatePayload = { statut };
    updatePayload.updatedAt = Date.now();
    if (guaranteeStartedAt !== null) updatePayload.guaranteeStartedAt = guaranteeStartedAt;
    if (guaranteeExpiresAt !== null) updatePayload.guaranteeExpiresAt = guaranteeExpiresAt;

    let updated = false;

    if (adminDb) {
      const docRef = adminDb.collection('transactions').doc(transactionId);
      const doc = await docRef.get();
      if (doc.exists) {
        await docRef.update(updatePayload);
        updated = true;
      }
    }

    const localTransactions = await readTransactionsFile();
    const idx = localTransactions.findIndex(tx => String(tx.id || '').trim() === transactionId);
    if (idx >= 0) {
      localTransactions[idx].statut = statut;
      if (guaranteeStartedAt !== null) localTransactions[idx].guaranteeStartedAt = guaranteeStartedAt;
      if (guaranteeExpiresAt !== null) localTransactions[idx].guaranteeExpiresAt = guaranteeExpiresAt;
      await writeTransactionsFile(localTransactions);
      updated = true;
    }

    if (!updated) {
      return res.status(404).json({ ok: false, message: 'Transaction introuvable.' });
    }

    return res.json({
      ok: true,
      id: transactionId,
      statut,
      guaranteeStartedAt: guaranteeStartedAt !== null ? guaranteeStartedAt : undefined,
      guaranteeExpiresAt: guaranteeExpiresAt !== null ? guaranteeExpiresAt : undefined
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur mise à jour statut transaction.', error: error.message });
  }
});

app.get('/api/transactions/:id/ratings', async (req, res) => {
  try {
    const transactionId = String(req.params.id || '').trim();
    if (!transactionId) {
      return res.status(400).json({ ok: false, message: 'ID transaction manquant.' });
    }

    let transaction = null;
    if (adminDb) {
      const doc = await adminDb.collection('transactions').doc(transactionId).get();
      if (doc.exists) {
        transaction = { id: doc.id, ...doc.data() };
      }
    }

    if (!transaction) {
      const localTransactions = await readTransactionsFile();
      transaction = localTransactions.find(tx => String(tx.id || '').trim() === transactionId) || null;
    }

    if (!transaction) {
      return res.status(404).json({ ok: false, message: 'Transaction introuvable.' });
    }

    const buyerIdLogin = String(transaction.acheteur || '').trim();
    const sellerIdLogin = String(transaction.vendeur || '').trim();
    if (!buyerIdLogin || !sellerIdLogin) {
      return res.status(400).json({ ok: false, message: 'Participants transaction incomplets.' });
    }

    let buyerToSeller = null;
    let sellerToBuyer = null;

    if (adminDb) {
      const buyerToSellerRef = adminDb
        .collection('users')
        .doc(sellerIdLogin)
        .collection('notations')
        .doc(buildNotationDocId(transactionId, buyerIdLogin));

      const sellerToBuyerRef = adminDb
        .collection('users')
        .doc(buyerIdLogin)
        .collection('notations')
        .doc(buildNotationDocId(transactionId, sellerIdLogin));

      const [buyerToSellerDoc, sellerToBuyerDoc] = await Promise.all([
        buyerToSellerRef.get(),
        sellerToBuyerRef.get()
      ]);

      if (buyerToSellerDoc.exists) {
        buyerToSeller = { id: buyerToSellerDoc.id, ...buyerToSellerDoc.data() };
      }
      if (sellerToBuyerDoc.exists) {
        sellerToBuyer = { id: sellerToBuyerDoc.id, ...sellerToBuyerDoc.data() };
      }
    }

    const users = await readUsersFile();
    const buyerUser = users.find(user => String(user.id_login || user.id || '').trim() === buyerIdLogin) || null;
    const sellerUser = users.find(user => String(user.id_login || user.id || '').trim() === sellerIdLogin) || null;

    if (!buyerToSeller && sellerUser && Array.isArray(sellerUser.notations)) {
      const localNote = sellerUser.notations.find(note =>
        String(note.transactionId || '').trim() === transactionId
        && String(note.fromIdLogin || '').trim() === buyerIdLogin
      );
      if (localNote) buyerToSeller = localNote;
    }

    if (!sellerToBuyer && buyerUser && Array.isArray(buyerUser.notations)) {
      const localNote = buyerUser.notations.find(note =>
        String(note.transactionId || '').trim() === transactionId
        && String(note.fromIdLogin || '').trim() === sellerIdLogin
      );
      if (localNote) sellerToBuyer = localNote;
    }

    return res.json({
      ok: true,
      transactionId,
      ratings: {
        buyerToSeller,
        sellerToBuyer
      }
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur lecture notations transaction.', error: error.message });
  }
});

app.post('/api/transactions/:id/ratings', requireAuth, async (req, res) => {
  try {
    const transactionId = String(req.params.id || '').trim();
    const fromIdLogin = req.callerUid;
    const score = toRatingValue(req.body?.score);
    const comment = sanitizeRatingComment(req.body?.comment);

    if (!transactionId) {
      return res.status(400).json({ ok: false, message: 'ID transaction manquant.' });
    }
    if (!fromIdLogin) {
      return res.status(400).json({ ok: false, message: 'fromIdLogin manquant.' });
    }
    if (score === null) {
      return res.status(400).json({ ok: false, message: 'La note doit être comprise entre 0 et 100.' });
    }
    if (!comment) {
      return res.status(400).json({ ok: false, message: 'Commentaire obligatoire.' });
    }

    let transaction = null;
    if (adminDb) {
      const doc = await adminDb.collection('transactions').doc(transactionId).get();
      if (doc.exists) {
        transaction = { id: doc.id, ...doc.data() };
      }
    }

    if (!transaction) {
      const localTransactions = await readTransactionsFile();
      transaction = localTransactions.find(tx => String(tx.id || '').trim() === transactionId) || null;
    }

    if (!transaction) {
      return res.status(404).json({ ok: false, message: 'Transaction introuvable.' });
    }

    const buyerIdLogin = String(transaction.acheteur || '').trim();
    const sellerIdLogin = String(transaction.vendeur || '').trim();

    if (!buyerIdLogin || !sellerIdLogin) {
      return res.status(400).json({ ok: false, message: 'Participants transaction incomplets.' });
    }

    let toIdLogin = '';
    let fromRole = '';
    if (fromIdLogin === buyerIdLogin) {
      toIdLogin = sellerIdLogin;
      fromRole = 'buyer';
    } else if (fromIdLogin === sellerIdLogin) {
      toIdLogin = buyerIdLogin;
      fromRole = 'seller';
    } else {
      return res.status(403).json({ ok: false, message: 'Utilisateur non autorisé à noter cette transaction.' });
    }

    const now = Date.now();
    const notationPayload = {
      transactionId,
      fromIdLogin,
      toIdLogin,
      fromRole,
      score,
      comment,
      updatedAt: now
    };

    const notationDocId = buildNotationDocId(transactionId, fromIdLogin);

    if (adminDb) {
      const notationRef = adminDb
        .collection('users')
        .doc(toIdLogin)
        .collection('notations')
        .doc(notationDocId);

      const existingDoc = await notationRef.get();
      if (existingDoc.exists) {
        await notationRef.set(notationPayload, { merge: true });
      } else {
        await notationRef.set({ ...notationPayload, createdAt: now }, { merge: true });
      }
    }

    const users = await readUsersFile();
    const receiverIdx = users.findIndex(user => String(user.id_login || user.id || '').trim() === toIdLogin);
    if (receiverIdx >= 0) {
      const notations = Array.isArray(users[receiverIdx].notations) ? users[receiverIdx].notations : [];
      const existingIdx = notations.findIndex(note =>
        String(note.transactionId || '').trim() === transactionId
        && String(note.fromIdLogin || '').trim() === fromIdLogin
      );

      if (existingIdx >= 0) {
        const createdAt = Number(notations[existingIdx].createdAt) || now;
        notations[existingIdx] = { ...notations[existingIdx], ...notationPayload, createdAt };
      } else {
        notations.push({ ...notationPayload, createdAt: now });
      }

      users[receiverIdx].notations = notations;
      await writeUsersFile(users);
    }

    const reputation = await recalculateUserReputation(toIdLogin);

    return res.json({
      ok: true,
      transactionId,
      fromIdLogin,
      toIdLogin,
      score,
      comment,
      reputation
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur enregistrement notation.', error: error.message });
  }
});

app.patch('/api/transactions/:id/montant', async (req, res) => {
  try {
    const transactionId = String(req.params.id || '').trim();
    const montant = Number(req.body?.montant);

    if (!transactionId) {
      return res.status(400).json({ ok: false, message: 'ID transaction manquant.' });
    }

    if (!Number.isFinite(montant) || montant <= 0) {
      return res.status(400).json({ ok: false, message: 'Montant invalide.' });
    }

    let updated = false;

    if (adminDb) {
      const docRef = adminDb.collection('transactions').doc(transactionId);
      const doc = await docRef.get();
      if (doc.exists) {
        await docRef.update({ montant });
        updated = true;
      }
    }

    const localTransactions = await readTransactionsFile();
    const idx = localTransactions.findIndex(tx => String(tx.id || '').trim() === transactionId);
    if (idx >= 0) {
      localTransactions[idx].montant = montant;
      await writeTransactionsFile(localTransactions);
      updated = true;
    }

    if (!updated) {
      return res.status(404).json({ ok: false, message: 'Transaction introuvable.' });
    }

    return res.json({ ok: true, id: transactionId, montant });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur mise à jour montant transaction.', error: error.message });
  }
});

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

app.patch('/api/transactions/:id/wallets', async (req, res) => {
  try {
    const transactionId = String(req.params.id || '').trim();
    const walletVendeurEvm = String(req.body?.walletVendeurEvm || '').trim();
    const walletVendeurPhantom = String(req.body?.walletVendeurPhantom || '').trim();

    if (!transactionId) {
      return res.status(400).json({ ok: false, message: 'ID transaction manquant.' });
    }
    if (walletVendeurEvm && !EVM_ADDRESS_RE.test(walletVendeurEvm)) {
      return res.status(400).json({ ok: false, message: 'Adresse EVM invalide (format attendu: 0x suivi de 40 caractères hexadécimaux).' });
    }
    if (walletVendeurPhantom && !SOLANA_ADDRESS_RE.test(walletVendeurPhantom)) {
      return res.status(400).json({ ok: false, message: 'Adresse Solana invalide (base58, 32-44 caractères).' });
    }

    let updated = false;

    if (adminDb) {
      const docRef = adminDb.collection('transactions').doc(transactionId);
      const doc = await docRef.get();
      if (doc.exists) {
        await docRef.update({
          walletVendeurEvm,
          walletVendeurPhantom
        });
        updated = true;
      }
    }

    const localTransactions = await readTransactionsFile();
    const idx = localTransactions.findIndex(tx => String(tx.id || '').trim() === transactionId);
    if (idx >= 0) {
      localTransactions[idx].walletVendeurEvm = walletVendeurEvm;
      localTransactions[idx].walletVendeurPhantom = walletVendeurPhantom;
      await writeTransactionsFile(localTransactions);
      updated = true;
    }

    if (!updated) {
      return res.status(404).json({ ok: false, message: 'Transaction introuvable.' });
    }

    return res.json({ ok: true, id: transactionId, walletVendeurEvm, walletVendeurPhantom });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur mise à jour wallets vendeur.', error: error.message });
  }
});

app.patch('/api/transactions/:id/solana-data', async (req, res) => {
  try {
    const transactionId = String(req.params.id || '').trim();
    const solanaPaymentId = String(req.body?.solanaPaymentId || '').trim();
    const funderPublicKey = String(req.body?.funderPublicKey || '').trim();
    const solanaTxSignature = String(req.body?.solanaTxSignature || '').trim();

    if (!transactionId) {
      return res.status(400).json({ ok: false, message: 'ID transaction manquant.' });
    }
    if (!solanaPaymentId) {
      return res.status(400).json({ ok: false, message: 'solanaPaymentId manquant.' });
    }
    if (!funderPublicKey || funderPublicKey.length < 32 || funderPublicKey.length > 44) {
      return res.status(400).json({ ok: false, message: 'funderPublicKey invalide.' });
    }

    const updatePayload = { solanaPaymentId, funderPublicKey };
    if (solanaTxSignature) updatePayload.solanaTxSignature = solanaTxSignature;

    let updated = false;

    if (adminDb) {
      const docRef = adminDb.collection('transactions').doc(transactionId);
      const doc = await docRef.get();
      if (doc.exists) {
        await docRef.update(updatePayload);
        updated = true;
      }
    }

    const localTransactions = await readTransactionsFile();
    const idx = localTransactions.findIndex(tx => String(tx.id || '').trim() === transactionId);
    if (idx >= 0) {
      Object.assign(localTransactions[idx], updatePayload);
      await writeTransactionsFile(localTransactions);
      updated = true;
    }

    if (!updated) {
      return res.status(404).json({ ok: false, message: 'Transaction introuvable.' });
    }

    return res.json({ ok: true, id: transactionId, solanaPaymentId, funderPublicKey, solanaTxSignature: solanaTxSignature || undefined });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur mise à jour données Solana.', error: error.message });
  }
});

app.patch('/api/transactions/:id/engagements', async (req, res) => {
  try {
    const transactionId = String(req.params.id || '').trim();
    const engagementAcheteur = String(req.body?.engagementAcheteur || '').trim();
    const engagementVendeur = String(req.body?.engagementVendeur || '').trim();

    if (!transactionId) {
      return res.status(400).json({ ok: false, message: 'ID transaction manquant.' });
    }

    let updated = false;

    if (adminDb) {
      const docRef = adminDb.collection('transactions').doc(transactionId);
      const doc = await docRef.get();
      if (doc.exists) {
        await docRef.update({
          engagementAcheteur,
          engagementVendeur
        });
        updated = true;
      }
    }

    const localTransactions = await readTransactionsFile();
    const idx = localTransactions.findIndex(tx => String(tx.id || '').trim() === transactionId);
    if (idx >= 0) {
      localTransactions[idx].engagementAcheteur = engagementAcheteur;
      localTransactions[idx].engagementVendeur = engagementVendeur;
      await writeTransactionsFile(localTransactions);
      updated = true;
    }

    if (!updated) {
      return res.status(404).json({ ok: false, message: 'Transaction introuvable.' });
    }

    return res.json({ ok: true, id: transactionId, engagementAcheteur, engagementVendeur });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur mise à jour engagements transaction.', error: error.message });
  }
});

app.patch('/api/transactions/:id/validation-contrat', async (req, res) => {
  try {
    const transactionId = String(req.params.id || '').trim();
    const validationAcheteur = !!req.body?.validationAcheteur;
    const validationVendeur = !!req.body?.validationVendeur;

    if (!transactionId) {
      return res.status(400).json({ ok: false, message: 'ID transaction manquant.' });
    }

    let updated = false;

    if (adminDb) {
      const docRef = adminDb.collection('transactions').doc(transactionId);
      const doc = await docRef.get();
      if (doc.exists) {
        await docRef.update({
          validationAcheteur,
          validationVendeur
        });
        updated = true;
      }
    }

    const localTransactions = await readTransactionsFile();
    const idx = localTransactions.findIndex(tx => String(tx.id || '').trim() === transactionId);
    if (idx >= 0) {
      localTransactions[idx].validationAcheteur = validationAcheteur;
      localTransactions[idx].validationVendeur = validationVendeur;
      await writeTransactionsFile(localTransactions);
      updated = true;
    }

    if (!updated) {
      return res.status(404).json({ ok: false, message: 'Transaction introuvable.' });
    }

    return res.json({ ok: true, id: transactionId, validationAcheteur, validationVendeur });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur mise à jour validation contrat.', error: error.message });
  }
});

app.post('/api/transactions/:id/generate-contract-pdf', async (req, res) => {
  try {
    const transactionId = String(req.params.id || '').trim();
    const senderIdLoginRaw = String(req.body?.senderIdLogin || '').trim();

    if (!transactionId) {
      return res.status(400).json({ ok: false, message: 'ID transaction manquant.' });
    }

    if (!adminStorageBucket) {
      return res.status(503).json({ ok: false, message: 'Firebase Storage Admin indisponible côté serveur.' });
    }

    let transaction = null;

    if (adminDb) {
      const doc = await adminDb.collection('transactions').doc(transactionId).get();
      if (doc.exists) {
        transaction = { id: doc.id, ...doc.data() };
      }
    }

    if (!transaction) {
      const localTransactions = await readTransactionsFile();
      transaction = localTransactions.find(tx => String(tx.id || '').trim() === transactionId) || null;
    }

    if (!transaction) {
      return res.status(404).json({ ok: false, message: 'Transaction introuvable.' });
    }

    const buyerIdLogin = String(transaction.acheteur || '').trim();
    const sellerIdLogin = String(transaction.vendeur || '').trim();
    const senderIdLogin = senderIdLoginRaw || buyerIdLogin || sellerIdLogin;

    if (!buyerIdLogin || !sellerIdLogin || !senderIdLogin) {
      return res.status(400).json({ ok: false, message: 'Participants transaction incomplets.' });
    }

    const usersMap = await resolveUsersByIdLogin([buyerIdLogin, sellerIdLogin, senderIdLogin]);
    const buyerUser = usersMap.get(buyerIdLogin) || null;
    const sellerUser = usersMap.get(sellerIdLogin) || null;

    const { conversationId, senderHandle } = await ensureConversationForTransactionData({
      transactionId,
      buyerIdLogin,
      sellerIdLogin,
      senderIdLogin
    });

    const pdfBuffer = await buildContractPdfBuffer({
      transaction,
      buyer: buyerUser,
      seller: sellerUser
    });

    const attachmentName = 'contrat.pdf';
    const objectPath = `conversations/${conversationId}/files/${Date.now()}_${attachmentName}`;

    const token = crypto.randomUUID();
    const file = adminStorageBucket.file(objectPath);
    await file.save(pdfBuffer, {
      contentType: 'application/pdf',
      resumable: false,
      metadata: {
        metadata: {
          firebaseStorageDownloadTokens: token,
          conversationId,
          transactionId,
          uploaderId: senderIdLogin,
          generatedType: 'contract-pdf'
        }
      }
    });

    const encodedPath = encodeURIComponent(objectPath);
    const reference = `https://firebasestorage.googleapis.com/v0/b/${adminStorageBucket.name}/o/${encodedPath}?alt=media&token=${token}`;

    const now = Date.now();
    const message = {
      senderId: senderHandle,
      text: 'Contrat généré automatiquement (étape Signer contrat).',
      createdAt: now,
      type: 'attachment',
      seenBy: [senderHandle],
      reference,
      attachmentName,
      attachmentType: 'application/pdf',
      attachmentSize: pdfBuffer.length
    };

    await appendConversationMessage({
      conversationId,
      message,
      lastMessage: `📎 ${attachmentName}`,
      lastMessageSenderId: senderHandle
    });

    if (adminDb) {
      const docRef = adminDb.collection('transactions').doc(transactionId);
      const doc = await docRef.get();
      if (doc.exists) {
        await docRef.update({
          contratPdfReference: reference,
          contratPdfName: attachmentName,
          contratPdfConversationId: conversationId,
          contratPdfGeneratedAt: now
        });
      }
    }

    const localTransactions = await readTransactionsFile();
    const idx = localTransactions.findIndex(tx => String(tx.id || '').trim() === transactionId);
    if (idx >= 0) {
      localTransactions[idx].contratPdfReference = reference;
      localTransactions[idx].contratPdfName = attachmentName;
      localTransactions[idx].contratPdfConversationId = conversationId;
      localTransactions[idx].contratPdfGeneratedAt = now;
      await writeTransactionsFile(localTransactions);
    }

    return res.status(201).json({
      ok: true,
      transactionId,
      conversationId,
      reference,
      attachmentName,
      attachmentType: 'application/pdf',
      attachmentSize: pdfBuffer.length
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur génération contrat PDF.', error: error.message });
  }
});

app.post('/api/transactions/:id/sign-contract', requireAuth, async (req, res) => {
  try {
    const transactionId = String(req.params.id || '').trim();
    const role = String(req.body?.role || '').trim().toLowerCase();
    const signatureDataUrl = String(req.body?.signatureDataUrl || '').trim();
    const senderIdLogin = req.callerUid;

    if (!transactionId || !role || !signatureDataUrl || !senderIdLogin) {
      return res.status(400).json({ ok: false, message: 'Champs requis manquants (transactionId, role, signatureDataUrl, senderIdLogin).' });
    }

    if (!['buyer', 'seller'].includes(role)) {
      return res.status(400).json({ ok: false, message: 'Rôle de signature invalide.' });
    }

    if (!adminStorageBucket) {
      return res.status(503).json({ ok: false, message: 'Firebase Storage Admin indisponible côté serveur.' });
    }

    let transaction = null;
    if (adminDb) {
      const doc = await adminDb.collection('transactions').doc(transactionId).get();
      if (doc.exists) transaction = { id: doc.id, ...doc.data() };
    }
    if (!transaction) {
      const localTransactions = await readTransactionsFile();
      transaction = localTransactions.find(tx => String(tx.id || '').trim() === transactionId) || null;
    }
    if (!transaction) {
      return res.status(404).json({ ok: false, message: 'Transaction introuvable.' });
    }

    const buyerIdLogin = String(transaction.acheteur || '').trim();
    const sellerIdLogin = String(transaction.vendeur || '').trim();

    if ((role === 'buyer' && senderIdLogin !== buyerIdLogin) || (role === 'seller' && senderIdLogin !== sellerIdLogin)) {
      return res.status(403).json({ ok: false, message: 'Utilisateur non autorisé à signer pour ce rôle.' });
    }

    const signatureBuffer = dataUrlToBuffer(signatureDataUrl);
    const signatureField = role === 'buyer' ? 'signatureAcheteurImage' : 'signatureVendeurImage';
    const signatureDateField = role === 'buyer' ? 'signatureAcheteurAt' : 'signatureVendeurAt';
    const now = Date.now();

    if (adminDb) {
      const docRef = adminDb.collection('transactions').doc(transactionId);
      const doc = await docRef.get();
      if (doc.exists) {
        await docRef.update({
          [signatureField]: signatureDataUrl,
          [signatureDateField]: now
        });
      }
    }

    const localTransactions = await readTransactionsFile();
    const idx = localTransactions.findIndex(tx => String(tx.id || '').trim() === transactionId);
    if (idx >= 0) {
      localTransactions[idx][signatureField] = signatureDataUrl;
      localTransactions[idx][signatureDateField] = now;
      await writeTransactionsFile(localTransactions);
      transaction = localTransactions[idx];
    } else {
      transaction = {
        ...transaction,
        [signatureField]: signatureDataUrl,
        [signatureDateField]: now
      };
    }

    const signatureAcheteurAt = toMillis(transaction.signatureAcheteurAt);
    const signatureVendeurAt = toMillis(transaction.signatureVendeurAt);

    let proofHash = String(transaction.preuveHashBlockchain || '').trim();
    let signedPdfReference = String(transaction.contratSignePdfReference || '').trim();
    let statut = String(transaction.statut || '').trim() || 'Signer contrat';

    if (signatureAcheteurAt && signatureVendeurAt) {
      const usersMap = await resolveUsersByIdLogin([buyerIdLogin, sellerIdLogin, senderIdLogin]);
      const buyerUser = usersMap.get(buyerIdLogin) || null;
      const sellerUser = usersMap.get(sellerIdLogin) || null;

      const { conversationId, senderHandle } = await ensureConversationForTransactionData({
        transactionId,
        buyerIdLogin,
        sellerIdLogin,
        senderIdLogin
      });

      const buyerSignatureBuffer = dataUrlToBuffer(transaction.signatureAcheteurImage || '');
      const sellerSignatureBuffer = dataUrlToBuffer(transaction.signatureVendeurImage || '');

      const preHashSeed = `${transactionId}|${signatureAcheteurAt}|${signatureVendeurAt}|${now}`;
      proofHash = crypto.createHash('sha256').update(preHashSeed).digest('hex');

      const signedPdfBuffer = await buildSignedContractPdfBuffer({
        transaction,
        buyer: buyerUser,
        seller: sellerUser,
        buyerSignatureBuffer,
        sellerSignatureBuffer,
        proofHash
      });

      proofHash = crypto.createHash('sha256').update(signedPdfBuffer).digest('hex');

      const attachmentName = 'contratsigne.pdf';
      const objectPath = `conversations/${conversationId}/files/${Date.now()}_${attachmentName}`;
      const token = crypto.randomUUID();
      const file = adminStorageBucket.file(objectPath);
      await file.save(signedPdfBuffer, {
        contentType: 'application/pdf',
        resumable: false,
        metadata: {
          metadata: {
            firebaseStorageDownloadTokens: token,
            conversationId,
            transactionId,
            uploaderId: senderIdLogin,
            generatedType: 'signed-contract-pdf',
            proofHash
          }
        }
      });

      const encodedPath = encodeURIComponent(objectPath);
      signedPdfReference = `https://firebasestorage.googleapis.com/v0/b/${adminStorageBucket.name}/o/${encodedPath}?alt=media&token=${token}`;
      statut = 'Déposer les fonds';

      const message = {
        senderId: senderHandle,
        text: `Contrat signé généré. Hash blockchain: ${proofHash}`,
        createdAt: now,
        type: 'attachment',
        seenBy: [senderHandle],
        reference: signedPdfReference,
        attachmentName,
        attachmentType: 'application/pdf',
        attachmentSize: signedPdfBuffer.length
      };

      await appendConversationMessage({
        conversationId,
        message,
        lastMessage: `📎 ${attachmentName}`,
        lastMessageSenderId: senderHandle
      });

      if (adminDb) {
        const docRef = adminDb.collection('transactions').doc(transactionId);
        const doc = await docRef.get();
        if (doc.exists) {
          await docRef.update({
            preuveHashBlockchain: proofHash,
            contratSignePdfReference: signedPdfReference,
            contratSignePdfName: attachmentName,
            contratSignePdfGeneratedAt: now,
            statut
          });
        }
      }

      const localTxs = await readTransactionsFile();
      const localIdx = localTxs.findIndex(tx => String(tx.id || '').trim() === transactionId);
      if (localIdx >= 0) {
        localTxs[localIdx].preuveHashBlockchain = proofHash;
        localTxs[localIdx].contratSignePdfReference = signedPdfReference;
        localTxs[localIdx].contratSignePdfName = attachmentName;
        localTxs[localIdx].contratSignePdfGeneratedAt = now;
        localTxs[localIdx].statut = statut;
        await writeTransactionsFile(localTxs);
      }
    }

    return res.json({
      ok: true,
      transactionId,
      role,
      signatureAcheteurAt: signatureAcheteurAt || null,
      signatureVendeurAt: signatureVendeurAt || null,
      preuveHashBlockchain: proofHash || null,
      contratSignePdfReference: signedPdfReference || null,
      statut
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur signature contrat.', error: error.message });
  }
});

app.post('/api/conversations/from-transaction', requireAuth, async (req, res) => {
  try {
    const transactionId = String(req.body?.transactionId || '').trim();
    const buyerIdLogin = String(req.body?.buyerIdLogin || '').trim();
    const sellerIdLogin = String(req.body?.sellerIdLogin || '').trim();
    const senderIdLogin = String(req.callerUid || '').trim();

    if (!buyerIdLogin || !sellerIdLogin || !senderIdLogin) {
      return res.status(400).json({ ok: false, message: 'Champs requis manquants (buyerIdLogin, sellerIdLogin, senderIdLogin).' });
    }

    const isAdmin = await resolveCallerIsAdmin(senderIdLogin);
    if (!isAdmin && senderIdLogin !== buyerIdLogin && senderIdLogin !== sellerIdLogin) {
      return res.status(403).json({ ok: false, message: 'Accès refusé à cette conversation.' });
    }

    const users = await resolveUsersByIdLogin([buyerIdLogin, sellerIdLogin, senderIdLogin]);
    const buyer = users.get(buyerIdLogin);
    const seller = users.get(sellerIdLogin);
    const sender = users.get(senderIdLogin);

    if (!buyer || !seller) {
      return res.status(404).json({ ok: false, message: 'Participants introuvables dans users.' });
    }

    const buyerHandle = getNormalizedUserHandle(buyer);
    const sellerHandle = getNormalizedUserHandle(seller);
    const senderHandle = getNormalizedUserHandle(sender);

    const safeBuyerHandle = buyerHandle || normalizeHandle(buyerIdLogin);
    const safeSellerHandle = sellerHandle || normalizeHandle(sellerIdLogin);

    const safeSenderHandle = senderHandle
      || (senderIdLogin === buyerIdLogin ? safeBuyerHandle : '')
      || (senderIdLogin === sellerIdLogin ? safeSellerHandle : '')
      || safeBuyerHandle;

    const participants = [buyerIdLogin, sellerIdLogin]
      .map(value => String(value || '').trim())
      .filter(Boolean)
      .sort();
    const transactionSuffix = transactionId ? `__tx__${transactionId}` : '';
    const conversationId = `${participants.join('__')}${transactionSuffix}`;
    const now = Date.now();
    const initialText = transactionId
      ? `Conversation démarrée pour la transaction ${transactionId}`
      : 'Conversation démarrée';

    let created = false;

    if (adminDb) {
      const convRef = adminDb.collection('conversations').doc(conversationId);
      const convDoc = await convRef.get();

      if (!convDoc.exists) {
        await convRef.set({
          participants,
          transactionId,
          lastMessage: initialText,
          lastMessageAt: now,
          lastMessageSenderId: safeSenderHandle,
          createdAt: now
        });

        await convRef.collection('messages').add({
          senderId: safeSenderHandle,
          text: initialText,
          createdAt: now,
          type: 'text',
          seenBy: [safeSenderHandle]
        });

        created = true;
      } else {
        await convRef.set({
          participants,
          transactionId,
          lastMessageAt: now
        }, { merge: true });
      }
    }

    const conversations = await readConversationsFile();
    const existingIndex = conversations.findIndex(c => String(c.id || '').trim() === conversationId);

    if (existingIndex === -1) {
      conversations.push({
        id: conversationId,
        participants,
        transactionId,
        lastMessage: initialText,
        lastMessageAt: now,
        lastMessageSenderId: safeSenderHandle,
        createdAt: now,
        messages: [{
          id: `msg-${now}`,
          senderId: safeSenderHandle,
          text: initialText,
          createdAt: now,
          type: 'text',
          seenBy: [safeSenderHandle]
        }]
      });
      await writeConversationsFile(conversations);
      created = true;
    } else {
      conversations[existingIndex].participants = participants;
      conversations[existingIndex].transactionId = transactionId;
      await writeConversationsFile(conversations);
    }

    return res.json({ ok: true, conversationId, created, participants, transactionId });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur création conversation.', error: error.message });
  }
});

app.get('/api/conversations/:id/status', requireAuth, async (req, res) => {
  try {
    const conversationId = String(req.params.id || '').trim();
    if (!conversationId) {
      return res.status(400).json({ ok: false, message: 'ID conversation manquant.' });
    }

    const access = await resolveConversationAccess(conversationId, req.callerUid);
    if (!access.ok) {
      return res.status(403).json({ ok: false, message: 'Accès refusé à cette conversation.' });
    }

    if (adminDb) {
      const convRef = adminDb.collection('conversations').doc(conversationId);
      const convDoc = await convRef.get();
      if (!convDoc.exists) {
        return res.status(404).json({ ok: false, message: 'Conversation introuvable.' });
      }
      const convData = convDoc.data() || {};
      const messagesSnapshot = await convRef.collection('messages').get();
      return res.json({
        ok: true,
        conversationId,
        messageCount: messagesSnapshot.size,
        lastMessageAt: Number(convData.lastMessageAt || 0)
      });
    }

    const conversations = await readConversationsFile();
    const conversation = conversations.find(c => String(c.id || '').trim() === conversationId);
    if (!conversation) {
      return res.status(404).json({ ok: false, message: 'Conversation introuvable.' });
    }
    const msgs = Array.isArray(conversation.messages) ? conversation.messages : [];
    return res.json({
      ok: true,
      conversationId,
      messageCount: msgs.length,
      lastMessageAt: Number(conversation.lastMessageAt || 0)
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur lecture statut conversation.', error: error.message });
  }
});

app.get('/api/conversations/:id/messages', requireAuth, async (req, res) => {
  try {
    const conversationId = String(req.params.id || '').trim();
    if (!conversationId) {
      return res.status(400).json({ ok: false, message: 'ID conversation manquant.' });
    }

    const access = await resolveConversationAccess(conversationId, req.callerUid);
    if (!access.ok) {
      return res.status(403).json({ ok: false, message: 'Accès refusé à cette conversation.' });
    }

    if (adminDb) {
      const convRef = adminDb.collection('conversations').doc(conversationId);
      const convDoc = await convRef.get();

      if (!convDoc.exists) {
        return res.status(404).json({ ok: false, message: 'Conversation introuvable.' });
      }

      const messagesSnapshot = await convRef.collection('messages').orderBy('createdAt', 'asc').get();
      const messages = messagesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      return res.json({ ok: true, conversationId, messages });
    }

    const conversations = await readConversationsFile();
    const conversation = conversations.find(c => String(c.id || '').trim() === conversationId);
    if (!conversation) {
      return res.status(404).json({ ok: false, message: 'Conversation introuvable.' });
    }

    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    return res.json({ ok: true, conversationId, messages });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur lecture messages conversation.', error: error.message });
  }
});

app.post('/api/conversations/:id/messages', requireAuth, async (req, res) => {
  try {
    const conversationId = String(req.params.id || '').trim();
    const text = String(req.body?.text || '').trim();
    const reference = String(req.body?.reference || '').trim();
    const attachmentName = String(req.body?.attachmentName || '').trim();
    const attachmentType = String(req.body?.attachmentType || '').trim();
    const attachmentSize = Number(req.body?.attachmentSize || 0);
    const senderIdLogin = req.callerUid;

    if (!conversationId) {
      return res.status(400).json({ ok: false, message: 'ID conversation manquant.' });
    }

    if (!text && !reference) {
      return res.status(400).json({ ok: false, message: 'Le message doit contenir un texte ou une référence de pièce jointe.' });
    }

    const access = await resolveConversationAccess(conversationId, senderIdLogin);
    if (!access.ok) {
      return res.status(403).json({ ok: false, message: 'Accès refusé à cette conversation.' });
    }

    const isAdmin = await resolveCallerIsAdmin(senderIdLogin);

    let senderHandle;
    if (isAdmin) {
      senderHandle = '__admin__';
    } else {
      const users = await resolveUsersByIdLogin([senderIdLogin]);
      const sender = users.get(senderIdLogin);
      senderHandle = getNormalizedUserHandle(sender) || normalizeHandle(senderIdLogin);
    }

    const now = Date.now();
    const resolvedType = reference ? 'attachment' : 'text';
    const lastMessagePreview = text || `📎 ${attachmentName || 'Pièce jointe'}`;
    const message = {
      senderId: senderHandle,
      text,
      createdAt: now,
      type: resolvedType,
      seenBy: [senderHandle]
    };
    if (isAdmin) {
      message.isAdmin = true;
    }

    if (reference) {
      message.reference = reference;
      if (attachmentName) message.attachmentName = attachmentName;
      if (attachmentType) message.attachmentType = attachmentType;
      if (Number.isFinite(attachmentSize) && attachmentSize > 0) {
        message.attachmentSize = attachmentSize;
      }
    }

    let found = false;

    if (adminDb) {
      const convRef = adminDb.collection('conversations').doc(conversationId);
      const convDoc = await convRef.get();

      if (!convDoc.exists) {
        return res.status(404).json({ ok: false, message: 'Conversation introuvable.' });
      }

      const newDoc = await convRef.collection('messages').add(message);
      await convRef.update({
        lastMessage: lastMessagePreview,
        lastMessageAt: now,
        lastMessageSenderId: senderHandle
      });

      found = true;
      message.id = newDoc.id;
    }

    const conversations = await readConversationsFile();
    const index = conversations.findIndex(c => String(c.id || '').trim() === conversationId);
    if (index >= 0) {
      const localMessage = {
        id: message.id || `msg-${now}`,
        ...message
      };
      const currentMessages = Array.isArray(conversations[index].messages) ? conversations[index].messages : [];
      conversations[index].messages = [...currentMessages, localMessage];
      conversations[index].lastMessage = lastMessagePreview;
      conversations[index].lastMessageAt = now;
      conversations[index].lastMessageSenderId = senderHandle;
      await writeConversationsFile(conversations);
      found = true;
      if (!message.id) message.id = localMessage.id;
    }

    if (!found) {
      return res.status(404).json({ ok: false, message: 'Conversation introuvable.' });
    }

    return res.status(201).json({ ok: true, conversationId, message });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur envoi message conversation.', error: error.message });
  }
});

app.post('/api/conversations/:id/attachments', requireAuth, async (req, res) => {
  try {
    const conversationId = String(req.params.id || '').trim();
    const senderIdLogin = String(req.callerUid || '').trim();
    const transactionId = String(req.body?.transactionId || '').trim();
    const fileNameRaw = String(req.body?.fileName || '').trim();
    const contentType = String(req.body?.contentType || 'application/octet-stream').trim();
    const base64Data = String(req.body?.base64Data || '').trim();

    if (!conversationId || !senderIdLogin || !fileNameRaw || !base64Data) {
      return res.status(400).json({ ok: false, message: 'Champs requis manquants (conversationId, senderIdLogin, fileName, base64Data).' });
    }

    const access = await resolveConversationAccess(conversationId, senderIdLogin);
    if (!access.ok) {
      return res.status(403).json({ ok: false, message: 'Accès refusé à cette conversation.' });
    }

    if (!adminStorageBucket) {
      return res.status(503).json({ ok: false, message: 'Firebase Storage Admin indisponible côté serveur.' });
    }

    const safeFileName = fileNameRaw.replace(/[^a-zA-Z0-9._-]/g, '_');
    const objectPath = `conversations/${conversationId}/files/${Date.now()}_${safeFileName}`;

    const dataWithoutPrefix = base64Data.includes(',') ? base64Data.split(',').pop() : base64Data;
    const fileBuffer = Buffer.from(dataWithoutPrefix, 'base64');

    if (!fileBuffer.length) {
      return res.status(400).json({ ok: false, message: 'Fichier vide.' });
    }

    if (fileBuffer.length > 10 * 1024 * 1024) {
      return res.status(413).json({ ok: false, message: 'Fichier trop volumineux (10 Mo max).' });
    }

    const token = crypto.randomUUID();
    const file = adminStorageBucket.file(objectPath);

    await file.save(fileBuffer, {
      contentType,
      resumable: false,
      metadata: {
        metadata: {
          firebaseStorageDownloadTokens: token,
          conversationId,
          transactionId,
          uploaderId: senderIdLogin
        }
      }
    });

    const encodedPath = encodeURIComponent(objectPath);
    const reference = `https://firebasestorage.googleapis.com/v0/b/${adminStorageBucket.name}/o/${encodedPath}?alt=media&token=${token}`;

    return res.status(201).json({
      ok: true,
      reference,
      path: objectPath,
      attachmentName: fileNameRaw,
      attachmentType: contentType,
      attachmentSize: fileBuffer.length
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur upload pièce jointe.', error: error.message });
  }
});

app.get('/api/attachments/download', requireAuth, async (req, res) => {
  try {
    const reference = String(req.query?.reference || '').trim();
    const fileNameRaw = String(req.query?.fileName || 'piece-jointe').trim();

    if (!reference) {
      return res.status(400).json({ ok: false, message: 'Référence de fichier manquante.' });
    }

    const safeFileName = fileNameRaw.replace(/[^a-zA-Z0-9._-]/g, '_') || 'piece-jointe';
    const urlObj = new URL(reference);
    if (urlObj.hostname !== 'firebasestorage.googleapis.com') {
      return res.status(400).json({ ok: false, message: 'Référence de fichier invalide.' });
    }

    const pathMatch = urlObj.pathname.match(/\/o\/(.+)$/);
    if (!pathMatch) {
      return res.status(400).json({ ok: false, message: 'Référence de fichier invalide.' });
    }

    const objectPath = decodeURIComponent(pathMatch[1]);
    const conversationMatch = objectPath.match(/^conversations\/([^/]+)\/files\//);
    if (!conversationMatch) {
      return res.status(400).json({ ok: false, message: 'Référence de fichier invalide.' });
    }

    const access = await resolveConversationAccess(conversationMatch[1], req.callerUid);
    if (!access.ok) {
      return res.status(403).json({ ok: false, message: 'Accès refusé à cette pièce jointe.' });
    }

    if (adminStorageBucket) {
      try {
        const file = adminStorageBucket.file(objectPath);
        const [exists] = await file.exists();
        if (exists) {
          const [fileBuffer] = await file.download();
          const [metadata] = await file.getMetadata();
          const contentType = metadata.contentType || 'application/octet-stream';

          res.setHeader('Content-Type', contentType);
          res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}"`);
          return res.send(fileBuffer);
        }
      } catch (adminError) {
        console.warn('Admin SDK download failed:', adminError.message);
      }
    }
    return res.status(404).json({ ok: false, message: 'Fichier introuvable.' });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur téléchargement pièce jointe.', error: error.message });
  }
});

app.get('/api/tokens', async (_req, res) => {
  try {
    const tokenListUrl = process.env.SOLANA_TOKEN_LIST_URL || 'https://raw.githubusercontent.com/solana-labs/token-list/main/src/tokens/solana.tokenlist.json';
    const tokenResponse = await fetch(tokenListUrl);

    if (!tokenResponse.ok) {
      return res.status(502).json({ ok: false, message: 'Impossible de charger la token list Solana.' });
    }

    const tokenPayload = await tokenResponse.json();
    const tokens = Array.isArray(tokenPayload.tokens) ? tokenPayload.tokens : [];

    const ids = Object.values(COINGECKO_MAP).join(',');
    const geckoUrl = `${process.env.COINGECKO_API_URL || 'https://api.coingecko.com/api/v3/simple/price'}?ids=${ids}&vs_currencies=eur`;
    const priceResponse = await fetch(geckoUrl);

    const prices = priceResponse.ok ? await priceResponse.json() : {};

    const pricedSymbols = Object.entries(COINGECKO_MAP)
      .filter(([_symbol, geckoId]) => prices[geckoId] && typeof prices[geckoId].eur === 'number')
      .reduce((acc, [symbol, geckoId]) => {
        acc[symbol] = prices[geckoId].eur;
        return acc;
      }, {});

    const tokenBySymbol = {};
    for (const token of tokens) {
      if (!token || !token.symbol) continue;
      if (!pricedSymbols[token.symbol]) continue;
      if (!tokenBySymbol[token.symbol]) {
        tokenBySymbol[token.symbol] = {
          name: token.name,
          symbol: token.symbol,
          decimals: token.decimals,
          logoURI: token.logoURI
        };
      }
    }

    return res.json({
      ok: true,
      prices: pricedSymbols,
      tokens: tokenBySymbol
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur backend tokens.', error: error.message });
  }
});

// ============ TRANSACTION COMMAND ENDPOINTS ============

// POST /api/transactions/:id/accept  [requireAuth, contrepartie non-initiatrice, En attente -> Configurer]
app.post('/api/transactions/:id/accept', requireAuth, async (req, res) => {
  try {
    const transactionId = String(req.params.id || '').trim();
    if (!transactionId) return res.status(400).json({ ok: false, message: 'ID transaction manquant.' });

    const { tx, role } = await fetchTxAndRole(transactionId, req.callerUid);
    if (!tx) return res.status(404).json({ ok: false, message: 'Transaction introuvable.' });
    if (!role) return res.status(403).json({ ok: false, message: 'Action réservée aux participants de la transaction.' });
    const initiatorId = String(tx.initiateur || '').trim();
    if (initiatorId && String(req.callerUid || '').trim() === initiatorId) {
      return res.status(403).json({ ok: false, message: 'Seule la contrepartie non initiatrice peut accepter la transaction.' });
    }
    if (tx.statut !== 'En attente') return res.status(409).json({ ok: false, message: `Transition impossible depuis le statut "${tx.statut}".` });

    const now = Date.now();
    const timeline = Array.isArray(tx.timeline) ? [...tx.timeline] : [];
    timeline.push({ status: 'accepted', time: now, label: 'Transaction acceptée par la contrepartie' });
    const updated = await applyTransactionUpdate(transactionId, { statut: 'Configurer', updatedAt: now, timeline });
    if (!updated) return res.status(404).json({ ok: false, message: 'Transaction introuvable lors de la mise à jour.' });

    return res.json({ ok: true, id: transactionId, statut: 'Configurer' });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur acceptation transaction.', error: error.message });
  }
});

// POST /api/transactions/:id/refuse  [requireAuth, contrepartie non-initiatrice, En attente -> Refusé]
app.post('/api/transactions/:id/refuse', requireAuth, async (req, res) => {
  try {
    const transactionId = String(req.params.id || '').trim();
    if (!transactionId) return res.status(400).json({ ok: false, message: 'ID transaction manquant.' });

    const { tx, role } = await fetchTxAndRole(transactionId, req.callerUid);
    if (!tx) return res.status(404).json({ ok: false, message: 'Transaction introuvable.' });
    if (!role) return res.status(403).json({ ok: false, message: 'Action réservée aux participants de la transaction.' });
    const initiatorId = String(tx.initiateur || '').trim();
    if (initiatorId && String(req.callerUid || '').trim() === initiatorId) {
      return res.status(403).json({ ok: false, message: 'Seule la contrepartie non initiatrice peut refuser la transaction.' });
    }
    if (tx.statut !== 'En attente') return res.status(409).json({ ok: false, message: `Transition impossible depuis le statut "${tx.statut}".` });

    const now = Date.now();
    const timeline = Array.isArray(tx.timeline) ? [...tx.timeline] : [];
    timeline.push({ status: 'refused', time: now, label: 'Transaction refusée par la contrepartie' });
    const updated = await applyTransactionUpdate(transactionId, { statut: 'Refusé', updatedAt: now, timeline });
    if (!updated) return res.status(404).json({ ok: false, message: 'Transaction introuvable lors de la mise à jour.' });

    return res.json({ ok: true, id: transactionId, statut: 'Refusé' });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur refus transaction.', error: error.message });
  }
});

// POST /api/transactions/:id/validate-contract  [requireAuth, acheteur ou vendeur, Valider contrat]
app.post('/api/transactions/:id/validate-contract', requireAuth, async (req, res) => {
  try {
    const transactionId = String(req.params.id || '').trim();
    if (!transactionId) return res.status(400).json({ ok: false, message: 'ID transaction manquant.' });

    const { tx, role } = await fetchTxAndRole(transactionId, req.callerUid);
    if (!tx) return res.status(404).json({ ok: false, message: 'Transaction introuvable.' });
    if (!role) return res.status(403).json({ ok: false, message: 'Vous n\'êtes pas participant de cette transaction.' });
    if (tx.statut !== 'Valider contrat') return res.status(409).json({ ok: false, message: `Validation impossible depuis le statut "${tx.statut}".` });

    const alreadyValidated = role === 'acheteur' ? !!tx.validationAcheteur : !!tx.validationVendeur;
    if (alreadyValidated) return res.status(409).json({ ok: false, message: 'Vous avez déjà validé ce contrat.' });

    const now = Date.now();
    const updatePayload = { updatedAt: now };
    const timeline = Array.isArray(tx.timeline) ? [...tx.timeline] : [];

    let validationAcheteur = !!tx.validationAcheteur;
    let validationVendeur = !!tx.validationVendeur;

    if (role === 'acheteur') {
      updatePayload.validationAcheteur = true;
      validationAcheteur = true;
      timeline.push({ status: 'buyer-contract-validated', time: now, label: 'Validation acheteur effectuée' });
    } else {
      updatePayload.validationVendeur = true;
      validationVendeur = true;
      timeline.push({ status: 'seller-contract-validated', time: now, label: 'Validation vendeur effectuée' });
    }

    let nextStatut = 'Valider contrat';
    if (validationAcheteur && validationVendeur) {
      nextStatut = 'Signer contrat';
      updatePayload.statut = 'Signer contrat';
      timeline.push({ status: 'contract-signed-step', time: now, label: 'Les deux parties ont validé — contrat à signer' });
    }
    updatePayload.timeline = timeline;

    const updated = await applyTransactionUpdate(transactionId, updatePayload);
    if (!updated) return res.status(404).json({ ok: false, message: 'Transaction introuvable lors de la mise à jour.' });

    return res.json({ ok: true, id: transactionId, statut: nextStatut, validationAcheteur, validationVendeur });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur validation contrat.', error: error.message });
  }
});

// POST /api/transactions/:id/complete-configuration  [requireAuth, participant, Configurer -> Valider contrat]
app.post('/api/transactions/:id/complete-configuration', requireAuth, async (req, res) => {
  try {
    const transactionId = String(req.params.id || '').trim();
    if (!transactionId) return res.status(400).json({ ok: false, message: 'ID transaction manquant.' });

    const { tx, role } = await fetchTxAndRole(transactionId, req.callerUid);
    if (!tx) return res.status(404).json({ ok: false, message: 'Transaction introuvable.' });
    if (!role) return res.status(403).json({ ok: false, message: 'Vous n\'êtes pas participant de cette transaction.' });
    if (tx.statut !== 'Configurer') return res.status(409).json({ ok: false, message: `Transition impossible depuis le statut "${tx.statut}".` });

    const hasBuyerEngagement = !!String(tx.engagementAcheteur || '').trim();
    const hasSellerEngagement = !!String(tx.engagementVendeur || '').trim();
    const hasSellerWallet = !!String(tx.walletVendeurEvm || '').trim() || !!String(tx.walletVendeurPhantom || '').trim();

    if (!hasBuyerEngagement || !hasSellerEngagement || !hasSellerWallet) {
      return res.status(409).json({ ok: false, message: 'Configuration incomplète (engagements et wallets requis).' });
    }

    const now = Date.now();
    const timeline = Array.isArray(tx.timeline) ? [...tx.timeline] : [];
    timeline.push({ status: 'contract-validation', time: now, label: 'Configuration terminée — contrat à valider' });

    const updated = await applyTransactionUpdate(transactionId, { statut: 'Valider contrat', updatedAt: now, timeline });
    if (!updated) return res.status(404).json({ ok: false, message: 'Transaction introuvable lors de la mise à jour.' });

    return res.json({ ok: true, id: transactionId, statut: 'Valider contrat' });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur finalisation configuration.', error: error.message });
  }
});

// POST /api/transactions/:id/start-guarantee  [requireAuth, vendeur, Déposer les documents -> Garantie]
app.post('/api/transactions/:id/start-guarantee', requireAuth, async (req, res) => {
  try {
    const transactionId = String(req.params.id || '').trim();
    if (!transactionId) return res.status(400).json({ ok: false, message: 'ID transaction manquant.' });

    const { tx, role } = await fetchTxAndRole(transactionId, req.callerUid);
    if (!tx) return res.status(404).json({ ok: false, message: 'Transaction introuvable.' });
    if (role !== 'vendeur') return res.status(403).json({ ok: false, message: 'Seul le vendeur peut démarrer la garantie.' });
    if (tx.statut !== 'Déposer les documents') return res.status(409).json({ ok: false, message: `Transition impossible depuis le statut "${tx.statut}".` });

    if (!Array.isArray(tx.timeline) || !tx.timeline.some(e => e?.status === 'documents-deposited')) {
      return res.status(409).json({ ok: false, message: 'Des documents doivent être déposés avant de démarrer la garantie.' });
    }

    const now = Date.now();
    const guaranteeHours = Number(tx.garantieperiode) || 48;
    const guaranteeStartedAt = now;
    const guaranteeExpiresAt = now + (guaranteeHours * 3_600_000);
    const timeline = Array.isArray(tx.timeline) ? [...tx.timeline] : [];
    timeline.push({ status: 'guarantee-started', time: now, label: `Garantie démarrée (${guaranteeHours}h)` });

    const updated = await applyTransactionUpdate(transactionId, {
      statut: 'Garantie',
      guaranteeStartedAt,
      guaranteeExpiresAt,
      updatedAt: now,
      timeline
    });
    if (!updated) return res.status(404).json({ ok: false, message: 'Transaction introuvable lors de la mise à jour.' });

    return res.json({ ok: true, id: transactionId, statut: 'Garantie', guaranteeStartedAt, guaranteeExpiresAt });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur démarrage garantie.', error: error.message });
  }
});

// POST /api/transactions/:id/open-dispute  [requireAuth, acheteur, Garantie -> Litige]
app.post('/api/transactions/:id/open-dispute', requireAuth, async (req, res) => {
  try {
    const transactionId = String(req.params.id || '').trim();
    const reason = String(req.body?.reason || '').trim();
    if (!transactionId) return res.status(400).json({ ok: false, message: 'ID transaction manquant.' });
    if (!reason) return res.status(400).json({ ok: false, message: 'Raison du litige obligatoire.' });

    const { tx, role } = await fetchTxAndRole(transactionId, req.callerUid);
    if (!tx) return res.status(404).json({ ok: false, message: 'Transaction introuvable.' });
    if (role !== 'acheteur') return res.status(403).json({ ok: false, message: 'Seul l\'acheteur peut ouvrir un litige.' });
    if (tx.statut !== 'Garantie') return res.status(409).json({ ok: false, message: `Litige impossible depuis le statut "${tx.statut}".` });

    if (Array.isArray(tx.timeline) && tx.timeline.some(e => e?.status === 'dispute')) {
      return res.status(409).json({ ok: false, message: 'Un litige est déjà ouvert sur cette transaction.' });
    }

    const now = Date.now();
    const timeline = Array.isArray(tx.timeline) ? [...tx.timeline] : [];
    timeline.push({ status: 'dispute', time: now, label: `Litige ouvert par l'acheteur : ${reason}` });

    const updated = await applyTransactionUpdate(transactionId, {
      statut: 'Litige',
      disputeSeenByAdmin: false,
      disputeReason: reason,
      disputeOpenedAt: now,
      updatedAt: now,
      timeline
    });
    if (!updated) return res.status(404).json({ ok: false, message: 'Transaction introuvable lors de la mise à jour.' });

    return res.json({ ok: true, id: transactionId, statut: 'Litige', disputeOpenedAt: now });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur ouverture litige.', error: error.message });
  }
});

// POST /api/transactions/:id/validate-early  [requireAuth, acheteur, Garantie -> Terminer]
app.post('/api/transactions/:id/validate-early', requireAuth, async (req, res) => {
  try {
    const transactionId = String(req.params.id || '').trim();
    if (!transactionId) return res.status(400).json({ ok: false, message: 'ID transaction manquant.' });

    const { tx, role } = await fetchTxAndRole(transactionId, req.callerUid);
    if (!tx) return res.status(404).json({ ok: false, message: 'Transaction introuvable.' });
    if (role !== 'acheteur') return res.status(403).json({ ok: false, message: 'Seul l\'acheteur peut valider la transaction.' });
    if (tx.statut !== 'Garantie') return res.status(409).json({ ok: false, message: `Validation anticipée impossible depuis le statut "${tx.statut}".` });

    const now = Date.now();
    const timeline = Array.isArray(tx.timeline) ? [...tx.timeline] : [];
    timeline.push({ status: 'validated-early', time: now, label: 'Transaction validée par l\'acheteur (libération anticipée)' });
    timeline.push({ status: 'completed', time: now, label: 'Fonds libérés au vendeur — Transaction terminée' });

    const updated = await applyTransactionUpdate(transactionId, { statut: 'Terminer', updatedAt: now, timeline });
    if (!updated) return res.status(404).json({ ok: false, message: 'Transaction introuvable lors de la mise à jour.' });

    return res.json({ ok: true, id: transactionId, statut: 'Terminer' });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur validation anticipée.', error: error.message });
  }
});

// POST /api/transactions/:id/complete-rating-step  [requireAuth, participant, Noter -> Terminer]
app.post('/api/transactions/:id/complete-rating-step', requireAuth, async (req, res) => {
  try {
    const transactionId = String(req.params.id || '').trim();
    if (!transactionId) return res.status(400).json({ ok: false, message: 'ID transaction manquant.' });

    const { tx, role } = await fetchTxAndRole(transactionId, req.callerUid);
    if (!tx) return res.status(404).json({ ok: false, message: 'Transaction introuvable.' });
    if (!role) return res.status(403).json({ ok: false, message: 'Vous n\'êtes pas participant de cette transaction.' });
    if (tx.statut !== 'Noter') return res.status(409).json({ ok: false, message: `Transition impossible depuis le statut "${tx.statut}".` });

    const buyerIdLogin = String(tx.acheteur || '').trim();
    const sellerIdLogin = String(tx.vendeur || '').trim();
    if (!buyerIdLogin || !sellerIdLogin) {
      return res.status(400).json({ ok: false, message: 'Participants transaction incomplets.' });
    }

    let callerNoteExists = false;
    if (adminDb) {
      const noteTarget = role === 'acheteur' ? sellerIdLogin : buyerIdLogin;
      const noteRef = adminDb
        .collection('users')
        .doc(noteTarget)
        .collection('notations')
        .doc(buildNotationDocId(transactionId, req.callerUid));
      const noteDoc = await noteRef.get();
      callerNoteExists = noteDoc.exists;
    }

    if (!callerNoteExists) {
      const users = await readUsersFile();
      const noteTarget = role === 'acheteur' ? sellerIdLogin : buyerIdLogin;
      const targetUser = users.find(u => String(u.id_login || u.id || '').trim() === noteTarget) || null;
      if (targetUser && Array.isArray(targetUser.notations)) {
        callerNoteExists = targetUser.notations.some(note =>
          String(note.transactionId || '').trim() === transactionId
          && String(note.fromIdLogin || '').trim() === req.callerUid
        );
      }
    }

    if (!callerNoteExists) {
      return res.status(409).json({ ok: false, message: 'Vous devez d\'abord soumettre votre notation avant de clôturer.' });
    }

    const now = Date.now();
    const timeline = Array.isArray(tx.timeline) ? [...tx.timeline] : [];
    timeline.push({ status: 'rating-validated', time: now, label: 'Commentaire validé — transaction terminée' });

    const updated = await applyTransactionUpdate(transactionId, { statut: 'Terminer', updatedAt: now, timeline });
    if (!updated) return res.status(404).json({ ok: false, message: 'Transaction introuvable lors de la mise à jour.' });

    return res.json({ ok: true, id: transactionId, statut: 'Terminer' });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur clôture étape notation.', error: error.message });
  }
});

// PATCH /api/transactions/:id/network  [requireAuth, change réseau d'une transaction avant validation contrat]
app.patch('/api/transactions/:id/network', requireAuth, async (req, res) => {
  try {
    const transactionId = String(req.params.id || '').trim();
    const rawPlatform = String(req.body?.blockchainPlatform || '').trim().toLowerCase();
    if (!transactionId) return res.status(400).json({ ok: false, message: 'ID transaction manquant.' });
    if (!['solana', 'ethereum'].includes(rawPlatform)) {
      return res.status(400).json({ ok: false, message: 'Réseau invalide (solana ou ethereum attendu).' });
    }

    let tx = null;
    if (adminDb) {
      const doc = await adminDb.collection('transactions').doc(transactionId).get();
      if (doc.exists) tx = { id: doc.id, ...doc.data() };
    }
    if (!tx) {
      const local = await readTransactionsFile();
      tx = local.find(t => String(t.id || '').trim() === transactionId) || null;
    }
    if (!tx) return res.status(404).json({ ok: false, message: 'Transaction introuvable.' });

    // Seul l'initiateur réel de la transaction peut modifier le réseau
    const initiatorId = String(tx.initiateur || tx.initiatorIdLogin || tx.initiator || '').trim();
    if (initiatorId && initiatorId !== req.callerUid) {
      return res.status(403).json({ ok: false, message: 'Seul l\'initiateur peut modifier le réseau.' });
    }

    // Modification autorisée uniquement avant la validation du contrat
    const LOCKED_STATUSES = ['Signer contrat', 'Déposer les fonds', 'Déposer les documents', 'Garantie', 'LOCKED', 'DISPUTE', 'Litige', 'REFUNDED', 'Refusé', 'RELEASED', 'Terminer', 'Noter'];
    const statut = String(tx.statut || '').trim();
    if (LOCKED_STATUSES.includes(statut)) {
      return res.status(409).json({ ok: false, message: `Modification du réseau impossible depuis le statut "${statut}".` });
    }

    const networkLabel = rawPlatform === 'ethereum' ? 'Ethereum' : 'Solana';
    const updated = await applyTransactionUpdate(transactionId, {
      blockchainPlatform: rawPlatform,
      network: networkLabel,
      updatedAt: Date.now()
    });
    if (!updated) return res.status(404).json({ ok: false, message: 'Transaction introuvable lors de la mise à jour.' });

    return res.json({ ok: true, id: transactionId, blockchainPlatform: rawPlatform, network: networkLabel });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur mise à jour réseau.', error: error.message });
  }
});

// POST /api/admin/users/:id/suspend  [requireAdmin, suspend user]
app.post('/api/admin/users/:id/suspend', requireAdmin, async (req, res) => {
  try {
    const userId = String(req.params.id || '').trim();
    if (!userId) return res.status(400).json({ ok: false, message: 'ID utilisateur manquant.' });

    if (adminDb) {
      await adminDb.collection('users').doc(userId).set({
        suspended: true,
        suspendedAt: Date.now(),
        suspendedBy: req.callerUid
      }, { merge: true });
    }
    return res.json({ ok: true, userId, suspended: true });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur suspension utilisateur.', error: error.message });
  }
});

// POST /api/admin/users/:id/reactivate  [requireAdmin, reactivate user]
app.post('/api/admin/users/:id/reactivate', requireAdmin, async (req, res) => {
  try {
    const userId = String(req.params.id || '').trim();
    if (!userId) return res.status(400).json({ ok: false, message: 'ID utilisateur manquant.' });

    if (adminDb) {
      await adminDb.collection('users').doc(userId).set({
        suspended: false,
        reactivatedAt: Date.now(),
        reactivatedBy: req.callerUid
      }, { merge: true });
    }
    return res.json({ ok: true, userId, suspended: false });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur réactivation utilisateur.', error: error.message });
  }
});

// POST /api/admin/transactions/:id/resolve-dispute  [requireAdmin, Litige -> Noter]
app.post('/api/admin/transactions/:id/resolve-dispute', requireAdmin, async (req, res) => {
  try {
    const transactionId = String(req.params.id || '').trim();
    const decision = String(req.body?.decision || '').trim();
    const comment = String(req.body?.comment || '').trim();
    if (!transactionId) return res.status(400).json({ ok: false, message: 'ID transaction manquant.' });
    if (!['RELEASE', 'REFUND'].includes(decision)) return res.status(400).json({ ok: false, message: 'Décision invalide (RELEASE ou REFUND attendu).' });
    if (!comment) return res.status(400).json({ ok: false, message: 'Commentaire de décision obligatoire.' });

    let tx = null;
    if (adminDb) {
      const doc = await adminDb.collection('transactions').doc(transactionId).get();
      if (doc.exists) tx = { id: doc.id, ...doc.data() };
    }
    if (!tx) {
      const local = await readTransactionsFile();
      tx = local.find(t => String(t.id || '').trim() === transactionId) || null;
    }
    if (!tx) return res.status(404).json({ ok: false, message: 'Transaction introuvable.' });
    if (tx.statut !== 'Litige') return res.status(409).json({ ok: false, message: `Résolution impossible depuis le statut "${tx.statut}".` });

    const now = Date.now();
    const label = decision === 'REFUND' ? 'Arbitrage — Remboursement décidé → Notation' : 'Arbitrage — Libération décidée → Notation';
    const timeline = Array.isArray(tx.timeline) ? [...tx.timeline] : [];
    timeline.push({ status: decision.toLowerCase(), time: now, label: `${label} — ${comment}`, resolvedBy: req.callerUid });

    const updated = await applyTransactionUpdate(transactionId, {
      statut: 'Noter',
      disputeDecision: decision,
      disputeComment: comment,
      disputeResolvedAt: now,
      disputeResolvedBy: req.callerUid,
      updatedAt: now,
      timeline
    });
    if (!updated) return res.status(404).json({ ok: false, message: 'Transaction introuvable lors de la mise à jour.' });

    return res.json({ ok: true, id: transactionId, statut: 'Noter', decision, resolvedAt: now });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur résolution litige.', error: error.message });
  }
});

// ============ ADMIN PANEL ROUTE (BEFORE STATIC MIDDLEWARE) ============
app.get('/admin.html', (req, res) => {
  return res.redirect('/admin/');
});

app.get('/admin', (req, res) => {
  return res.redirect('/admin/');
});

app.get('/admin/', (req, res) => {
  return res.sendFile(path.join(FRONTEND_ROOT, 'admin', 'index.html'));
});

app.get('/admin/login', (req, res) => {
  return res.sendFile(path.join(FRONTEND_ROOT, 'admin', 'login.html'));
});

app.get('/admin/login.html', (req, res) => {
  return res.sendFile(path.join(FRONTEND_ROOT, 'admin', 'login.html'));
});

app.use(express.static(FRONTEND_ROOT, {
  index: false,
  maxAge: '15m',
  setHeaders: (res, filePath) => {
    if (String(filePath || '').toLowerCase().endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=900');
  }
}));

app.get('/', (req, res) => {
  return res.sendFile(path.join(FRONTEND_ROOT, 'login.html'));
});

app.get('/{*path}', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  return res.sendFile(path.join(FRONTEND_ROOT, 'index.html'));
});

async function ensureLocalTlsCertificate() {
  const keyExists = fsSync.existsSync(TLS_KEY_PATH);
  const certExists = fsSync.existsSync(TLS_CERT_PATH);

  if (keyExists && certExists) {
    const [key, cert] = await Promise.all([
      fs.readFile(TLS_KEY_PATH, 'utf8'),
      fs.readFile(TLS_CERT_PATH, 'utf8')
    ]);
    return { key, cert, generated: false };
  }

  await fs.mkdir(TLS_CERT_DIR, { recursive: true });

  const attrs = [{ name: 'commonName', value: 'localhost' }];
  const pems = await selfsigned.generate(attrs, {
    algorithm: 'sha256',
    keySize: 2048,
    days: 365,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
          { type: 7, ip: '::1' },
          { type: 7, ip: '0.0.0.0' }
        ]
      }
    ]
  });

  await Promise.all([
    fs.writeFile(TLS_KEY_PATH, pems.private, 'utf8'),
    fs.writeFile(TLS_CERT_PATH, pems.cert, 'utf8')
  ]);

  return { key: pems.private, cert: pems.cert, generated: true };
}

async function startServer() {
  const onListenError = (error) => {
    if (error && error.code === 'EADDRINUSE') {
      console.error(`Le port ${HTTPS_PORT} est deja utilise. Un serveur est probablement deja demarre.`);
      process.exit(1);
    }

    console.error('Echec demarrage serveur:', error?.message || error);
    process.exit(1);
  };

  if (!USE_HTTPS) {
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`OFM backend running on http://0.0.0.0:${PORT}`);
      startAutomatedStatusEngine();
    });
    server.on('error', onListenError);
    return;
  }

  try {
    const tls = await ensureLocalTlsCertificate();
    const server = https.createServer({ key: tls.key, cert: tls.cert }, app);
    server.on('error', onListenError);
    server.listen(HTTPS_PORT, '0.0.0.0', () => {
      if (tls.generated) {
        console.log(`Certificat auto-signe genere: ${TLS_CERT_PATH}`);
      }
      console.log(`OFM backend running on https://0.0.0.0:${HTTPS_PORT}`);
      startAutomatedStatusEngine();
    });
  } catch (error) {
    console.error('Echec demarrage HTTPS, fallback HTTP:', error.message);
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`OFM backend running on http://0.0.0.0:${PORT}`);
      startAutomatedStatusEngine();
    });
    server.on('error', onListenError);
  }
}

startServer();


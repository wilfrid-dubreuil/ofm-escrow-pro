/* ============================================================
   OFM Escrow Pro - Application Logic
   ============================================================ */

// ============ STATE MANAGEMENT ============
const AppData = {
    // will hold information about the signed–in user; null when nobody is logged in
    currentUser: null,
    escrows: [],
    disputes: [],
    payments: [],
    nextEscrowId: 1
};

// Firebase initialization placeholder (needs config same as login.html)
if (typeof firebase !== 'undefined') {
    const firebaseConfig = {
        apiKey: "AIzaSyCukmS_r4HXy8zjSiXNn2uSLWMCu7eMsNM",
        authDomain: "midgen-u6gv0i.firebaseapp.com",
        projectId: "midgen-u6gv0i",
        storageBucket: "midgen-u6gv0i.firebasestorage.app",
        messagingSenderId: "364043792835",
        appId: "1:364043792835:web:be5db5d2c038ed2e5a8d76"
    };
    firebase.initializeApp(firebaseConfig);
}


let currentEscrowId = null;
let countdownInterval = null;
let isBuyerRole = true;
const API_BASE_URL = window.location.origin && window.location.origin.startsWith('http')
    ? window.location.origin
    : 'http://localhost:3001';

const cryptoPrices = {
    BTC:  43500,
    ETH:  2800,
    SOL:  220,
    USDT: 1,
    USDC: 1,
    MATIC: 0.8,
    TON:  7
};

const userNameCacheByIdLogin = {};
const userHandleCacheByIdLogin = {};
let ethersImportPromise = null;
const ALLOWED_TRANSACTION_CRYPTO = 'SOL';
const DEFAULT_REFERRAL_HANDLE = 'actarus';

function showElement(element) {
    if (!element) return;
    element.classList.remove('hidden');
}

function hideElement(element) {
    if (!element) return;
    element.classList.add('hidden');
}

function showSelectablePopup(message) {
    const text = String(message || '');
    const overlay = document.createElement('div');
    overlay.className = 'selectable-popup-overlay';

    const box = document.createElement('div');
    box.className = 'selectable-popup-box';

    const isError = text.includes('❌') || text.toLowerCase().includes('error') || text.toLowerCase().includes('unauthorized') || text.toLowerCase().includes('permission');
    const title = document.createElement('div');
    title.textContent = isError ? 'Erreur' : 'Information';
    title.className = `selectable-popup-title ${isError ? 'is-error' : 'is-info'}`;

    const textArea = document.createElement('textarea');
    textArea.readOnly = true;
    textArea.value = text;
    textArea.className = 'selectable-popup-textarea';

    const actions = document.createElement('div');
    actions.className = 'selectable-popup-actions';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.textContent = 'Copier';
    copyBtn.className = 'selectable-popup-btn selectable-popup-btn-copy';
    copyBtn.onclick = async () => {
        try {
            await navigator.clipboard.writeText(text);
            copyBtn.textContent = 'Copié';
            setTimeout(() => { copyBtn.textContent = 'Copier'; }, 1200);
        } catch (_error) {
            textArea.focus();
            textArea.select();
        }
    };

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = 'OK';
    closeBtn.className = 'selectable-popup-btn selectable-popup-btn-ok';

    const close = () => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };

    closeBtn.onclick = close;
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) close();
    });

    actions.appendChild(copyBtn);
    actions.appendChild(closeBtn);
    box.appendChild(title);
    box.appendChild(textArea);
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    textArea.focus();
    textArea.select();
}

if (typeof window !== 'undefined') {
    window.alert = (message) => showSelectablePopup(message);
}

// Solana token list storage
let solanaTokenList = {};

// ============ CROSS-PAGE TAB MAP ============
function toMillis(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    if (typeof value?.toMillis === 'function') return value.toMillis();
    if (typeof value?.seconds === 'number') return value.seconds * 1000;
    return null;
}

const TRANSACTION_STEPPER_STEPS = [
    'En attente',
    'Configurer',
    'Valider contrat',
    'Signer contrat',
    'Déposer les fonds',
    'Déposer les documents',
    'Garantie',
    'Noter',
    'Terminer'
];

function getEscrowStepperIndex(status) {
    const normalizedStatus = String(status || '').trim().toLowerCase();
    const directIndex = TRANSACTION_STEPPER_STEPS.findIndex(step => step.toLowerCase() === normalizedStatus);
    if (directIndex >= 0) return directIndex;

    switch (status) {
        case 'En attente': return 0;
        case 'Accepté': return 3;
        case 'LOCKED': return 5;
        case 'DISPUTE': return 6;
        case 'RELEASED': return 8;
        case 'REFUNDED': return 8;
        case 'Refusé': return 0;
        default: return 0;
    }
}

function renderEscrowStatusStepper(status) {
    const currentIndex = getEscrowStepperIndex(status);

    return TRANSACTION_STEPPER_STEPS.map((step, index) => {
        const stepStateClass = index < currentIndex
            ? 'status-step done'
            : index === currentIndex
                ? 'status-step current'
                : 'status-step todo';

        const indicator = index < currentIndex ? '✓' : String(index + 1);

        return `
            <div class="${stepStateClass}">
                <div class="status-step-index">${indicator}</div>
                <div class="status-step-label">${step}</div>
            </div>
        `;
    }).join('');
}

function isChatEnabledForStatus(status) {
    return getEscrowStepperIndex(status) >= 1;
}

function scrollToDetailBlock(blockId) {
    const block = document.getElementById(blockId);
    if (!block) return;

    block.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const focusTarget = block.querySelector('textarea, input, button');
    if (focusTarget && typeof focusTarget.focus === 'function') {
        focusTarget.focus({ preventScroll: true });
    }
}

const PAGE_TABS = {
    'dashboard':     'index.html',
    'escrows':       'transactions.html',
    'escrow-detail': 'transactions.html',
    'create':        'create.html',
    'payment':       'create.html',
    'admin':         'admin.html'
};

// ============ LOAD SOLANA TOKEN LIST ============
async function loadSolanaTokenList() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/tokens`);
        const payload = await response.json();
        if (!response.ok || !payload.ok) throw new Error(payload.message || 'API tokens indisponible');

            const createdAt = toMillis(transaction.datecreation) ?? Date.now();

        Object.entries(payload.prices || {}).forEach(([symbol, price]) => {
            if (typeof price === 'number' && price > 0) {
                cryptoPrices[symbol] = price;
            }
        });

        populateCryptoSelect();
    } catch (error) {
        console.error('Error loading Solana token list:', error);
        populateCryptoSelectFallback();
    }
}

// ============ POPULATE CRYPTO SELECT ============
function populateCryptoSelect() {
    const selectElements = ['crypto-select', 'create-crypto'];

    selectElements.forEach(selectId => {
        const selectElement = document.getElementById(selectId);
        if (!selectElement) return;

        selectElement.innerHTML = '';

        const option = document.createElement('option');
        option.value = ALLOWED_TRANSACTION_CRYPTO;
        const price = cryptoPrices[ALLOWED_TRANSACTION_CRYPTO] || 0;
        option.textContent = `${ALLOWED_TRANSACTION_CRYPTO} — ${(typeof price === 'number' ? price : 0).toFixed(2)}€`;
        selectElement.appendChild(option);
        selectElement.value = ALLOWED_TRANSACTION_CRYPTO;
    });
}

// ============ FALLBACK: POPULATE WITHOUT TOKEN LIST ============
function populateCryptoSelectFallback() {
    const selectElements = ['crypto-select', 'create-crypto'];

    selectElements.forEach(selectId => {
        const selectElement = document.getElementById(selectId);
        if (!selectElement) return;

        selectElement.innerHTML = '';
        const option = document.createElement('option');
        option.value = ALLOWED_TRANSACTION_CRYPTO;
        option.textContent = `${ALLOWED_TRANSACTION_CRYPTO} — ${cryptoPrices[ALLOWED_TRANSACTION_CRYPTO] || 0}€`;
        selectElement.appendChild(option);
        selectElement.value = ALLOWED_TRANSACTION_CRYPTO;
    });
}

// ============ UPDATE CRYPTO PRICES FROM COINGECKO ============
async function updateCryptoPrices() {
    try {
        await loadSolanaTokenList();
    } catch (error) {
        console.error('Error updating crypto prices:', error);
    }
}

// ============ SELECT OVERLAY SETUP ============
function setupSelectOverlay() {
    const overlay = document.getElementById('selectOverlay');
    if (!overlay) return;
    const selectElements = document.querySelectorAll('select');

    selectElements.forEach(select => {
        select.addEventListener('focus', () => {
            overlay.classList.add('active');
        });

        select.addEventListener('blur', () => {
            overlay.classList.remove('active');
        });
    });

    overlay.addEventListener('click', () => {
        overlay.classList.remove('active');
    });
}

// ============ SELLER SEARCH ============
async function searchSeller() {
    const sellerInput = document.getElementById('seller-input');
    const statusDiv = document.getElementById('seller-status');

    if (!sellerInput) return;

    let handle = sellerInput.value.trim();

    if (!handle) {
        hideElement(statusDiv);
        return;
    }

    if (handle.startsWith('@')) {
        handle = handle.substring(1);
    }

    showElement(statusDiv);
    statusDiv.className = 'seller-status loading';
    statusDiv.innerHTML = '⏳ Vérification du compte...';

    console.log('Searching for seller with handle:', handle);

    try {
        const response = await fetch(`${API_BASE_URL}/api/users/handle/${encodeURIComponent(handle)}`);
        const payload = await response.json();

        if (response.ok && payload.ok && payload.user) {
            const user = payload.user;
            const displayName = user.Name || user.email || user.mail || handle;
            const reputation = (user['réputation'] === undefined || user['réputation'] === null || String(user['réputation']).trim() === '')
                ? 0
                : user['réputation'];

            statusDiv.className = 'seller-status success';
            statusDiv.innerHTML = `✅ Utilisateur trouvé: <strong>${displayName}</strong> (Réputation: ${reputation}%)`;

            sellerInput.dataset.sellerId = user.id || '';
            sellerInput.dataset.sellerIdLogin = user.id_login || user.id || '';
            sellerInput.dataset.sellerHandle = user.handle || handle;
            sellerInput.dataset.sellerEmail = user.email || user.mail || '';
            sellerInput.dataset.sellerName = displayName;
            return;
        }

        statusDiv.className = 'seller-status error';
        statusDiv.innerHTML = `❌ Aucun utilisateur trouvé avec le nom d'utilisateur "@${handle}"`;
    } catch (error) {
        console.error('Error searching for seller:', error);
        statusDiv.className = 'seller-status error';
        statusDiv.innerHTML = '❌ Erreur lors de la vérification du compte.';
    }
}

async function persistTransactionInDatabase({ buyerIdLogin, counterpartyHandle, titre, cryptopaiement, montant, garantieperiode, isBuyerRole }) {
    if (String(cryptopaiement || '').trim().toUpperCase() !== ALLOWED_TRANSACTION_CRYPTO) {
        throw new Error(`Seules les transactions ${ALLOWED_TRANSACTION_CRYPTO} sont autorisées.`);
    }

    const response = await fetch(`${API_BASE_URL}/api/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            buyerIdLogin,
            buyerName: AppData.currentUser?.name || '',
            buyerMail: AppData.currentUser?.email || '',
            counterpartyHandle,
            titre,
            cryptopaiement,
            montant,
            garantieperiode,
            isBuyerRole
        })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
        throw new Error(payload.message || 'Impossible d\'enregistrer la transaction en base.');
    }

    return payload.transaction;
}

async function updateTransactionStatusInDatabase(dbTransactionId, statut) {
    if (!dbTransactionId) return;

    const response = await fetch(`${API_BASE_URL}/api/transactions/${encodeURIComponent(dbTransactionId)}/statut`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ statut })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
        throw new Error(payload.message || 'Impossible de mettre à jour le statut en base.');
    }
}

async function updateTransactionAmountInDatabase(dbTransactionId, montant) {
    if (!dbTransactionId) return;

    const response = await fetch(`${API_BASE_URL}/api/transactions/${encodeURIComponent(dbTransactionId)}/montant`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ montant })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
        throw new Error(payload.message || 'Impossible de mettre à jour le montant en base.');
    }
}

async function updateTransactionWalletsInDatabase(dbTransactionId, walletVendeurEvm, walletVendeurPhantom) {
    if (!dbTransactionId) return;

    const response = await fetch(`${API_BASE_URL}/api/transactions/${encodeURIComponent(dbTransactionId)}/wallets`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletVendeurEvm, walletVendeurPhantom })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
        throw new Error(payload.message || 'Impossible de mettre à jour les wallets vendeur en base.');
    }
}

async function updateTransactionEngagementsInDatabase(dbTransactionId, engagementAcheteur, engagementVendeur) {
    if (!dbTransactionId) return;

    const response = await fetch(`${API_BASE_URL}/api/transactions/${encodeURIComponent(dbTransactionId)}/engagements`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engagementAcheteur, engagementVendeur })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
        throw new Error(payload.message || 'Impossible de mettre à jour les engagements en base.');
    }
}

async function updateTransactionContractValidationInDatabase(dbTransactionId, validationAcheteur, validationVendeur) {
    if (!dbTransactionId) return;

    const response = await fetch(`${API_BASE_URL}/api/transactions/${encodeURIComponent(dbTransactionId)}/validation-contrat`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ validationAcheteur, validationVendeur })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
        throw new Error(payload.message || 'Impossible de mettre à jour la validation du contrat en base.');
    }
}

async function signTransactionInDatabase(dbTransactionId, role, signatureDataUrl) {
    if (!dbTransactionId) return null;

    const response = await fetch(`${API_BASE_URL}/api/transactions/${encodeURIComponent(dbTransactionId)}/sign-contract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            role,
            signatureDataUrl,
            senderIdLogin: AppData.currentUser?.id || ''
        })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
        throw new Error(payload.message || 'Impossible de signer le contrat.');
    }

    return payload;
}

async function generateContractPdfInDatabase(dbTransactionId) {
    if (!dbTransactionId) return null;

    const response = await fetch(`${API_BASE_URL}/api/transactions/${encodeURIComponent(dbTransactionId)}/generate-contract-pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ senderIdLogin: AppData.currentUser?.id || '' })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
        throw new Error(payload.message || 'Impossible de générer le contrat PDF.');
    }

    return payload;
}

async function ensureConversationForTransaction({ transactionId, buyerIdLogin, sellerIdLogin, senderIdLogin }) {
    const response = await fetch(`${API_BASE_URL}/api/conversations/from-transaction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            transactionId,
            buyerIdLogin,
            sellerIdLogin,
            senderIdLogin
        })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
        throw new Error(payload.message || 'Impossible de créer la conversation.');
    }

    return payload;
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function normalizeHandleValue(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return '';
    return raw.startsWith('@') ? raw.slice(1) : raw;
}

function formatDateTime(value) {
    const millis = toMillis(value);
    if (!millis) return '-';
    return new Date(millis).toLocaleString('fr-FR');
}

async function loadCurrentUserProfileFromDatabase() {
    const idLogin = String(AppData.currentUser?.id || '').trim();
    if (!idLogin) return null;

    const response = await fetch(`${API_BASE_URL}/api/users/id-login/${encodeURIComponent(idLogin)}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok || !payload.user) {
        throw new Error(payload.message || 'Impossible de charger votre profil.');
    }

    return payload.user;
}

async function updateCurrentUserReferralInDatabase(parrainHandle) {
    const idLogin = String(AppData.currentUser?.id || '').trim();
    if (!idLogin) throw new Error('Utilisateur non connecté.');

    const response = await fetch(`${API_BASE_URL}/api/users/${encodeURIComponent(idLogin)}/profile`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parrainHandle })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
        throw new Error(payload.message || 'Impossible de mettre à jour le code parrain.');
    }

    return payload;
}

async function verifyHandleExists(handle) {
    const normalized = normalizeHandleValue(handle);
    if (!normalized) return { ok: false, message: 'Handle vide.' };

    const response = await fetch(`${API_BASE_URL}/api/users/handle/${encodeURIComponent(normalized)}`);
    const payload = await response.json().catch(() => ({}));

    if (response.ok && payload.ok && payload.user) {
        return { ok: true, handle: normalized, user: payload.user };
    }

    if (response.status === 404) {
        return { ok: false, message: `Aucun utilisateur trouvé avec @${normalized}.` };
    }

    return { ok: false, message: payload.message || 'Vérification du handle impossible.' };
}

async function openProfileEditor() {
    if (!AppData.currentUser?.id) {
        alert('❌ Utilisateur non connecté.');
        return;
    }

    let profile;
    try {
        profile = await loadCurrentUserProfileFromDatabase();
    } catch (error) {
        alert(`❌ ${error.message}`);
        return;
    }

    const currentName = String(profile.Name || AppData.currentUser.name || '').trim();
    const currentHandle = normalizeHandleValue(profile.handle || '');
    const currentEmail = String(profile.mail || profile.email || AppData.currentUser.email || '').trim();
    const currentIdLogin = String(profile.id_login || profile.id || AppData.currentUser.id || '').trim();
    const currentReputation = String(profile['réputation'] ?? profile.reputation ?? '-').trim() || '-';
    const currentReferral = normalizeHandleValue(profile.parrainHandle || '') || DEFAULT_REFERRAL_HANDLE;
    const affiliations = Array.isArray(profile.affiliations) ? profile.affiliations : [];

    const overlay = document.createElement('div');
    overlay.className = 'profile-overlay';

    const box = document.createElement('div');
    box.className = 'profile-modal';

    const affiliationsHtml = affiliations.length === 0
        ? '<div class="profile-affiliations-empty">Aucune affiliation enregistrée.</div>'
        : affiliations.map(item => {
            const parrain = normalizeHandleValue(item.parrainHandle || '-');
            const dateDebut = formatDateTime(item['dateDébut']);
            const dateFin = item['dateFin'] === null ? 'Active' : formatDateTime(item['dateFin']);
            return `
                <div class="profile-affiliation-item">
                    <div class="profile-affiliation-top"><strong>Parrain:</strong> ${parrain ? '@' + escapeHtml(parrain) : '-'}</div>
                    <div class="profile-affiliation-meta"><strong>Début:</strong> ${escapeHtml(dateDebut)} | <strong>Fin:</strong> ${escapeHtml(dateFin)}</div>
                </div>
            `;
        }).join('');

    box.innerHTML = `
        <div class="profile-modal-header">
            <div class="profile-modal-title">Mon profil</div>
            <button type="button" class="button secondary profile-close-btn" id="profile-close-btn">Fermer</button>
        </div>

        <div class="content-grid profile-grid">
            <div class="card profile-card">
                <div class="card-title profile-card-title">Informations utilisateur</div>
                <div class="profile-user-info">
                    <div><strong>Nom:</strong> ${escapeHtml(currentName || '-')}</div>
                    <div><strong>Handle:</strong> ${currentHandle ? '@' + escapeHtml(currentHandle) : '-'}</div>
                    <div><strong>Email:</strong> ${escapeHtml(currentEmail || '-')}</div>
                    <div><strong>ID login:</strong> ${escapeHtml(currentIdLogin || '-')}</div>
                    <div><strong>Réputation:</strong> ${escapeHtml(currentReputation)}</div>
                </div>
            </div>

            <div class="card profile-card">
                <div class="card-title profile-card-title">Modifier le code parrain</div>
                <div class="form-group profile-compact-form-group">
                    <label class="profile-compact-label">Code parrain actuel</label>
                    <input id="profile-current-referral" type="text" readonly value="${currentReferral ? '@' + escapeHtml(currentReferral) : '-'}">
                </div>
                <div class="form-group profile-compact-form-group">
                    <label class="profile-compact-label">Nouveau code parrain (handle)</label>
                    <div class="profile-referral-row">
                        <input id="profile-new-referral" type="text" placeholder="Ex : pierre110" value="${escapeHtml(currentReferral)}">
                        <button type="button" class="button secondary profile-verify-btn" id="profile-verify-referral">Vérifier</button>
                    </div>
                </div>
                <div id="profile-referral-status" class="seller-status profile-referral-status hidden"></div>
                <button type="button" class="button success profile-save-btn" id="profile-save-referral">Enregistrer code parrain</button>
            </div>
        </div>

        <div class="card profile-card">
            <div class="card-title profile-card-title">Historique affiliations</div>
            ${affiliationsHtml}
        </div>

        <div class="profile-actions-row">
            <button type="button" class="button danger profile-logout-btn" id="profile-logout-btn">Se déconnecter</button>
        </div>
    `;

    const close = () => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };

    const statusEl = box.querySelector('#profile-referral-status');
    const newReferralInput = box.querySelector('#profile-new-referral');

    const applyProfileReferralStyle = () => {
        if (!newReferralInput) return;
        const normalized = normalizeHandleValue(newReferralInput.value || '');
        newReferralInput.classList.toggle('is-default-referral', normalized === DEFAULT_REFERRAL_HANDLE);
    };

    const setStatus = (kind, message) => {
        if (!statusEl) return;
        showElement(statusEl);
        statusEl.className = `seller-status ${kind}`;
        statusEl.textContent = message;
    };

    const verifyNewReferral = async () => {
        const normalized = normalizeHandleValue(newReferralInput?.value || '');
        if (newReferralInput) {
            newReferralInput.value = normalized || DEFAULT_REFERRAL_HANDLE;
            applyProfileReferralStyle();
        }

        const normalizedWithDefault = normalized || DEFAULT_REFERRAL_HANDLE;

        if (normalizedWithDefault === currentHandle) {
            setStatus('error', '❌ Le code parrain ne peut pas être votre propre handle.');
            return null;
        }

        setStatus('loading', '⏳ Vérification du handle...');
        const check = await verifyHandleExists(normalizedWithDefault);
        if (!check.ok) {
            setStatus('error', `❌ ${check.message}`);
            return null;
        }

        const displayName = check.user?.Name || check.user?.mail || check.user?.email || normalizedWithDefault;
        setStatus('success', `✅ Parrain trouvé: ${displayName} (@${normalizedWithDefault})`);
        return normalizedWithDefault;
    };

    box.querySelector('#profile-close-btn')?.addEventListener('click', close);
    box.querySelector('#profile-verify-referral')?.addEventListener('click', verifyNewReferral);
    newReferralInput?.addEventListener('input', () => {
        applyProfileReferralStyle();
        if (!statusEl) return;
        statusEl.className = 'seller-status';
        hideElement(statusEl);
        statusEl.textContent = '';
    });

    box.querySelector('#profile-save-referral')?.addEventListener('click', async () => {
        const verified = await verifyNewReferral();
        if (!verified) return;

        try {
            await updateCurrentUserReferralInDatabase(verified);
            AppData.currentUser.parrainHandle = verified;
            saveData();
            setStatus('success', `✅ Code parrain mis à jour: @${verified}`);
        } catch (error) {
            setStatus('error', `❌ ${error.message}`);
        }
    });

    box.querySelector('#profile-logout-btn')?.addEventListener('click', () => {
        close();
        logout();
    });

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) close();
    });

    applyProfileReferralStyle();

    overlay.appendChild(box);
    document.body.appendChild(overlay);
}

async function getEthersLibrary() {
    if (typeof window !== 'undefined' && window.ethers) {
        return window.ethers;
    }

    if (!ethersImportPromise) {
        ethersImportPromise = import('https://cdn.jsdelivr.net/npm/ethers@6.13.4/+esm')
            .then(module => module.ethers || module);
    }

    return ethersImportPromise;
}

async function downloadConversationAttachment(encodedUrl, encodedName) {
    try {
        const url = decodeURIComponent(String(encodedUrl || ''));
        const fileName = decodeURIComponent(String(encodedName || 'piece-jointe'));
        if (!url) throw new Error('Référence de fichier introuvable.');

        const downloadUrl = `${API_BASE_URL}/api/attachments/download?reference=${encodeURIComponent(url)}&fileName=${encodeURIComponent(fileName)}`;
        const link = document.createElement('a');
        link.href = downloadUrl;
        link.download = fileName || 'piece-jointe';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    } catch (error) {
        alert(`❌ ${error.message}`);
    }
}

async function loadConversationMessages(conversationId) {
    const response = await fetch(`${API_BASE_URL}/api/conversations/${encodeURIComponent(conversationId)}/messages`);
    const payload = await response.json().catch(() => ({}));

    if (!response.ok || !payload.ok) {
        throw new Error(payload.message || 'Impossible de charger les messages.');
    }

    return Array.isArray(payload.messages) ? payload.messages : [];
}

async function sendConversationMessage(conversationId, text) {
    return sendConversationPayload(conversationId, { text });
}

async function sendConversationPayload(conversationId, payloadData) {
    const text = String(payloadData?.text || '').trim();
    const reference = String(payloadData?.reference || '').trim();
    const attachmentName = String(payloadData?.attachmentName || '').trim();
    const attachmentType = String(payloadData?.attachmentType || '').trim();
    const attachmentSize = Number(payloadData?.attachmentSize || 0);

    const body = {
        senderIdLogin: AppData.currentUser?.id || '',
        text
    };

    if (reference) {
        body.reference = reference;
        if (attachmentName) body.attachmentName = attachmentName;
        if (attachmentType) body.attachmentType = attachmentType;
        if (Number.isFinite(attachmentSize) && attachmentSize > 0) {
            body.attachmentSize = attachmentSize;
        }
    }

    const response = await fetch(`${API_BASE_URL}/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
        throw new Error(payload.message || 'Impossible d\'envoyer le message.');
    }

    return payload.message;
}

async function uploadAttachmentToFirebaseStorage(file, escrow) {
    if (!file) {
        throw new Error('Aucun fichier sélectionné.');
    }

    const toBase64 = (inputFile) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Impossible de lire le fichier.'));
        reader.readAsDataURL(inputFile);
    });

    const base64Data = await toBase64(file);
    const conversationToken = String(escrow.conversationId || 'conversation').trim();

    const response = await fetch(`${API_BASE_URL}/api/conversations/${encodeURIComponent(conversationToken)}/attachments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            senderIdLogin: String(AppData.currentUser?.id || ''),
            transactionId: String(escrow.dbTransactionId || ''),
            fileName: String(file.name || 'piece-jointe'),
            contentType: String(file.type || 'application/octet-stream'),
            base64Data
        })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
        throw new Error(payload.message || 'Impossible d\'uploader la pièce jointe.');
    }

    return {
        reference: payload.reference,
        attachmentName: payload.attachmentName || file.name || 'Pièce jointe',
        attachmentType: payload.attachmentType || file.type || 'application/octet-stream',
        attachmentSize: Number(payload.attachmentSize || file.size || 0)
    };
}

function renderConversationMessages(escrow, messages, participantHandles = {}) {
    const chatMessagesEl = document.getElementById(`chat-messages-${escrow.id}`);
    if (!chatMessagesEl) return;

    if (!Array.isArray(messages) || messages.length === 0) {
        chatMessagesEl.innerHTML = '<div class="chat-empty">Aucun message pour le moment.</div>';
        return;
    }

    const buyerHandle = normalizeHandleValue(participantHandles.buyerHandle);
    const sellerHandle = normalizeHandleValue(participantHandles.sellerHandle);
    const buyerIdToken = normalizeHandleValue(escrow.buyerIdLogin || '');
    const sellerIdToken = normalizeHandleValue(escrow.sellerIdLogin || '');
    const buyerTokens = [buyerHandle, buyerIdToken].filter(Boolean);
    const sellerTokens = [sellerHandle, sellerIdToken].filter(Boolean);

    const sortedMessages = [...messages].sort((a, b) => {
        const aTime = toMillis(a?.createdAt) ?? 0;
        const bTime = toMillis(b?.createdAt) ?? 0;
        return bTime - aTime;
    });

    chatMessagesEl.innerHTML = sortedMessages.map((msg) => {
        const sender = normalizeHandleValue(msg.senderId || '');
        const isBuyerMessage = buyerTokens.includes(sender);
        const isSellerMessage = sellerTokens.includes(sender);
        const senderLabel = isBuyerMessage ? 'Acheteur' : (isSellerMessage ? 'Vendeur' : 'Participant');
        const messageRoleClass = isBuyerMessage ? 'buyer' : (isSellerMessage ? 'seller' : 'other');
        const dateValue = toMillis(msg.createdAt) ?? Date.now();
        const attachmentName = String(msg.attachmentName || 'Pièce jointe');
        const attachmentUrl = String(msg.reference || '');
        const encodedAttachmentName = encodeURIComponent(attachmentName);
        const encodedAttachmentUrl = encodeURIComponent(attachmentUrl);

        return `
            <div class="chat-row ${messageRoleClass}">
                <div class="chat-bubble ${messageRoleClass}">
                    <div class="chat-sender ${messageRoleClass}">${senderLabel}</div>
                    <div class="chat-text">${escapeHtml(msg.text || '')}</div>
                    ${msg.reference ? `<div class="chat-attachment-row"><button type="button" class="button secondary chat-attachment-btn" onclick="downloadConversationAttachment('${encodedAttachmentUrl}','${encodedAttachmentName}')">📎 Télécharger ${escapeHtml(attachmentName)}</button></div>` : ''}
                    <div class="chat-time">${new Date(dateValue).toLocaleString('fr-FR')}</div>
                </div>
            </div>
        `;
    }).join('');

    chatMessagesEl.scrollTop = 0;
}

async function resolveUserHandleByIdLogin(idLogin, fallbackValue = '') {
    const normalizedId = String(idLogin || '').trim();
    if (!normalizedId) return normalizeHandleValue(fallbackValue);

    if (userHandleCacheByIdLogin[normalizedId] !== undefined) {
        return userHandleCacheByIdLogin[normalizedId];
    }

    try {
        const response = await fetch(`${API_BASE_URL}/api/users/id-login/${encodeURIComponent(normalizedId)}`);
        const payload = await response.json().catch(() => ({}));
        if (response.ok && payload.ok && payload.user) {
            const resolvedHandle = normalizeHandleValue(payload.user.handle || fallbackValue);
            userHandleCacheByIdLogin[normalizedId] = resolvedHandle;
            return resolvedHandle;
        }
    } catch (error) {
        console.error('Error resolving user handle by id_login:', error);
    }

    const fallback = normalizeHandleValue(fallbackValue || normalizedId);
    userHandleCacheByIdLogin[normalizedId] = fallback;
    return fallback;
}

async function refreshEscrowConversation(escrowId) {
    const escrow = AppData.escrows.find(e => e.id === escrowId);
    if (!escrow || !escrow.conversationId) return;

    try {
        const buyerHandle = await resolveUserHandleByIdLogin(escrow.buyerIdLogin, escrow.buyer);
        const sellerHandle = await resolveUserHandleByIdLogin(escrow.sellerIdLogin, escrow.seller);
        const messages = await loadConversationMessages(escrow.conversationId);
        renderConversationMessages(escrow, messages, { buyerHandle, sellerHandle });
    } catch (error) {
        const chatMessagesEl = document.getElementById(`chat-messages-${escrow.id}`);
        if (chatMessagesEl) {
            chatMessagesEl.innerHTML = `<div class="chat-error">❌ ${escapeHtml(error.message)}</div>`;
        }
    }
}

async function submitEscrowMessage(escrowId) {
    const escrow = AppData.escrows.find(e => e.id === escrowId);
    if (!escrow) return;

    if (!escrow.conversationId) {
        try {
            const conv = await ensureConversationForTransaction({
                transactionId: escrow.dbTransactionId || '',
                buyerIdLogin: escrow.buyerIdLogin || '',
                sellerIdLogin: escrow.sellerIdLogin || '',
                senderIdLogin: AppData.currentUser?.id || ''
            });
            escrow.conversationId = conv?.conversationId || '';
            saveData();
        } catch (error) {
            alert(`❌ ${error.message || 'Conversation introuvable.'}`);
            return;
        }
    }

    if (!escrow.conversationId) {
        alert('❌ Conversation introuvable.');
        return;
    }

    const textInputEl = document.getElementById(`chat-input-${escrow.id}`);
    const fileInputEl = document.getElementById(`chat-file-${escrow.id}`);
    const text = String(textInputEl?.value || '').trim();
    const hasFile = !!(fileInputEl && fileInputEl.files && fileInputEl.files.length > 0);

    if (!text && !hasFile) {
        alert('❌ Saisissez un message ou joignez un fichier.');
        return;
    }

    try {
        if (hasFile) {
            const file = fileInputEl.files[0];
            const uploadData = await uploadAttachmentToFirebaseStorage(file, escrow);
            await sendConversationPayload(escrow.conversationId, {
                text,
                reference: uploadData.reference,
                attachmentName: uploadData.attachmentName,
                attachmentType: uploadData.attachmentType,
                attachmentSize: uploadData.attachmentSize
            });
        } else {
            await sendConversationMessage(escrow.conversationId, text);
        }

        if (fileInputEl) fileInputEl.value = '';
        if (textInputEl) textInputEl.value = '';
        await refreshEscrowConversation(escrowId);
    } catch (error) {
        alert(`❌ ${error.message}`);
    }
}

function handleEscrowChatEnter(event, escrowId) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    submitEscrowMessage(escrowId);
}

async function renderEscrowConversationWindow(escrow) {
    const chatEl = document.getElementById('detail-chat-block');
    if (!chatEl) return;

    if (!isChatEnabledForStatus(escrow.status)) {
        chatEl.innerHTML = `<div class="alert alert-info">ℹ️ Le tchat sera disponible à partir de l'étape Configurer.</div>`;
        return;
    }

    if (!escrow.conversationId) {
        const conv = await ensureConversationForTransaction({
            transactionId: escrow.dbTransactionId || '',
            buyerIdLogin: escrow.buyerIdLogin || '',
            sellerIdLogin: escrow.sellerIdLogin || '',
            senderIdLogin: AppData.currentUser.id
        });
        escrow.conversationId = conv?.conversationId || '';
        saveData();
    }

    chatEl.innerHTML = `
        <div class="form-group mt-05">
            <label>Salon de discussion privée</label>
            <div id="chat-messages-${escrow.id}" class="chat-messages"></div>
            <input id="chat-file-${escrow.id}" type="file" class="chat-file-input">
            <div class="chat-input-row">
                <input id="chat-input-${escrow.id}" type="text" placeholder="Écrire un message..." onkeydown="handleEscrowChatEnter(event, ${escrow.id})">
                <button class="button success chat-send-btn" type="button" onclick="submitEscrowMessage(${escrow.id})">Envoyer</button>
            </div>
        </div>
    `;

    await refreshEscrowConversation(escrow.id);
}

async function resolveUserNameByIdLogin(idLogin, fallbackValue) {
    const normalizedId = String(idLogin || '').trim();
    if (!normalizedId) return fallbackValue || '-';

    if (userNameCacheByIdLogin[normalizedId]) {
        return userNameCacheByIdLogin[normalizedId];
    }

    try {
        const response = await fetch(`${API_BASE_URL}/api/users/id-login/${encodeURIComponent(normalizedId)}`);
        const payload = await response.json();

        if (response.ok && payload.ok && payload.user) {
            const user = payload.user;
            const name = user.Name || fallbackValue || normalizedId;
            userNameCacheByIdLogin[normalizedId] = name;
            return name;
        }
    } catch (error) {
        console.error('Error resolving user name by id_login:', error);
    }

    return fallbackValue || normalizedId;
}

// ============ INIT ============
document.addEventListener('DOMContentLoaded', () => {
    loadData();
    loadSolanaTokenList();
    setupSelectOverlay();

    if (typeof firebase !== 'undefined') {
        firebase.auth().onAuthStateChanged(user => {
            if (user) {
                const displayName = user.displayName && user.displayName.trim()
                    ? user.displayName
                    : (user.email ? user.email.split('@')[0] : '');

                AppData.currentUser = {
                    id: user.uid,
                    name: displayName,
                    email: user.email,
                    avatar: displayName ? _getInitials(displayName) : (user.email ? user.email[0].toUpperCase() : ''),
                    role: 'buyer'
                };
                updateUserUI();
                initCurrentPage();
            } else {
                window.location.href = 'login.html';
            }
        });
    } else {
        if (!AppData.currentUser || !AppData.currentUser.name) {
            window.location.href = 'login.html';
            return;
        }
        updateUserUI();
        initCurrentPage();
    }
});

/** Detect which page we're on and run the matching initialisation. */
async function initCurrentPage() {
    try {
        const profile = await loadCurrentUserProfileFromDatabase();
        if (profile && AppData.currentUser) {
            AppData.currentUser.name = String(profile.Name || AppData.currentUser.name || '').trim() || AppData.currentUser.name;
            AppData.currentUser.email = String(profile.mail || profile.email || AppData.currentUser.email || '').trim() || AppData.currentUser.email;
            AppData.currentUser.handle = normalizeHandleValue(profile.handle || AppData.currentUser.handle || '');
            AppData.currentUser.parrainHandle = normalizeHandleValue(profile.parrainHandle || AppData.currentUser.parrainHandle || '');
            updateUserUI();
        }
    } catch (error) {
        console.warn('Profil utilisateur non chargé:', error.message);
    }

    await loadTransactionsFromDatabase();

    if (document.getElementById('dashboard'))    updateDashboard();
    if (document.getElementById('escrows'))      displayEscrows();
    if (document.getElementById('admin'))        updateAdmin();
    if (document.getElementById('create'))       setCounterpartyRole(true);
    if (document.getElementById('dashboard'))    await renderDashboardRecentTransactionsFromDatabase();

    // Pending payment: navigated here from the dashboard quick-create form
    const pendingPayment = sessionStorage.getItem('ofm_pending_payment');
    if (pendingPayment && document.getElementById('payment')) {
        sessionStorage.removeItem('ofm_pending_payment');
        showPayment(parseInt(pendingPayment));
    }

    // Pending detail: navigated here from the dashboard recent-escrows list
    const pendingDetail = sessionStorage.getItem('ofm_pending_detail');
    if (pendingDetail && document.getElementById('escrow-detail')) {
        sessionStorage.removeItem('ofm_pending_detail');
        showEscrowDetail(parseInt(pendingDetail));
        return;
    }

    await openSharedTransactionFromUrl();
}

function setCounterpartyRole(isBuyer) {
    isBuyerRole = !!isBuyer;

    const hidden = document.getElementById('is-buyer-input');
    if (hidden) hidden.value = isBuyerRole ? 'true' : 'false';

    const buyerBtn = document.getElementById('role-buyer-btn');
    const sellerBtn = document.getElementById('role-seller-btn');
    const handleLabel = document.getElementById('counterparty-handle-label');

    if (handleLabel) {
        handleLabel.textContent = isBuyerRole
            ? '👤 Renseigner le nom d\'utilisateur du vendeur'
            : '👤 Renseigner le nom d\'utilisateur de l\'acheteur';
    }

    if (!buyerBtn || !sellerBtn) return;

    buyerBtn.className = isBuyerRole ? 'button success' : 'button secondary';
    sellerBtn.className = isBuyerRole ? 'button secondary' : 'button success';
}

async function loadTransactionsFromDatabase() {
    if (!AppData.currentUser || !AppData.currentUser.id) return;

    try {
        const response = await fetch(`${API_BASE_URL}/api/transactions?userIdLogin=${encodeURIComponent(AppData.currentUser.id)}`);
        const payload = await response.json();
        if (!response.ok || !payload.ok || !Array.isArray(payload.transactions)) return;

        const existingByDbId = new Map(
            AppData.escrows
                .filter(escrow => escrow.dbTransactionId)
                .map(escrow => [String(escrow.dbTransactionId), escrow])
        );

        payload.transactions.forEach(transaction => {
            const txId = String(transaction.id || '');
            if (!txId) return;

            const createdAt = toMillis(transaction.datecreation) ?? Date.now();
            const guaranteeHours = Number(transaction.garantieperiode) || 48;
            const buyerId = String(transaction.acheteur || '').trim();
            const sellerId = String(transaction.vendeur || '').trim();
            const initiatorId = String(transaction.initiateur || '').trim();
            const buyerName = String(transaction.acheteur_name || '').trim();
            const sellerName = String(transaction.vendeur_name || '').trim();

            const mappedFields = {
                dbTransactionId: txId,
                initiatorIdLogin: initiatorId,
                buyerIdLogin: buyerId,
                sellerIdLogin: sellerId,
                contractSignedBuyer: !!transaction.signatureAcheteurAt,
                contractSignedSeller: !!transaction.signatureVendeurAt,
                signedContractHash: String(transaction.preuveHashBlockchain || '').trim(),
                engagementText: String(transaction.engagementVendeur || '').trim(),
                engagementBuyerText: String(transaction.engagementAcheteur || '').trim(),
                sellerEngagementSaved: !!String(transaction.engagementVendeur || '').trim(),
                buyerEngagementSaved: !!String(transaction.engagementAcheteur || '').trim(),
                contractValidatedBuyer: !!transaction.validationAcheteur,
                contractValidatedSeller: !!transaction.validationVendeur,
                sellerWalletAddress: String(transaction.walletVendeurEvm || '').trim(),
                sellerWalletConnected: !!String(transaction.walletVendeurEvm || '').trim(),
                sellerSolanaWalletAddress: String(transaction.walletVendeurPhantom || '').trim(),
                sellerSolanaWalletConnected: !!String(transaction.walletVendeurPhantom || '').trim(),
                walletIdsSaved: !!String(transaction.walletVendeurEvm || '').trim() || !!String(transaction.walletVendeurPhantom || '').trim(),
                datecreation: createdAt,
                amount: Number(transaction.montant) || 0,
                crypto: transaction.cryptopaiement || ALLOWED_TRANSACTION_CRYPTO,
                title: transaction.titre || 'Transaction',
                isBuyerRole: buyerId === AppData.currentUser.id,
                status: transaction.statut || 'En attente',
                buyer: buyerName || (buyerId === AppData.currentUser.id ? AppData.currentUser.name : (buyerId || 'Acheteur')),
                seller: sellerName || (sellerId === AppData.currentUser.id ? AppData.currentUser.name : (sellerId || 'Vendeur')),
                buyerEmail: AppData.currentUser.email || '',
                sellerEmail: '',
                description: transaction.titre || 'Transaction',
                created: createdAt,
                expires: createdAt + (guaranteeHours * 3_600_000)
            };

            const existing = existingByDbId.get(txId);
            if (existing) {
                Object.assign(existing, mappedFields);
                if (!Array.isArray(existing.timeline) || existing.timeline.length === 0) {
                    existing.timeline = [{ status: 'created', time: createdAt, label: 'Transaction importée depuis la base' }];
                }
                return;
            }

            AppData.escrows.push({
                id: AppData.nextEscrowId++,
                ...mappedFields,
                timeline: [{ status: 'created', time: createdAt, label: 'Transaction importée depuis la base' }]
            });
        });

        saveData();
    } catch (error) {
        console.error('Error loading transactions from database:', error);
    }
}

function buildTransactionShareUrl(escrow) {
    const baseUrl = new URL('transactions.html', window.location.href);
    if (escrow.dbTransactionId) {
        baseUrl.searchParams.set('tx', String(escrow.dbTransactionId));
    } else {
        baseUrl.searchParams.set('escrow', String(escrow.id));
    }
    return baseUrl.toString();
}

async function copyTransactionShareLink(escrowId) {
    const escrow = AppData.escrows.find(item => item.id === escrowId);
    if (!escrow) {
        alert('❌ Transaction introuvable.');
        return;
    }

    const url = buildTransactionShareUrl(escrow);
    try {
        await navigator.clipboard.writeText(url);
        alert('✅ Lien de partage copié.');
    } catch (_error) {
        alert('❌ Impossible de copier le lien.');
    }
}

async function openSharedTransactionFromUrl() {
    if (!document.getElementById('escrow-detail')) return;

    const params = new URLSearchParams(window.location.search);
    const txId = String(params.get('tx') || '').trim();
    const localEscrowId = parseInt(params.get('escrow') || '', 10);

    if (txId) {
        let escrow = AppData.escrows.find(item => String(item.dbTransactionId || '') === txId);

        if (!escrow) {
            try {
                const response = await fetch(`${API_BASE_URL}/api/transactions/${encodeURIComponent(txId)}`);
                const payload = await response.json();

                if (response.ok && payload.ok && payload.transaction) {
                    const transaction = payload.transaction;
                    const createdAt = toMillis(transaction.datecreation) ?? Date.now();
                    const guaranteeHours = Number(transaction.garantieperiode) || 48;
                    const buyerId = String(transaction.acheteur || '').trim();
                    const sellerId = String(transaction.vendeur || '').trim();
                    const initiatorId = String(transaction.initiateur || '').trim();
                    const buyerName = String(transaction.acheteur_name || '').trim();
                    const sellerName = String(transaction.vendeur_name || '').trim();

                    escrow = {
                        id: AppData.nextEscrowId++,
                        dbTransactionId: txId,
                        initiatorIdLogin: initiatorId,
                        buyerIdLogin: buyerId,
                        sellerIdLogin: sellerId,
                        contractSignedBuyer: !!transaction.signatureAcheteurAt,
                        contractSignedSeller: !!transaction.signatureVendeurAt,
                        signedContractHash: String(transaction.preuveHashBlockchain || '').trim(),
                        engagementText: String(transaction.engagementVendeur || '').trim(),
                        engagementBuyerText: String(transaction.engagementAcheteur || '').trim(),
                        sellerEngagementSaved: !!String(transaction.engagementVendeur || '').trim(),
                        buyerEngagementSaved: !!String(transaction.engagementAcheteur || '').trim(),
                        contractValidatedBuyer: !!transaction.validationAcheteur,
                        contractValidatedSeller: !!transaction.validationVendeur,
                        sellerWalletAddress: String(transaction.walletVendeurEvm || '').trim(),
                        sellerWalletConnected: !!String(transaction.walletVendeurEvm || '').trim(),
                        sellerSolanaWalletAddress: String(transaction.walletVendeurPhantom || '').trim(),
                        sellerSolanaWalletConnected: !!String(transaction.walletVendeurPhantom || '').trim(),
                        walletIdsSaved: !!String(transaction.walletVendeurEvm || '').trim() || !!String(transaction.walletVendeurPhantom || '').trim(),
                        datecreation: createdAt,
                        amount: Number(transaction.montant) || 0,
                        crypto: transaction.cryptopaiement || ALLOWED_TRANSACTION_CRYPTO,
                        title: transaction.titre || 'Transaction',
                        isBuyerRole: buyerId === AppData.currentUser.id,
                        status: transaction.statut || 'En attente',
                        buyer: buyerName || (buyerId || 'Acheteur'),
                        seller: sellerName || (sellerId || 'Vendeur'),
                        buyerEmail: '',
                        sellerEmail: '',
                        description: transaction.titre || 'Transaction',
                        created: createdAt,
                        expires: createdAt + (guaranteeHours * 3_600_000),
                        timeline: [{ status: 'created', time: createdAt, label: 'Transaction chargée via lien partagé' }]
                    };

                    AppData.escrows.push(escrow);
                    saveData();
                }
            } catch (error) {
                console.error('Error loading shared transaction:', error);
            }
        }

        if (escrow) {
            showEscrowDetail(escrow.id);
        }

        return;
    }

    if (!Number.isNaN(localEscrowId)) {
        const escrow = AppData.escrows.find(item => item.id === localEscrowId);
        if (escrow) showEscrowDetail(escrow.id);
    }
}

async function renderDashboardRecentTransactionsFromDatabase() {
    const recentEl = document.getElementById('recent-escrows');
    if (!recentEl) return;

    try {
        const response = await fetch(`${API_BASE_URL}/api/transactions`);
        const payload = await response.json();
        if (!response.ok || !payload.ok || !Array.isArray(payload.transactions)) return;

        const recentTransactions = payload.transactions
            .slice()
            .sort((a, b) => (toMillis(b.datecreation) ?? 0) - (toMillis(a.datecreation) ?? 0))
            .slice(0, 5);

        if (recentTransactions.length === 0) {
            recentEl.innerHTML = '<p class="text-muted">Aucune transaction pour le moment</p>';
            return;
        }

        recentEl.innerHTML = recentTransactions.map(tx => {
            const amount = Number(tx.montant) || 0;
            const crypto = tx.cryptopaiement || ALLOWED_TRANSACTION_CRYPTO;
            const price = cryptoPrices[crypto] || 1;
            const cryptoAmount = (amount / price).toFixed(3);
            const title = tx.titre || 'Transaction';
            const txDateCreation = toMillis(tx.datecreation);
            const createdLe = txDateCreation ? new Date(txDateCreation).toLocaleDateString('fr-FR') : '-';
            const buyerName = tx.acheteur_name || tx.acheteur || '-';
            const sellerName = tx.vendeur_name || tx.vendeur || '-';
            const statut = tx.statut || 'En attente';
            const badgeClass = statut === 'Accepté'
                ? 'status-released'
                : (statut === 'Refusé' ? 'status-dispute' : 'status-pending');
            const txId = String(tx.id || '').trim();
            const transactionDetailUrl = `transactions.html?tx=${encodeURIComponent(txId)}`;

            return `
                <div class="item item-clickable" onclick="window.location.href='${transactionDetailUrl}'">
                    <div class="item-header">
                        <div>
                            <div class="item-title">${title}</div>
                            <div class="item-subtitle">${cryptoAmount} ${crypto} = ${amount}€</div>
                        </div>
                        <div class="status-badge ${badgeClass}">${statut}</div>
                    </div>
                    <div class="item-meta">
                        <span>Acheteur: ${buyerName}</span>
                        <span>Vendeur: ${sellerName}</span>
                        <span>Créée le: ${createdLe}</span>
                    </div>
                </div>
            `;
        }).join('');
    } catch (error) {
        console.error('Error rendering dashboard DB transactions:', error);
    }
}

// ============ STORAGE ============
function saveData() {
    try {
        localStorage.setItem('ofm_pro_data', JSON.stringify(AppData));
    } catch (e) {
        console.log('LocalStorage unavailable');
    }
}

function loadData() {
    try {
        const saved = localStorage.getItem('ofm_pro_data');
        if (saved) Object.assign(AppData, JSON.parse(saved));
    } catch (e) {
        console.log('LocalStorage unavailable');
    }
}

// ============ UI / TAB NAVIGATION ============
/**
 * Show a tab.
 * If the tab exists on the current page → show it in place.
 * Otherwise → navigate to the page that hosts it.
 */
function switchTab(tabId) {
    const el = document.getElementById(tabId);

    if (!el) {
        // Tab lives on another page — redirect there
        window.location.href = PAGE_TABS[tabId] || 'index.html';
        return;
    }

    document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
    el.classList.add('active');
    window.scrollTo(0, 0);

    if (tabId === 'escrows') displayEscrows();
    if (tabId === 'admin')   updateAdmin();
}

// ============ USER / LOGIN HELPERS ============
function updateUserUI() {
    const userProfile = document.querySelector('.user-profile');
    const navLogin    = document.getElementById('nav-login');
    const navLogout   = document.getElementById('nav-logout');

    // ── Sidebar elements ──
    const sidebarAvatar  = document.getElementById('sidebarAvatar');
    const sidebarName    = document.getElementById('sidebarName');
    const topbarUserBtn  = document.getElementById('topbarUserBtn');

    if (AppData.currentUser) {
        const name     = AppData.currentUser.name || AppData.currentUser.email || 'Utilisateur';
        const initials = _getInitials(name);

        // Legacy top-nav (kept for non-shell pages)
        if (userProfile) {
            showElement(userProfile);
            const avatarEl = document.getElementById('userAvatar');
            const nameEl   = document.getElementById('userName');
            if (avatarEl) avatarEl.textContent = AppData.currentUser.avatar || initials;
            if (nameEl)   nameEl.textContent   = name;
            userProfile.onclick = () => { openProfileEditor(); };
        }

        // Sidebar profile
        if (sidebarAvatar) sidebarAvatar.textContent = initials;
        if (sidebarName)   sidebarName.textContent   = name;
        const sidebarSubLogin = document.getElementById('sidebarSub');
        if (sidebarSubLogin) sidebarSubLogin.textContent = 'Compte vérifié';
        if (topbarUserBtn) topbarUserBtn.textContent  = initials;

        hideElement(navLogin);
        showElement(navLogout);
    } else {
        hideElement(userProfile);
        showElement(navLogin);
        hideElement(navLogout);

        // Sidebar — état non connecté
        if (sidebarAvatar) sidebarAvatar.textContent = '?';
        if (sidebarName)   sidebarName.textContent   = 'Non connecté';
        const sidebarSubLogout = document.getElementById('sidebarSub');
        if (sidebarSubLogout) sidebarSubLogout.textContent = 'Cliquer pour se connecter';
        if (topbarUserBtn) topbarUserBtn.textContent  = '?';
    }
}

function _getInitials(name) {
    return name.split(' ').map(w => w[0]).join('').toUpperCase();
}

function logout() {
    if (typeof firebase !== 'undefined') {
        firebase.auth().signOut().then(() => {
            AppData.currentUser = null;
            window.location.href = 'login.html';
        });
    } else {
        AppData.currentUser = null;
        saveData();
        window.location.href = 'login.html';
    }
}

function assertLoggedIn() {
    if (!AppData.currentUser || !AppData.currentUser.name) {
        alert('❌ Veuillez vous connecter.');
        window.location.href = 'login.html';
        return false;
    }
    return true;
}

// ============ AMOUNT HELPERS ============
function updateAmountInfo() {
    const cryptoEl = document.getElementById('crypto-select');
    const amountEl = document.getElementById('amount-input');
    if (!cryptoEl || !amountEl) return;

    const crypto  = cryptoEl.value;
    const amount  = parseFloat(amountEl.value) || 0;
    const cryptoAmount = (amount / cryptoPrices[crypto]).toFixed(6);

    const info     = document.getElementById('amount-info');
    const infoText = document.getElementById('amount-info-text');
    if (!info || !infoText) return;
    showElement(info);
    infoText.textContent = `${amount} EUR = ${cryptoAmount} ${crypto}`;
}

function updateCreateInfo() {
    const cryptoEl = document.getElementById('create-crypto');
    const amountEl = document.getElementById('create-amount');
    if (!cryptoEl || !amountEl) return;

    const crypto  = cryptoEl.value;
    const amount  = parseFloat(amountEl.value) || 0;
    const cryptoAmount = (amount / cryptoPrices[crypto]).toFixed(6);
    const commission   = (amount * 0.05).toFixed(2);
    const vendorGets   = amount.toFixed(2);

    const info    = document.getElementById('create-info');
    const summary = document.getElementById('create-summary');
    if (!info || !summary) return;

    showElement(info);
    document.getElementById('create-info-text').textContent = `Vous enverrez: ${cryptoAmount} ${crypto}`;

    showElement(summary);
    document.getElementById('create-summary-content').innerHTML = `
        <div>Total: ${amount}€ en ${crypto}</div>
        <div>Commission (5%): ${commission}€ → Vous</div>
        <div>Vendeur Reçoit: ${vendorGets}€</div>
    `;
}

// ============ ESCROW CREATION (Dashboard quick form) ============
async function createEscrow() {
    if (!assertLoggedIn()) return;

    const sellerInput = document.getElementById('seller-input');
    if (!sellerInput) { alert('❌ Champ vendeur introuvable'); return; }
    const sellerName = sellerInput.dataset.sellerName || sellerInput.value.trim();
    const sellerEmail = sellerInput.dataset.sellerEmail || '';
    if (!sellerName) { alert('❌ Veuillez renseigner un vendeur'); return; }
    const sellerHandleRaw = sellerInput.dataset.sellerHandle || sellerInput.value.trim();
    const sellerHandle = sellerHandleRaw.startsWith('@') ? sellerHandleRaw.slice(1) : sellerHandleRaw;
    const crypto    = document.getElementById('crypto-select').value;
    const amount    = parseFloat(document.getElementById('amount-input').value);
    const guarantee = parseInt(document.getElementById('guarantee-select').value);
    const titleEl = document.getElementById('transaction-title');
    const title = titleEl ? titleEl.value.trim() : '';
    const isBuyerInput = document.getElementById('is-buyer-input');
    const roleIsBuyer = isBuyerInput ? isBuyerInput.value !== 'false' : isBuyerRole;
    if (!guarantee || guarantee <= 0) { alert('❌ Période de garantie invalide'); return; }
    if (!amount || amount <= 0) { alert('❌ Montant invalide'); return; }
    if (String(crypto || '').toUpperCase() !== ALLOWED_TRANSACTION_CRYPTO) { alert(`❌ Seules les transactions ${ALLOWED_TRANSACTION_CRYPTO} sont autorisées.`); return; }
    if (!title) { alert('❌ Veuillez renseigner un titre de transaction'); return; }
    if (!sellerHandle) { alert('❌ Veuillez renseigner le nom d\'utilisateur de la contrepartie'); return; }

    let persistedTransaction = null;
    try {
        persistedTransaction = await persistTransactionInDatabase({
            buyerIdLogin: AppData.currentUser.id,
            counterpartyHandle: sellerHandle,
            titre: title,
            cryptopaiement: crypto,
            montant: amount,
            garantieperiode: guarantee,
            isBuyerRole: roleIsBuyer
        });
    } catch (error) {
        alert(`❌ ${error.message}`);
        return;
    }

    const newEscrow = _buildEscrow({
        sellerName,
        sellerEmail,
        crypto,
        amount,
        guarantee,
        title,
        isBuyerRole: roleIsBuyer,
        dbTransactionId: persistedTransaction ? persistedTransaction.id : null,
        datecreation: persistedTransaction ? toMillis(persistedTransaction.datecreation) : null
    });
    AppData.escrows.push(newEscrow);
    saveData();
    currentEscrowId = newEscrow.id;
    showEscrowDetail(newEscrow.id);
}

// ============ ESCROW CREATION (Full form on create.html) ============
function submitCreateEscrow() {
    if (!assertLoggedIn()) return;

    const sellerRaw = document.getElementById('create-seller').value;
    if (!sellerRaw) { alert('❌ Sélectionnez un vendeur'); return; }

    const [sellerName, sellerEmail] = sellerRaw.split('|');
    const crypto      = document.getElementById('create-crypto').value;
    const amount      = parseFloat(document.getElementById('create-amount').value);
    const guarantee   = parseInt(document.getElementById('create-guarantee').value);
    if (!guarantee || guarantee <= 0) { alert('❌ Période de garantie invalide'); return; }
    if (String(crypto || '').toUpperCase() !== ALLOWED_TRANSACTION_CRYPTO) { alert(`❌ Seules les transactions ${ALLOWED_TRANSACTION_CRYPTO} sont autorisées.`); return; }
    const description = document.getElementById('create-description').value;

    if (!amount || amount <= 0) { alert('❌ Montant invalide'); return; }

    const newEscrow = _buildEscrow({ sellerName, sellerEmail, crypto, amount, guarantee, description });
    AppData.escrows.push(newEscrow);
    saveData();
    currentEscrowId = newEscrow.id;
    showEscrowDetail(newEscrow.id);
}

/**
 * Internal factory – builds a new escrow object.
 */
function _buildEscrow({ sellerName, sellerEmail, crypto, amount, guarantee, title = 'Transaction multi-crypto', description, isBuyerRole = true, dbTransactionId = null, datecreation = null }) {
    const escrowDescription = (description && description.trim()) || title;
    const now = toMillis(datecreation) ?? Date.now();
    return {
        id:          AppData.nextEscrowId++,
        dbTransactionId,
        initiatorIdLogin: AppData.currentUser.id,
        amount,
        crypto,
        title,
        isBuyerRole,
        status:      'En attente',
        buyer:       AppData.currentUser.name,
        seller:      sellerName,
        buyerEmail:  AppData.currentUser.email,
        sellerEmail,
        description: escrowDescription,
        datecreation: now,
        created:     now,
        expires:     now + (guarantee * 3_600_000),
        timeline:    [{ status: 'created', time: now, label: 'Escrow créé' }]
    };
}

// ============ PAYMENT PAGE ============
function showPayment(escrowId) {
    currentEscrowId = escrowId;
    const escrow = AppData.escrows.find(e => e.id === escrowId);
    if (!escrow) return;

    // If payment tab is not on this page, save id and navigate to create.html
    if (!document.getElementById('payment')) {
        sessionStorage.setItem('ofm_pending_payment', escrowId);
        window.location.href = 'create.html';
        return;
    }

    const cryptoAmount = (escrow.amount / cryptoPrices[escrow.crypto]).toFixed(6);
    const commission   = (escrow.amount * 0.05).toFixed(2);
    const vendorGets   = escrow.amount.toFixed(2);

    document.getElementById('payment-id').textContent              = 'ESC-2025-' + String(escrow.id).padStart(5, '0');
    document.getElementById('payment-crypto-amount').textContent   = cryptoAmount + ' ' + escrow.crypto;
    document.getElementById('payment-commission').textContent      = commission + '€ (5%)';
    document.getElementById('payment-seller-gets').textContent     = vendorGets + '€';
    document.getElementById('payment-usdt').textContent            = escrow.amount + ' EUR (équivalent USDT)';
    document.getElementById('payment-crypto-type').textContent     = escrow.crypto;
    document.getElementById('payment-exact-amount').textContent    = cryptoAmount + ' ' + escrow.crypto;

    switchTab('payment');
    startCountdown();
}

function confirmPayment() {
    const escrow = AppData.escrows.find(e => e.id === currentEscrowId);
    if (!escrow) return;

    escrow.status = 'LOCKED';
    escrow.timeline.push({ status: 'paid',   time: Date.now(), label: 'Paiement reçu' });
    escrow.timeline.push({ status: 'locked', time: Date.now(), label: 'Fonds verrouillés (Smart Contract)' });

    AppData.payments.push({
        id:        'PAY-' + Date.now(),
        escrowId:  currentEscrowId,
        amount:    escrow.amount,
        crypto:    escrow.crypto,
        timestamp: Date.now()
    });

    saveData();
    const hoursLeft = ((escrow.expires - Date.now()) / 3_600_000).toFixed(1);
    alert(`✅ Paiement confirmé! Les fonds sont maintenant verrouillés dans le smart contract Polygon.\n\nLe vendeur peut maintenant livrer. Vous avez ${hoursLeft}h pour confirmer.`);
    window.location.href = 'index.html';
}

function copyPaymentAddress() {
    const address = document.getElementById('payment-address').textContent;
    navigator.clipboard.writeText(address).then(() => {
        alert('✅ Adresse copiée dans le presse-papiers!');
    });
}

function startCountdown() {
    if (countdownInterval) clearInterval(countdownInterval);
    let seconds = 30 * 60;

    const countdownEl = document.getElementById('countdown');
    if (!countdownEl) return;

    const tick = () => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        countdownEl.textContent =
            String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
        if (seconds <= 0) clearInterval(countdownInterval);
    };

    countdownInterval = setInterval(() => { seconds--; tick(); }, 1000);
    tick();
}

// ============ ESCROW DETAIL ============
async function showEscrowDetail(escrowId) {
    // If detail tab is not on this page, save id and navigate to transactions.html
    if (!document.getElementById('escrow-detail')) {
        sessionStorage.setItem('ofm_pending_detail', escrowId);
        window.location.href = 'transactions.html';
        return;
    }

    currentEscrowId = escrowId;
    const escrow = AppData.escrows.find(e => e.id === escrowId);
    if (!escrow) return;
    const isInitiator = escrow.initiatorIdLogin
        ? String(escrow.initiatorIdLogin) === String(AppData.currentUser.id)
        : false;
    const isSellerUser = escrow.sellerIdLogin
        ? String(escrow.sellerIdLogin) === String(AppData.currentUser.id)
        : String(escrow.seller || '') === String(AppData.currentUser.name || '');
    const isBuyerUser = escrow.buyerIdLogin
        ? String(escrow.buyerIdLogin) === String(AppData.currentUser.id)
        : String(escrow.buyer || '') === String(AppData.currentUser.name || '');
    const isContractValidationOrLater = getEscrowStepperIndex(escrow.status) >= 2;

    const cryptoAmount = (escrow.amount / cryptoPrices[escrow.crypto]).toFixed(3);
    const commission   = (escrow.amount * 0.05).toFixed(2);
    const vendorAmount = (escrow.amount * 0.95).toFixed(2);

    document.getElementById('detail-id').textContent            = escrow.title || escrow.description || 'Transaction';
    const detailAmountEl = document.getElementById('detail-amount');
    if (isInitiator && !isContractValidationOrLater) {
        detailAmountEl.innerHTML = `
            <div class="detail-amount-edit-row">
                <input id="detail-amount-input" class="detail-amount-input" type="number" min="0.01" step="0.01" value="${Number(escrow.amount || 0).toFixed(2)}">
                <button type="button" class="button secondary detail-amount-save-btn" onclick="saveInitiatorAmount(${escrow.id})">Enregistrer</button>
            </div>
        `;
    } else {
        detailAmountEl.textContent = `${Number(escrow.amount || 0).toFixed(2)} € (${cryptoAmount} ${escrow.crypto})`;
    }
    document.getElementById('detail-commission').textContent    = commission + '€';
    document.getElementById('detail-seller-amount').textContent = vendorAmount + '€';

    const statusMap = {
        LOCKED:   '🔒 VERROUILLÉ',
        RELEASED: '✅ LIBÉRÉ',
        DISPUTE:  '⚠️ DISPUTE',
        REFUNDED: '💰 REMBOURSÉ',
        'En attente': '⏱️ EN ATTENTE',
        'Accepté': '✅ ACCEPTÉ',
        'Refusé':  '❌ REFUSÉ',
        'Configurer': '🛠️ CONFIGURER',
        'Valider contrat': '📋 VALIDER CONTRAT',
        'Signer contrat': '✍️ SIGNER CONTRAT',
        'Déposer les fonds': '💰 DÉPOSER LES FONDS',
        'Déposer les documents': '📄 DÉPOSER LES DOCUMENTS',
        'Garantie': '🛡️ GARANTIE',
        'Noter': '⭐ NOTER',
        'Terminer': '🏁 TERMINER'
    };
    document.getElementById('detail-status').textContent =
        statusMap[escrow.status] || String(escrow.status || 'En attente');

    const stepperEl = document.getElementById('detail-status-stepper');
    if (stepperEl) {
        stepperEl.innerHTML = renderEscrowStatusStepper(escrow.status);
    }

    document.getElementById('detail-expires').textContent = new Date(escrow.expires).toLocaleString('fr-FR');

    // Parties
    const buyerDisplayName = await resolveUserNameByIdLogin(escrow.buyerIdLogin, escrow.buyer);
    const sellerDisplayName = await resolveUserNameByIdLogin(escrow.sellerIdLogin, escrow.seller);

    document.getElementById('detail-buyer').textContent       = buyerDisplayName;
    document.getElementById('detail-buyer-email').textContent = escrow.buyerEmail;
    document.getElementById('detail-buyer-rep').innerHTML = '';

    document.getElementById('detail-seller').textContent       = sellerDisplayName;
    document.getElementById('detail-seller-email').textContent = escrow.sellerEmail;
    document.getElementById('detail-seller-rep').innerHTML = '';

    // Timeline
    const createdTs = toMillis(escrow.datecreation) ?? toMillis(escrow.created) ?? Date.now();
    const createdLabel = new Date(createdTs).toLocaleString('fr-FR');
    const currentStatus = escrow.status || 'En attente';

    document.getElementById('detail-timeline').innerHTML = escrow.timeline.map(item => {
        const isInitialCreatedEvent = item.status === 'created' || item.label === 'Escrow créé';
        const timelineLabel = isInitialCreatedEvent
            ? `Statut: ${currentStatus} — Créée le: ${createdLabel}`
            : item.label;
        const timelineTime = isInitialCreatedEvent ? createdTs : item.time;

        return `
        <div class="timeline-item ${item.status !== 'pending' ? 'completed' : ''}">
            <div class="timeline-dot"></div>
            <div>
                <div class="timeline-title">${timelineLabel}</div>
                <div class="timeline-time">${new Date(timelineTime).toLocaleString('fr-FR')}</div>
            </div>
        </div>
    `;
    }).join('');

    // Progress bar
    const elapsed     = Date.now() - escrow.created;
    const total       = escrow.expires - escrow.created;
    const percentage  = Math.min(100, (elapsed / total) * 100);
    document.getElementById('detail-progress').style.width = percentage + '%';
    document.getElementById('detail-progress-text').textContent = Math.round(percentage) + '%';

    // Alert
    const alertMap = {
        LOCKED:   `<div class="alert alert-success">✅ Fonds sécurisés dans le smart contract Polygon</div>`,
        RELEASED: `<div class="alert alert-success">✅ Fonds libérés au vendeur</div>`,
        DISPUTE:  `<div class="alert alert-danger">⚠️ Litige en cours d'arbitrage</div>`,
        REFUNDED: `<div class="alert alert-info">💰 Fonds remboursés à l'acheteur</div>`
    };
    document.getElementById('detail-alert').innerHTML = alertMap[escrow.status] || '';

    const engagementSellerValue = String(escrow.engagementText || '').trim();
    const engagementBuyerValue = String(escrow.engagementBuyerText || '').trim();
    const sellerEvmWalletValue = escrow.sellerWalletConnected ? String(escrow.sellerWalletAddress || '').trim() : '';
    const sellerPhantomWalletValue = escrow.sellerSolanaWalletConnected ? String(escrow.sellerSolanaWalletAddress || '').trim() : '';
    const sellerBlockEl = document.getElementById('detail-seller-block');
    if (sellerBlockEl) {
        sellerBlockEl.innerHTML = `
            ${isSellerUser && !isContractValidationOrLater ? `<button class="button ${escrow.sellerWalletConnected ? 'secondary' : 'success'} seller-wallet-btn">🔌 Connect MetaMask</button>` : ''}
            ${isSellerUser && !isContractValidationOrLater ? `<button class="button ${escrow.sellerSolanaWalletConnected ? 'secondary' : 'success'} seller-phantom-btn">👻 Connect Phantom (Solana)</button>` : ''}
            <div class="form-group seller-wallet-group-evm">
                <label class="seller-wallet-label">Wallet EVM</label>
                <div class="input-with-icon">
                    <input id="detail-wallet-evm-input" type="text" ${(isSellerUser && !isContractValidationOrLater) ? '' : 'readonly'} placeholder="0x..." value="${escapeHtml(sellerEvmWalletValue)}">
                    ${isSellerUser && !isContractValidationOrLater ? `<button type="button" class="icon-button" onclick="pasteSellerWalletId(${escrow.id}, 'evm')" title="Coller l'ID wallet EVM">📋</button>` : ''}
                </div>
            </div>
            <div class="form-group seller-wallet-group-phantom">
                <label class="seller-wallet-label">Wallet Phantom (Solana)</label>
                <div class="input-with-icon">
                    <input id="detail-wallet-phantom-input" type="text" ${(isSellerUser && !isContractValidationOrLater) ? '' : 'readonly'} placeholder="Adresse Solana..." value="${escapeHtml(sellerPhantomWalletValue)}">
                    ${isSellerUser && !isContractValidationOrLater ? `<button type="button" class="icon-button" onclick="pasteSellerWalletId(${escrow.id}, 'phantom')" title="Coller l'ID wallet Phantom">📋</button>` : ''}
                </div>
            </div>
            ${isSellerUser && !isContractValidationOrLater ? `<button class="button ${escrow.walletIdsSaved ? 'secondary' : 'success'} seller-wallet-save-btn" type="button" onclick="saveSellerWalletIds(${escrow.id})">Enregistrer IDs portefeuille</button>` : ''}
            <div class="card-title seller-engagement-title">Engagement vendeur</div>
            <textarea id="detail-engagement-seller-input" class="engagement-textarea" ${(isSellerUser && !isContractValidationOrLater) ? '' : 'readonly'} placeholder="Saisir un engagement...">${escapeHtml(engagementSellerValue)}</textarea>
            ${isSellerUser && !isContractValidationOrLater ? `<button class="button ${escrow.sellerEngagementSaved ? 'secondary' : 'success'} engagement-save-btn" type="button" onclick="saveEngagementText(${escrow.id})">Enregistrer</button>` : ''}
        `;
    }

    const buyerBlockEl = document.getElementById('detail-buyer-block');
    if (buyerBlockEl) {
        buyerBlockEl.innerHTML = `
            <div class="card-title buyer-engagement-title">Engagement acheteur</div>
            <textarea id="detail-engagement-buyer-input" class="engagement-textarea" ${(isBuyerUser && !isContractValidationOrLater) ? '' : 'readonly'} placeholder="Saisir un engagement acheteur...">${escapeHtml(engagementBuyerValue)}</textarea>
            ${isBuyerUser && !isContractValidationOrLater ? `<button class="button ${escrow.buyerEngagementSaved ? 'secondary' : 'success'} engagement-save-btn" type="button" onclick="saveBuyerEngagementText(${escrow.id})">Enregistrer</button>` : ''}
        `;
    }

    // Actions
    let actionsHtml = '';

    if (escrow.status === 'Configurer') {
        const buyerEngagementDone = !!String(escrow.engagementBuyerText || '').trim() || !!escrow.buyerEngagementSaved;
        const sellerEngagementDone = !!String(escrow.engagementText || '').trim() || !!escrow.sellerEngagementSaved;
        const sellerWalletDone = !!escrow.walletIdsSaved
            || !!String(escrow.sellerWalletAddress || '').trim()
            || !!String(escrow.sellerSolanaWalletAddress || '').trim();
        const buyerActionEnabled = !!isBuyerUser;
        const sellerActionEnabled = !!isSellerUser;

        actionsHtml += `
            <div class="card-title mt-02 mb-065">🧭 Actions de configuration</div>
            <div class="config-checklist">
                <div class="config-checklist-item">
                    <button type="button" class="inline-link-button" onclick="scrollToDetailBlock('detail-buyer-block')" ${buyerActionEnabled ? '' : 'disabled'}>Acheteur : Remplir les engagements</button>
                    <span class="config-check">${buyerEngagementDone ? '✅' : '⬜'}</span>
                </div>
                <div class="config-checklist-item">
                    <button type="button" class="inline-link-button" onclick="scrollToDetailBlock('detail-seller-block')" ${sellerActionEnabled ? '' : 'disabled'}>Vendeur : Remplir les engagements</button>
                    <span class="config-check">${sellerEngagementDone ? '✅' : '⬜'}</span>
                </div>
                <div class="config-checklist-item">
                    <button type="button" class="inline-link-button" onclick="scrollToDetailBlock('detail-seller-block')" ${sellerActionEnabled ? '' : 'disabled'}>Vendeur : Fournir l'adresse du wallet</button>
                    <span class="config-check">${sellerWalletDone ? '✅' : '⬜'}</span>
                </div>
            </div>
            <div class="divider"></div>
        `;
    }

    if (escrow.status === 'Valider contrat') {
        const buyerValidated = !!escrow.contractValidatedBuyer;
        const sellerValidated = !!escrow.contractValidatedSeller;
        const canValidateBuyer = isBuyerUser && !buyerValidated;
        const canValidateSeller = isSellerUser && !sellerValidated;

        actionsHtml += `
            <div class="card-title mt-02 mb-065">📋 Contrat à valider</div>
            <div class="two-col-grid-06">
                <button class="button ${buyerValidated ? 'secondary' : 'success'}" type="button" onclick="validateContractByRole(${escrow.id}, 'buyer')" ${canValidateBuyer ? '' : 'disabled'}>
                    ${buyerValidated ? '✅ Validé Acheteur' : 'Valider Acheteur'}
                </button>
                <button class="button ${sellerValidated ? 'secondary' : 'success'}" type="button" onclick="validateContractByRole(${escrow.id}, 'seller')" ${canValidateSeller ? '' : 'disabled'}>
                    ${sellerValidated ? '✅ Validé Vendeur' : 'Valider Vendeur'}
                </button>
            </div>
            <div class="alert alert-info my-07">
                ℹ️ La validation verrouille les blocs vendeur/acheteur et la modification du montant.
            </div>
            <div class="divider"></div>
        `;
    }

    if (escrow.status === 'Signer contrat') {
        const buyerSigned = !!escrow.contractSignedBuyer;
        const sellerSigned = !!escrow.contractSignedSeller;
        const canSignBuyer = isBuyerUser && !buyerSigned;
        const canSignSeller = isSellerUser && !sellerSigned;
        const hashProof = String(escrow.signedContractHash || '').trim();

        actionsHtml += `
            <div class="card-title mt-02 mb-065">✍️ Signer le contrat</div>
            <div class="two-col-grid-06">
                <button class="button ${buyerSigned ? 'secondary' : 'success'}" type="button" onclick="openContractSignaturePad(${escrow.id}, 'buyer')" ${canSignBuyer ? '' : 'disabled'}>
                    ${buyerSigned ? '✅ Signé Acheteur' : 'Signer Acheteur'}
                </button>
                <button class="button ${sellerSigned ? 'secondary' : 'success'}" type="button" onclick="openContractSignaturePad(${escrow.id}, 'seller')" ${canSignSeller ? '' : 'disabled'}>
                    ${sellerSigned ? '✅ Signé Vendeur' : 'Signer Vendeur'}
                </button>
            </div>
            ${hashProof ? `<div class="alert alert-success my-07">✅ Hash de preuve blockchain: ${escapeHtml(hashProof)}</div>` : `<div class="alert alert-info my-07">ℹ️ Les deux signatures génèrent automatiquement le PDF signé et le hash de preuve blockchain.</div>`}
            <div class="divider"></div>
        `;
    }

    if (escrow.status === 'En attente' && !isInitiator) {
        actionsHtml = `
            <div class="alert alert-info">ℹ️ Vous n'êtes pas l'initiateur. Acceptez ou refusez cette transaction.</div>
            <button class="button success mb-05" onclick="acceptTransaction(${escrow.id})">✅ Accepter</button>
            <button class="button danger" onclick="refuseTransaction(${escrow.id})">❌ Refuser</button>
        `;
    } else if (escrow.status === 'En attente' && isInitiator) {
        actionsHtml = `<div class="alert alert-info">ℹ️ En attente de la réponse de la contrepartie.</div>`;
    }

    if (escrow.status === 'LOCKED' && escrow.buyer === AppData.currentUser.name) {
        actionsHtml = `
            <div class="alert alert-info">ℹ️ Vous êtes l'acheteur. Confirmez la livraison ou ouvrez un litige.</div>
            <button class="button success mb-05" onclick="confirmDelivery(${escrow.id})">✅ Confirmer Livraison</button>
            <button class="button danger"  onclick="openDispute(${escrow.id})">⚠️ Ouvrir Litige</button>
        `;
    } else if (escrow.status === 'LOCKED' && escrow.seller === AppData.currentUser.name) {
        actionsHtml = `<div class="alert alert-info">ℹ️ Vous êtes le vendeur. En attente de confirmation acheteur.</div>`;
    }
    if (escrow.status === 'En attente') {
        actionsHtml += `
            <div class="divider"></div>
            <div class="form-group mt-05">
                <label>Lien partageable</label>
                <div class="input-with-icon">
                    <input type="text" readonly value="${buildTransactionShareUrl(escrow)}">
                    <button type="button" class="icon-button" onclick="copyTransactionShareLink(${escrow.id})" title="Copier le lien">📋</button>
                </div>
            </div>
        `;
    }
    document.getElementById('detail-actions').innerHTML = actionsHtml;

    try {
        await renderEscrowConversationWindow(escrow);
    } catch (error) {
        const chatEl = document.getElementById('detail-chat-block');
        if (chatEl) {
            chatEl.innerHTML = `<div class="alert alert-danger">❌ ${escapeHtml(error.message)}</div>`;
        }
    }

    switchTab('escrow-detail');
}

async function connectSellerWallet(escrowId) {
    const escrow = AppData.escrows.find(e => e.id === escrowId);
    if (!escrow) return;

    const isSellerUser = escrow.sellerIdLogin
        ? String(escrow.sellerIdLogin) === String(AppData.currentUser.id)
        : String(escrow.seller || '') === String(AppData.currentUser.name || '');

    if (!isSellerUser) {
        alert('❌ Seul le vendeur peut connecter son wallet.');
        return;
    }

    if (typeof window === 'undefined' || !window.ethereum) {
        alert('❌ MetaMask introuvable. Installez ou activez MetaMask.');
        return;
    }

    try {
        const ethersLib = await getEthersLibrary();
        const provider = new ethersLib.BrowserProvider(window.ethereum);
        await provider.send('eth_requestAccounts', []);
        const signer = await provider.getSigner();
        const walletAddress = await signer.getAddress();

        escrow.sellerWalletConnected = true;
        escrow.sellerWalletAddress = walletAddress;
        saveData();
        await showEscrowDetail(escrowId);
        alert(`✅ Wallet vendeur connecté : ${walletAddress}`);
    } catch (error) {
        alert(`❌ Connexion wallet impossible: ${error.message || 'Erreur inconnue.'}`);
    }
}

async function connectSellerPhantomWallet(escrowId) {
    const escrow = AppData.escrows.find(e => e.id === escrowId);
    if (!escrow) return;

    const isSellerUser = escrow.sellerIdLogin
        ? String(escrow.sellerIdLogin) === String(AppData.currentUser.id)
        : String(escrow.seller || '') === String(AppData.currentUser.name || '');

    if (!isSellerUser) {
        alert('❌ Seul le vendeur peut connecter son wallet Phantom.');
        return;
    }

    const provider = window?.solana;
    if (!provider || !provider.isPhantom) {
        alert('❌ Wallet Phantom introuvable. Installez ou activez Phantom.');
        return;
    }

    try {
        const response = await provider.connect();
        const publicKey = String(response?.publicKey?.toString?.() || provider.publicKey?.toString?.() || '').trim();

        if (!publicKey) {
            throw new Error('Adresse Phantom introuvable après connexion.');
        }

        escrow.sellerSolanaWalletConnected = true;
        escrow.sellerSolanaWalletAddress = publicKey;
        saveData();
        await showEscrowDetail(escrowId);
        alert(`✅ Wallet Phantom connecté : ${publicKey}`);
    } catch (error) {
        alert(`❌ Connexion Phantom impossible: ${error.message || 'Erreur inconnue.'}`);
    }
}

async function pasteSellerWalletId(escrowId, walletType) {
    const escrow = AppData.escrows.find(e => e.id === escrowId);
    if (!escrow) return;

    const isSellerUser = escrow.sellerIdLogin
        ? String(escrow.sellerIdLogin) === String(AppData.currentUser.id)
        : String(escrow.seller || '') === String(AppData.currentUser.name || '');

    if (!isSellerUser) {
        alert('❌ Seul le vendeur peut renseigner les IDs portefeuille.');
        return;
    }

    try {
        const clipboardText = String(await navigator.clipboard.readText() || '').trim();
        if (!clipboardText) {
            alert('❌ Le presse-papiers est vide.');
            return;
        }

        if (walletType === 'evm') {
            const evmInput = document.getElementById('detail-wallet-evm-input');
            if (evmInput) evmInput.value = clipboardText;
        } else {
            const phantomInput = document.getElementById('detail-wallet-phantom-input');
            if (phantomInput) phantomInput.value = clipboardText;
        }

        await saveSellerWalletIds(escrowId, false);
    } catch (error) {
        alert(`❌ Impossible de lire le presse-papiers: ${error.message || 'Erreur inconnue.'}`);
    }
}

async function saveSellerWalletIds(escrowId, withSuccessPopup = true) {
    const escrow = AppData.escrows.find(e => e.id === escrowId);
    if (!escrow) return;

    const isSellerUser = escrow.sellerIdLogin
        ? String(escrow.sellerIdLogin) === String(AppData.currentUser.id)
        : String(escrow.seller || '') === String(AppData.currentUser.name || '');

    if (!isSellerUser) {
        alert('❌ Seul le vendeur peut enregistrer les IDs portefeuille.');
        return;
    }

    const evmInput = document.getElementById('detail-wallet-evm-input');
    const phantomInput = document.getElementById('detail-wallet-phantom-input');

    const evmValue = String(evmInput?.value || '').trim();
    const phantomValue = String(phantomInput?.value || '').trim();

    if (escrow.dbTransactionId) {
        try {
            await updateTransactionWalletsInDatabase(escrow.dbTransactionId, evmValue, phantomValue);
        } catch (error) {
            alert(`❌ ${error.message}`);
            return;
        }
    }

    escrow.sellerWalletAddress = evmValue;
    escrow.sellerWalletConnected = !!evmValue;

    escrow.sellerSolanaWalletAddress = phantomValue;
    escrow.sellerSolanaWalletConnected = !!phantomValue;
    escrow.walletIdsSaved = true;

    await tryAdvanceConfigurerStatus(escrow);

    saveData();
    showEscrowDetail(escrowId);

    if (withSuccessPopup) {
        alert('✅ IDs portefeuille enregistrés.');
    }
}

function isConfigurerChecklistComplete(escrow) {
    const buyerEngagementDone = !!String(escrow?.engagementBuyerText || '').trim() || !!escrow?.buyerEngagementSaved;
    const sellerEngagementDone = !!String(escrow?.engagementText || '').trim() || !!escrow?.sellerEngagementSaved;
    const sellerWalletDone = !!escrow?.walletIdsSaved
        || !!String(escrow?.sellerWalletAddress || '').trim()
        || !!String(escrow?.sellerSolanaWalletAddress || '').trim();

    return buyerEngagementDone && sellerEngagementDone && sellerWalletDone;
}

async function tryAdvanceConfigurerStatus(escrow) {
    if (!escrow || escrow.status !== 'Configurer') return false;
    if (!isConfigurerChecklistComplete(escrow)) return false;

    if (escrow.dbTransactionId) {
        try {
            await updateTransactionStatusInDatabase(escrow.dbTransactionId, 'Valider contrat');
        } catch (error) {
            alert(`❌ ${error.message}`);
            return false;
        }
    }

    escrow.status = 'Valider contrat';
    escrow.timeline = Array.isArray(escrow.timeline) ? escrow.timeline : [];
    escrow.timeline.push({ status: 'contract-validation', time: Date.now(), label: 'Configuration terminée — contrat à valider' });
    saveData();
    return true;
}

async function tryAdvanceSignerContratStatus(escrow) {
    if (!escrow || escrow.status !== 'Valider contrat') return false;
    if (!escrow.contractValidatedBuyer || !escrow.contractValidatedSeller) return false;

    if (escrow.dbTransactionId) {
        try {
            await updateTransactionStatusInDatabase(escrow.dbTransactionId, 'Signer contrat');
        } catch (error) {
            alert(`❌ ${error.message}`);
            return false;
        }
    }

    escrow.status = 'Signer contrat';
    escrow.timeline = Array.isArray(escrow.timeline) ? escrow.timeline : [];
    escrow.timeline.push({ status: 'contract-signed-step', time: Date.now(), label: 'Les deux parties ont validé — contrat à signer' });

    if (escrow.dbTransactionId) {
        try {
            const payload = await generateContractPdfInDatabase(escrow.dbTransactionId);
            if (payload?.conversationId && !escrow.conversationId) {
                escrow.conversationId = payload.conversationId;
            }
        } catch (error) {
            alert(`⚠️ Statut mis à jour, mais contrat PDF non généré: ${error.message}`);
        }
    }

    saveData();
    return true;
}

async function validateContractByRole(escrowId, role) {
    const escrow = AppData.escrows.find(e => e.id === escrowId);
    if (!escrow) return;

    if (escrow.status !== 'Valider contrat') {
        alert('❌ Cette action est disponible uniquement à l\'étape Valider contrat.');
        return;
    }

    const isSellerUser = escrow.sellerIdLogin
        ? String(escrow.sellerIdLogin) === String(AppData.currentUser.id)
        : String(escrow.seller || '') === String(AppData.currentUser.name || '');
    const isBuyerUser = escrow.buyerIdLogin
        ? String(escrow.buyerIdLogin) === String(AppData.currentUser.id)
        : String(escrow.buyer || '') === String(AppData.currentUser.name || '');

    if (role === 'buyer' && !isBuyerUser) {
        alert('❌ Seul l\'acheteur peut valider côté acheteur.');
        return;
    }

    if (role === 'seller' && !isSellerUser) {
        alert('❌ Seul le vendeur peut valider côté vendeur.');
        return;
    }

    if (role === 'buyer') {
        escrow.contractValidatedBuyer = true;
    } else if (role === 'seller') {
        escrow.contractValidatedSeller = true;
    } else {
        return;
    }

    if (escrow.dbTransactionId) {
        try {
            await updateTransactionContractValidationInDatabase(
                escrow.dbTransactionId,
                !!escrow.contractValidatedBuyer,
                !!escrow.contractValidatedSeller
            );
        } catch (error) {
            alert(`❌ ${error.message}`);
            return;
        }
    }

    escrow.timeline = Array.isArray(escrow.timeline) ? escrow.timeline : [];
    escrow.timeline.push({
        status: role === 'buyer' ? 'buyer-contract-validated' : 'seller-contract-validated',
        time: Date.now(),
        label: role === 'buyer' ? 'Validation acheteur effectuée' : 'Validation vendeur effectuée'
    });

    await tryAdvanceSignerContratStatus(escrow);
    saveData();
    showEscrowDetail(escrowId);
}

async function openContractSignaturePad(escrowId, role) {
    const escrow = AppData.escrows.find(e => e.id === escrowId);
    if (!escrow) return;

    if (escrow.status !== 'Signer contrat') {
        alert('❌ Signature disponible uniquement à l\'étape Signer contrat.');
        return;
    }

    const isBuyerUser = escrow.buyerIdLogin
        ? String(escrow.buyerIdLogin) === String(AppData.currentUser.id)
        : String(escrow.buyer || '') === String(AppData.currentUser.name || '');
    const isSellerUser = escrow.sellerIdLogin
        ? String(escrow.sellerIdLogin) === String(AppData.currentUser.id)
        : String(escrow.seller || '') === String(AppData.currentUser.name || '');

    if (role === 'buyer' && !isBuyerUser) {
        alert('❌ Seul l\'acheteur peut signer côté acheteur.');
        return;
    }
    if (role === 'seller' && !isSellerUser) {
        alert('❌ Seul le vendeur peut signer côté vendeur.');
        return;
    }

    const alreadySigned = role === 'buyer' ? !!escrow.contractSignedBuyer : !!escrow.contractSignedSeller;
    if (alreadySigned) {
        alert('✅ Cette signature est déjà enregistrée.');
        return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'signature-overlay';

    const box = document.createElement('div');
    box.className = 'signature-modal';

    const signerLabel = role === 'buyer' ? 'Acheteur' : 'Vendeur';

    box.innerHTML = `
        <div class="signature-header">
            <div class="signature-title">Signature contrat — ${signerLabel}</div>
            <button type="button" class="button secondary signature-close-btn" id="sign-close">Fermer</button>
        </div>
        <div class="alert alert-info mb-06">ℹ️ Dessinez votre signature puis cliquez sur Signer.</div>
        <canvas id="sign-canvas" class="signature-canvas" width="680" height="220"></canvas>
        <div class="signature-actions">
            <button type="button" class="button secondary signature-clear-btn" id="sign-clear">Effacer</button>
            <button type="button" class="button success signature-submit-btn" id="sign-submit">Signer</button>
        </div>
        <div id="sign-status" class="seller-status mt-06 hidden"></div>
    `;

    const close = () => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };

    const canvas = box.querySelector('#sign-canvas');
    const ctx = canvas.getContext('2d');
    let isDrawing = false;
    let hasStroke = false;

    ctx.strokeStyle = '#111827';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const getPos = (event) => {
        const rect = canvas.getBoundingClientRect();
        const point = event.touches && event.touches[0] ? event.touches[0] : event;
        return {
            x: (point.clientX - rect.left) * (canvas.width / rect.width),
            y: (point.clientY - rect.top) * (canvas.height / rect.height)
        };
    };

    const start = (event) => {
        isDrawing = true;
        const pos = getPos(event);
        ctx.beginPath();
        ctx.moveTo(pos.x, pos.y);
        hasStroke = true;
        event.preventDefault();
    };

    const draw = (event) => {
        if (!isDrawing) return;
        const pos = getPos(event);
        ctx.lineTo(pos.x, pos.y);
        ctx.stroke();
        event.preventDefault();
    };

    const stop = (event) => {
        if (!isDrawing) return;
        isDrawing = false;
        ctx.closePath();
        event.preventDefault();
    };

    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', draw);
    canvas.addEventListener('mouseup', stop);
    canvas.addEventListener('mouseleave', stop);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', draw, { passive: false });
    canvas.addEventListener('touchend', stop, { passive: false });

    const statusEl = box.querySelector('#sign-status');
    const setStatus = (kind, message) => {
        showElement(statusEl);
        statusEl.className = `seller-status ${kind}`;
        statusEl.textContent = message;
    };

    box.querySelector('#sign-close')?.addEventListener('click', close);
    box.querySelector('#sign-clear')?.addEventListener('click', () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        hasStroke = false;
        hideElement(statusEl);
    });

    box.querySelector('#sign-submit')?.addEventListener('click', async () => {
        if (!hasStroke) {
            setStatus('error', '❌ Veuillez dessiner votre signature.');
            return;
        }

        if (!escrow.dbTransactionId) {
            setStatus('error', '❌ Transaction base introuvable.');
            return;
        }

        try {
            setStatus('loading', '⏳ Signature en cours...');
            const signatureDataUrl = canvas.toDataURL('image/png');
            const payload = await signTransactionInDatabase(escrow.dbTransactionId, role, signatureDataUrl);

            escrow.contractSignedBuyer = !!payload.signatureAcheteurAt || !!escrow.contractSignedBuyer;
            escrow.contractSignedSeller = !!payload.signatureVendeurAt || !!escrow.contractSignedSeller;
            if (payload.preuveHashBlockchain) escrow.signedContractHash = payload.preuveHashBlockchain;

            if (payload.statut) {
                escrow.status = payload.statut;
            }

            escrow.timeline = Array.isArray(escrow.timeline) ? escrow.timeline : [];
            escrow.timeline.push({
                status: role === 'buyer' ? 'buyer-contract-signed' : 'seller-contract-signed',
                time: Date.now(),
                label: role === 'buyer' ? 'Signature acheteur enregistrée' : 'Signature vendeur enregistrée'
            });

            saveData();
            close();
            showEscrowDetail(escrowId);
            alert('✅ Signature enregistrée.');
        } catch (error) {
            setStatus('error', `❌ ${error.message}`);
        }
    });

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) close();
    });

    overlay.appendChild(box);
    document.body.appendChild(overlay);
}

async function saveEngagementText(escrowId) {
    const escrow = AppData.escrows.find(e => e.id === escrowId);
    if (!escrow) return;

    const isSellerUser = escrow.sellerIdLogin
        ? String(escrow.sellerIdLogin) === String(AppData.currentUser.id)
        : String(escrow.seller || '') === String(AppData.currentUser.name || '');

    if (!isSellerUser) {
        alert('❌ Seul le vendeur peut modifier l\'engagement.');
        return;
    }

    const inputEl = document.getElementById('detail-engagement-seller-input');
    if (!inputEl) return;

    const sellerEngagementValue = String(inputEl.value || '').trim();
    const buyerEngagementValue = String(escrow.engagementBuyerText || '').trim();

    if (escrow.dbTransactionId) {
        try {
            await updateTransactionEngagementsInDatabase(escrow.dbTransactionId, buyerEngagementValue, sellerEngagementValue);
        } catch (error) {
            alert(`❌ ${error.message}`);
            return;
        }
    }

    escrow.engagementText = sellerEngagementValue;
    escrow.sellerEngagementSaved = true;
    await tryAdvanceConfigurerStatus(escrow);
    saveData();
    showEscrowDetail(escrowId);
    alert('✅ Engagement enregistré.');
}

async function saveBuyerEngagementText(escrowId) {
    const escrow = AppData.escrows.find(e => e.id === escrowId);
    if (!escrow) return;

    const isBuyerUser = escrow.buyerIdLogin
        ? String(escrow.buyerIdLogin) === String(AppData.currentUser.id)
        : String(escrow.buyer || '') === String(AppData.currentUser.name || '');

    if (!isBuyerUser) {
        alert('❌ Seul l\'acheteur peut modifier l\'engagement acheteur.');
        return;
    }

    const inputEl = document.getElementById('detail-engagement-buyer-input');
    if (!inputEl) return;

    const buyerEngagementValue = String(inputEl.value || '').trim();
    const sellerEngagementValue = String(escrow.engagementText || '').trim();

    if (escrow.dbTransactionId) {
        try {
            await updateTransactionEngagementsInDatabase(escrow.dbTransactionId, buyerEngagementValue, sellerEngagementValue);
        } catch (error) {
            alert(`❌ ${error.message}`);
            return;
        }
    }

    escrow.engagementBuyerText = buyerEngagementValue;
    escrow.buyerEngagementSaved = true;
    await tryAdvanceConfigurerStatus(escrow);
    saveData();
    showEscrowDetail(escrowId);
    alert('✅ Engagement acheteur enregistré.');
}

async function saveInitiatorAmount(escrowId) {
    const escrow = AppData.escrows.find(e => e.id === escrowId);
    if (!escrow) return;

    const isInitiator = escrow.initiatorIdLogin
        ? String(escrow.initiatorIdLogin) === String(AppData.currentUser.id)
        : false;

    if (!isInitiator) {
        alert('❌ Seul l\'initiateur peut modifier le montant.');
        return;
    }

    const inputEl = document.getElementById('detail-amount-input');
    if (!inputEl) return;

    const newAmount = Number(String(inputEl.value || '').replace(',', '.'));
    if (!Number.isFinite(newAmount) || newAmount <= 0) {
        alert('❌ Montant invalide.');
        return;
    }

    if (escrow.dbTransactionId) {
        try {
            await updateTransactionAmountInDatabase(escrow.dbTransactionId, newAmount);
        } catch (error) {
            alert(`❌ ${error.message}`);
            return;
        }
    }

    escrow.amount = newAmount;
    saveData();
    showEscrowDetail(escrowId);
}

// ============ DELIVERY / DISPUTE ============
function confirmDelivery(escrowId) {
    const escrow = AppData.escrows.find(e => e.id === escrowId);
    if (!escrow) return;

    escrow.status = 'RELEASED';
    escrow.timeline.push({ status: 'delivered', time: Date.now(), label: 'Livraison confirmée' });
    escrow.timeline.push({ status: 'released',  time: Date.now(), label: 'Fonds libérés au vendeur' });

    saveData();
    alert('✅ Livraison confirmée! Fonds libérés au vendeur.');
    switchTab('escrows');
}

async function acceptTransaction(escrowId) {
    const escrow = AppData.escrows.find(e => e.id === escrowId);
    if (!escrow) return;

    if (escrow.dbTransactionId) {
        try {
            await updateTransactionStatusInDatabase(escrow.dbTransactionId, 'Configurer');
        } catch (error) {
            alert(`❌ ${error.message}`);
            return;
        }
    }

    try {
        const conversation = await ensureConversationForTransaction({
            transactionId: escrow.dbTransactionId || '',
            buyerIdLogin: escrow.buyerIdLogin || '',
            sellerIdLogin: escrow.sellerIdLogin || '',
            senderIdLogin: AppData.currentUser.id
        });
        escrow.conversationId = conversation?.conversationId || escrow.conversationId || '';
    } catch (error) {
        alert(`⚠️ Transaction acceptée, mais chat non créé: ${error.message}`);
    }

    escrow.status = 'Configurer';
    escrow.timeline.push({ status: 'accepted', time: Date.now(), label: 'Transaction acceptée par la contrepartie' });
    saveData();
    showEscrowDetail(escrowId);
}

async function refuseTransaction(escrowId) {
    const escrow = AppData.escrows.find(e => e.id === escrowId);
    if (!escrow) return;

    if (escrow.dbTransactionId) {
        try {
            await updateTransactionStatusInDatabase(escrow.dbTransactionId, 'Refusé');
        } catch (error) {
            alert(`❌ ${error.message}`);
            return;
        }
    }

    escrow.status = 'Refusé';
    escrow.timeline.push({ status: 'refused', time: Date.now(), label: 'Transaction refusée par la contrepartie' });
    saveData();
    showEscrowDetail(escrowId);
}

function openDispute(escrowId) {
    const reason = prompt('Raison du litige:');
    if (!reason) return;

    const escrow = AppData.escrows.find(e => e.id === escrowId);
    if (!escrow) return;

    escrow.status = 'DISPUTE';
    escrow.timeline.push({ status: 'dispute', time: Date.now(), label: 'Litige ouvert' });

    AppData.disputes.push({
        id:       AppData.disputes.length + 1,
        escrowId,
        amount:   escrow.amount,
        opener:   AppData.currentUser.name,
        reason,
        opened:   Date.now(),
        status:   'OPEN'
    });

    saveData();
    alert('✅ Litige ouvert! Un arbitre examinera votre cas dans les 24-48 heures.');
    switchTab('escrows');
}

function resolveDispute(escrowId, decision) {
    const escrow  = AppData.escrows.find(e => e.id === escrowId);
    const dispute = AppData.disputes.find(d => d.escrowId === escrowId);
    if (!escrow) return;

    if (decision === 'REFUND') {
        escrow.status = 'REFUNDED';
        escrow.timeline.push({ status: 'refunded', time: Date.now(), label: 'Remboursé à acheteur' });
    } else if (decision === 'RELEASE') {
        escrow.status = 'RELEASED';
        escrow.timeline.push({ status: 'released', time: Date.now(), label: 'Libéré au vendeur' });
    }

    if (dispute) {
        dispute.status     = 'RESOLVED';
        dispute.resolution = decision;
    }

    saveData();
    alert(`✅ Dispute résolu!\n${decision === 'REFUND' ? 'Remboursement à acheteur' : 'Libération au vendeur'}`);
    updateAdmin();
}

// ============ DASHBOARD RENDERING ============
function updateDashboard() {
    const total      = AppData.escrows.length;
    const locked     = AppData.escrows.filter(e => e.status === 'LOCKED').length;
    const released   = AppData.escrows.filter(e => e.status === 'RELEASED').length;
    const disputed   = AppData.disputes.filter(d => d.status === 'OPEN').length;
    const totalValue = AppData.escrows.reduce((sum, e) => sum + e.amount, 0);
    const success    = total > 0 ? ((released / total) * 100).toFixed(1) : 0;

    const el = id => document.getElementById(id);
    if (!el('stat-total')) return; // not on dashboard page

    el('stat-total').textContent        = total;
    el('stat-total-change').textContent = total > 0 ? '+' + locked : '+0';
    el('stat-value').textContent        = '$' + totalValue.toFixed(0);
    el('stat-disputes').textContent     = disputed;
    el('stat-success').textContent      = success + '%';

    const recentHtml = AppData.escrows.slice(-5).reverse().map(e => _escrowRowHtml(e)).join('');
    const recentEl = document.getElementById('recent-escrows');
    if (recentEl) {
        // index.html uses a table tbody
        recentEl.innerHTML = recentHtml || '<tr><td colspan="6" class="p-15 text-muted">Aucune transaction pour le moment</td></tr>';
    }

    // Update sidebar badge
    const badge = document.getElementById('sidebar-badge-deals');
    if (badge) badge.textContent = AppData.escrows.length;

    // Update dashboard summary
    const summaryEl = document.getElementById('dashboard-summary');
    if (summaryEl) {
        const inDispute = AppData.escrows.filter(e => e.status === 'DISPUTE').length;
        const locked    = AppData.escrows.filter(e => e.status === 'LOCKED').length;
        summaryEl.textContent = `${AppData.escrows.length} deals au total · ${inDispute} en litige · ${locked} fonds bloqués`;
    }

    // Update tab counts
    _updateTabCounts();
}

function _updateTabCounts() {
    const counts = {
        all: AppData.escrows.length,
        pending: AppData.escrows.filter(e => ['En attente','Contrat en attente','Dépôt en attente'].includes(e.status)).length,
        locked:  AppData.escrows.filter(e => e.status === 'LOCKED').length,
        dispute: AppData.escrows.filter(e => e.status === 'DISPUTE').length,
        completed: AppData.escrows.filter(e => e.status === 'RELEASED').length,
        refunded:  AppData.escrows.filter(e => e.status === 'REFUNDED').length,
    };
    for (const [key, val] of Object.entries(counts)) {
        const el = document.getElementById(`tab-count-${key}`);
        if (el) el.textContent = val;
    }
}
}

// ============ ESCROW LIST ============
function displayEscrows() {
    const listEl = document.getElementById('escrows-list');
    if (!listEl) return;

    const sortedEscrows = [...AppData.escrows].sort((a, b) => {
        const aCreated = toMillis(a?.datecreation) ?? toMillis(a?.created) ?? 0;
        const bCreated = toMillis(b?.datecreation) ?? toMillis(b?.created) ?? 0;
        return bCreated - aCreated;
    });

    const html = AppData.escrows.length === 0
        ? '<tr><td colspan="6" class="p-15 text-muted">Aucune transaction</td></tr>'
        : sortedEscrows.map(e => _escrowRowHtml(e)).join('');

    listEl.innerHTML = html;

    // Update sidebar badge
    const badge = document.getElementById('sidebar-badge-deals');
    if (badge) badge.textContent = AppData.escrows.length;

    _updateTabCounts();
}

// Global filter hook called by filter tabs
window.applyDealFilter = function(filter) {
    const listEl = document.getElementById('escrows-list');
    if (!listEl) return;
    const filtered = filter === 'all' ? AppData.escrows : AppData.escrows.filter(e => {
        if (filter === 'pending')   return ['En attente','Contrat en attente','Dépôt en attente'].includes(e.status);
        if (filter === 'locked')    return e.status === 'LOCKED';
        if (filter === 'dispute')   return e.status === 'DISPUTE';
        if (filter === 'completed') return e.status === 'RELEASED';
        if (filter === 'refunded')  return e.status === 'REFUNDED';
        return true;
    });
    listEl.innerHTML = filtered.length === 0
        ? '<tr><td colspan="6" class="p-15 text-muted">Aucun deal dans cette catégorie</td></tr>'
        : filtered.map(e => _escrowRowHtml(e)).join('');
};

/** Builds a single escrow table-row HTML string for the deals-table. */
function _escrowRowHtml(e) {
    const title = (e.title && String(e.title).trim()) ? e.title : (e.description || 'Transaction');
    const createdTs = Number(e.datecreation) || 0;
    const createdLe = createdTs ? new Date(createdTs).toLocaleDateString('fr-FR') : '-';
    const isMyRole   = AppData.currentUser;
    const role       = (isMyRole && e.buyerIdLogin === AppData.currentUser?.uid) ? 'acheteur' : 'vendeur';
    const party      = role === 'acheteur' ? e.seller : e.buyer;
    const partyInitials = party ? party.split(' ').map(w => w[0]).join('').toUpperCase().slice(0,2) : '?';
    const amountFmt  = e.amount ? e.amount.toLocaleString('fr-FR', {minimumFractionDigits:2}) + ' €' : '—';

    const statusMap = {
        'LOCKED':            { cls: 'chip chip-escrow',  text: 'En garantie' },
        'RELEASED':          { cls: 'chip chip-succes',  text: 'Complété' },
        'DISPUTE':           { cls: 'chip chip-litige',  text: 'Litige ouvert' },
        'REFUNDED':          { cls: 'chip chip-neutre',  text: 'Remboursé' },
        'En attente':        { cls: 'chip chip-attente', text: 'En attente' },
        'Contrat en attente':{ cls: 'chip chip-attente', text: 'Contrat en attente' },
        'Dépôt en attente':  { cls: 'chip chip-attente', text: 'Dépôt en attente' },
    };
    const { cls, text } = statusMap[e.status] || { cls: 'chip chip-attente', text: e.status || '—' };

    return `
        <tr onclick="showEscrowDetail(${e.id})">
            <td><span class="deals-table-ref">${e.ref || ('DL-' + String(e.id).padStart(4,'0'))}</span></td>
            <td>
                <div class="deals-table-deal-name">${title}</div>
                <div class="deals-table-deal-sub">Vous êtes ${role} · créé le ${createdLe}</div>
            </td>
            <td>
                <div class="deals-table-party">
                    <div class="deals-table-party-avatar">${partyInitials}</div>
                    <span>${party || '—'}</span>
                </div>
            </td>
            <td class="deals-table-amount">
                <div class="deals-table-amount-value">${amountFmt}</div>
            </td>
            <td><span class="${cls}">${text}</span></td>
            <td class="deals-table-chevron">›</td>
        </tr>
    `;
}

/** @deprecated use _escrowRowHtml */
function _escrowItemHtml(e) { return _escrowRowHtml(e); }

// ============ ADMIN PANEL ============
function updateAdmin() {
    const el = id => document.getElementById(id);
    if (!el('admin-total')) return; // not on admin page

    const total      = AppData.escrows.length;
    const locked     = AppData.escrows.filter(e => e.status === 'LOCKED').length;
    const released   = AppData.escrows.filter(e => e.status === 'RELEASED').length;
    const refunded   = AppData.escrows.filter(e => e.status === 'REFUNDED').length;
    const totalValue = AppData.escrows.reduce((sum, e) => sum + e.amount, 0);
    const commission = (totalValue * 0.05).toFixed(2);
    const success    = total > 0 ? ((released / total) * 100).toFixed(1) : 0;
    const disputeRate= total > 0 ? ((AppData.disputes.length / total) * 100).toFixed(1) : 0;

    el('admin-total').textContent          = total;
    el('admin-locked').textContent         = locked;
    el('admin-released').textContent       = released;
    el('admin-refunded').textContent       = refunded;
    el('admin-disputes-count').textContent = AppData.disputes.filter(d => d.status === 'OPEN').length;
    el('admin-success').textContent        = success + '%';
    el('admin-commission').textContent     = '$' + commission;
    el('admin-tvl').textContent            = '$' + totalValue.toFixed(0);
    el('admin-daily').textContent          = '~' + Math.ceil(AppData.escrows.length / 1);
    el('admin-avg-time').textContent       = '4h 30m';
    el('admin-dispute-rate').textContent   = disputeRate + '%';

    // Open disputes
    const openDisputes = AppData.disputes.filter(d => d.status === 'OPEN');
    el('admin-disputes').innerHTML = openDisputes.length === 0
        ? '<p class="text-muted">Aucun litige actuellement</p>'
        : openDisputes.map(d => `
            <div class="item">
                <div class="item-header">
                    <div class="item-title">Litige #${d.id} - ${d.amount}€</div>
                    <div class="status-badge status-dispute">OUVERT</div>
                </div>
                <div class="item-meta">
                    <span>Ouvert par: ${d.opener}</span>
                    <span>Raison: ${d.reason}</span>
                </div>
                <div class="two-col-grid-05 mt-10">
                    <button class="button secondary" onclick="resolveDispute(${d.escrowId}, 'REFUND')">💰 Rembourser</button>
                    <button class="button secondary" onclick="resolveDispute(${d.escrowId}, 'RELEASE')">✅ Libérer</button>
                </div>
            </div>
        `).join('');

    // All deals
    el('admin-all-deals').innerHTML = AppData.escrows.length === 0
        ? '<p class="text-muted">Aucun deal n\'a été créé</p>'
        : AppData.escrows.map(e => {
            const comm = (e.amount * 0.05).toFixed(2);
            const badgeMap = { LOCKED: 'status-locked', RELEASED: 'status-released', DISPUTE: 'status-dispute' };
            const badge = badgeMap[e.status] || 'status-pending';
            return `
                <div class="item">
                    <div class="item-header">
                        <div>
                            <div class="item-title">#ESC-${e.id} - ${e.amount}€</div>
                            <div class="item-meta">
                                <span>${e.buyer} → ${e.seller}</span>
                                <span>Commission: ${comm}€</span>
                            </div>
                        </div>
                        <div class="status-badge ${badge}">${e.status}</div>
                    </div>
                </div>
            `;
        }).join('');
}

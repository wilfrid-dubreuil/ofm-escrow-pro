const path = require('path');
const crypto = require('crypto');
const fs = require('fs/promises');
const fsSync = require('fs');
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const admin = require('firebase-admin');
const PDFDocument = require('pdfkit');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const app = express();
const PORT = process.env.PORT || 3001;
const FRONTEND_ROOT = path.join(__dirname, '..', '..');
const USERS_FILE = path.join(__dirname, '..', 'data', 'users.json');
const TRANSACTIONS_FILE = path.join(__dirname, '..', 'data', 'transactions.json');
const CONVERSATIONS_FILE = path.join(__dirname, '..', 'data', 'conversations.json');
const FIREBASE_SERVICE_ACCOUNT_PATH = process.env.FIREBASE_SERVICE_ACCOUNT_PATH
  ? path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH)
  : path.join(__dirname, '..', 'midgen-u6gv0i-firebase-adminsdk-fbsvc-ae88ed43bb.json');

let adminDb = null;
let adminStorageBucket = null;

try {
  if (fsSync.existsSync(FIREBASE_SERVICE_ACCOUNT_PATH)) {
    const serviceAccount = JSON.parse(fsSync.readFileSync(FIREBASE_SERVICE_ACCOUNT_PATH, 'utf8'));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'midgen-u6gv0i.firebasestorage.app'
    });
    adminDb = admin.firestore();
    adminStorageBucket = admin.storage().bucket();
    console.log('Firebase Admin initialisé (Firestore server-side actif).');
  } else {
    console.warn(`Service account introuvable: ${FIREBASE_SERVICE_ACCOUNT_PATH}`);
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
  MATIC: 'matic-network',
  TON: 'the-open-network'
};

app.use(cors());
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
  return null;
}

async function readUsersFile() {
  const content = await fs.readFile(USERS_FILE, 'utf8');
  return JSON.parse(content);
}

async function writeUsersFile(users) {
  await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

async function readTransactionsFile() {
  try {
    const content = await fs.readFile(TRANSACTIONS_FILE, 'utf8');
    return JSON.parse(content);
  } catch (_error) {
    return [];
  }
}

async function writeTransactionsFile(transactions) {
  await fs.writeFile(TRANSACTIONS_FILE, JSON.stringify(transactions, null, 2), 'utf8');
}

async function readConversationsFile() {
  try {
    const content = await fs.readFile(CONVERSATIONS_FILE, 'utf8');
    return JSON.parse(content);
  } catch (_error) {
    return [];
  }
}

async function writeConversationsFile(conversations) {
  await fs.writeFile(CONVERSATIONS_FILE, JSON.stringify(conversations, null, 2), 'utf8');
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

async function ensureConversationForTransactionData({ transactionId, buyerIdLogin, sellerIdLogin, senderIdLogin }) {
  const users = await resolveUsersByIdLogin([buyerIdLogin, sellerIdLogin, senderIdLogin]);
  const buyer = users.get(buyerIdLogin);
  const seller = users.get(sellerIdLogin);
  const sender = users.get(senderIdLogin);

  if (!buyer || !seller || !sender) {
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
        return res.json({ ok: true, user: { id: doc.id, ...doc.data() } });
      }

      const snapshot = await adminDb
        .collection('users')
        .where('id_login', '==', idLogin)
        .limit(1)
        .get();

      if (!snapshot.empty) {
        const found = snapshot.docs[0];
        return res.json({ ok: true, user: { id: found.id, ...found.data() } });
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

app.post('/api/users', async (req, res) => {
  try {
    const name = String(req.body?.Name || '').trim();
    const normalizedHandle = normalizeHandle(req.body?.handle);
    const idLogin = String(req.body?.id_login || req.body?.id || '').trim();
    const mail = String(req.body?.mail || req.body?.email || '').trim();
    const reputationValue = Number(req.body?.['réputation'] ?? 100);

    if (!name || !normalizedHandle || !idLogin || !mail) {
      return res.status(400).json({ ok: false, message: 'Champs requis manquants (Name, handle, id_login, mail).' });
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

    const newUser = {
      id: idLogin,
      handle: normalizedHandle,
      email: mail,
      Name: name,
      id_login: idLogin,
      mail,
      'réputation': Number.isFinite(reputationValue) ? reputationValue : 100
    };

    if (adminDb) {
      await adminDb.collection('users').doc(idLogin).set({
        Name: newUser.Name,
        handle: newUser.handle,
        id_login: newUser.id_login,
        mail: newUser.mail,
        réputation: newUser['réputation']
      });
    }

    const existsById = users.some(user => String(user.id || user.id_login || '') === idLogin);
    if (!existsById) {
      users.push(newUser);
      await writeUsersFile(users);
    }

    return res.status(201).json({ ok: true, user: newUser });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur création utilisateur backend.', error: error.message });
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
    const montant = Number(req.body?.montant);
    const garantieperiode = Number(req.body?.garantieperiode);
    const isBuyerRole = req.body?.isBuyerRole !== false;

    if (!buyerIdLogin || !counterpartyHandle || !titre || !cryptopaiement) {
      return res.status(400).json({ ok: false, message: 'Champs requis manquants (buyerIdLogin, counterpartyHandle, titre, cryptopaiement).' });
    }
    if (normalizedCrypto !== 'SOL') {
      return res.status(400).json({ ok: false, message: 'Seules les transactions SOL sont autorisées.' });
    }
    if (!Number.isFinite(montant) || montant <= 0) {
      return res.status(400).json({ ok: false, message: 'Montant invalide.' });
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
      cryptopaiement: 'SOL',
      montant,
      garantieperiode,
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

app.get('/api/transactions', async (req, res) => {
  try {
    const userIdLogin = String(req.query?.userIdLogin || '').trim();

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

      return {
        ...tx,
        datecreation,
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
      acheteur_name: usersByIdLogin.get(acheteurId) || acheteurId,
      vendeur_name: usersByIdLogin.get(vendeurId) || vendeurId
    };

    return res.json({ ok: true, transaction: enrichedTransaction });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur lecture transaction.', error: error.message });
  }
});

app.patch('/api/transactions/:id/statut', async (req, res) => {
  try {
    const transactionId = String(req.params.id || '').trim();
    const statut = String(req.body?.statut || '').trim();
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
      'DISPUTE',
      'RELEASED',
      'REFUNDED'
    ];

    if (!transactionId) {
      return res.status(400).json({ ok: false, message: 'ID transaction manquant.' });
    }

    if (!allowed.includes(statut)) {
      return res.status(400).json({ ok: false, message: 'Statut invalide.' });
    }

    let updated = false;

    if (adminDb) {
      const docRef = adminDb.collection('transactions').doc(transactionId);
      const doc = await docRef.get();
      if (doc.exists) {
        await docRef.update({ statut });
        updated = true;
      }
    }

    const localTransactions = await readTransactionsFile();
    const idx = localTransactions.findIndex(tx => String(tx.id || '').trim() === transactionId);
    if (idx >= 0) {
      localTransactions[idx].statut = statut;
      await writeTransactionsFile(localTransactions);
      updated = true;
    }

    if (!updated) {
      return res.status(404).json({ ok: false, message: 'Transaction introuvable.' });
    }

    return res.json({ ok: true, id: transactionId, statut });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Erreur mise à jour statut transaction.', error: error.message });
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

app.patch('/api/transactions/:id/wallets', async (req, res) => {
  try {
    const transactionId = String(req.params.id || '').trim();
    const walletVendeurEvm = String(req.body?.walletVendeurEvm || '').trim();
    const walletVendeurPhantom = String(req.body?.walletVendeurPhantom || '').trim();

    if (!transactionId) {
      return res.status(400).json({ ok: false, message: 'ID transaction manquant.' });
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
      text: '📄 Contrat généré automatiquement (étape Signer contrat).',
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

app.post('/api/conversations/from-transaction', async (req, res) => {
  try {
    const transactionId = String(req.body?.transactionId || '').trim();
    const buyerIdLogin = String(req.body?.buyerIdLogin || '').trim();
    const sellerIdLogin = String(req.body?.sellerIdLogin || '').trim();
    const senderIdLogin = String(req.body?.senderIdLogin || '').trim();

    if (!buyerIdLogin || !sellerIdLogin || !senderIdLogin) {
      return res.status(400).json({ ok: false, message: 'Champs requis manquants (buyerIdLogin, sellerIdLogin, senderIdLogin).' });
    }

    const users = await resolveUsersByIdLogin([buyerIdLogin, sellerIdLogin, senderIdLogin]);
    const buyer = users.get(buyerIdLogin);
    const seller = users.get(sellerIdLogin);
    const sender = users.get(senderIdLogin);

    if (!buyer || !seller || !sender) {
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

app.get('/api/conversations/:id/messages', async (req, res) => {
  try {
    const conversationId = String(req.params.id || '').trim();
    if (!conversationId) {
      return res.status(400).json({ ok: false, message: 'ID conversation manquant.' });
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

app.post('/api/conversations/:id/messages', async (req, res) => {
  try {
    const conversationId = String(req.params.id || '').trim();
    const text = String(req.body?.text || '').trim();
    const reference = String(req.body?.reference || '').trim();
    const attachmentName = String(req.body?.attachmentName || '').trim();
    const attachmentType = String(req.body?.attachmentType || '').trim();
    const attachmentSize = Number(req.body?.attachmentSize || 0);
    const senderIdLogin = String(req.body?.senderIdLogin || '').trim();

    if (!conversationId || !senderIdLogin) {
      return res.status(400).json({ ok: false, message: 'Champs requis manquants (conversationId, senderIdLogin).' });
    }

    if (!text && !reference) {
      return res.status(400).json({ ok: false, message: 'Le message doit contenir un texte ou une référence de pièce jointe.' });
    }

    const users = await resolveUsersByIdLogin([senderIdLogin]);
    const sender = users.get(senderIdLogin);
    const senderHandle = getNormalizedUserHandle(sender) || normalizeHandle(senderIdLogin);

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

app.post('/api/conversations/:id/attachments', async (req, res) => {
  try {
    const conversationId = String(req.params.id || '').trim();
    const senderIdLogin = String(req.body?.senderIdLogin || '').trim();
    const transactionId = String(req.body?.transactionId || '').trim();
    const fileNameRaw = String(req.body?.fileName || '').trim();
    const contentType = String(req.body?.contentType || 'application/octet-stream').trim();
    const base64Data = String(req.body?.base64Data || '').trim();

    if (!conversationId || !senderIdLogin || !fileNameRaw || !base64Data) {
      return res.status(400).json({ ok: false, message: 'Champs requis manquants (conversationId, senderIdLogin, fileName, base64Data).' });
    }

    if (!adminStorageBucket) {
      return res.status(503).json({ ok: false, message: 'Firebase Storage Admin indisponible côté serveur.' });
    }

    const safeFileName = fileNameRaw.replace(/[^a-zA-Z0-9._-]/g, '_');
    const objectPath = `conversations/${conversationId}/files/${Date.now()}_${safeFileName}`;

    const dataWithoutPrefix = base64Data.includes(',') ? base64Data.split(',').pop() : base64Data;
    const fileBuffer = Buffer.from(dataWithoutPrefix, 'base64');

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

app.get('/api/attachments/download', async (req, res) => {
  try {
    const reference = String(req.query?.reference || '').trim();
    const fileNameRaw = String(req.query?.fileName || 'piece-jointe').trim();

    if (!reference) {
      return res.status(400).json({ ok: false, message: 'Référence de fichier manquante.' });
    }

    const safeFileName = fileNameRaw.replace(/[^a-zA-Z0-9._-]/g, '_') || 'piece-jointe';
    const upstream = await fetch(reference);

    if (!upstream.ok) {
      return res.status(502).json({ ok: false, message: 'Impossible de récupérer le fichier depuis Storage.' });
    }

    const fileBuffer = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}"`);
    return res.send(fileBuffer);
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

app.use(express.static(FRONTEND_ROOT));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  return res.sendFile(path.join(FRONTEND_ROOT, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`OFM backend running on http://localhost:${PORT}`);
});

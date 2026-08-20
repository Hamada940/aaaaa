// ============================================================
// FINAL SERVER – Full Details Modal + Keyword Groups + Advanced Search
// ============================================================
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const ioClient = require('socket.io-client');
const crypto = require('crypto');
const axios = require('axios');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// ─── CONFIG ──────────────────────────────────────────────────
const SUPPORTED_COUNTRIES = ['ca'];
const DEFAULT_COUNTRY = 'ca';
const APP_VERSION = '4.7.0';
const DEVICE_NAME = 'cat-dashboard-v9';

const ECDSA_PRIVATE_JWK = {
    crv: "P-256",
    d: "x5vpowfSzCjS0zZWAyzGewCQaLyyY8Vw7mzmWBR6loQ",
    ext: true,
    key_ops: ["sign"],
    kty: "EC",
    x: "qTRfCjqGW_x785-DlpdIYoZm0be-t8j908YBMwYDpXU",
    y: "4wOAjBiaTtS_BJtNlix8mRtyv_7ONEYHsBAXcSCyELU"
};
const ECDSA_PUBLIC_JWK = {
    crv: "P-256",
    ext: true,
    key_ops: ["verify"],
    kty: "EC",
    x: "qTRfCjqGW_x785-DlpdIYoZm0be-t8j908YBMwYDpXU",
    y: "4wOAjBiaTtS_BJtNlix8mRtyv_7ONEYHsBAXcSCyELU"
};

const DASHBOARD_USERNAME = 'vine';
const DASHBOARD_PASSWORD = 'ChangeMe123!';

const API_URL = 'https://api.v-helper.com';
const WS_URL = 'wss://api.v-helper.com';

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const ITEMS_FILE = path.join(DATA_DIR, 'items.json');
const ACTIVITY_FILE = path.join(DATA_DIR, 'activity.json');
const KEYWORDS_FILE = path.join(DATA_DIR, 'keywords.json');

if (!fs.existsSync(ITEMS_FILE)) fs.writeFileSync(ITEMS_FILE, '[]', 'utf8');
if (!fs.existsSync(ACTIVITY_FILE)) fs.writeFileSync(ACTIVITY_FILE, '[]', 'utf8');
if (!fs.existsSync(KEYWORDS_FILE)) fs.writeFileSync(KEYWORDS_FILE, '{"highlight":[], "hide":[], "blur":[]}', 'utf8');

function loadJSON(file, def) {
    try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
    return def;
}
function saveJSON(file, data) {
    try { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); } catch (e) {}
}

let settings = loadJSON(path.join(DATA_DIR, 'settings.json'), { columns: 6 });
let pinnedKeywords = loadJSON(path.join(DATA_DIR, 'keywords.json'), { highlight: [], hide: [], blur: [] });
let unpinnedAsins = loadJSON(path.join(DATA_DIR, 'unpinned.json'), []);
let hiddenItems = loadJSON(path.join(DATA_DIR, 'hidden.json'), []);
let identity = loadJSON(path.join(DATA_DIR, 'identity.json'), null);

// ─── IDENTITY MANAGER ──────────────────────────────────────
class IdentityManager {
    constructor() { this.currentIdentity = identity; }
    generateCustomerId() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let id = 'A';
        for (let i = 0; i < 13; i++) id += chars[Math.floor(Math.random() * chars.length)];
        return id;
    }
    signECDSA(privateKeyJwk, dataString) {
        const privateKey = crypto.createPrivateKey({ key: privateKeyJwk, format: 'jwk' });
        const sign = crypto.createSign('SHA256');
        sign.update(dataString);
        sign.end();
        const raw = sign.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' });
        return raw.toString('base64');
    }
    getCID(country, customerId) {
        return crypto.createHash('sha256').update(`${country}${customerId}`).digest('hex');
    }
    async registerIdentity(country = DEFAULT_COUNTRY) {
        const customerId = this.generateCustomerId();
        const content = {
            api_version: 5,
            app_version: APP_VERSION,
            action: 'get_uuid',
            country: country,
            cid: this.getCID(country, customerId)
        };
        const dataString = JSON.stringify(content);
        const signature = this.signECDSA(ECDSA_PRIVATE_JWK, dataString);
        const payload = { ...content, s: signature, pk: ECDSA_PUBLIC_JWK };
        const response = await axios.post(API_URL, payload, { timeout: 15000 });
        if (response.data?.ok === 'ok' && response.data.uuid) {
            const identity = { uuid: response.data.uuid, customerId, country, createdAt: new Date().toISOString() };
            saveJSON(path.join(DATA_DIR, 'identity.json'), identity);
            this.currentIdentity = identity;
            return identity;
        }
        throw new Error('Registration failed');
    }
    async getOrCreateIdentity(country = DEFAULT_COUNTRY) {
        if (this.currentIdentity) return this.currentIdentity;
        return await this.registerIdentity(country);
    }
    async rotateIdentity(country = DEFAULT_COUNTRY) {
        fs.unlinkSync(path.join(DATA_DIR, 'identity.json'));
        return await this.registerIdentity(country);
    }
}
const identityManager = new IdentityManager();

// ─── EXPRESS SETUP ────────────────────────────────────────
const app = express();
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors());
app.use(compression());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ limit: '1mb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 500, message: 'Too many requests' }));

const server = http.createServer(app);
server.setMaxListeners(20);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingTimeout: 60000,
    pingInterval: 25000
});

function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.split(/\s+/).pop() || '';
    try {
        const decoded = Buffer.from(token, 'base64').toString();
        const [user, pass] = decoded.split(':');
        if (user === DASHBOARD_USERNAME && pass === DASHBOARD_PASSWORD) return next();
    } catch (e) {}
    res.set('WWW-Authenticate', 'Basic realm="VHelper Dashboard"');
    res.status(401).send('Authentication required');
}
app.use('/', requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

// ─── GLOBAL STATE ──────────────────────────────────────────
let allItems = loadJSON(ITEMS_FILE, []);
let activityLog = loadJSON(ACTIVITY_FILE, []);
let wsSocket = null;
let last100Received = false;

console.log(`[📂] Loaded ${allItems.length} items from disk`);
console.log(`[📂] Loaded ${activityLog.length} activity entries from disk`);

// ─── HELPERS ──────────────────────────────────────────────
function normalizeQueue(q) {
    const s = String(q || '').toLowerCase().replace(/\s+/g, '_');
    if (s.includes('afa') || s.includes('last')) return 'last_chance';
    if (s.includes('ai') || s.includes('encore')) return 'encore';
    if (s.includes('all')) return 'all_items';
    if (s.includes('potluck') || s.includes('rfy')) return 'potluck';
    return s;
}

function extractProduct(data, country) {
    const item = data.item || data.product || data;
    return {
        queue: normalizeQueue(item.queue || item.queueType || data.queue),
        title: item.title || item.name || 'Unknown Product',
        asin: item.asin || item.parentAsin || 'N/A',
        price: item.price || item.retail || 'N/A',
        etv: item.etv || item.price || 'N/A',
        etv_min: item.etv_min ?? item.etv ?? null,
        etv_max: item.etv_max ?? item.etv ?? null,
        brand: item.brand || item.byLine || item.seller || 'Unknown',
        date: item.date || item.createdAt || new Date().toISOString(),
        img_url: item.img_url || item.imageUrl || item.image || item.img || null,
        enrollment_guid: item.enrollment_guid || '',
        is_parent_asin: !!item.is_parent_asin,
        is_pre_release: !!item.is_pre_release,
        unavailable: !!item.unavailable || !!item.unavailableItem,
        variants: item.variants || [],
        limited: !!item.limited,
        coupon: item.coupon || '',
        discount: item.discount || '',
        stars: item.stars || '',
        reviewers: item.reviewers || '',
        shipping_country: item.shipping_country || '',
        country: country || DEFAULT_COUNTRY,
        additional_img: item.additional_img || [],
        order_success: item.order_success || 0,
        order_failed: item.order_failed || 0,
        date_added: item.date_added || item.date || new Date().toISOString(),
        reason: item.reason || 'stream',
        KW: item.KW || '',
        BlurKW: item.BlurKW || '',
        KWsMatch: !!item.KWsMatch,
        BlurKWsMatch: !!item.BlurKWsMatch,
        highlightGroupId: item.highlightGroupId || null,
        tier: item.tier || 'silver'
    };
}

function broadcastItem(item) {
    if (!item.title || item.title === 'Unknown Product') return;
    const existing = allItems.findIndex(i => i.asin === item.asin);
    if (existing !== -1) allItems.splice(existing, 1);
    allItems.unshift(item);
    if (allItems.length > 2000) allItems.pop();
    saveJSON(ITEMS_FILE, allItems);
    console.log(`[💾] Saved item: ${item.title} (total ${allItems.length})`);
    io.emit('newItem', item);
    addActivity('new_item', item);
}

function addActivity(type, data) {
    const ev = { type, data, date: new Date().toISOString() };
    activityLog.unshift(ev);
    if (activityLog.length > 1000) activityLog.pop();
    saveJSON(ACTIVITY_FILE, activityLog);
    io.emit('activity', ev);
}

// ─── WEBSOCKET CONNECTION ─────────────────────────────────
async function connectVHelper() {
    if (wsSocket) { try { wsSocket.disconnect(); } catch (e) {} }
    const identity = await identityManager.getOrCreateIdentity(DEFAULT_COUNTRY);
    wsSocket = ioClient(WS_URL, {
        transports: ['websocket'],
        query: {
            app_version: APP_VERSION,
            countryCode: 'ca',
            uuid: identity.uuid,
            fid: '',
            cid: identityManager.getCID('ca', identity.customerId),
            device_name: DEVICE_NAME
        }
    });

    last100Received = false;

    wsSocket.on('connect', () => console.log('[✓] Connected to VHelper CA'));
    wsSocket.on('connection_info', () => {
        console.log('[ℹ️] Received connection_info, requesting last 100...');
        setTimeout(() => {
            if (wsSocket && wsSocket.connected) {
                wsSocket.emit('getLast100', {
                    app_version: APP_VERSION,
                    uuid: identity.uuid,
                    cid: identityManager.getCID('ca', identity.customerId),
                    fid: '',
                    countryCode: 'ca',
                    limit: 100,
                    request_variants: false
                });
                console.log('[📤] Sent getLast100 request');
            }
        }, 500);
    });

    wsSocket.on('last100', (data) => {
        const products = data.products || data.items || [];
        console.log(`[📦] Received ${products.length} historical items`);
        products.forEach(raw => broadcastItem(extractProduct(raw, 'ca')));
        last100Received = true;
    });

    wsSocket.on('newItem', (data) => broadcastItem(extractProduct(data, 'ca')));
    wsSocket.on('items', (data) => {
        (data.items || []).forEach(raw => broadcastItem(extractProduct(raw, 'ca')));
    });
    wsSocket.on('message', (data) => {
        try {
            const p = JSON.parse(data);
            if (p.action === 'pong') return;
            const item = extractProduct(p, 'ca');
            broadcastItem(item);
        } catch (e) {}
    });

    wsSocket.on('disconnect', () => console.log('[✗] Disconnected'));

    setTimeout(async () => {
        if (!last100Received && wsSocket && wsSocket.connected) {
            console.log('[⚠️] last100 not received via WS, trying HTTP fallback...');
            try {
                const identity = await identityManager.getOrCreateIdentity('ca');
                const payload = {
                    api_version: 5,
                    app_version: APP_VERSION,
                    action: 'item_explorer',
                    country: 'ca',
                    uuid: identity.uuid,
                    cid: identityManager.getCID('ca', identity.customerId),
                    limit: 100,
                    orderBy: 'date_added_desc'
                };
                const dataString = JSON.stringify(payload);
                const signature = identityManager.signECDSA(ECDSA_PRIVATE_JWK, dataString);
                const signed = { ...payload, s: signature, pk: ECDSA_PUBLIC_JWK };
                const response = await axios.post(API_URL, signed, { timeout: 15000 });
                if (response.data && response.data.ok === 'ok' && response.data.items) {
                    const products = response.data.items;
                    console.log(`[📦] HTTP fallback got ${products.length} items`);
                    products.forEach(raw => broadcastItem(extractProduct(raw, 'ca')));
                }
            } catch (err) {
                console.error('[❌] HTTP fallback failed:', err.message);
            }
        }
    }, 10000);
}

// ─── KEYWORD GROUPS API ──────────────────────────────────
app.get('/api/keywords', (req, res) => res.json(pinnedKeywords));
app.post('/api/keywords', (req, res) => {
    const { type, keyword } = req.body;
    if (!type || !['highlight', 'hide', 'blur'].includes(type)) {
        return res.status(400).json({ error: 'Invalid keyword type' });
    }
    const kw = keyword?.trim();
    if (!kw) return res.status(400).json({ error: 'Keyword required' });
    if (!pinnedKeywords[type].includes(kw)) {
        pinnedKeywords[type].push(kw);
        saveJSON(KEYWORDS_FILE, pinnedKeywords);
        io.emit('keywordsUpdated', pinnedKeywords);
    }
    res.json({ success: true, keywords: pinnedKeywords });
});
app.post('/api/keywords/delete', (req, res) => {
    const { type, keyword } = req.body;
    if (!type || !pinnedKeywords[type]) return res.status(400).json({ error: 'Invalid type' });
    pinnedKeywords[type] = pinnedKeywords[type].filter(k => k !== keyword);
    saveJSON(KEYWORDS_FILE, pinnedKeywords);
    io.emit('keywordsUpdated', pinnedKeywords);
    res.json({ success: true });
});

// ─── UNPINNED / HIDDEN ──────────────────────────────────
app.get('/api/unpinned', (req, res) => res.json(unpinnedAsins));
app.post('/api/unpin', (req, res) => {
    const { asin } = req.body;
    if (asin && !unpinnedAsins.includes(asin)) {
        unpinnedAsins.push(asin);
        saveJSON(path.join(DATA_DIR, 'unpinned.json'), unpinnedAsins);
        io.emit('unpinnedUpdated', unpinnedAsins);
    }
    res.json({ success: true });
});
app.post('/api/pin', (req, res) => {
    const { asin } = req.body;
    unpinnedAsins = unpinnedAsins.filter(a => a !== asin);
    saveJSON(path.join(DATA_DIR, 'unpinned.json'), unpinnedAsins);
    io.emit('unpinnedUpdated', unpinnedAsins);
    res.json({ success: true });
});

app.get('/api/hidden', (req, res) => res.json(hiddenItems));
app.post('/api/hidden/toggle', (req, res) => {
    const { asin } = req.body;
    if (hiddenItems.includes(asin)) hiddenItems = hiddenItems.filter(a => a !== asin);
    else hiddenItems.push(asin);
    saveJSON(path.join(DATA_DIR, 'hidden.json'), hiddenItems);
    io.emit('hiddenUpdated', hiddenItems);
    res.json({ success: true });
});

app.post('/api/delete-item', (req, res) => {
    const { asin } = req.body;
    allItems = allItems.filter(i => i.asin !== asin);
    saveJSON(ITEMS_FILE, allItems);
    io.emit('itemDeleted', { asin });
    res.json({ success: true });
});

app.post('/api/delete-items', (req, res) => {
    const { asins } = req.body;
    if (Array.isArray(asins)) {
        allItems = allItems.filter(i => !asins.includes(i.asin));
        saveJSON(ITEMS_FILE, allItems);
        asins.forEach(asin => io.emit('itemDeleted', { asin }));
    }
    res.json({ success: true });
});

// ─── ADVANCED SEARCH API ──────────────────────────────────
app.get('/api/items', (req, res) => {
    let items = [...allItems];
    const {
        asin, title,
        etv_min, etv_max,
        price_min, price_max,
        queue,
        unavailable,
        sort = 'date_added_desc',
        page = 1,
        limit = 50
    } = req.query;

    // Filter: ASIN (partial match)
    if (asin) {
        const search = asin.toLowerCase().trim();
        items = items.filter(i => i.asin.toLowerCase().includes(search));
    }

    // Filter: Title (partial match)
    if (title) {
        const search = title.toLowerCase().trim();
        items = items.filter(i => (i.title || '').toLowerCase().includes(search));
    }

    // Filter: ETV range
    const etvMin = parseFloat(etv_min);
    const etvMax = parseFloat(etv_max);
    if (!isNaN(etvMin)) {
        items = items.filter(i => {
            const val = parseFloat(i.etv_min ?? i.etv);
            return !isNaN(val) && val >= etvMin;
        });
    }
    if (!isNaN(etvMax)) {
        items = items.filter(i => {
            const val = parseFloat(i.etv_max ?? i.etv);
            return !isNaN(val) && val <= etvMax;
        });
    }

    // Filter: Price range
    const priceMin = parseFloat(price_min);
    const priceMax = parseFloat(price_max);
    if (!isNaN(priceMin)) {
        items = items.filter(i => {
            const val = parseFloat(i.price);
            return !isNaN(val) && val >= priceMin;
        });
    }
    if (!isNaN(priceMax)) {
        items = items.filter(i => {
            const val = parseFloat(i.price);
            return !isNaN(val) && val <= priceMax;
        });
    }

    // Filter: Queue
    if (queue && queue !== 'all') {
        items = items.filter(i => i.queue === queue);
    }

    // Filter: Unavailable
    if (unavailable === 'true') {
        items = items.filter(i => i.unavailable === true);
    } else if (unavailable === 'false') {
        items = items.filter(i => i.unavailable !== true);
    }

    // Sorting
    const [field, order] = sort.split('_');
    const desc = order === 'desc';
    items.sort((a, b) => {
        let va = a[field] ?? '';
        let vb = b[field] ?? '';
        if (field === 'etv' || field === 'price') {
            va = parseFloat(va) || 0;
            vb = parseFloat(vb) || 0;
        } else if (field === 'date_added' || field === 'date') {
            va = new Date(va).getTime() || 0;
            vb = new Date(vb).getTime() || 0;
        } else {
            va = String(va).toLowerCase();
            vb = String(vb).toLowerCase();
        }
        if (va < vb) return desc ? 1 : -1;
        if (va > vb) return desc ? -1 : 1;
        return 0;
    });

    // Pagination
    const total = items.length;
    const p = parseInt(page) || 1;
    const lim = parseInt(limit) || 50;
    const start = (p - 1) * lim;
    const end = start + lim;
    const paginated = items.slice(start, end);

    res.json({
        items: paginated,
        total,
        page: p,
        totalPages: Math.ceil(total / lim),
        limit: lim
    });
});

app.get('/api/items/all', (req, res) => res.json(allItems));
app.get('/api/items/:asin', (req, res) => {
    const item = allItems.find(i => i.asin === req.params.asin);
    if (item) res.json(item);
    else res.status(404).json({ error: 'Not found' });
});

app.get('/api/activity', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    res.json(activityLog.slice(0, limit));
});

app.post('/api/identity/rotate', async (req, res) => {
    try {
        const newId = await identityManager.rotateIdentity('ca');
        connectVHelper();
        res.json({ success: true, identity: newId });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/clear-all', (req, res) => {
    allItems.length = 0;
    activityLog.length = 0;
    saveJSON(ITEMS_FILE, allItems);
    saveJSON(ACTIVITY_FILE, activityLog);
    io.emit('clearAll');
    console.log('[🧹] All items and activity cleared');
    res.json({ success: true });
});

// ─── START SERVER ──────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    console.log(`\n🍟♤ ｃ𝓐𝐓 🐟🎁`);
    console.log(`VHelper Dashboard (Canada Only) on port ${PORT}`);
    console.log(`User: ${DASHBOARD_USERNAME} / Pass: ${DASHBOARD_PASSWORD}`);
    console.log(`[📂] Loaded ${allItems.length} items from disk`);
    console.log(`[📂] Loaded ${activityLog.length} activity entries from disk\n`);
    if (!identity) identity = await identityManager.registerIdentity('ca');
    connectVHelper();

    setInterval(() => {
        const MAX_ITEMS = 2000;
        if (allItems.length > MAX_ITEMS) {
            const trimmed = allItems.length - MAX_ITEMS;
            allItems.splice(MAX_ITEMS);
            saveJSON(ITEMS_FILE, allItems);
            console.log(`[🧹] Auto-trimmed ${trimmed} old items (kept ${MAX_ITEMS})`);
            io.emit('itemsTrimmed', { kept: MAX_ITEMS });
        }
    }, 3600000);
});

process.on('SIGINT', () => {
    wsSocket?.disconnect();
    server.close(() => process.exit(0));
});

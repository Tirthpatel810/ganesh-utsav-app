/* =====================================================================
   GANESH UTSAV -- society event app (food counter + collection + expenses)

   Design notes worth knowing before editing this file:

   1. OFFLINE FIRST. Every screen renders from localStorage. The network
      is never in the path of a tap. A volunteer with no signal can serve
      plates and collect money all evening; it syncs when signal returns.

   2. APPEND-ONLY LEDGERS. We never update or delete a serving, a
      contribution or an expense. An undo writes a NEW negative row.
      That is why two phones can never conflict and why totals cannot
      drift. Every total in this file is a SUM.

   3. IDEMPOTENT PUSH. Every row carries a client_uid generated on the
      phone. The server has a unique index on it, so a retry after a
      dropped connection can never double-count.

   4. NO DEPENDENCIES. No CDN, no framework. Nothing external can break
      at 8pm on day two.
   ===================================================================== */
'use strict';
(function () {

const CFG      = window.GANESH_CONFIG || {};
const URL_BASE = (CFG.SUPABASE_URL || '').replace(/\/+$/, '');
const ANON     = CFG.SUPABASE_ANON || '';
const POLL_MS  = Math.max(2, CFG.POLL_SECONDS || 4) * 1000;
const QTYS     = CFG.QTY_BUTTONS || [1, 2, 3, 4, 5];
const UNDO_S   = CFG.UNDO_WINDOW_SECONDS || 900;
const VERSION  = '1.0.0';
// Only two ways money actually arrives at a society gate.
const MODES    = [['cash','Cash'], ['upi','UPI']];

/* ─────────────────────────── helpers ─────────────────────────── */
const $  = id => document.getElementById(id);
const qs = (s, r) => (r || document).querySelector(s);
const qa = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID()
    : 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
const pad = (n, w) => String(n).padStart(w, '0');
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2);
const today = () => ymd(new Date());
const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

let CUR = '₹';
const money = v => CUR + Math.round(num(v)).toLocaleString('en-IN');
const hhmm  = iso => { const d = new Date(iso);
    return pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2); };
const buzz = ms => { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) {} };

function toast(msg, kind, ms) {
    const t = document.createElement('div');
    t.className = 'toast ' + (kind || '');
    t.textContent = msg;
    $('toast-host').appendChild(t);
    setTimeout(() => t.remove(), ms || 2200);
}

/* ─────────────────────────── storage ─────────────────────────── */
const K = 'gu.v1.';
const LS = {
    get(k, d) { try { const v = localStorage.getItem(K + k);
                      return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(K + k, JSON.stringify(v)); } catch (e) {} },
    del(k)    { try { localStorage.removeItem(K + k); } catch (e) {} }
};

/* ─────────────────────────── auth ─────────────────────────── */
const AUTH = {
    s: LS.get('session', null),

    save() { LS.set('session', this.s); },

    async signIn(email, password) {
        const r = await fetch(URL_BASE + '/auth/v1/token?grant_type=password', {
            method: 'POST',
            headers: { apikey: ANON, 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email, password: password })
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error_description || j.msg || j.error || 'Sign in failed');
        this.s = { at: j.access_token, rt: j.refresh_token,
                   exp: Date.now() + (j.expires_in || 3600) * 1000, user: j.user };
        this.save();
        return this.s;
    },

    async refresh() {
        if (!this.s || !this.s.rt) throw new Error('no session');
        const r = await fetch(URL_BASE + '/auth/v1/token?grant_type=refresh_token', {
            method: 'POST',
            headers: { apikey: ANON, 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: this.s.rt })
        });
        const j = await r.json();
        if (!r.ok) { this.signOut(); throw new Error('session expired'); }
        this.s.at  = j.access_token;
        this.s.rt  = j.refresh_token || this.s.rt;
        this.s.exp = Date.now() + (j.expires_in || 3600) * 1000;
        this.save();
        return this.s;
    },

    async token() {
        if (!this.s) throw new Error('not signed in');
        // refresh a minute early so a request never dies mid-flight
        if (Date.now() > this.s.exp - 60000) await this.refresh();
        return this.s.at;
    },

    signOut() { this.s = null; LS.del('session'); }
};

/* ─────────────────────────── REST ─────────────────────────── */
async function rest(path, opts, _retried) {
    const o = opts || {};
    const token = await AUTH.token();
    const r = await fetch(URL_BASE + '/rest/v1/' + path, {
        method: o.method || 'GET',
        headers: Object.assign({
            apikey: ANON,
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json'
        }, o.headers || {}),
        body: o.body
    });
    if (r.status === 401 && !_retried) { await AUTH.refresh(); return rest(path, o, true); }
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 300));
    if (r.status === 204) return null;
    const txt = await r.text();
    return txt ? JSON.parse(txt) : null;
}

// insert rows, collapsing any duplicate client_uid from an offline retry
function insertRows(table, rows) {
    return rest(table + '?on_conflict=client_uid', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(rows)
    });
}

async function uploadBill(pathName, dataUrl) {
    const token = await AUTH.token();
    const blob  = await (await fetch(dataUrl)).blob();
    const r = await fetch(URL_BASE + '/storage/v1/object/bills/' + pathName, {
        method: 'POST',
        headers: { apikey: ANON, Authorization: 'Bearer ' + token,
                   'Content-Type': blob.type || 'image/jpeg', 'x-upsert': 'true' },
        body: blob
    });
    if (!r.ok && r.status !== 409) throw new Error('bill upload ' + r.status);
}

/* ─────────────────────────── state ─────────────────────────── */
const EPOCH = '1970-01-01T00:00:00Z';
const S = {
    settings: LS.get('settings', {}),
    houses:   LS.get('houses', []),
    days:     LS.get('days', []),
    cats:     LS.get('cats', []),
    servings:      LS.get('servings', []),
    contributions: LS.get('contributions', []),
    expenses:      LS.get('expenses', []),
    queue:  LS.get('queue', { servings: [], contributions: [], expenses: [] }),
    photos: LS.get('photos', {}),
    cursors: LS.get('cursors', { servings: 0, contributions: 0, expenses: 0,
                                 houses: EPOCH, cats: EPOCH }),
    profile: LS.get('profile', { display_name: '', role: 'volunteer',
                                 receipt_series: '', can_collect: true, can_expense: false }),
    device:  LS.get('device', ''),
    recent:  LS.get('recent', []),
    activeDate:   LS.get('activeDate', null),
    groupServe:   null, groupCollect: null,
    searchServe: '', searchCollect: '', searchRoster: '',
    tab: 'serve', online: navigator.onLine, syncing: false, flushing: false,
    lastSync: LS.get('lastSync', null),
    houseSel: null, collectSel: null, pendingServe: null,
    csMode: 'cash', eMode: 'cash', ePhoto: null,
    csGanpati: '', csQty: {}
};
S.queue.servings      = S.queue.servings      || [];
S.queue.contributions = S.queue.contributions || [];
S.queue.expenses      = S.queue.expenses      || [];

function persist() {
    LS.set('settings', S.settings);   LS.set('houses', S.houses);
    LS.set('days', S.days);           LS.set('cats', S.cats);
    LS.set('servings', S.servings);   LS.set('contributions', S.contributions);
    LS.set('expenses', S.expenses);   LS.set('queue', S.queue);
    LS.set('photos', S.photos);       LS.set('cursors', S.cursors);
    LS.set('profile', S.profile);     LS.set('device', S.device);
    LS.set('recent', S.recent);       LS.set('activeDate', S.activeDate);
    LS.set('lastSync', S.lastSync);
}

/* ─────────────────── derived indexes (rebuilt on change) ─────────────────── */
const IDX = { house: {}, plate: {}, money: {}, day: {}, cat: {}, extra: {}, extraCharge: {},
               reg: {}, ganpati: {}, food: {}, regDays: {} };

function allServings()      { return S.servings.concat(S.queue.servings); }
function allContributions() { return S.contributions.concat(S.queue.contributions); }
function allExpenses()      { return S.expenses.concat(S.queue.expenses); }

function reindex() {
    IDX.house = {};
    S.houses.forEach(h => { IDX.house[h.id] = h; });

    // plate tallies: houseId|date -> {normal, extra, total}
    IDX.plate = {};
    IDX.day   = {};
    allServings().forEach(r => {
        const k = (r.house_id == null ? 'g' : r.house_id) + '|' + r.event_date;
        const t = IDX.plate[k] || (IDX.plate[k] = { normal: 0, extra: 0, total: 0 });
        if (r.is_extra) t.extra += r.qty; else t.normal += r.qty;
        t.total += r.qty;
        const d = IDX.day[r.event_date] ||
                  (IDX.day[r.event_date] = { total: 0, extra: 0, guest: 0, houses: {} });
        d.total += r.qty;
        if (r.is_extra) d.extra += r.qty;
        if (r.is_guest) d.guest += r.qty;
        if (r.house_id != null) d.houses[r.house_id] = (d.houses[r.house_id] || 0) + r.qty;
    });

    // money per house, split by what it was collected FOR
    //
    // Registration is not a property of the house. It is what that house has
    // PAID FOR on a given day. A family that gave only to ganpati is
    // registered for zero plates, so every plate it takes is chargeable.
    IDX.money = {}; IDX.ganpati = {}; IDX.food = {};
    IDX.reg = {}; IDX.regDays = {};
    allContributions().forEach(r => {
        if (r.house_id == null) return;
        const amt = num(r.amount);
        IDX.money[r.house_id] = (IDX.money[r.house_id] || 0) + amt;
        if (r.purpose === 'food') {
            IDX.food[r.house_id] = (IDX.food[r.house_id] || 0) + amt;
            if (r.event_date) {
                const k = r.house_id + '|' + r.event_date;
                IDX.reg[k] = (IDX.reg[k] || 0) + num(r.qty);
                const d = IDX.regDays[r.house_id] || (IDX.regDays[r.house_id] = {});
                d[r.event_date] = (d[r.event_date] || 0) + num(r.qty);
            }
        } else {
            IDX.ganpati[r.house_id] = (IDX.ganpati[r.house_id] || 0) + amt;
        }
    });

    // Chargeable extras = plates taken beyond what was paid for, on that day,
    // valued at that day's price. Computed after IDX.reg is built.
    IDX.extra = {}; IDX.extraCharge = {};
    for (const k in IDX.plate) {
        const parts = k.split('|');
        const hid = parts[0], date = parts[1];
        if (hid === 'g') continue;
        const taken = IDX.plate[k].total;
        const paidFor = IDX.reg[k] || 0;
        const over = Math.max(0, taken - paidFor);
        if (!over) continue;
        IDX.extra[hid] = (IDX.extra[hid] || 0) + over;
        IDX.extraCharge[hid] = (IDX.extraCharge[hid] || 0) + over * dayRate(date);
    }

    IDX.cat = {};
    S.cats.forEach(c => { IDX.cat[c.id] = c; });
}

function platesAllDays(houseId) {
    let n = 0;
    for (const k in IDX.plate) {
        if (k.split('|')[0] === String(houseId)) n += IDX.plate[k].total;
    }
    return n;
}
// Each event day has its own plate price. An extra Full Dish must never be
// billed at the price of a Moong Pulao, so every chargeable plate is valued at
// the price of the day it was actually taken. The event-wide rate is only a
// fallback for a date that is not a listed event day.
function dayRate(date) {
    const d = S.days.filter(x => x.event_date === date)[0];
    if (d && d.plate_rate != null && d.plate_rate !== '') return num(d.plate_rate);
    return num(S.settings.extra_plate_rate);
}
function dayMenu(date) {
    const d = S.days.filter(x => x.event_date === date)[0];
    return d ? (d.menu_label || '') : '';
}
// how many plates this house has PAID FOR on this day
const registeredQty = (houseId, date) => IDX.reg[houseId + '|' + date] || 0;
const ganpatiOf     = houseId => IDX.ganpati[houseId] || 0;
const foodPaidOf    = houseId => IDX.food[houseId] || 0;
const daysRegistered = houseId => Object.keys(IDX.regDays[houseId] || {})
    .filter(d => IDX.regDays[houseId][d] > 0).length;
const platesPaidFor  = houseId => Object.keys(IDX.regDays[houseId] || {})
    .reduce((a, k) => a + IDX.regDays[houseId][k], 0);

const plateTally = (houseId, date) =>
    IDX.plate[(houseId == null ? 'g' : houseId) + '|' + date] || { normal: 0, extra: 0, total: 0 };
const paidOf = houseId => IDX.money[houseId] || 0;
const rate   = () => num(S.settings.extra_plate_rate);

// total chargeable extra plates for a house, and their value, across all days
const extraPlatesAllDays  = houseId => IDX.extra[houseId] || 0;
const extraChargeAllDays  = houseId => IDX.extraCharge[houseId] || 0;
// There is no "expected" any more. Ganpati is whatever a family chooses to
// give, so it can never be a debt and can never show a negative. The only
// thing a house can owe is plates taken beyond what it paid for.
function houseBalance(h) {
    const extra = extraChargeAllDays(h.id);
    return {
        ganpati: ganpatiOf(h.id),
        food:    foodPaidOf(h.id),
        total:   paidOf(h.id),
        days:    daysRegistered(h.id),
        extra:   extra,
        due:     extra
    };
}

/* ─────────────────────────── sync ─────────────────────────── */
function setNet(state, text, queued) {
    const b = $('netbar');
    b.dataset.state = state;
    $('netbar-text').textContent = text;
    const q = $('netbar-queue');
    if (queued > 0) { q.hidden = false; q.textContent = queued + ' queued'; }
    else q.hidden = true;
}
const queueSize = () =>
    S.queue.servings.length + S.queue.contributions.length + S.queue.expenses.length;

function netStatus() {
    const q = queueSize();
    if (!S.online)   setNet('off',  'Offline · saved on this phone', q);
    else if (q > 0)  setNet('sync', 'Syncing…', q);
    else if (S.syncing) setNet('sync', 'Syncing…', 0);
    else setNet('ok', 'Online · synced' + (S.lastSync ? ' ' + hhmm(S.lastSync) : ''), 0);
}

async function pullPaged(table, cursorKey, orderCol) {
    const col = orderCol || 'id';
    let cur = S.cursors[cursorKey], got = [], guard = 0;
    while (guard++ < 40) {
        const filter = col + '=gt.' + encodeURIComponent(cur);
        const rows = await rest(table + '?' + filter + '&order=' + col + '.asc&limit=1000');
        if (!rows || !rows.length) break;
        got = got.concat(rows);
        cur = rows[rows.length - 1][col];
        if (rows.length < 1000) break;
    }
    S.cursors[cursorKey] = cur;
    return got;
}

function mergeLedger(listName, rows) {
    if (!rows.length) return;
    const seen = {};
    S[listName].forEach(r => { seen[r.id] = 1; });
    rows.forEach(r => { if (!seen[r.id]) { S[listName].push(r); seen[r.id] = 1; } });
    // drop queued copies the server has now confirmed
    const conf = {};
    rows.forEach(r => { if (r.client_uid) conf[r.client_uid] = 1; });
    S.queue[listName] = S.queue[listName].filter(r => !conf[r.client_uid]);
}

function upsertMaster(listName, rows) {
    if (!rows.length) return;
    const byId = {};
    S[listName].forEach((r, i) => { byId[r.id] = i; });
    rows.forEach(r => {
        if (byId[r.id] != null) S[listName][byId[r.id]] = r;
        else { byId[r.id] = S[listName].length; S[listName].push(r); }
    });
}

async function bootstrap() {
    S.cursors = { servings: 0, contributions: 0, expenses: 0, houses: EPOCH, cats: EPOCH };
    S.servings = []; S.contributions = []; S.expenses = []; S.houses = []; S.cats = [];
    await syncNow(true);
}

async function loadProfile() {
    if (!AUTH.s || !AUTH.s.user) return;
    const rows = await rest('profiles?id=eq.' + AUTH.s.user.id + '&limit=1');
    if (rows && rows[0]) S.profile = rows[0];
}

async function syncNow(full) {
    if (S.syncing || !S.online) return;
    S.syncing = true; netStatus();
    try {
        const st = await rest('app_settings?id=eq.1&limit=1');
        if (st && st[0]) { S.settings = st[0]; CUR = S.settings.currency_symbol || '₹'; }

        const days = await rest('event_days?order=day_no.asc');
        if (days) S.days = days;

        upsertMaster('houses', await pullPaged('houses', 'houses', 'updated_at'));
        await pullCats();

        mergeLedger('servings',      await pullPaged('servings', 'servings'));
        mergeLedger('contributions', await pullPaged('contributions', 'contributions'));
        mergeLedger('expenses',      await pullPaged('expenses', 'expenses'));

        if (full || !S.profile.display_name) await loadProfile();

        S.lastSync = new Date().toISOString();
        persist(); reindex(); renderAll();
    } catch (e) {
        console.warn('sync failed', e);
        if (full) toast('Sync failed: ' + e.message, 'bad', 4000);
    } finally { S.syncing = false; netStatus(); await flush(); }
}

// `cats` lives at a different table name than its cursor key
async function pullCats() {
    const rows = await rest('expense_categories?order=sort_order.asc');
    if (rows) { S.cats = rows; }
}

async function flush() {
    if (S.flushing || !S.online || !queueSize()) { netStatus(); return; }
    S.flushing = true; netStatus();
    try {
        for (const name of ['servings', 'contributions', 'expenses']) {
            while (S.queue[name].length) {
                const batch = S.queue[name].slice(0, 50);

                if (name === 'expenses') {                 // bill photos first
                    for (const row of batch) {
                        const p = S.photos[row.client_uid];
                        if (p && row.bill_path) {
                            try { await uploadBill(row.bill_path, p);
                                  delete S.photos[row.client_uid]; }
                            catch (e) { console.warn('bill upload deferred', e); }
                        }
                    }
                }
                const payload = batch.map(r => {
                    const c = Object.assign({}, r);
                    delete c._local; return c;
                });
                const saved = await insertRows(name, payload);
                mergeLedger(name, saved || []);
                const done = {};
                batch.forEach(r => { done[r.client_uid] = 1; });
                S.queue[name] = S.queue[name].filter(r => !done[r.client_uid]);
                persist();
            }
        }
        S.lastSync = new Date().toISOString();
        persist(); reindex(); renderAll();
    } catch (e) {
        console.warn('flush failed', e);
    } finally { S.flushing = false; netStatus(); }
}

/* ─────────────────────── activity log (grouped) ─────────────────────── */
function activityFor(date) {
    const out = [];
    const voided = {};
    allServings().forEach(r => { if (r.void_of_id) voided['s' + r.void_of_id] = 1; });
    allContributions().forEach(r => { if (r.void_of_id) voided['c' + r.void_of_id] = 1; });
    allExpenses().forEach(r => { if (r.void_of_id) voided['e' + r.void_of_id] = 1; });

    // servings grouped by action_id so one undo reverses the whole tap
    const acts = {};
    allServings().forEach(r => {
        if (date && r.event_date !== date) return;
        const a = acts[r.action_id] || (acts[r.action_id] = {
            kind: 'serve', action_id: r.action_id, rows: [], qty: 0, extra: 0,
            house_id: r.house_id, is_guest: r.is_guest, at: r.served_at,
            pending: false, reversal: !!r.void_of_id, reversed: false });
        a.rows.push(r); a.qty += r.qty;
        if (r.is_extra) a.extra += r.qty;
        if (r._local) a.pending = true;
        if (r.id && voided['s' + r.id]) a.reversed = true;
    });
    for (const k in acts) out.push(acts[k]);

    allContributions().forEach(r => {
        if (date && (r.collected_at || '').slice(0, 10) !== date) return;
        out.push({ kind: 'collect', row: r, at: r.collected_at, qty: num(r.amount),
                   pending: !!r._local, reversal: !!r.void_of_id,
                   reversed: !!(r.id && voided['c' + r.id]) });
    });
    allExpenses().forEach(r => {
        if (date && (r.created_at || '').slice(0, 10) !== date) return;
        out.push({ kind: 'spend', row: r, at: r.created_at, qty: num(r.amount),
                   pending: !!r._local, reversal: !!r.void_of_id,
                   reversed: !!(r.id && voided['e' + r.id]) });
    });
    out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return out;
}
const undoable = a => !a.reversal && !a.reversed &&
    (Date.now() - new Date(a.at).getTime()) < UNDO_S * 1000;

/* ═══════════════════════════ ACTIONS ═══════════════════════════ */

function pushRow(name, row) {
    row._local = true;
    row.client_uid = row.client_uid || uid();
    S.queue[name].push(row);
    persist(); reindex(); renderAll(); flush();
}

/* ---- food ---- */
function planServe(house, n) {
    const t = plateTally(house.id, S.activeDate);
    const paidFor = registeredQty(house.id, S.activeDate);
    const free = Math.max(0, paidFor - t.total);
    const normal = Math.min(n, free);
    return { tally: t, paidFor: paidFor, free: free, normal: normal, extra: n - normal };
}

function commitServe(house, normalQty, extraQty, isGuest) {
    const action = uid(), now = new Date().toISOString();
    const base = {
        action_id: action, house_id: isGuest ? null : house.id,
        event_date: S.activeDate, is_guest: !!isGuest,
        served_by: S.profile.display_name || '', device_label: S.device || '',
        served_at: now, void_of_id: null
    };
    if (!isGuest) {
        S.recent = [house.id].concat(S.recent.filter(x => x !== house.id)).slice(0, 8);
    }
    if (normalQty > 0) pushRow('servings',
        Object.assign({}, base, { qty: normalQty, is_extra: false, client_uid: uid() }));
    if (extraQty > 0) pushRow('servings',
        Object.assign({}, base, { qty: extraQty, is_extra: true, client_uid: uid() }));

    buzz(extraQty > 0 ? [40, 60, 40] : 35);
    const who = isGuest ? 'Guest' : house.house_code + (house.family_name ? ' · ' + house.family_name : '');
    toast(who + '  +' + (normalQty + extraQty) + (extraQty > 0 ? '  (' + extraQty + ' extra)' : ''),
          extraQty > 0 ? 'warn' : 'ok');
    closeSheets();
}

function serveHouse(house, n) {
    n = clamp(Math.round(num(n)), 1, 99);
    const p = planServe(house, n);
    if (p.extra > 0 && S.settings.allow_extra_plates === false) {
        toast('Extra plates are switched off', 'bad'); return;
    }
    if (p.extra > 0) { askExtra(house, n, p); return; }
    commitServe(house, p.normal, 0, false);
}

function undoAction(a) {
    if (a.kind === 'serve') {
        // rows never sent to the server can simply leave the queue
        const local = a.rows.filter(r => r._local);
        if (local.length === a.rows.length) {
            const ids = {}; local.forEach(r => { ids[r.client_uid] = 1; });
            S.queue.servings = S.queue.servings.filter(r => !ids[r.client_uid]);
            persist(); reindex(); renderAll();
            toast('Removed', 'ok'); buzz(20); return;
        }
        const action = uid(), now = new Date().toISOString();
        a.rows.forEach(r => {
            if (!r.id) return;
            pushRow('servings', {
                action_id: action, house_id: r.house_id, event_date: r.event_date,
                qty: -r.qty, is_extra: r.is_extra, is_guest: r.is_guest,
                served_by: S.profile.display_name || '', device_label: S.device || '',
                served_at: now, void_of_id: r.id, client_uid: uid()
            });
        });
        toast('Undone', 'ok'); buzz(20); return;
    }

    const r = a.row;
    const name = a.kind === 'collect' ? 'contributions' : 'expenses';
    if (r._local) {
        S.queue[name] = S.queue[name].filter(x => x.client_uid !== r.client_uid);
        if (name === 'expenses') delete S.photos[r.client_uid];
        persist(); reindex(); renderAll(); toast('Removed', 'ok'); return;
    }
    if (a.kind === 'collect') {
        pushRow('contributions', {
            house_id: r.house_id, donor_name: r.donor_name, amount: -num(r.amount),
            mode: r.mode, receipt_series: r.receipt_series, receipt_no: null,
            collected_by: S.profile.display_name || '',
            collected_by_uid: AUTH.s && AUTH.s.user ? AUTH.s.user.id : null,
            notes: 'reversal of receipt ' + r.receipt_series + '/' + r.receipt_no,
            void_of_id: r.id, collected_at: new Date().toISOString(), client_uid: uid()
        });
    } else {
        pushRow('expenses', {
            category_id: r.category_id, description: r.description, vendor_name: r.vendor_name,
            amount: -num(r.amount), mode: r.mode, spent_on: r.spent_on,
            paid_by: S.profile.display_name || '',
            paid_by_uid: AUTH.s && AUTH.s.user ? AUTH.s.user.id : null,
            bill_path: '', status: 'draft', notes: 'reversal',
            void_of_id: r.id, created_at: new Date().toISOString(), client_uid: uid()
        });
    }
    toast('Reversed', 'ok');
}

/* ---- receipts ---- */
function nextReceiptNo() {
    const series = S.profile.receipt_series || '';
    if (!series) return null;
    let max = 0;
    allContributions().forEach(r => {
        if (r.receipt_series === series && r.receipt_no) max = Math.max(max, r.receipt_no);
    });
    return max + 1;
}
function receiptLabel(no) {
    const series = S.profile.receipt_series || '?';
    const pre = S.settings.receipt_prefix || 'GU';
    return no ? pre + '/' + series + '/' + pad(no, 4) : 'no series assigned';
}

/* ---- collection ---- */
function commitCollect(house, donorName, amount, mode, note) {   // donors only
    amount = num(amount);
    if (amount <= 0) { return 'Enter an amount'; }
    const no = nextReceiptNo();
    if (!no) return 'This volunteer has no receipt series. An admin must set one.';
    pushRow('contributions', {
        house_id: house ? house.id : null, donor_name: house ? '' : (donorName || '').trim(),
        purpose: 'ganpati', event_date: null, qty: null, collection_uid: uid(),
        amount: amount, mode: mode || 'cash',
        receipt_series: S.profile.receipt_series, receipt_no: no,
        collected_by: S.profile.display_name || '',
        collected_by_uid: AUTH.s && AUTH.s.user ? AUTH.s.user.id : null,
        notes: note || '', void_of_id: null,
        collected_at: new Date().toISOString(), client_uid: uid()
    });
    buzz([30, 50, 30]);
    toast((house ? house.house_code : donorName) + '  ' + money(amount) +
          '  ·  ' + receiptLabel(no), 'ok', 3200);
    return null;
}

/* ---- expenses ---- */
function commitExpense(d) {
    const cuid = uid();
    const hasPhoto = !!S.ePhoto;
    if (hasPhoto) { S.photos[cuid] = S.ePhoto; }
    pushRow('expenses', {
        category_id: d.category_id, description: d.description, vendor_name: d.vendor_name,
        amount: num(d.amount), mode: d.mode, spent_on: d.spent_on,
        paid_by: d.paid_by || S.profile.display_name || '',
        paid_by_uid: AUTH.s && AUTH.s.user ? AUTH.s.user.id : null,
        bill_path: hasPhoto ? cuid + '.jpg' : '',   // deterministic: no UPDATE ever needed
        status: S.profile.role === 'admin' ? 'approved' : 'draft',
        notes: '', void_of_id: null,
        created_at: new Date().toISOString(), client_uid: cuid
    });
    buzz(35);
    toast('Expense saved  ' + money(d.amount), 'ok');
}

/* ═══════════════════════════ RENDER ═══════════════════════════ */

function activeDay() { return S.days.filter(d => d.event_date === S.activeDate)[0] || null; }

function pickActiveDate() {
    if (S.activeDate && S.days.some(d => d.event_date === S.activeDate)) return;
    const t = today();
    const exact = S.days.filter(d => d.event_date === t)[0];
    if (exact) { S.activeDate = t; return; }
    const future = S.days.filter(d => d.event_date >= t).sort((a, b) =>
        a.event_date.localeCompare(b.event_date))[0];
    S.activeDate = future ? future.event_date
                 : (S.days.length ? S.days[S.days.length - 1].event_date : t);
}

function renderTopbar() {
    const d = activeDay();
    $('day-badge').textContent = d ? 'Day ' + d.day_no + ' · ' + d.event_date.slice(8) + '/' +
        d.event_date.slice(5, 7) : (S.activeDate || '—');
    $('day-menu').textContent = d
        ? (d.menu_label || 'Event day') +
          (d.plate_rate != null ? '  ·  ' + money(d.plate_rate) : '')
        : 'No event day set';
    if (S.tab === 'collect') {
        let tot = 0; allContributions().forEach(r => { tot += num(r.amount); });
        $('topbar-val').textContent = money(tot).replace(CUR, '');
        $('topbar-key').textContent = 'collected';
    } else if (S.tab === 'expense') {
        let tot = 0; allExpenses().forEach(r => { tot += num(r.amount); });
        $('topbar-val').textContent = money(tot).replace(CUR, '');
        $('topbar-key').textContent = 'spent';
    } else {
        const dd = IDX.day[S.activeDate];
        $('topbar-val').textContent = dd ? dd.total : 0;
        $('topbar-key').textContent = 'plates';
    }
}

function groups() {
    const seen = {}, out = [];
    S.houses.forEach(h => { if (!seen[h.wing_group]) { seen[h.wing_group] = 1; out.push(h.wing_group); } });
    return out.sort();
}

function renderGroupTabs(hostId, current, onPick) {
    const host = $(hostId), gs = groups();
    host.innerHTML = '';
    gs.forEach(g => {
        const n = S.houses.filter(h => h.wing_group === g && h.is_active).length;
        const b = document.createElement('button');
        b.className = g === current ? 'active' : '';
        b.innerHTML = esc(g) + '<small>' + n + ' homes</small>';
        b.onclick = () => onPick(g);
        host.appendChild(b);
    });
    host.hidden = gs.length < 2;
}

function filterHouses(group, search) {
    const q = (search || '').trim().toLowerCase();
    let list = S.houses.slice();
    if (q) {
        list = list.filter(h =>
            String(h.number_label).toLowerCase().indexOf(q) === 0 ||
            h.house_code.toLowerCase().indexOf(q) >= 0 ||
            (h.family_name || '').toLowerCase().indexOf(q) >= 0);
    } else if (group) {
        list = list.filter(h => h.wing_group === group);
    }
    return list.sort((a, b) => a.wing_group === b.wing_group
        ? a.sort_order - b.sort_order
        : a.wing_group.localeCompare(b.wing_group));
}

// A-1 and C-1 both used to render as "1", so switching wings looked like
// nothing had happened. The button now carries the wing letter.
function shortCode(h) {
    const wing = String(h.house_code || '').split('-')[0];
    return wing + String(h.number_label);
}
function houseButton(h, cls, badge) {
    const b = document.createElement('button');
    b.className = 'hbtn ' + cls + (h.is_active ? '' : ' inactive');
    const lab = shortCode(h);
    b.innerHTML =
        (badge ? '<span class="cnt">' + esc(badge) + '</span>' : '') +
        '<span class="n' + (lab.length > 4 ? ' long' : '') + '">' + esc(lab) + '</span>' +
        (h.family_name ? '<span class="fam">' + esc(h.family_name) + '</span>' : '');
    return b;
}

/* ---- serve grid ---- */
function renderServe() {
    const list = filterHouses(S.groupServe, S.searchServe);
    const host = $('house-grid');
    host.innerHTML = '';
    list.forEach(h => {
        const t = plateTally(h.id, S.activeDate);
        let cls = 'none';
        if (t.extra > 0) cls = 'extra';
        else if (t.normal > 0 && t.normal >= num(h.member_count)) cls = 'full';
        else if (t.normal > 0) cls = 'part';
        const b = houseButton(h, cls, t.total > 0 ? t.total : '');
        b.onclick = () => openServeSheet(h);
        host.appendChild(b);
    });
    $('grid-empty').hidden = list.length > 0;

    const strip = $('recent-strip'), items = $('recent-items');
    const rec = S.recent.map(id => IDX.house[id]).filter(Boolean);
    strip.hidden = rec.length === 0 || !!S.searchServe;
    items.innerHTML = '';
    rec.forEach(h => {
        const c = document.createElement('button');
        c.className = 'recent-chip';
        c.textContent = h.house_code;
        c.onclick = () => openServeSheet(h);
        items.appendChild(c);
    });
}

/* ---- collect grid ---- */
function renderCollect() {
    let collected = 0, platesPaid = 0;
    allContributions().forEach(r => {
        collected += num(r.amount);
        if (r.purpose === 'food') platesPaid += num(r.qty);
    });
    $('c-collected').textContent = money(collected);
    $('c-plates').textContent = platesPaid;

    const nDays = S.days.length || 7;
    const list = filterHouses(S.groupCollect, S.searchCollect);
    const host = $('collect-grid');
    host.innerHTML = '';
    list.forEach(h => {
        const b0 = houseBalance(h);
        let cls = 'none';
        if (b0.days >= nDays)      cls = 'full';     // registered for every day
        else if (b0.days > 0)      cls = 'part';     // some days
        else if (b0.total > 0)     cls = 'over';     // gave ganpati only
        const badge = b0.days > 0 ? b0.days + 'd'
                    : (b0.total > 0 ? '\u20b9' : '');
        const b = houseButton(h, cls, badge);
        b.onclick = () => openCollectSheet(h);
        host.appendChild(b);
    });
    $('c-grid-empty').hidden = list.length > 0;
}

/* ---- expense tab ---- */
function renderExpense() {
    let spent = 0, drafts = 0, collected = 0;
    allExpenses().forEach(r => { spent += num(r.amount);
        if (r.status !== 'approved' && !r.void_of_id) drafts++; });
    allContributions().forEach(r => { collected += num(r.amount); });
    $('e-spent').textContent = money(spent);
    $('e-hand').textContent  = money(collected - spent);
    $('e-draft').textContent = drafts;

    const sel = $('e-cat');
    if (sel.options.length !== S.cats.length) {
        const keep = sel.value;
        sel.innerHTML = '';
        S.cats.forEach(c => {
            const o = document.createElement('option');
            o.value = c.id; o.textContent = c.name; sel.appendChild(o);
        });
        if (keep) sel.value = keep;
    }

    const byCat = {};
    allExpenses().forEach(r => { byCat[r.category_id] = (byCat[r.category_id] || 0) + num(r.amount); });
    const bc = $('e-bycat');
    bc.innerHTML = '';
    S.cats.slice().sort((a, b) => num(byCat[b.id]) - num(byCat[a.id])).forEach(c => {
        const v = num(byCat[c.id]);
        if (!v) return;
        const row = document.createElement('div');
        row.className = 'dayrow';
        row.innerHTML = '<div class="dm">' + esc(c.name) + '</div>' +
                        '<div class="dp">' + esc(money(v)) + '</div>';
        bc.appendChild(row);
    });
    if (!bc.children.length) bc.innerHTML = '<div class="dayrow"><div class="dm">' +
        'No expenses recorded yet</div></div>';

    renderLog($('e-list'), activityFor(null).filter(a => a.kind === 'spend'), 60);
}

/* ---- live ---- */
function renderLive() {
    const d = IDX.day[S.activeDate] || { total: 0, extra: 0, guest: 0, houses: {} };
    const servedHouses = Object.keys(d.houses).filter(k => d.houses[k] > 0).length;
    const activeHouses = S.houses.filter(h => h.is_active).length;
    $('s-total').textContent  = d.total;
    $('s-houses').textContent = servedHouses;
    $('s-pending').textContent = Math.max(0, activeHouses - servedHouses);
    $('s-extra').textContent  = d.extra;
    $('s-guest').textContent  = d.guest;

    const now = Date.now();
    const inWin = (from, to) => {
        let n = 0;
        allServings().forEach(r => {
            const t = new Date(r.served_at).getTime();
            if (t >= now - to && t < now - from) n += r.qty;
        });
        return n;
    };
    const cur = inWin(0, 9e5), prev = inWin(9e5, 18e5);
    $('s-rate').textContent = cur;
    const tr = $('s-trend');
    tr.textContent = cur > prev ? '▲' : (cur < prev ? '▼' : '');
    tr.className = 'trend ' + (cur > prev ? 'up' : (cur < prev ? 'down' : ''));

    // 2h arrival curve, 12 buckets of 10 min
    const buckets = new Array(12).fill(0);
    allServings().forEach(r => {
        const mins = (now - new Date(r.served_at).getTime()) / 60000;
        if (mins >= 0 && mins < 120) buckets[11 - Math.floor(mins / 10)] += r.qty;
    });
    const mx = Math.max.apply(null, buckets.concat([1]));
    $('spark').innerHTML = buckets.map(v =>
        '<i style="height:' + Math.round(v / mx * 100) + '%" title="' + v + ' plates"></i>').join('');

    // money
    let cin = 0, cout = 0, donor = 0, extraDue = 0, paid = 0, unpaid = 0;
    allContributions().forEach(r => { cin += num(r.amount); if (r.house_id == null) donor += num(r.amount); });
    allExpenses().forEach(r => { cout += num(r.amount); });
    const unpaidNames = [];
    S.houses.forEach(h => {
        if (!h.is_active) return;
        const b = houseBalance(h);
        extraDue += b.extra;
        if (b.total > 0) paid++; else { unpaid++; unpaidNames.push(h.house_code); }
    });
    $('m-in').textContent    = money(cin);
    $('m-out').textContent   = money(cout);
    $('m-bal').textContent   = money(cin - cout);
    $('m-paid').textContent  = paid;
    $('m-unpaid').textContent = unpaid;
    $('m-extra').textContent = money(extraDue);
    $('m-donor').textContent = money(donor);

    // day list
    const dl = $('daylist');
    dl.innerHTML = '';
    S.days.forEach(day => {
        const t = IDX.day[day.event_date] || { total: 0 };
        const row = document.createElement('div');
        row.className = 'dayrow' + (day.event_date === S.activeDate ? ' now' : '');
        row.innerHTML = '<div class="dn">' + day.day_no + '</div>' +
            '<div class="dm">' + esc(day.menu_label || 'Day ' + day.day_no) +
            '<div class="dd">' + esc(day.event_date) +
            (day.plate_rate != null ? ' · ' + money(day.plate_rate) + '/plate' : '') +
            '</div></div>' +
            '<div class="dp">' + t.total + '</div>';
        row.onclick = () => { S.activeDate = day.event_date; persist(); renderAll(); };
        dl.appendChild(row);
    });

    const pl = $('pending-list');
    pl.innerHTML = '';
    S.houses.forEach(h => {
        if (!h.is_active) return;
        if ((d.houses[h.id] || 0) > 0) return;
        const s = document.createElement('span');
        s.textContent = h.house_code;
        pl.appendChild(s);
    });
    const ul = $('unpaid-list');
    ul.innerHTML = unpaidNames.map(c => '<span>' + esc(c) + '</span>').join('');
}

/* ---- roster ---- */
function renderRoster() {
    const isAdmin = S.profile.role === 'admin';
    $('roster-add').disabled = !isAdmin;
    $('roster-hint').textContent = isAdmin
        ? S.houses.length + ' houses. Tap any row to edit. Changes reach every phone and Odoo.'
        : S.houses.length + ' houses. Only an admin can change the roster.';
    const q = S.searchRoster.trim().toLowerCase();
    const list = S.houses.filter(h => !q ||
        h.house_code.toLowerCase().indexOf(q) >= 0 ||
        (h.family_name || '').toLowerCase().indexOf(q) >= 0)
        .sort((a, b) => a.wing_group === b.wing_group
            ? a.sort_order - b.sort_order : a.wing_group.localeCompare(b.wing_group))
        .slice(0, 400);
    const host = $('roster-list');
    host.innerHTML = '';
    list.forEach(h => {
        const b = houseBalance(h);
        const row = document.createElement('div');
        row.className = 'rrow' + (h.is_active ? '' : ' off');
        row.innerHTML = '<div class="rc">' + esc(h.house_code) + '</div>' +
            '<div class="rf">' + esc(h.family_name || '—') + '</div>' +
            '<div class="rm">' + h.member_count + 'p · ' + esc(money(b.paid)) + '</div>';
        if (isAdmin) row.onclick = () => openHouseModal(h);
        host.appendChild(row);
    });
}

/* ---- logs ---- */
function renderLog(host, acts, limit) {
    host.innerHTML = '';
    acts.slice(0, limit || 40).forEach(a => {
        const row = document.createElement('div');
        row.className = 'logrow';
        let main = '', sub = '', amtCls = '', amtTxt = '';

        if (a.kind === 'serve') {
            const h = a.house_id != null ? IDX.house[a.house_id] : null;
            main = a.is_guest ? 'Guest'
                 : (h ? esc(h.house_code) + (h.family_name ? ' · ' + esc(h.family_name) : '') : '?');
            if (a.extra > 0) main += '<span class="tag x">' + a.extra + ' extra</span>';
            if (a.is_guest) main += '<span class="tag g">guest</span>';
            sub = hhmm(a.at) + ' · ' + (a.rows[0].served_by || 'volunteer');
            amtTxt = (a.qty > 0 ? '+' : '') + a.qty;
            amtCls = 'lq ' + (a.qty > 0 ? 'pos' : 'neg');
        } else if (a.kind === 'collect') {
            const r = a.row, h = r.house_id != null ? IDX.house[r.house_id] : null;
            main = h ? esc(h.house_code) + (h.family_name ? ' · ' + esc(h.family_name) : '')
                     : esc(r.donor_name || 'Donor') + '<span class="tag g">outside</span>';
            const what = r.purpose === 'food'
                ? (dayMenu(r.event_date) || r.event_date) + ' x' + (r.qty || 0)
                : 'Ganpati';
            sub = what + ' · ' + hhmm(a.at) + ' · ' +
                  String(r.mode).toUpperCase() +
                  (r.receipt_no ? ' · ' + receiptLabel(r.receipt_no) : '');
            amtTxt = money(r.amount); amtCls = 'amt in';
        } else {
            const r = a.row, c = IDX.cat[r.category_id];
            main = esc(r.description || (c ? c.name : 'Expense'));
            if (r.status !== 'approved') main += '<span class="tag d">draft</span>';
            else main += '<span class="tag a">approved</span>';
            sub = (c ? c.name + ' · ' : '') + (r.spent_on || '') +
                  (r.vendor_name ? ' · ' + r.vendor_name : '');
            amtTxt = money(r.amount); amtCls = 'amt out';
        }
        if (a.reversal)  main += '<span class="tag v">reversal</span>';
        if (a.reversed)  main += '<span class="tag v">cancelled</span>';
        if (a.pending)   main += '<span class="tag v">queued</span>';

        row.innerHTML =
            '<div class="' + amtCls + '">' + amtTxt + '</div>' +
            '<div class="lmain">' + main + '<div class="lsub">' + esc(sub) + '</div></div>';
        if (undoable(a)) {
            const u = document.createElement('button');
            u.className = 'undo'; u.textContent = 'Undo';
            u.onclick = ev => { ev.stopPropagation(); undoAction(a); };
            row.appendChild(u);
        }
        host.appendChild(row);
    });
    if (!host.children.length) host.innerHTML =
        '<div class="logrow"><div class="lmain" style="color:var(--txt3)">Nothing yet today</div></div>';
}

/* ---- more tab ---- */
function renderMore() {
    $('who-name').textContent = S.profile.display_name || (AUTH.s && AUTH.s.user ? AUTH.s.user.email : '—');
    $('who-role').textContent = S.profile.role || 'volunteer';
    $('who-series').textContent = S.profile.receipt_series || 'none';
    if ($('device-label') !== document.activeElement) $('device-label').value = S.device || '';

    const sel = $('day-select');
    sel.innerHTML = '';
    S.days.forEach(d => {
        const o = document.createElement('option');
        o.value = d.event_date;
        o.textContent = 'Day ' + d.day_no + ' · ' + d.event_date + ' · ' + (d.menu_label || '');
        sel.appendChild(o);
    });
    sel.value = S.activeDate || '';

    $('sync-detail').innerHTML =
        'Last sync ' + (S.lastSync ? hhmm(S.lastSync) : 'never') + '<br>' +
        S.houses.length + ' houses · ' + allServings().length + ' plate rows · ' +
        allContributions().length + ' receipts · ' + allExpenses().length + ' expenses<br>' +
        (queueSize() ? '<b style="color:var(--amber)">' + queueSize() + ' waiting to sync</b>'
                     : 'Everything synced');
    renderLog($('log-list'), activityFor(S.activeDate), 40);
    renderRoster();
}

function pickServeGroup(g) {
    S.groupServe = g;
    renderGroupTabs('group-tabs', g, pickServeGroup);
    renderServe();
}
function pickCollectGroup(g) {
    S.groupCollect = g;
    renderGroupTabs('c-group-tabs', g, pickCollectGroup);
    renderCollect();
}
function setCsMode(m) { S.csMode = m; renderModeRow('cs-mode', () => S.csMode, setCsMode); }
function setEMode(m)  { S.eMode  = m; renderModeRow('e-mode',  () => S.eMode,  setEMode); }

function renderAll() {
    pickActiveDate();
    CUR = S.settings.currency_symbol || '₹';
    if (!S.groupServe)   S.groupServe   = groups()[0] || null;
    if (!S.groupCollect) S.groupCollect = groups()[0] || null;
    renderTopbar();
    renderGroupTabs('group-tabs',   S.groupServe,   pickServeGroup);
    renderGroupTabs('c-group-tabs', S.groupCollect, pickCollectGroup);
    if (S.tab === 'serve')   renderServe();
    if (S.tab === 'collect') renderCollect();
    if (S.tab === 'expense') renderExpense();
    if (S.tab === 'live')    renderLive();
    if (S.tab === 'more')    renderMore();
    netStatus();
}

/* ═══════════════════════════ SHEETS & MODALS ═══════════════════════════ */
function closeSheets() {
    $('serve-sheet').hidden = true;
    $('collect-sheet').hidden = true;
    $('sheet-back').hidden = true;
    S.houseSel = null; S.collectSel = null;
}
function closeModals() {
    $('extra-modal').hidden = true; $('donor-modal').hidden = true;
    $('house-modal').hidden = true; $('modal-back').hidden = true;
    S.pendingServe = null;
}

function openServeSheet(h) {
    S.houseSel = h;
    const t = plateTally(h.id, S.activeDate);
    const paidFor = registeredQty(h.id, S.activeDate);
    const free = Math.max(0, paidFor - t.total);
    const r = dayRate(S.activeDate);

    $('sh-code').textContent = h.house_code;
    $('sh-name').textContent = h.family_name || 'No name recorded';
    $('sh-members').textContent = paidFor;     // paid for today, NOT family size
    $('sh-today').textContent = t.total;
    $('sh-left').textContent = free;
    $('sh-rate').textContent = r > 0 ? money(r) : '\u2014';

    // one big tap is the normal case
    const one = $('q-one');
    one.className = 'serve-one' + (free < 1 ? ' over' : '');
    one.textContent = free < 1 ? '+ 1 PLATE  (extra ' + money(r) + ')' : '+ 1 PLATE';
    one.onclick = () => serveHouse(h, 1);

    // the grid stays for a family collecting together
    const g = $('qty-grid');
    g.innerHTML = '';
    QTYS.filter(x => x > 1).forEach(qn => {
        const b = document.createElement('button');
        b.className = 'qbtn' + (qn > free ? ' over' : '');
        b.textContent = qn;
        b.onclick = () => serveHouse(h, qn);
        g.appendChild(b);
    });
    $('q-input').value = Math.max(1, free || 1);
    renderLog($('sh-log'), activityFor(S.activeDate).filter(a =>
        a.kind === 'serve' && a.house_id === h.id), 6);
    $('sheet-back').hidden = false;
    $('serve-sheet').hidden = false;
}

function askExtra(h, n, p) {
    S.pendingServe = { house: h, plan: p };
    const r = dayRate(S.activeDate);
    const menu = dayMenu(S.activeDate);
    const paid = p.paidFor;
    $('xm-title').textContent = paid > 0
        ? h.house_code + ' has taken all the plates it paid for'
        : h.house_code + ' has not paid for today';
    $('xm-body').innerHTML = esc(h.house_code) +
        (h.family_name ? ' (' + esc(h.family_name) + ')' : '') +
        (paid > 0
            ? ' paid for <b>' + paid + ' plate' + (paid > 1 ? 's' : '') + '</b> today and has taken <b>' +
              p.tally.total + '</b>.'
            : ' has not paid for any plates ' + (menu ? 'on ' + esc(menu) + ' ' : '') + 'today.') +
        ' Giving ' + n + ' more adds <b>' + p.extra + ' extra plate' +
        (p.extra > 1 ? 's' : '') + '</b>' +
        (r > 0 ? ', chargeable at <b>' + money(r) + '</b> each and recovered later.' : '.');
    $('xm-split').innerHTML =
        'Paid for today <b>' + paid + '</b>' +
        '<br>Already taken <b>' + p.tally.total + '</b>' +
        '<br>Covered by what they paid <b>' + p.normal + '</b>' +
        '<br>Extra (chargeable) <b>' + p.extra + '</b>' +
        (r > 0 ? '<br>Added to their statement <b>' + money(p.extra * r) + '</b>' : '');
    $('xm-ok').textContent = 'Allow ' + p.extra + ' extra';
    $('modal-back').hidden = false;
    $('extra-modal').hidden = false;
    buzz([50, 80, 50]);
}

function openCollectSheet(h) {
    S.collectSel = h;
    // one line per bucket: ganpati, then one per event day
    S.csGanpati = '';
    S.csQty = {};
    S.days.forEach(d => { S.csQty[d.event_date] = 0; });
    S.csMode = 'cash';

    $('cs-code').textContent = h.house_code;
    $('cs-name').textContent = h.family_name || 'No name recorded';
    $('cs-error').hidden = true;
    renderModeRow('cs-mode', () => S.csMode, setCsMode);
    $('cs-receipt').textContent = receiptLabel(nextReceiptNo());
    renderCollectLines();
    $('sheet-back').hidden = false;
    $('collect-sheet').hidden = false;
}

function renderCollectLines() {
    const h = S.collectSel;
    if (!h) return;
    const b = houseBalance(h);

    // what this house has already given
    const bits = [];
    if (b.ganpati) bits.push('Ganpati <b>' + money(b.ganpati) + '</b>');
    if (b.food)    bits.push('Food <b>' + money(b.food) + '</b> for <b>' + b.days + '</b> day' +
                             (b.days === 1 ? '' : 's'));
    if (b.extra)   bits.push('<span style="color:#fca5a5">Extra plates owed <b>' +
                             money(b.extra) + '</b></span>');
    $('cs-sofar').innerHTML = bits.length
        ? 'Already given: ' + bits.join(' &nbsp;·&nbsp; ')
        : 'Nothing given yet.';

    const host = $('cs-lines');
    host.innerHTML = '';

    // ---- ganpati: any amount, no expectation ----
    const g = document.createElement('div');
    g.className = 'csrow ganpati';
    g.innerHTML = '<div class="cl"><b>Ganpati donation</b>' +
        '<span>Any amount' + (b.ganpati ? ' \u00b7 <span class="paid">already ' +
        esc(money(b.ganpati)) + '</span>' : '') + '</span></div>';
    const gi = document.createElement('input');
    gi.className = 'amt-in'; gi.type = 'number'; gi.inputMode = 'decimal';
    gi.min = '0'; gi.placeholder = '0'; gi.value = S.csGanpati;
    gi.oninput = e => { S.csGanpati = e.target.value; updateCollectTotal(); };
    g.appendChild(gi);
    host.appendChild(g);

    // ---- one row per day: fixed price, choose how many plates ----
    S.days.forEach(d => {
        const rate = dayRate(d.event_date);
        const already = registeredQty(h.id, d.event_date);
        const qty = S.csQty[d.event_date] || 0;
        const row = document.createElement('div');
        row.className = 'csrow' + (already > 0 ? ' done' : '');
        row.innerHTML =
            '<div class="cl"><b>' + esc(d.menu_label || 'Day ' + d.day_no) + '</b>' +
            '<span>' + esc(d.event_date.slice(8) + '/' + d.event_date.slice(5, 7)) +
            ' \u00b7 ' + esc(money(rate)) + ' each' +
            (already > 0 ? ' \u00b7 <span class="paid">' + already + ' paid</span>' : '') +
            '</span></div>';

        const st = document.createElement('div');
        st.className = 'stepper';
        const minus = document.createElement('button');
        minus.textContent = '\u2212';
        minus.onclick = () => { S.csQty[d.event_date] = Math.max(0, qty - 1); renderCollectLines(); };
        const q = document.createElement('div');
        q.className = 'q'; q.textContent = qty;
        const plus = document.createElement('button');
        plus.textContent = '+';
        plus.onclick = () => { S.csQty[d.event_date] = Math.min(99, qty + 1); renderCollectLines(); };
        st.appendChild(minus); st.appendChild(q); st.appendChild(plus);
        row.appendChild(st);

        const line = document.createElement('div');
        line.className = 'line' + (qty > 0 ? ' on' : '');
        line.textContent = qty > 0 ? money(qty * rate) : '\u2014';
        row.appendChild(line);
        host.appendChild(row);
    });

    updateCollectTotal();
}

function collectTotal() {
    let t = num(S.csGanpati);
    S.days.forEach(d => { t += (S.csQty[d.event_date] || 0) * dayRate(d.event_date); });
    return t;
}

function updateCollectTotal() {
    const t = collectTotal();
    $('cs-total').textContent = money(t);
    $('cs-save').textContent = t > 0 ? 'Collect ' + money(t) : 'Collect';
    $('cs-save').disabled = t <= 0;
}

function saveCollection() {
    const h = S.collectSel;
    if (!h) return;
    const total = collectTotal();
    if (total <= 0) { showErr('cs-error', 'Nothing to collect yet'); return; }
    const no = nextReceiptNo();
    if (!no) { showErr('cs-error',
        'This volunteer has no receipt series. An admin must set one.'); return; }

    // One collection = one receipt number = several lines sharing a collection_uid.
    const cuid = uid(), now = new Date().toISOString();
    const base = {
        house_id: h.id, donor_name: '', mode: S.csMode,
        receipt_series: S.profile.receipt_series, receipt_no: no,
        collected_by: S.profile.display_name || '',
        collected_by_uid: AUTH.s && AUTH.s.user ? AUTH.s.user.id : null,
        notes: '', void_of_id: null, collection_uid: cuid, collected_at: now
    };
    const gan = num(S.csGanpati);
    if (gan > 0) pushRow('contributions', Object.assign({}, base, {
        purpose: 'ganpati', event_date: null, qty: null,
        amount: gan, client_uid: uid() }));
    S.days.forEach(d => {
        const q = S.csQty[d.event_date] || 0;
        if (q <= 0) return;
        pushRow('contributions', Object.assign({}, base, {
            purpose: 'food', event_date: d.event_date, qty: q,
            amount: q * dayRate(d.event_date), client_uid: uid() }));
    });
    buzz([30, 50, 30]);
    toast(h.house_code + '  ' + money(total) + '  \u00b7  ' + receiptLabel(no), 'ok', 3200);
    closeSheets();
}

function renderModeRow(hostId, getter, setter) {
    const host = $(hostId);
    host.innerHTML = '';
    MODES.forEach(m => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = getter() === m[0] ? 'active' : '';
        b.textContent = m[1];
        b.onclick = () => setter(m[0]);
        host.appendChild(b);
    });
}

function openHouseModal(h) {
    const isNew = !h;
    S.houseEdit = h || null;
    $('hm-title').textContent = isNew ? 'Add house' : 'Edit ' + h.house_code;
    $('hm-code').value    = h ? h.house_code : '';
    $('hm-group').value   = h ? h.wing_group : (S.groupServe || 'AB');
    $('hm-label').value   = h ? h.number_label : '';
    $('hm-sort').value    = h ? h.sort_order : '';
    $('hm-family').value  = h ? h.family_name : '';
    $('hm-members').value = h ? h.member_count : 4;
    $('hm-phone').value   = h ? h.phone : '';
    $('hm-notes').value   = h ? h.notes : '';
    $('hm-active').checked = h ? h.is_active : true;
    $('hm-error').hidden = true;
    $('modal-back').hidden = false;
    $('house-modal').hidden = false;
}

async function saveHouse() {
    const body = {
        house_code: $('hm-code').value.trim(),
        wing_group: $('hm-group').value.trim() || 'AB',
        number_label: $('hm-label').value.trim(),
        sort_order: parseInt($('hm-sort').value, 10) || 0,
        family_name: $('hm-family').value.trim(),
        member_count: parseInt($('hm-members').value, 10) || 0,
        phone: $('hm-phone').value.trim(),
        notes: $('hm-notes').value.trim(),
        is_active: $('hm-active').checked
    };
    if (!body.house_code) { showErr('hm-error', 'House code is required'); return; }
    if (!body.number_label) body.number_label = body.house_code;
    if (!S.online) { showErr('hm-error', 'Roster changes need a connection'); return; }
    try {
        const h = S.houseEdit;
        const rows = h
            ? await rest('houses?id=eq.' + h.id, { method: 'PATCH',
                headers: { Prefer: 'return=representation' }, body: JSON.stringify(body) })
            : await rest('houses', { method: 'POST',
                headers: { Prefer: 'return=representation' }, body: JSON.stringify([body]) });
        upsertMaster('houses', rows || []);
        persist(); reindex(); closeModals(); renderAll();
        toast('Saved ' + body.house_code, 'ok');
    } catch (e) {
        showErr('hm-error', String(e.message).indexOf('42501') >= 0 ||
            String(e.message).indexOf('403') >= 0
            ? 'Only an admin can change the roster' : e.message);
    }
}
function showErr(id, msg) { const e = $(id); e.textContent = msg; e.hidden = false; }

/* ─────────────────────── photo handling ─────────────────────── */
function readPhoto(file) {
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => {
            const img = new Image();
            img.onload = () => {
                const max = 1280;
                let w = img.width, h = img.height;
                if (w > max || h > max) { const s = max / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
                const c = document.createElement('canvas');
                c.width = w; c.height = h;
                c.getContext('2d').drawImage(img, 0, 0, w, h);
                resolve(c.toDataURL('image/jpeg', 0.7));
            };
            img.onerror = reject;
            img.src = fr.result;
        };
        fr.onerror = reject;
        fr.readAsDataURL(file);
    });
}

/* ─────────────────────── CSV export ─────────────────────── */
function exportCsv() {
    const rows = [];
    rows.push(['GANESH UTSAV EXPORT', new Date().toISOString()]);
    rows.push([]);
    rows.push(['HOUSE STATEMENT']);
    rows.push(['house_code','family','group','ganpati_given','food_paid','total_given',
               'plates_paid_for','days_registered','plates_taken','extra_plates',
               'extra_charge','balance_due']);
    S.houses.forEach(h => {
        const b = houseBalance(h);
        rows.push([h.house_code, h.family_name, h.wing_group, b.ganpati, b.food, b.total,
                   platesPaidFor(h.id), b.days, platesAllDays(h.id),
                   extraPlatesAllDays(h.id), b.extra, b.due]);
    });
    rows.push([]);
    rows.push(['PLATE LEDGER']);
    rows.push(['date','house','qty','is_extra','is_guest','served_by','at']);
    allServings().forEach(r => {
        const h = r.house_id != null ? IDX.house[r.house_id] : null;
        rows.push([r.event_date, h ? h.house_code : 'GUEST', r.qty, r.is_extra, r.is_guest,
                   r.served_by, r.served_at]);
    });
    rows.push([]);
    rows.push(['CONTRIBUTIONS']);
    rows.push(['receipt','date','house_or_donor','purpose','for_day','plates',
               'amount','mode','collected_by','note']);
    allContributions().forEach(r => {
        const h = r.house_id != null ? IDX.house[r.house_id] : null;
        rows.push([(r.receipt_series || '') + '/' + (r.receipt_no || ''),
                   (r.collected_at || '').slice(0, 10),
                   h ? h.house_code : r.donor_name, r.purpose || 'ganpati',
                   r.event_date || '', r.qty || '',
                   r.amount, r.mode, r.collected_by, r.notes]);
    });
    rows.push([]);
    rows.push(['EXPENSES']);
    rows.push(['date','category','description','vendor','amount','mode','status','paid_by']);
    allExpenses().forEach(r => {
        const c = IDX.cat[r.category_id];
        rows.push([r.spent_on, c ? c.name : '', r.description, r.vendor_name,
                   r.amount, r.mode, r.status, r.paid_by]);
    });

    const csv = rows.map(r => r.map(v => {
        const s = v == null ? '' : String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'ganesh-utsav-' + today() + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('CSV exported', 'ok');
}

/* ═══════════════════════════ WIRING ═══════════════════════════ */
function switchTab(name) {
    S.tab = name;
    qa('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
    qa('.bottom-nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    qs('.tab.active').scrollTop = 0;
    renderAll();
}

function wire() {
    qa('.bottom-nav button').forEach(b => b.onclick = () => switchTab(b.dataset.tab));

    /* serve */
    $('search').oninput = e => { S.searchServe = e.target.value; renderServe(); };
    $('sheet-close').onclick = closeSheets;
    $('sheet-back').onclick = closeSheets;
    $('q-minus').onclick = () => { $('q-input').value = Math.max(1, num($('q-input').value) - 1); };
    $('q-plus').onclick  = () => { $('q-input').value = Math.min(99, num($('q-input').value) + 1); };
    $('q-serve').onclick = () => { if (S.houseSel) serveHouse(S.houseSel, $('q-input').value); };
    $('q-one').onclick = () => { if (S.houseSel) serveHouse(S.houseSel, 1); };
    $('guest-btn').onclick = () => {
        const n = prompt('How many guest plates?', '1');
        if (n == null) return;
        const q = clamp(Math.round(num(n)), 1, 99);
        if (q > 0) commitServe(null, q, 0, true);
    };

    /* extra confirm */
    $('xm-cancel').onclick = closeModals;
    $('modal-back').onclick = closeModals;
    $('xm-ok').onclick = () => {
        const p = S.pendingServe;
        closeModals();
        if (p) commitServe(p.house, p.plan.normal, p.plan.extra, false);
    };

    /* collect */
    $('c-search').oninput = e => { S.searchCollect = e.target.value; renderCollect(); };
    $('cs-close').onclick = closeSheets;
    $('cs-save').onclick = saveCollection;
    $('donor-btn').onclick = () => {
        const sel = $('dm-mode');
        sel.innerHTML = MODES.map(m => '<option value="' + m[0] + '">' + m[1] + '</option>').join('');
        $('dm-name').value = ''; $('dm-amt').value = ''; $('dm-note').value = '';
        $('dm-error').hidden = true;
        $('dm-receipt').textContent = receiptLabel(nextReceiptNo());
        $('modal-back').hidden = false; $('donor-modal').hidden = false;
    };
    $('dm-cancel').onclick = closeModals;
    $('dm-save').onclick = () => {
        const name = $('dm-name').value.trim();
        if (!name) { showErr('dm-error', 'Donor name is required'); return; }
        const err = commitCollect(null, name, $('dm-amt').value, $('dm-mode').value,
                                  $('dm-note').value.trim());
        if (err) showErr('dm-error', err); else closeModals();
    };

    /* expense */
    renderModeRow('e-mode', () => S.eMode, setEMode);
    $('e-date').value = today();
    $('e-photo-btn').onclick = () => $('e-photo').click();
    $('e-photo').onchange = async e => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        try {
            S.ePhoto = await readPhoto(f);
            $('e-photo-prev').src = S.ePhoto;
            $('e-photo-prev').hidden = false;
            $('e-photo-clear').hidden = false;
            $('e-photo-btn').textContent = '📷 Change';
        } catch (err) { toast('Could not read that photo', 'bad'); }
    };
    $('e-photo-clear').onclick = () => {
        S.ePhoto = null; $('e-photo').value = '';
        $('e-photo-prev').hidden = true; $('e-photo-clear').hidden = true;
        $('e-photo-btn').textContent = '📷 Attach bill';
    };
    $('e-save').onclick = () => {
        const amt = num($('e-amt').value);
        if (amt <= 0) { showErr('e-error', 'Enter an amount'); return; }
        if (!$('e-cat').value) { showErr('e-error', 'Pick a category'); return; }
        $('e-error').hidden = true;
        commitExpense({
            category_id: parseInt($('e-cat').value, 10),
            description: $('e-desc').value.trim(),
            vendor_name: $('e-vendor').value.trim(),
            amount: amt, mode: S.eMode,
            spent_on: $('e-date').value || today(),
            paid_by: $('e-paidby').value.trim()
        });
        $('e-amt').value = ''; $('e-desc').value = ''; $('e-vendor').value = '';
        $('e-photo-clear').onclick();
    };

    /* more */
    $('device-label').oninput = e => { S.device = e.target.value; persist(); };
    $('day-select').onchange = e => { S.activeDate = e.target.value; persist(); renderAll(); };
    $('btn-refresh').onclick = async () => {
        toast('Refreshing…');
        await bootstrap(); await pullCats();
        persist(); reindex(); renderAll(); toast('Refreshed', 'ok');
    };
    $('btn-export').onclick = exportCsv;
    $('roster-search').oninput = e => { S.searchRoster = e.target.value; renderRoster(); };
    $('roster-add').onclick = () => openHouseModal(null);
    $('hm-cancel').onclick = closeModals;
    $('hm-save').onclick = saveHouse;
    $('btn-signout').onclick = () => {
        if (queueSize() > 0 && !confirm(queueSize() +
            ' entries have not synced yet. Signing out keeps them on this phone, ' +
            'but they will only upload when you sign in again. Continue?')) return;
        AUTH.signOut();
        $('screen-app').classList.remove('active');
        $('screen-login').classList.add('active');
    };

    /* login */
    $('login-form').onsubmit = async ev => {
        ev.preventDefault();
        const btn = $('login-btn');
        btn.disabled = true; btn.textContent = 'Signing in…';
        $('login-error').hidden = true;
        try {
            await AUTH.signIn($('login-email').value.trim(), $('login-pass').value);
            $('login-pass').value = '';
            await start();
        } catch (e) {
            showErr('login-error', e.message);
        } finally { btn.disabled = false; btn.textContent = 'Sign In'; }
    };

    /* network */
    window.addEventListener('online',  () => { S.online = true;  netStatus(); syncNow(); });
    window.addEventListener('offline', () => { S.online = false; netStatus(); });
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) syncNow();
    });
    window.addEventListener('keydown', e => {
        if (e.key === 'Escape') { closeSheets(); closeModals(); }
    });
}

/* ═══════════════════════════ BOOT ═══════════════════════════ */
async function start() {
    $('screen-login').classList.remove('active');
    $('screen-app').classList.add('active');
    reindex(); pickActiveDate(); renderAll();
    try { await loadProfile(); } catch (e) {}
    try { await pullCats(); } catch (e) {}
    await syncNow(S.houses.length === 0);
    persist(); reindex(); renderAll();
    if (!S._timer) {
        S._timer = setInterval(() => { syncNow(); }, POLL_MS);
        setInterval(() => { if (S.tab === 'live') renderLive(); }, 15000);
    }
}

function boot() {
    $('app-version').textContent = VERSION;
    if (!URL_BASE || URL_BASE.indexOf('PASTE') >= 0 || !ANON || ANON.indexOf('PASTE') >= 0) {
        $('login-config-warn').hidden = false;
        $('login-btn').disabled = true;
    }
    wire();
    if (AUTH.s) start();
    try {
        if (navigator.serviceWorker && navigator.serviceWorker.register) {
            navigator.serviceWorker.register('sw.js').catch(() => {});
        }
    } catch (e) { /* private mode / unsupported: app still works, just not offline-installed */ }
}
document.addEventListener('DOMContentLoaded', boot);

})();

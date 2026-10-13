'use strict';
/* Primo Barbershop — owner dashboard.
   Needs app.js (helpers, sb, DB) and an owner account in Supabase Auth (see README.md). */

const S = { bookings: [], barbers: [], queue: [], inventory: [] };
let adminOpen = false, adminTab = 'today', pollTimer = null;
let selIds = new Set(), pendingDelete = null, shownIds = [], pendingRemove = null;
let staffMsg = '', manualOpen = false, allFilter = 'all', repPeriod = 'month', repBarber = 'all';
const TAB_KEY = 'primo_admin_tab';

/* ---------- mapping database rows ---------- */
function mapBooking(r) {
  return { id: r.id, code: r.code, name: r.customer_name, phone: r.phone, email: r.email || '', notes: r.notes || '', service: r.service_name, serviceId: r.service_id,
    price: Number(r.price), dur: r.duration_min, barber: r.barber_id, barberName: r.barber_name || '', date: r.booking_date, timeMin: r.start_min,
    status: r.status, autoNoShow: r.auto_no_show, rate: r.commission_rate == null ? null : Number(r.commission_rate), source: r.source };
}
function mapBarber(r) { return { ...r, commission: Number(r.commission || 0), hours: r.hours || {}, tags: r.tags || [], rating: r.rating == null ? null : Number(r.rating) }; }

/* ---------- small helpers ---------- */
const barberNameOf = b => (S.barbers.find(x => x.id === b.barber) || {}).name || b.barberName || 'Former staff';
const rateOf = b => b.rate != null ? b.rate : ((S.barbers.find(x => x.id === b.barber) || {}).commission || 0);
const sumPrice = l => l.reduce((t, b) => t + b.price, 0);
const commOf = l => Math.round(l.reduce((t, b) => t + b.price * rateOf(b), 0));
const activeBarbers = () => S.barbers.filter(b => b.active !== false);
function contactCell(b) {
  if (!b.phone && !b.email) return '—';
  if (!b.phone) return esc(b.email);
  return esc(b.phone) + (b.email ? `<br><span style="font-size:.78rem;color:var(--bone-dim);">${esc(b.email)}</span>` : '');
}
function periodMatch(d, per) {
  const t = manilaNow().date;
  if (per === 'all') return true;
  if (per === 'today') return d === t;
  if (per === 'week') return d >= addDays(t, -6) && d <= t;
  if (per === 'month') return d.slice(0, 7) === t.slice(0, 7);
  if (per === 'lastmonth') { const [y, m] = t.split('-').map(Number); const pm = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; return d.slice(0, 7) === pm; }
  return true;
}
function monthCommission(id) { const l = S.bookings.filter(b => b.barber === id && b.status === 'completed' && periodMatch(b.date, 'month')); return { count: l.length, comm: commOf(l) }; }
function upcomingCount(id) { const t = manilaNow().date; return S.bookings.filter(b => b.barber === id && b.status === 'confirmed' && b.date >= t).length; }
function hourOpts(from, to, sel) { let o = ''; for (let h = from; h <= to; h++) o += `<option value="${h}" ${h === sel ? 'selected' : ''}>${hr12(h)}</option>`; return o; }
function randomAvatar() { const pick = a => a[Math.floor(Math.random() * a.length)]; return { skin: pick(['#c69168', '#a8714a', '#d8a77f', '#8d5a3b', '#e0b48c']), hair: pick(['#16120f', '#1b1511', '#2a2018', '#3a2a1c']), style: pick(['fade', 'quiff', 'crop']), beard: Math.random() < .5 }; }
function adminNote(msg) { const m = el('adminMsg'); m.textContent = msg || ''; if (msg) setTimeout(() => { if (m.textContent === msg) m.textContent = ''; }, 8000); }
function dbError(e) { return e && e.code === '23P01' ? 'That time is already booked for that barber.' : ((e && e.message) || 'Something went wrong.'); }

/* ---------- login / session (Supabase Auth keeps you signed in across refreshes) ---------- */
async function checkOwner() { const r = await sb.rpc('is_owner'); return !r.error && r.data === true; }

async function initAdmin() {
  el('staffOpen').addEventListener('click', () => { el('staffOverlay').classList.add('show'); el('ownerUser').focus(); });
  document.querySelectorAll('#adminTabs button').forEach(b => b.addEventListener('click', () => setAdminTab(b.dataset.atab)));
  el('ownerPass').addEventListener('keydown', e => { if (e.key === 'Enter') tryLogin(); });
  const s = await sb.auth.getSession();
  if (s.data && s.data.session && await checkOwner()) openAdmin();
  sb.auth.onAuthStateChange(ev => { if (ev === 'SIGNED_OUT' && adminOpen) hideAdmin(); });
}
function closeStaff() {
  ['ownerUser', 'ownerPass'].forEach(id => el(id).value = '');
  el('ownerPass').type = 'password'; el('passToggle').textContent = 'Show';
  el('staffOverlay').classList.remove('show'); el('pinError').textContent = '';
}
function togglePass() {
  const i = el('ownerPass'), b = el('passToggle'), show = i.type === 'password';
  i.type = show ? 'text' : 'password'; b.textContent = show ? 'Hide' : 'Show'; b.setAttribute('aria-pressed', show);
}
async function tryLogin() {
  const err = el('pinError'), btn = el('loginBtn'); err.textContent = '';
  const email = el('ownerUser').value.trim(), password = el('ownerPass').value;
  if (!email || !password) { err.textContent = 'Enter your email and password.'; return; }
  btn.disabled = true;
  const r = await sb.auth.signInWithPassword({ email, password });
  if (r.error) { btn.disabled = false; err.textContent = 'Incorrect email or password.'; return; }
  if (!(await checkOwner())) { await sb.auth.signOut(); btn.disabled = false; err.textContent = 'This account is not authorized.'; return; }
  btn.disabled = false; closeStaff(); openAdmin();
}
async function openAdmin() {
  adminOpen = true;
  try { adminTab = localStorage.getItem(TAB_KEY) || 'today'; } catch (e) { adminTab = 'today'; }
  el('adminShell').classList.add('show');
  document.querySelectorAll('#adminTabs button').forEach(x => x.classList.toggle('active', x.dataset.atab === adminTab));
  el('adminBody').innerHTML = '<p class="loading">Loading…</p>';
  await refreshAdmin();
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {                       // pick up new customer bookings every 30 seconds
    const a = document.activeElement;
    if (!adminOpen || (a && /INPUT|SELECT|TEXTAREA/.test(a.tagName))) return;
    refreshAdmin();
  }, 30000);
}
function hideAdmin() { adminOpen = false; clearInterval(pollTimer); el('adminShell').classList.remove('show'); }
async function closeAdmin() { hideAdmin(); await sb.auth.signOut(); }            // "Log out"
function setAdminTab(tab) {
  adminTab = tab;
  try { localStorage.setItem(TAB_KEY, tab); } catch (e) { /* ignore */ }
  document.querySelectorAll('#adminTabs button').forEach(x => x.classList.toggle('active', x.dataset.atab === tab));
  renderAdmin(tab);
}

/* ---------- loading ---------- */
async function loadAdminData() {
  await sb.rpc('auto_expire_bookings');                 // confirmed bookings 24h past their time -> no-show
  const [b, br, q, inv] = await Promise.all([
    sb.from('bookings').select('*').order('booking_date', { ascending: false }).order('start_min', { ascending: false }).limit(5000),
    sb.from('barbers').select('*').order('sort_order').order('created_at'),
    sb.from('queue').select('*').eq('queue_date', manilaNow().date).order('queue_no'),
    sb.from('inventory').select('*').order('name')
  ]);
  for (const r of [b, br, q, inv]) if (r.error) throw r.error;
  S.bookings = b.data.map(mapBooking); S.barbers = br.data.map(mapBarber); S.queue = q.data; S.inventory = inv.data;
}
async function refreshAdmin() {
  try { await loadAdminData(); } catch (e) { adminNote('Could not load data: ' + dbError(e)); return; }
  renderAdmin(adminTab);
}
async function afterStaffChange(rerender) {
  try { await loadPublic(); renderBarbers(); } catch (e) { /* public side refreshes on next load */ }
  if (rerender) await refreshAdmin();
}

/* ---------- actions ---------- */
async function setStatus(id, status) {
  const r = await sb.from('bookings').update({ status }).eq('id', id);
  if (r.error) { adminNote(dbError(r.error)); return; }
  await refreshAdmin();
}
function toggleSel(id, on) { if (on) selIds.add(id); else selIds.delete(id); renderAdmin('all'); }
function toggleAll(on) { shownIds.forEach(id => { if (on) selIds.add(id); else selIds.delete(id); }); renderAdmin('all'); }
function askDelete(ids) { pendingDelete = ids; renderAdmin('all'); }
async function doDelete() {
  const ids = pendingDelete || [];
  const r = await sb.from('bookings').delete().in('id', ids);
  if (r.error) { adminNote(dbError(r.error)); return; }
  selIds = new Set([...selIds].filter(id => !ids.includes(id))); pendingDelete = null;
  await refreshAdmin();
}

function manualBookingForm() {
  return `<details class="note" style="margin-bottom:14px;" ${manualOpen ? 'open' : ''} ontoggle="manualOpen=this.open"><summary>Add a booking manually (phone call, Facebook message, walk-in)</summary>
    <div style="margin-top:12px;">
      <div class="field-row"><div class="field"><label for="mName">Customer name</label><input id="mName" maxlength="80"></div><div class="field"><label for="mPhone">Phone</label><input id="mPhone" type="tel" maxlength="20"></div></div>
      <div class="field-row"><div class="field"><label for="mSvc">Service</label><select id="mSvc" onchange="manualSlots()">${DB.services.map(x => `<option value="${esc(x.id)}">${esc(x.name)} — ₱${x.price}</option>`).join('')}</select></div>
        <div class="field"><label for="mBar">Barber</label><select id="mBar" onchange="manualSlots()"><option value="any">Any barber</option>${DB.barbers.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select></div></div>
      <div class="field-row"><div class="field"><label for="mDate">Date</label><input id="mDate" type="date" min="${manilaNow().date}" value="${manilaNow().date}" onchange="manualSlots()"></div>
        <div class="field"><label for="mTime">Time</label><select id="mTime"></select></div></div>
      <div class="field"><label for="mNotes">Special request (optional)</label><input id="mNotes" maxlength="300"></div>
      <div id="mErr" class="empty-slots" role="alert" style="margin-bottom:8px;"></div>
      <button class="btn small" onclick="saveManual()">Add booking</button>
    </div></details>`;
}
async function manualSlots() {
  const sel = el('mTime'); if (!sel) return;
  const svc = svcOf(el('mSvc').value), date = el('mDate').value, bar = el('mBar').value;
  if (!svc || !date) { sel.innerHTML = '<option value="">—</option>'; return; }
  let sl = [];
  try { sl = await slotsFor(bar, date, svc.duration_min); } catch (e) { /* offline */ }
  sel.innerHTML = sl.length ? sl.map(x => `<option value="${x.min}|${esc(x.barber)}">${fmtTime(x.min)} — ${esc((barberOf(x.barber) || {}).name || '')}</option>`).join('') : '<option value="">No open times</option>';
}
async function saveManual() {
  const g = id => el(id).value.trim(), err = el('mErr'), name = g('mName'), phone = normPhone(g('mPhone'));
  const svc = svcOf(g('mSvc')), parts = (g('mTime') || '').split('|');
  if (!name) { err.textContent = 'Enter the customer name.'; return; }
  if (!PHONE_RE.test(phone)) { err.textContent = 'Enter a valid phone number.'; return; }
  if (!svc || !parts[0] || !parts[1] || !g('mDate')) { err.textContent = 'Pick a date and an open time.'; return; }
  const bar = barberOf(parts[1]);
  const r = await sb.from('bookings').insert({ customer_name: name, phone, notes: g('mNotes') || null, service_id: svc.id, service_name: svc.name, price: svc.price,
    duration_min: svc.duration_min, barber_id: parts[1], barber_name: bar ? bar.name : '', booking_date: g('mDate'), start_min: Number(parts[0]), source: 'manual' });
  if (r.error) { err.textContent = dbError(r.error); return; }
  manualOpen = false; await refreshAdmin();
}

/* ---------- staff ---------- */
function staffCard(b, pr) {
  const mc = monthCommission(b.id), days = [1, 2, 3, 4, 5, 6, 0].filter(d => DB.hours[d]);
  const confirm = pr === b.id ? `<div class="confirm-box" style="border-color:var(--bad);background:rgba(161,72,63,.1);margin:12px 0;"><strong style="color:var(--bad);">Remove ${esc(b.name)}?</strong> ${upcomingCount(b.id)} upcoming confirmed booking(s) with them stay in the list, so cancel or re-book them if needed. Past bookings and commission history are kept.<div class="cta-row"><button class="btn bad small" onclick="removeStaff('${b.id}')">Yes, remove</button><button class="btn ghost small" onclick="pendingRemove=null;renderAdmin('staff')">Keep</button></div></div>` : '';
  return `<div class="card" style="margin-bottom:16px;${b.active === false ? 'opacity:.75;' : ''}">
    <div class="field-row"><div class="field"><label>Name<input value="${esc(b.name)}" maxlength="40" onchange="editStaff('${b.id}','name',this.value)"></label></div>
      <div class="field"><label>Role<input value="${esc(b.role)}" maxlength="40" onchange="editStaff('${b.id}','role',this.value)"></label></div></div>
    <div class="field-row"><div class="field"><label>Specialties (comma separated)<input value="${esc(b.tags.join(', '))}" onchange="editStaff('${b.id}','tags',this.value)"></label></div>
      <div class="field"><label>Commission %<input type="number" min="0" max="100" value="${Math.round(b.commission * 100)}" onchange="editStaff('${b.id}','commission',this.value)"></label></div></div>
    <p style="margin:0 0 12px;font-size:.88rem;">This month: <strong style="color:var(--brass);">₱${mc.comm}</strong> commission from ${mc.count} completed cut${mc.count === 1 ? '' : 's'}${b.active === false ? ' · <span class="low-stock">On leave</span>' : ''}</p>
    <label>Working hours</label>
    ${days.map(d => { const sh = DB.hours[d], h = b.hours[d]; return `<div class="hrow"><span>${DAY_NAMES[d].slice(0, 3)}</span><input type="checkbox" aria-label="Works ${DAY_NAMES[d]}" ${h ? 'checked' : ''} onchange="setHours('${b.id}',${d},'on',this.checked)">
      <select ${h ? '' : 'disabled'} aria-label="Start time" onchange="setHours('${b.id}',${d},'start',this.value)">${hourOpts(sh[0], sh[1] - 1, h ? h[0] : sh[0])}</select>
      <select ${h ? '' : 'disabled'} aria-label="End time" onchange="setHours('${b.id}',${d},'end',this.value)">${hourOpts(sh[0] + 1, sh[1], h ? h[1] : sh[1])}</select></div>`; }).join('')}
    ${confirm}
    <div class="cta-row" style="margin-top:12px;"><button class="btn ghost small" onclick="toggleActive('${b.id}')">${b.active === false ? 'Mark as active' : 'Mark on leave'}</button><button class="btn bad small" onclick="askRemove('${b.id}')">Remove</button></div>
  </div>`;
}
async function updateBarber(id, patch) {
  const r = await sb.from('barbers').update(patch).eq('id', id);
  if (r.error) { adminNote(dbError(r.error)); return false; }
  Object.assign(S.barbers.find(x => x.id === id) || {}, patch);
  return true;
}
async function editStaff(id, field, val) {
  let patch;
  if (field === 'tags') patch = { tags: val.split(',').map(x => x.trim()).filter(Boolean) };
  else if (field === 'commission') patch = { commission: Math.min(100, Math.max(0, Number(val) || 0)) / 100 };
  else patch = { [field]: val.trim() || (S.barbers.find(x => x.id === id) || {})[field] };
  if (await updateBarber(id, patch)) afterStaffChange(false);
}
async function setHours(id, d, field, val) {
  const b = S.barbers.find(x => x.id === id), sh = DB.hours[d]; if (!b || !sh) return;
  const hours = { ...b.hours };
  if (field === 'on') hours[d] = val ? [Math.max(sh[0], 10), Math.min(sh[1], 19)] : null;
  else if (hours[d]) {
    let s0 = hours[d][0], e0 = hours[d][1]; val = Number(val);
    if (field === 'start') { s0 = val; if (e0 <= s0) e0 = Math.min(s0 + 1, sh[1]); } else { e0 = val; if (s0 >= e0) s0 = Math.max(e0 - 1, sh[0]); }
    hours[d] = [s0, e0];
  }
  if (hours[d] == null) delete hours[d];
  if (await updateBarber(id, { hours })) { await afterStaffChange(false); renderAdmin('staff'); }
}
async function addStaff() {
  const err = el('nsErr'), name = el('nsName').value.trim();
  if (!name) { err.textContent = 'Enter a name for the new staff member.'; return; }
  const role = el('nsRole').value.trim() || 'Barber', commission = Math.min(100, Math.max(0, Number(el('nsComm').value) || 0)) / 100;
  const hours = {}; [0, 1, 2, 3, 4, 5, 6].forEach(d => { const sh = DB.hours[d]; if (sh) hours[d] = [Math.max(sh[0], 10), Math.min(sh[1], 19)]; });
  const r = await sb.from('barbers').insert({ name, role, tags: [], commission, hours, active: true, avatar: randomAvatar(), sort_order: S.barbers.length + 1 });
  if (r.error) { err.textContent = dbError(r.error); return; }
  staffMsg = ''; await afterStaffChange(true);
}
async function toggleActive(id) {
  const b = S.barbers.find(x => x.id === id); if (!b) return;
  if (b.active !== false && activeBarbers().length <= 1) { staffMsg = 'You need at least one active barber so customers can still book.'; renderAdmin('staff'); return; }
  staffMsg = '';
  if (await updateBarber(id, { active: b.active === false })) { await afterStaffChange(true); }
}
function askRemove(id) {
  if (activeBarbers().filter(b => b.id !== id).length < 1) { staffMsg = 'You need at least one active barber so customers can still book.'; pendingRemove = null; }
  else { staffMsg = ''; pendingRemove = id; }
  renderAdmin('staff');
}
async function removeStaff(id) {
  const r = await sb.from('barbers').delete().eq('id', id);
  if (r.error) { adminNote(dbError(r.error)); return; }
  pendingRemove = null; await afterStaffChange(true);
}

/* ---------- queue & inventory ---------- */
async function queueSet(id, status) { const r = await sb.from('queue').update({ status }).eq('id', id); if (r.error) adminNote(dbError(r.error)); await refreshAdmin(); refreshStatus(); }
async function updateInv(id, field, val) { const r = await sb.from('inventory').update({ [field]: Math.max(0, Number(val) || 0) }).eq('id', id); if (r.error) adminNote(dbError(r.error)); await refreshAdmin(); }
async function addInv() {
  const name = el('invName').value.trim(); if (!name) return;
  const r = await sb.from('inventory').insert({ name, stock: Number(el('invStock').value) || 0, min_stock: Number(el('invMin').value) || 0 });
  if (r.error) adminNote(dbError(r.error)); await refreshAdmin();
}

/* ---------- rendering ---------- */
const byNewest = (a, b) => (b.date + String(b.timeMin).padStart(4, '0')).localeCompare(a.date + String(a.timeMin).padStart(4, '0'));
function statusPill(b) { return `<span class="status-pill status-${b.status}">${b.status}${b.autoNoShow ? ' (auto)' : ''}</span>`; }
function actionButtons(b) {
  return b.status === 'confirmed' ? `<button class="btn good small" onclick="setStatus('${b.id}','completed')">Complete</button><button class="btn ghost small" onclick="setStatus('${b.id}','cancelled')">Cancel</button><button class="btn ghost small" onclick="setStatus('${b.id}','no-show')">No-show</button>` : '';
}

function renderAdmin(tab) {
  const body = el('adminBody'), today = manilaNow().date;
  const todays = S.bookings.filter(b => b.date === today);

  if (tab === 'today') {
    const completed = todays.filter(b => b.status === 'completed'), cancelled = todays.filter(b => b.status === 'cancelled');
    body.innerHTML = `
      <div class="stat-grid">
        <div class="stat-card"><div class="n">${todays.length}</div><div class="l">Appointments today</div></div>
        <div class="stat-card"><div class="n">${completed.length}</div><div class="l">Completed</div></div>
        <div class="stat-card"><div class="n">${cancelled.length}</div><div class="l">Cancelled</div></div>
        <div class="stat-card"><div class="n">₱${sumPrice(completed)}</div><div class="l">Revenue today</div></div>
      </div>
      <div class="admin-section"><h3>Today's schedule</h3>
        <div style="overflow-x:auto;"><table><thead><tr><th>Time</th><th>Customer</th><th>Contact</th><th>Service</th><th>Special request</th><th>Barber</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${[...todays].sort((a, b) => a.timeMin - b.timeMin).map(b => `
          <tr><td>${fmtTime(b.timeMin)}</td><td>${esc(b.name)}</td><td>${contactCell(b)}</td><td>${esc(b.service)}</td><td class="req">${esc(b.notes) || '—'}</td><td>${esc(barberNameOf(b))}</td>
          <td>${statusPill(b)}</td><td class="action-btns">${actionButtons(b) || '—'}</td></tr>`).join('') || '<tr><td colspan="8">No appointments today.</td></tr>'}
        </tbody></table></div>
      </div>`;
  } else if (tab === 'all') {
    let list = [...S.bookings].sort(byNewest);
    if (allFilter === 'upcoming') list = list.filter(b => b.status === 'confirmed' && b.date >= today);
    else if (allFilter !== 'all') list = list.filter(b => b.status === allFilter);
    shownIds = list.map(b => b.id);
    selIds = new Set([...selIds].filter(id => shownIds.includes(id)));
    const opts = [['all', 'All'], ['upcoming', 'Upcoming'], ['completed', 'Completed'], ['cancelled', 'Cancelled'], ['no-show', 'No-show']];
    body.innerHTML = `<div class="admin-section"><h3>All client bookings (${list.length})</h3>
      <p class="note" style="margin-top:0;margin-bottom:14px;">Bookings made by customers on any device appear here (this page refreshes every 30 seconds). Tick the ones you want to remove, or use Delete on a single row. Deleting a completed booking also removes it from the sales reports. A confirmed booking still open 24 hours after its time is marked no-show automatically.</p>
      ${manualBookingForm()}
      <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px;">
        <div style="min-width:200px;"><label for="allFilter">Show</label>
          <select id="allFilter" onchange="allFilter=this.value;renderAdmin('all')">${opts.map(o => `<option value="${o[0]}" ${allFilter === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('')}</select></div>
        <button class="btn bad small" ${selIds.size ? '' : 'disabled'} onclick="askDelete([...selIds])">Delete selected (${selIds.size})</button>
      </div>
      ${pendingDelete ? `<div class="confirm-box" style="border-color:var(--bad);background:rgba(161,72,63,.1);margin-bottom:14px;"><strong style="color:var(--bad);">Delete ${pendingDelete.length} booking${pendingDelete.length > 1 ? 's' : ''}?</strong> This can't be undone.<div class="cta-row"><button class="btn bad small" onclick="doDelete()">Yes, delete</button><button class="btn ghost small" onclick="pendingDelete=null;renderAdmin('all')">Keep them</button></div></div>` : ''}
      <div style="overflow-x:auto;"><table><thead><tr><th><input type="checkbox" aria-label="Select all shown" ${list.length && list.every(b => selIds.has(b.id)) ? 'checked' : ''} onchange="toggleAll(this.checked)"></th><th>Date</th><th>Time</th><th>Code</th><th>Customer</th><th>Contact</th><th>Service</th><th>Barber</th><th>Special request</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${list.map(b => `<tr><td><input type="checkbox" aria-label="Select booking" ${selIds.has(b.id) ? 'checked' : ''} onchange="toggleSel('${b.id}',this.checked)"></td><td>${b.date}</td><td>${fmtTime(b.timeMin)}</td><td>${esc(b.code)}</td><td>${esc(b.name)}</td><td>${contactCell(b)}</td><td>${esc(b.service)}</td><td>${esc(barberNameOf(b))}</td><td class="req">${esc(b.notes) || '—'}</td>
        <td>${statusPill(b)}</td><td class="action-btns">${actionButtons(b)}<button class="btn bad small" onclick="askDelete(['${b.id}'])">Delete</button></td></tr>`).join('') || '<tr><td colspan="11">No bookings match.</td></tr>'}</tbody></table></div></div>`;
    manualSlots();
  } else if (tab === 'queue') {
    const live = S.queue.filter(q => q.status === 'waiting' || q.status === 'serving');
    body.innerHTML = `<div class="admin-section"><h3>Walk-in queue today (${live.filter(q => q.status === 'waiting').length} waiting)</h3>
      <div style="overflow-x:auto;"><table><thead><tr><th>#</th><th>Name</th><th>Phone</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${live.map(q => `<tr><td>${q.queue_no}</td><td>${esc(q.name)}</td><td>${esc(q.phone)}</td><td>${esc(q.status)}</td>
        <td class="action-btns">${q.status === 'waiting' ? `<button class="btn good small" onclick="queueSet('${q.id}','serving')">Serving now</button>` : `<button class="btn good small" onclick="queueSet('${q.id}','done')">Done</button>`}
        <button class="btn ghost small" onclick="queueSet('${q.id}','removed')">Remove</button></td></tr>`).join('') || '<tr><td colspan="5">Queue is empty.</td></tr>'}
      </tbody></table></div></div>`;
  } else if (tab === 'reports') {
    const completed = S.bookings.filter(b => b.status === 'completed' && periodMatch(b.date, repPeriod));
    const periods = [['today', 'Today'], ['week', 'Last 7 days'], ['month', 'This month'], ['lastmonth', 'Last month'], ['all', 'All time']];
    const totalSales = sumPrice(completed), totalComm = commOf(completed);
    const ids = [...new Set([...S.barbers.map(b => b.id), ...completed.map(b => b.barber).filter(Boolean)])];
    const rows = ids.map(id => {
      const l = completed.filter(b => b.barber === id), bar = S.barbers.find(x => x.id === id);
      return { nm: bar ? bar.name : ((l[0] && l[0].barberName) || 'Former staff') + ' (removed)', n: l.length, sales: sumPrice(l), rate: bar ? Math.round(bar.commission * 100) + '%' : '—', comm: commOf(l) };
    });
    const orphan = completed.filter(b => !b.barber);
    if (orphan.length) rows.push({ nm: 'Former staff (removed)', n: orphan.length, sales: sumPrice(orphan), rate: '—', comm: commOf(orphan) });
    const detail = completed.filter(b => repBarber === 'all' || b.barber === repBarber).sort(byNewest);
    const svcCounts = {}; completed.forEach(b => svcCounts[b.service] = (svcCounts[b.service] || 0) + 1);
    const cust = {}; S.bookings.forEach(b => { const c = cust[b.phone] || (cust[b.phone] = { name: b.name, done: 0, noshow: 0 }); if (b.status === 'completed') c.done++; if (b.status === 'no-show') c.noshow++; });
    body.innerHTML = `
      <div style="margin-bottom:18px;max-width:220px;"><label for="repPeriod">Period</label>
        <select id="repPeriod" onchange="repPeriod=this.value;renderAdmin('reports')">${periods.map(o => `<option value="${o[0]}" ${repPeriod === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('')}</select></div>
      <div class="admin-section"><h3>Sales</h3>
        <div class="stat-grid">
          <div class="stat-card"><div class="n">₱${totalSales}</div><div class="l">Sales</div></div>
          <div class="stat-card"><div class="n">${completed.length}</div><div class="l">Completed cuts</div></div>
          <div class="stat-card"><div class="n">₱${totalComm}</div><div class="l">Commission owed</div></div>
          <div class="stat-card"><div class="n">₱${totalSales - totalComm}</div><div class="l">Shop share</div></div>
        </div></div>
      <div class="admin-section"><h3>Barber commission</h3>
        <div style="overflow-x:auto;"><table><thead><tr><th>Barber</th><th>Cuts completed</th><th>Sales</th><th>Rate</th><th>Commission</th></tr></thead>
        <tbody>${rows.map(r => `<tr><td>${esc(r.nm)}</td><td>${r.n}</td><td>₱${r.sales}</td><td>${r.rate}</td><td><strong style="color:var(--brass);">₱${r.comm}</strong></td></tr>`).join('')}
        <tr><td><strong>Total</strong></td><td>${completed.length}</td><td>₱${totalSales}</td><td></td><td><strong>₱${totalComm}</strong></td></tr></tbody></table></div>
        <p class="note">Commission is the price of each completed booking times that barber's rate when you marked it complete. Only bookings marked Complete count.</p></div>
      <div class="admin-section"><h3>Commission details</h3>
        <div style="margin-bottom:12px;max-width:220px;"><label for="repBarber">Barber</label>
          <select id="repBarber" onchange="repBarber=this.value;renderAdmin('reports')"><option value="all" ${repBarber === 'all' ? 'selected' : ''}>All barbers</option>${S.barbers.map(b => `<option value="${b.id}" ${repBarber === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></div>
        <div style="overflow-x:auto;"><table><thead><tr><th>Date</th><th>Customer</th><th>Service</th><th>Barber</th><th>Price</th><th>Rate</th><th>Commission</th></tr></thead>
        <tbody>${detail.map(b => `<tr><td>${b.date}</td><td>${esc(b.name)}</td><td>${esc(b.service)}</td><td>${esc(barberNameOf(b))}</td><td>₱${b.price}</td><td>${Math.round(rateOf(b) * 100)}%</td><td>₱${Math.round(b.price * rateOf(b))}</td></tr>`).join('') || '<tr><td colspan="7">No completed bookings in this period.</td></tr>'}</tbody></table></div></div>
      <div class="admin-section"><h3>Services booked</h3>
        <table><thead><tr><th>Service</th><th>Count</th></tr></thead>
        <tbody>${Object.entries(svcCounts).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('') || '<tr><td colspan="2">No completed bookings in this period.</td></tr>'}</tbody></table></div>
      <div class="admin-section"><h3>Customers &amp; no-shows</h3>
        <div style="overflow-x:auto;"><table><thead><tr><th>Customer</th><th>Phone</th><th>Completed</th><th>No-shows</th></tr></thead>
        <tbody>${Object.entries(cust).map(([p, c]) => `<tr><td>${esc(c.name)}</td><td>${esc(p)}</td><td>${c.done}</td><td>${c.noshow}</td></tr>`).join('') || '<tr><td colspan="4">No customers yet.</td></tr>'}</tbody></table></div></div>`;
  } else if (tab === 'inventory') {
    body.innerHTML = `<div class="admin-section"><h3>Inventory</h3>
      ${S.inventory.map(it => `
        <div class="inv-row">
          <div>${esc(it.name)}${it.stock <= it.min_stock ? ' <span class="low-stock">⚠ low stock</span>' : ''}</div>
          <div>Stock: <input type="number" min="0" value="${it.stock}" style="width:70px;display:inline-block;" onchange="updateInv('${it.id}','stock',this.value)"></div>
          <div>Min: <input type="number" min="0" value="${it.min_stock}" style="width:60px;display:inline-block;" onchange="updateInv('${it.id}','min_stock',this.value)"></div>
          <div></div>
        </div>`).join('')}
      <div class="inv-row"><div><input id="invName" placeholder="New item" maxlength="60"></div><div><input id="invStock" type="number" min="0" placeholder="Stock" style="width:80px;"></div><div><input id="invMin" type="number" min="0" placeholder="Min" style="width:70px;"></div><div><button class="btn small" onclick="addInv()">Add</button></div></div>
      <p class="note">Inventory is tracked manually here — update counts as you buy or use supplies.</p></div>`;
  } else if (tab === 'staff') {
    body.innerHTML = `<div class="admin-section"><h3>Staff (${S.barbers.length})</h3>
      ${staffMsg ? `<div class="empty-slots" role="alert" style="margin-bottom:12px;">${esc(staffMsg)}</div>` : ''}
      <div class="card" style="margin-bottom:18px;"><strong style="color:var(--brass);">Add a staff member</strong>
        <div class="field-row" style="margin-top:12px;"><div class="field"><label for="nsName">Name</label><input id="nsName" maxlength="40"></div><div class="field"><label for="nsRole">Role</label><input id="nsRole" value="Barber" maxlength="40"></div></div>
        <div class="field" style="max-width:200px;"><label for="nsComm">Commission %</label><input id="nsComm" type="number" min="0" max="100" value="30"></div>
        <div id="nsErr" class="empty-slots" role="alert" style="margin-bottom:8px;"></div>
        <button class="btn small" onclick="addStaff()">Add staff</button></div>
      ${S.barbers.map(b => staffCard(b, pendingRemove)).join('')}
      <p class="note">New staff appear on the Barbers page and in the booking form right away. Removing someone keeps their past bookings and commission history.</p></div>`;
  }
}

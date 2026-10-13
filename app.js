'use strict';
/* Primo Barbershop — customer site.
   Needs: config.js, the Supabase library, and the database from schema.sql. */

const CFG = window.PRIMO || {};
const TZ = 'Asia/Manila';
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DB = { services: [], hours: {}, barbers: [] };   // loaded from Supabase
let sb = null;                                         // Supabase client (shared with admin.js)

/* ---------- helpers ---------- */
const el = id => document.getElementById(id);
function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const normPhone = p => String(p || '').replace(/[\s\-().]/g, '');
const PHONE_RE = /^\+?\d{7,15}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// "Now" in the shop's time zone, whatever the visitor's device says.
function manilaNow() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  return { date: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) };
}
const dowOf = d => new Date(d + 'T00:00:00Z').getUTCDay();
function addDays(d, n) { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function hr12(h) { return ((h + 11) % 12 + 1) + (h >= 12 ? ' PM' : ' AM'); }
function fmtTime(min) { const h = Math.floor(min / 60), m = min % 60; return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; }
function fmtDate(d) { return new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); }
const svcOf = id => DB.services.find(s => s.id === id);
const barberOf = id => DB.barbers.find(b => b.id === id);

/* ---------- navigation ---------- */
function showTab(name) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  const panel = el('tab-' + name); if (!panel) return;
  panel.classList.add('active');
  document.querySelectorAll('nav.tabs button[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  el('tabs').classList.remove('open');
  window.scrollTo({ top: 0, behavior: 'auto' });
  saveDraft();
}
function wireNav() {
  document.querySelectorAll('nav.tabs button[data-tab]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
  el('hamburger').addEventListener('click', () => el('tabs').classList.toggle('open'));
}

/* ---------- loading data ---------- */
function configured() {
  const ok = v => v && !/YOUR-/.test(v);
  return !!(window.supabase && ok(CFG.SUPABASE_URL) && ok(CFG.SUPABASE_ANON_KEY));
}
async function loadPublic() {
  const [sv, hr, br] = await Promise.all([
    sb.from('services').select('*').eq('active', true).order('sort_order'),
    sb.from('shop_hours').select('*').order('dow'),
    sb.rpc('public_barbers')
  ]);
  for (const r of [sv, hr, br]) if (r.error) throw r.error;
  DB.services = sv.data.map(s => ({ ...s, price: Number(s.price) }));
  DB.hours = {};
  hr.data.forEach(h => { DB.hours[h.dow] = h.open_hour == null ? null : [h.open_hour, h.close_hour]; });
  DB.barbers = br.data.map(b => ({ ...b, hours: b.hours || {}, tags: b.tags || [], rating: b.rating == null ? null : Number(b.rating) }));
}

/* ---------- static sections ---------- */
function renderServices() {
  const cats = [...new Set(DB.services.map(s => s.category))];
  el('serviceList').innerHTML = cats.map(cat => `<h3 class="cat-heading">${esc(cat)}</h3>` +
    DB.services.filter(s => s.category === cat).map(s => `
      <div class="service">
        <div><h3>${esc(s.name)}</h3><p>${esc(s.description || '')}</p></div>
        <div class="right"><span class="dur">${s.duration_min} min</span><span class="price">₱${s.price}</span><br>
          <button class="btn small" style="margin-top:8px;" onclick="startBooking('${esc(s.id)}')">Book</button></div>
      </div>`).join('')).join('') || '<p class="loading">No services yet.</p>';
}

function barberAvatar(a) {
  if (!a) return '';
  const hp = {
    fade: 'M64 84 C58 46 80 30 106 30 C134 30 154 46 148 84 C146 66 130 50 106 50 C82 50 66 66 64 84Z',
    quiff: 'M62 82 C54 44 84 22 116 28 C146 32 158 58 150 84 C148 64 134 50 112 50 C90 50 70 58 62 82Z',
    crop: 'M64 78 C60 48 82 36 106 36 C134 36 152 50 148 78 C142 62 126 54 106 54 C86 54 70 62 64 78Z'
  };
  return `<svg viewBox="0 0 212 212" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Barber portrait">
    <rect width="212" height="212" fill="#242019"/>
    <path d="M24 212 C30 168 68 156 106 156 C144 156 182 168 188 212Z" fill="#3a332c"/>
    <path d="M88 156 L106 182 L124 156Z" fill="#ece6da"/>
    <polygon points="92,170 106,177 92,184" fill="#b5703f"/><polygon points="120,170 106,177 120,184" fill="#b5703f"/>
    <rect x="90" y="128" width="32" height="32" fill="${esc(a.skin)}"/>
    <ellipse cx="62" cy="96" rx="7" ry="11" fill="${esc(a.skin)}"/><ellipse cx="150" cy="96" rx="7" ry="11" fill="${esc(a.skin)}"/>
    <ellipse cx="106" cy="94" rx="43" ry="50" fill="${esc(a.skin)}"/>
    ${a.beard ? `<path d="M63 100 C63 142 84 152 106 152 C128 152 149 142 149 100 C141 118 126 124 106 124 C86 124 71 118 63 100Z" fill="${esc(a.hair)}"/>` : ''}
    <path d="${hp[a.style] || hp.fade}" fill="${esc(a.hair)}"/>
    <circle cx="90" cy="92" r="3" fill="#141210"/><circle cx="122" cy="92" r="3" fill="#141210"/>
  </svg>`;
}
function scheduleSummary(hours) {
  const days = [1, 2, 3, 4, 5, 6, 0].filter(d => DB.hours[d] && hours[d]);
  if (!days.length) return 'Off this week';
  const nm = d => DAY_NAMES[d].slice(0, 3);
  const same = days.every(d => hours[d][0] === hours[days[0]][0] && hours[d][1] === hours[days[0]][1]);
  if (same) return days.map(nm).join('/') + ' · ' + hr12(hours[days[0]][0]) + '–' + hr12(hours[days[0]][1]);
  return days.slice(0, 3).map(d => nm(d) + ' ' + hr12(hours[d][0]) + '–' + hr12(hours[d][1])).join(' · ') + (days.length > 3 ? ' …' : '');
}
function renderBarbers() {
  el('barberList').innerHTML = DB.barbers.map(b => `
    <div class="card">
      <div class="avatar">${barberAvatar(b.avatar)}</div>
      <div class="barber-name">${esc(b.name)}</div>
      <div class="barber-role">${esc(b.role)}</div>
      ${b.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}
      ${b.rating ? `<div class="rating">★ ${b.rating.toFixed(1)}</div>` : ''}
      <p style="font-size:.82rem;">${esc(scheduleSummary(b.hours))}</p>
      <button class="btn ghost small" onclick="startBooking(null,'${esc(b.id)}')">Book with ${esc(b.name)}</button>
    </div>`).join('') || '<p class="loading">No barbers available right now.</p>';
}

function renderHours() {
  const order = [1, 2, 3, 4, 5, 6, 0], rows = [];
  order.forEach(d => {
    const h = DB.hours[d], t = h ? `${hr12(h[0])} – ${hr12(h[1])}` : 'Closed';
    const last = rows[rows.length - 1];
    if (last && last.t === t) last.days.push(d); else rows.push({ t, days: [d] });
  });
  el('hoursList').innerHTML = rows.map(r => {
    const a = DAY_NAMES[r.days[0]], b = DAY_NAMES[r.days[r.days.length - 1]];
    return `<div class="row-line"><span>${r.days.length === 1 ? a : a.slice(0, 3) + ' – ' + b.slice(0, 3)}</span><span>${r.t}</span></div>`;
  }).join('');
}

function renderPromos() {
  const today = manilaNow().date;
  const active = (CFG.PROMOS || []).filter(p => !p.expires || p.expires >= today);
  el('promoList').innerHTML = active.length ? active.map(p => `
    <div class="promo-card">
      <div><h3 style="margin-bottom:2px;">${esc(p.name)}</h3><p style="margin:0;">${esc(p.desc || '')}</p>${p.expires ? `<p class="exp">Ends ${esc(p.expires)}</p>` : ''}</div>
      <div style="text-align:right;">
        ${p.price ? `<span class="amt">₱${esc(p.price)}</span>${p.was ? `<span class="was">₱${esc(p.was)}</span>` : ''}<br>` : ''}
        <button class="btn small" style="margin-top:8px;" onclick="startBooking('${esc(p.service || '')}')">Book this promo</button>
      </div>
    </div>`).join('') : '<p>No active promos right now — check back soon.</p>';
}
function renderReviews() {
  el('reviewList').innerHTML = (CFG.REVIEWS || []).map(r => `
    <div class="review"><div class="stars">★★★★★</div><p>"${esc(r.text)}"</p><p style="color:var(--brass);">— ${esc(r.name)}</p></div>`).join('');
}
function renderFaq() {
  el('faqList').innerHTML = (CFG.FAQS || []).map((f, i) => `
    <div class="faq-item" id="faq${i}">
      <div class="faq-q" onclick="el('faq${i}').classList.toggle('open')">${esc(f.q)}<span>+</span></div>
      <div class="faq-a"><p style="margin:0;">${esc(f.a)}</p></div>
    </div>`).join('');
}

async function refreshStatus() {
  const now = manilaNow(), h = DB.hours[dowOf(now.date)];
  let label, cls;
  if (!h) { label = 'Closed today'; cls = 'closed'; }
  else if (now.min < h[0] * 60 || now.min >= h[1] * 60) { label = 'Closed now'; cls = 'closed'; }
  else {
    let waiting = 0;
    try { const r = await sb.rpc('public_status'); waiting = (r.data && r.data.waiting) || 0; } catch (e) { /* ignore */ }
    if (waiting >= 6) { label = `Very busy — about ${waiting * 15} min wait`; cls = 'closed'; }
    else if (waiting >= 3) { label = `Busy — estimated wait ${waiting * 15} min`; cls = 'busy'; }
    else { label = 'Open now — walk-ins welcome'; cls = 'open'; }
  }
  el('statusDot').className = 'dot ' + cls;
  el('statusText').textContent = label;
}

/* ---------- availability ---------- */
// Returns open start times for a date: [{min, barber}] (barber = who will cut). The server re-checks on booking.
async function slotsFor(barberId, dateStr, dur) {
  const dow = dowOf(dateStr), shop = DB.hours[dow];
  if (!shop) return [];
  const r = await sb.rpc('get_busy', { p_date: dateStr });
  if (r.error) throw r.error;
  const busy = r.data || [];
  const now = manilaNow(), isToday = dateStr === now.date;
  const cands = (barberId && barberId !== 'any') ? DB.barbers.filter(b => b.id === barberId) : DB.barbers;
  const load = id => busy.filter(x => x.barber_id === id).length;
  const ordered = [...cands].sort((a, b) => load(a.id) - load(b.id));   // "any barber" = least busy first
  const out = [];
  for (let m = shop[0] * 60; m + dur <= shop[1] * 60; m += 15) {
    if (isToday && m <= now.min + 15) continue;
    for (const b of ordered) {
      const h = b.hours[dow];
      if (!h || m < h[0] * 60 || m + dur > h[1] * 60) continue;
      if (busy.some(x => x.barber_id === b.id && m < x.start_min + x.duration_min && m + dur > x.start_min)) continue;
      out.push({ min: m, barber: b.id }); break;
    }
  }
  return out;
}

/* ---------- booking flow ---------- */
let bk = { service: null, barber: null, date: null, time: null, assignedBarber: null, result: null, notice: '' };
let bkStep = 0, slotSeq = 0;
const STEP_LABELS = ['Service', 'Barber', 'Date & time', 'Your info', 'Confirm'];
const ERR_MSG = {
  invalid_name: 'Please enter your full name.',
  invalid_phone: 'Please enter a valid phone number so the shop can reach you.',
  invalid_email: 'Please check the email address.',
  invalid_notes: 'Your special request is too long (300 characters max).',
  invalid_service: 'That service is no longer available.',
  invalid_barber: 'That barber is not available. Please pick another.',
  invalid_date: 'Please pick a date within the next 60 days.',
  closed: 'The shop is closed that day.',
  barber_off: 'That barber is off that day.',
  outside_hours: 'That time is outside working hours.',
  in_past: 'That time has already passed.',
  too_many: 'You already have 3 upcoming bookings. Please call the shop to book more.',
  slot_taken: 'Sorry, that time was just taken. Please pick another.'
};

function startBooking(serviceId, barberId) {
  bk = { service: serviceId && svcOf(serviceId) ? serviceId : null, barber: barberId || null, date: null, time: null, assignedBarber: null, result: null, notice: '' };
  bkStep = bk.service ? 1 : 0;
  if (barberId) bkStep = bk.service ? 2 : 0;
  showTab('book'); renderBookStep();
}
function renderStepDots() {
  el('stepDots').innerHTML = STEP_LABELS.map((l, i) => `<span class="step-dot ${i === bkStep ? 'on' : i < bkStep ? 'done' : ''}">${i + 1}. ${l}</span>`).join('');
}
function renderBookStep() { renderBookStepInner(); bindDraftInputs(); saveDraft(); }

function renderBookStepInner() {
  renderStepDots();
  const box = el('bookStepContent');
  if (!DB.services.length) { box.innerHTML = '<p class="loading">Loading…</p>'; return; }

  if (bkStep === 0) {
    box.innerHTML = `<div class="pick-grid">${DB.services.map(s => `
      <button class="pick ${bk.service === s.id ? 'sel' : ''}" onclick="bk.service='${esc(s.id)}';bkStep=1;renderBookStep();">
        <div class="t1">${esc(s.name)}</div><div class="t2">₱${s.price} · ${s.duration_min} min</div></button>`).join('')}</div>`;
  } else if (bkStep === 1) {
    box.innerHTML = `<div class="pick-grid">
      <button class="pick ${bk.barber === null ? 'sel' : ''}" onclick="bk.barber=null;bkStep=2;renderBookStep();"><div class="t1">Any barber</div><div class="t2">Soonest open chair</div></button>
      ${DB.barbers.map(b => `<button class="pick ${bk.barber === b.id ? 'sel' : ''}" onclick="bk.barber='${esc(b.id)}';bkStep=2;renderBookStep();"><div class="t1">${esc(b.name)}</div><div class="t2">${esc(b.role)}${b.rating ? ' · ★' + b.rating : ''}</div></button>`).join('')}
      </div>
      <button class="btn ghost small" style="margin-top:14px;" onclick="bkStep=0;renderBookStep();">Back</button>`;
  } else if (bkStep === 2) {
    const svc = svcOf(bk.service) || { duration_min: 30 };
    const today = manilaNow().date;
    const dateVal = bk.date && bk.date >= today ? bk.date : today;
    box.innerHTML = `${bk.notice ? `<p class="empty-slots" role="alert">${esc(bk.notice)}</p>` : ''}
      <div class="field"><label for="dateIn">Date</label><input id="dateIn" type="date" min="${today}" max="${addDays(today, 60)}" value="${dateVal}"></div>
      <div id="slotArea"></div>
      <button class="btn ghost small" style="margin-top:14px;" onclick="bkStep=1;renderBookStep();">Back</button>`;
    bk.notice = '';
    const draw = async () => {
      const d = el('dateIn').value; if (!d) return;
      bk.date = d;
      const area = el('slotArea'), my = ++slotSeq;
      area.innerHTML = '<p class="loading" style="margin-top:14px;">Loading open times…</p>';
      let sl;
      try { sl = await slotsFor(bk.barber, d, svc.duration_min); }
      catch (e) { if (my === slotSeq) area.innerHTML = '<p class="empty-slots" style="margin-top:14px;">Could not load times. Check your connection and try again.</p>'; return; }
      if (my !== slotSeq) return;
      area.innerHTML = sl.length ? `<div class="pick-grid" style="margin-top:14px;">${sl.map(s => `
        <button class="pick ${bk.time === s.min ? 'sel' : ''}" onclick="bk.time=${s.min};bk.assignedBarber='${esc(s.barber)}';bkStep=3;renderBookStep();">
          <div class="t1">${fmtTime(s.min)}</div><div class="t2">${esc((barberOf(s.barber) || {}).name || '')}</div></button>`).join('')}</div>`
        : '<p class="empty-slots" style="margin-top:14px;">No open times that day — try another date.</p>';
    };
    el('dateIn').addEventListener('change', draw);
    draw();
  } else if (bkStep === 3) {
    box.innerHTML = `
      <div class="field"><label for="custName">Full name</label><input id="custName" autocomplete="name" maxlength="80"></div>
      <div class="field-row">
        <div class="field"><label for="custPhone">Phone number</label><input id="custPhone" type="tel" autocomplete="tel" placeholder="09xx xxx xxxx" maxlength="20"></div>
        <div class="field"><label for="custEmail">Email (optional)</label><input id="custEmail" type="email" autocomplete="email" placeholder="you@email.com" maxlength="80"></div>
      </div>
      <div class="field"><label for="custNotes">Special request (optional)</label><textarea id="custNotes" maxlength="300" placeholder="Hairstyle reference, barber preference, allergies, anything we should know"></textarea></div>
      <input class="hp" id="hpWebsite" tabindex="-1" autocomplete="off" aria-hidden="true">
      <div id="bkError" class="empty-slots" role="alert" style="margin-bottom:10px;"></div>
      <button class="btn small" id="confirmBtn" onclick="submitBooking()">Confirm booking</button>
      <button class="btn ghost small" onclick="bkStep=2;renderBookStep();">Back</button>`;
  } else if (bkStep === 4 && bk.result) {
    const r = bk.result;
    box.innerHTML = `
      <div class="summary">
        <div><span>Service</span><span>${esc(r.service_name)}</span></div>
        <div><span>Barber</span><span>${esc(r.barber_name)}</span></div>
        <div><span>Date</span><span>${esc(fmtDate(r.date))}</span></div>
        <div><span>Time</span><span>${fmtTime(r.start_min)}</span></div>
        <div><span>Price</span><span>₱${esc(r.price)}</span></div>
      </div>
      <div class="confirm-box" id="confirmBoxInner">
        <strong>Booking confirmed ✂️</strong>
        <p style="margin-top:8px;">Your booking code is <strong style="font-size:1.1rem;letter-spacing:.08em;">${esc(r.code)}</strong>. Keep it, together with your phone number, to check or cancel this booking. Please arrive 5–10 minutes early. You can cancel free of charge up to 2 hours before your appointment.</p>
        <div class="cta-row">
          <a class="btn ghost small" id="calLink" target="_blank" rel="noopener">Add to calendar</a>
          <button class="btn ghost small" onclick="cancelLast()">Cancel appointment</button>
        </div>
      </div>
      <button class="btn small" style="margin-top:16px;" onclick="resetBooking()">Book another appointment</button>`;
    const [y, mo, d] = r.date.split('-'), pad = n => String(n).padStart(2, '0');
    const dt = m => `${y}${mo}${d}T${pad(Math.floor(m / 60))}${pad(m % 60)}00`;
    el('calLink').href = 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + encodeURIComponent(`Primo Barbershop - ${r.service_name} with ${r.barber_name}`) +
      '&dates=' + dt(r.start_min) + '/' + dt(r.start_min + r.duration_min) + '&ctz=Asia%2FManila&location=' + encodeURIComponent('511 MacArthur Hwy, Angeles City, Pampanga') + '&details=' + encodeURIComponent('Cut. Shave. Fade.');
  } else { bkStep = 0; renderBookStepInner(); }
}

async function submitBooking() {
  const err = el('bkError'); err.textContent = '';
  if (el('hpWebsite').value) return;                       // bots fill hidden fields
  const name = el('custName').value.trim(), phone = el('custPhone').value.trim();
  const email = el('custEmail').value.trim().toLowerCase(), notes = el('custNotes').value.trim();
  if (!name) { err.textContent = ERR_MSG.invalid_name; return; }
  if (!PHONE_RE.test(normPhone(phone))) { err.textContent = ERR_MSG.invalid_phone; return; }
  if (email && !EMAIL_RE.test(email)) { err.textContent = ERR_MSG.invalid_email; return; }
  const btn = el('confirmBtn'); btn.disabled = true; btn.textContent = 'Booking…';
  let res;
  try {
    res = await sb.rpc('create_booking', { p_name: name, p_phone: phone, p_email: email || null, p_notes: notes || null, p_service_id: bk.service, p_barber: bk.assignedBarber, p_date: bk.date, p_start: bk.time });
  } catch (e) { res = { error: e }; }
  if (res.error || !res.data) { btn.disabled = false; btn.textContent = 'Confirm booking'; err.textContent = 'Something went wrong. Please try again, or call the shop.'; return; }
  if (!res.data.ok) {
    if (res.data.error === 'slot_taken' || res.data.error === 'in_past') { bk.time = null; bk.assignedBarber = null; bk.notice = ERR_MSG[res.data.error]; bkStep = 2; renderBookStep(); return; }
    btn.disabled = false; btn.textContent = 'Confirm booking'; err.textContent = ERR_MSG[res.data.error] || 'Could not complete that booking.'; return;
  }
  bk.result = res.data; bk.phone = phone;
  ['custName', 'custPhone', 'custEmail', 'custNotes'].forEach(k => delete draftFields[k]);
  draftFields.lkPhone = phone; draftFields.lkCode = res.data.code;     // pre-fill "My booking"
  el('lkPhone').value = phone; el('lkCode').value = res.data.code;
  bkStep = 4; renderBookStep();
}
async function cancelLast() {
  const box = el('confirmBoxInner');
  const r = await sb.rpc('cancel_booking', { p_code: bk.result.code, p_phone: bk.phone });
  const d = r.data || {};
  box.innerHTML = d.ok ? '<strong>Appointment cancelled.</strong>'
    : `<strong>Could not cancel.</strong><p>${d.error === 'too_late' ? 'It is less than 2 hours before your appointment. Please call the shop.' : 'Please call the shop.'}</p>`;
}
function resetBooking() {
  bk = { service: null, barber: null, date: null, time: null, assignedBarber: null, result: null, notice: '' };
  bkStep = 0; renderBookStep();
}

/* ---------- walk-in queue ---------- */
async function joinQueue() {
  const msg = el('queueMsg'), name = el('wqName').value.trim(), phone = el('wqPhone').value.trim();
  if (!name || !PHONE_RE.test(normPhone(phone))) { msg.textContent = 'Enter your name and a valid phone number.'; return; }
  msg.textContent = 'Joining…';
  const r = await sb.rpc('join_queue', { p_name: name, p_phone: phone });
  const d = r.data;
  if (r.error || !d) { msg.textContent = 'Something went wrong. Please try again.'; return; }
  if (!d.ok) { msg.textContent = { already_waiting: 'This number is already in the queue.', queue_full: 'The queue is full right now. Please call the shop.', invalid_name: 'Enter your name.', invalid_phone: 'Enter a valid phone number.' }[d.error] || 'Could not join the queue.'; return; }
  msg.innerHTML = `<strong style="color:var(--brass);">Queue #${d.queue_no}</strong> — ${d.ahead} ahead of you, estimated wait ${d.ahead * 15} min. Please head to the shop.`;
  ['wqName', 'wqPhone'].forEach(id => { el(id).value = ''; delete draftFields[id]; }); saveDraft();
  refreshStatus();
}

/* ---------- my booking & points ---------- */
async function lookupCustomer() {
  const out = el('lookupResult'), phone = normPhone(el('lkPhone').value), code = el('lkCode').value.trim().toUpperCase();
  if (!PHONE_RE.test(phone)) { out.textContent = 'Enter the phone number you booked with.'; return; }
  out.textContent = 'Looking up…';
  const [pts, bkg] = await Promise.all([sb.rpc('loyalty_points', { p_phone: phone }), code ? sb.rpc('my_booking', { p_code: code, p_phone: phone }) : Promise.resolve(null)]);
  let html = `<p><strong style="color:var(--brass);">${pts.data || 0} loyalty points</strong> (1 completed visit = 1 point, 10 = free classic cut)</p>`;
  if (code) {
    const d = bkg && bkg.data;
    if (!d || !d.ok) html += '<p>No booking found for that code and phone number.</p>';
    else {
      html += `<p>${esc(d.service_name)} with ${esc(d.barber_name)}<br>${esc(fmtDate(d.date))} at ${fmtTime(d.start_min)} — <strong>${esc(d.status)}</strong></p>`;
      if (d.status === 'confirmed') html += `<button class="btn ghost small" onclick="cancelByCode('${esc(d.code)}','${esc(phone)}')">Cancel this booking</button>`;
    }
  }
  out.innerHTML = html;
}
async function cancelByCode(code, phone) {
  const r = await sb.rpc('cancel_booking', { p_code: code, p_phone: phone });
  const d = r.data || {};
  el('lookupResult').innerHTML = d.ok ? '<p><strong>Booking cancelled.</strong></p>' : `<p>${d.error === 'too_late' ? 'It is less than 2 hours before your appointment. Please call the shop.' : 'Could not cancel. Please call the shop.'}</p>`;
}

/* ---------- keep what people typed across a refresh (this device only) ---------- */
const DRAFT_KEY = 'primo_draft_v2';
const DRAFT_FIELDS = ['custName', 'custPhone', 'custEmail', 'custNotes', 'wqName', 'wqPhone', 'lkPhone', 'lkCode'];
let draftFields = {};
function saveDraft() {
  try {
    const tab = (document.querySelector('.panel.active') || {}).id;
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ bk: bkStep >= 4 ? null : bk, bkStep: bkStep >= 4 ? 0 : bkStep, fields: draftFields, tab: tab ? tab.replace('tab-', '') : 'home' }));
  } catch (e) { /* storage unavailable */ }
}
function bindDraftInputs() {
  DRAFT_FIELDS.forEach(id => {
    const x = el(id); if (!x || x.dataset.draftBound) return;
    if (draftFields[id] !== undefined) x.value = draftFields[id];
    x.dataset.draftBound = '1';
    x.addEventListener('input', () => { draftFields[id] = x.value; saveDraft(); });
  });
}
function loadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); if (!d) return;
    draftFields = d.fields || {};
    if (d.bk) { bk = { ...bk, ...d.bk, result: null, notice: '' }; bkStep = d.bkStep || 0; }
    if (d.tab && el('tab-' + d.tab)) showTab(d.tab);
  } catch (e) { /* ignore a corrupt draft */ }
}
async function validateDraft() {
  if (bk.service && !svcOf(bk.service)) { bk.service = null; bkStep = 0; }
  if (bk.barber && !barberOf(bk.barber)) bk.barber = null;
  if (bk.date && bk.date < manilaNow().date) { bk.date = null; bk.time = null; bk.assignedBarber = null; bkStep = Math.min(bkStep, 2); }
  if (bkStep >= 3) {
    let ok = false;
    try { const svc = svcOf(bk.service); ok = !!svc && (await slotsFor(bk.barber, bk.date, svc.duration_min)).some(x => x.min === bk.time && x.barber === bk.assignedBarber); } catch (e) { /* offline */ }
    if (!ok) { bk.time = null; bk.assignedBarber = null; bkStep = 2; }
  }
}

/* ---------- start ---------- */
async function init() {
  wireNav();
  renderPromos(); renderReviews(); renderFaq();
  if (!configured()) { el('configBanner').hidden = false; el('statusText').textContent = ''; return; }
  sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  try {
    await loadPublic();
    renderServices(); renderBarbers(); renderHours();
    loadDraft(); await validateDraft(); renderBookStep();
    refreshStatus(); setInterval(refreshStatus, 60000);
  } catch (e) {
    console.error(e);
    el('statusText').textContent = 'Could not load the shop data. Please refresh.';
  }
  if (typeof initAdmin === 'function') initAdmin();
}
init();

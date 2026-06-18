// ─── Shared crypto helper (used by gate + personal lock) ────────────────────
async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── Entry gate ─────────────────────────────────────────────────────────────
// Default sheet URL — always used as fallback even before For Me is configured
const DEFAULT_SHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQ1h9uuaolW1iVGo9fTIrksOQEX5Vq714yBRnC4ZSKcd6NTGZudGK_yXAn-P_J8o6gAARWpJFpFYXz3/pub?gid=0&single=true&output=csv';

// ─── Owner password (hardcoded so it's the same on every device) ─────────────
// SHA-256 of the owner password. To change: run sha256('newpassword') in the
// browser console and replace the string below.
const OWNER_PW_HASH = '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4'; // "1234"

// ─── Firebase + Firestore ────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyCixkin0UA2JVD6Am2YNB4WFGjXiPePjn4",
  authDomain: "sea-travel-planner.firebaseapp.com",
  projectId: "sea-travel-planner",
  storageBucket: "sea-travel-planner.firebasestorage.app",
  messagingSenderId: "467711297731",
  appId: "1:467711297731:web:7d6d48c1495409c69b7a76",
  measurementId: "G-804FFW1THN"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
async function uploadPhoto(file, folder) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('upload_preset', 'sea_trips');
  formData.append('folder', 'sea/' + folder);
  const res = await fetch('https://api.cloudinary.com/v1_1/dleyj8ti6/image/upload', {
    method: 'POST',
    body: formData,
  });
  const data = await res.json();
  if (!data.secure_url) throw new Error('Cloudinary upload failed: ' + JSON.stringify(data));
  return data.secure_url;
}

// ─── Storage ─────────────────────────────────────────────────────────────────
// _cache holds all synced data in memory; photos stay in localStorage (too large for Firestore)
const _cache = {};

const store = {
  get: (k, def) => {
    if (_cache[k] !== undefined) return _cache[k];
    try { return JSON.parse(localStorage.getItem('sea_' + k)) ?? def; } catch { return def; }
  },
  set: (k, v) => {
    _cache[k] = v;
    // Mirror access list to localStorage so the entry gate can read it without waiting for Firestore
    if (k === 'accessList') localStorage.setItem('sea_accessList', JSON.stringify(v));
    db.collection('tripdata').doc('main').set({ [k]: JSON.stringify(v) }, { merge: true }).catch(console.error);
  }
};

(function initGate() {
  if (sessionStorage.getItem('sea_access') === 'granted') {
    document.getElementById('entryGate').style.display = 'none';
    document.getElementById('appShell').style.display = 'block';
    return;
  }

  function normalise(val) {
    return val.trim().toLowerCase().replace(/[\s\-().+]/g, '');
  }

  // Parse CSV rows into {name, value} objects — handles quoted fields
  function parseCSV(text) {
    return text.split('\n').slice(1).map(line => {
      const cols = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
      return cols[0] ? { name: cols[0], value: cols[1] || '' } : null;
    }).filter(Boolean);
  }

  async function fetchSheetList() {
    const url = store.get('sheetURL', DEFAULT_SHEET_URL) || DEFAULT_SHEET_URL;
    if (!url) return [];
    const cached = localStorage.getItem('sea_sheetCache');
    const cachedAt = parseInt(localStorage.getItem('sea_sheetCachedAt') || '0');
    // Use cache if less than 5 minutes old
    if (cached && Date.now() - cachedAt < 5 * 60 * 1000) return JSON.parse(cached);
    try {
      const res = await fetch(url);
      const text = await res.text();
      const list = parseCSV(text);
      localStorage.setItem('sea_sheetCache', JSON.stringify(list));
      localStorage.setItem('sea_sheetCachedAt', Date.now().toString());
      return list;
    } catch {
      return cached ? JSON.parse(cached) : [];
    }
  }

  async function getFullList() {
    const local = JSON.parse(localStorage.getItem('sea_accessList') || '[]');
    const sheet = await fetchSheetList();
    return [...local, ...sheet];
  }

  async function checkAccess(input) {
    const list = await getFullList();
    const norm = normalise(input);
    return list.some(entry => normalise(entry.value) === norm);
  }

  const submitBtn = document.getElementById('entrySubmit');
  const errEl = document.getElementById('entryError');

  submitBtn.addEventListener('click', async () => {
    const val = document.getElementById('entryInput').value.trim();
    if (!val) return;
    submitBtn.textContent = 'Checking...';
    submitBtn.disabled = true;
    if (await checkAccess(val)) {
      sessionStorage.setItem('sea_access', 'granted');
      document.getElementById('entryGate').style.display = 'none';
      document.getElementById('appShell').style.display = 'block';
    } else {
      errEl.textContent = "That email or number isn't on the list. Ask Makena for access!";
      setTimeout(() => errEl.textContent = '', 4000);
      document.getElementById('entryInput').value = '';
    }
    submitBtn.textContent = 'Enter';
    submitBtn.disabled = false;
  });

  document.getElementById('entryInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') submitBtn.click();
  });

  // Owner bypass — use For Me password to skip the gate
  document.getElementById('entryOwnerToggle').addEventListener('click', () => {
    const fields = document.getElementById('entryOwnerFields');
    fields.style.display = fields.style.display === 'none' ? 'flex' : 'none';
    if (fields.style.display === 'flex') document.getElementById('entryOwnerPw').focus();
  });

  async function ownerUnlock() {
    const pw = document.getElementById('entryOwnerPw').value;
    if (!pw) return;
    const entered = await sha256(pw);
    if (entered === OWNER_PW_HASH) {
      sessionStorage.setItem('sea_access', 'granted');
      document.getElementById('entryGate').style.display = 'none';
      document.getElementById('appShell').style.display = 'block';
    } else {
      errEl.textContent = 'Wrong password.';
      setTimeout(() => errEl.textContent = '', 2500);
      document.getElementById('entryOwnerPw').value = '';
    }
  }

  document.getElementById('entryOwnerSubmit').addEventListener('click', ownerUnlock);
  document.getElementById('entryOwnerPw').addEventListener('keydown', e => {
    if (e.key === 'Enter') ownerUnlock();
  });
})();

// (store defined above, before the entry gate)

// ─── Navigation ─────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-link, .nav-dropdown-item, #countriesGalleryBtn').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    const page = link.dataset.page;
    navigateTo(page);
    if (page === 'countries') { renderCountriesList(); renderCalendar(); }
    if (page === 'gallery') renderGallery();
  });
});

// Hamburger menu
const hamburger = document.getElementById('navHamburger');
const navLinks = document.getElementById('navLinks');
hamburger.addEventListener('click', () => {
  navLinks.classList.toggle('mobile-open');
  hamburger.classList.toggle('open');
});
// Close mobile nav on any link click
document.querySelectorAll('.nav-link, .nav-dropdown-item, #countriesGalleryBtn').forEach(l => {
  l.addEventListener('click', () => {
    navLinks.classList.remove('mobile-open');
    hamburger.classList.remove('open');
  });
});

// Dropdown: close when clicking outside
document.addEventListener('click', e => {
  if (!e.target.closest('.nav-dropdown')) {
    document.querySelectorAll('.nav-dropdown').forEach(d => d.classList.remove('open'));
  }
});
document.querySelectorAll('.nav-dropdown-trigger').forEach(trigger => {
  trigger.addEventListener('click', e => {
    e.preventDefault();
    const dd = trigger.closest('.nav-dropdown');
    const wasOpen = dd.classList.contains('open');
    document.querySelectorAll('.nav-dropdown').forEach(d => d.classList.remove('open'));
    if (!wasOpen) dd.classList.add('open');
  });
});

// ─── Currency ────────────────────────────────────────────────────────────────
// Approximate rates to CAD (updated periodically — not live)
const RATES_TO_CAD = {
  CAD: 1,
  USD: 1.36,
  EUR: 1.50,
  GBP: 1.75,
  AUD: 0.89,
  SGD: 1.02,
  MYR: 0.31,
  THB: 0.040,
  VND: 0.000054,
  KHR: 0.00033,
  IDR: 0.000086,
  PHP: 0.024,
  JPY: 0.0092,
};
const CURRENCY_SYMBOLS = {
  CAD:'CA$', USD:'US$', EUR:'€', GBP:'£', AUD:'A$', SGD:'S$',
  MYR:'RM', THB:'฿', VND:'₫', KHR:'៛', IDR:'Rp', PHP:'₱', JPY:'¥',
};
function toCAD(amount, currency) { return amount * (RATES_TO_CAD[currency] || 1); }
function fmtCAD(n) { return 'CA$' + n.toFixed(2); }
function fmtLocal(n, currency) { return (CURRENCY_SYMBOLS[currency] || currency + ' ') + n.toFixed(2); }

// ─── Country meta ────────────────────────────────────────────────────────────
const COUNTRY_COORDS = {
  Thailand: [13.7563, 100.5018],
  Vietnam: [14.0583, 108.2772],
  Cambodia: [12.5657, 104.9910],
  Laos: [17.9757, 102.6331],
  Myanmar: [21.9162, 95.9560],
  Indonesia: [-0.7893, 113.9213],
  Malaysia: [4.2105, 101.9758],
  Philippines: [12.8797, 121.7740],
  Singapore: [1.3521, 103.8198],
};
const COUNTRY_FLAGS = {
  Thailand:'🇹🇭', Vietnam:'🇻🇳', Cambodia:'🇰🇭', Laos:'🇱🇦', Myanmar:'🇲🇲',
  Indonesia:'🇮🇩', Malaysia:'🇲🇾', Philippines:'🇵🇭', Singapore:'🇸🇬',
};
const TYPE_ICONS = {
  temple:'🛕', nature:'🌿', food:'🍜', beach:'🏖', city:'🌆',
  adventure:'🧗', accommodation:'🏨', other:'📍',
};

// ═══════════════════════════════════════════════════════════════════════════
// TIMELINE
// ═══════════════════════════════════════════════════════════════════════════
const DEFAULT_BLOCKS = [
  { id: 1, country: 'Thailand', start: '2027-01-15', end: '2027-02-10' },
  { id: 2, country: 'Cambodia', start: '2027-02-10', end: '2027-02-24' },
  { id: 3, country: 'Vietnam', start: '2027-02-24', end: '2027-04-01' },
];
let blocks = [...DEFAULT_BLOCKS];

let DAY_W = window.innerWidth <= 768 ? 7 : 14; // px per day (responsive)
window.addEventListener('resize', () => {
  const newW = window.innerWidth <= 768 ? 7 : 14;
  if (newW !== DAY_W) { DAY_W = newW; renderTimeline(); renderCalendar(); }
});

function parseDate(s) { return new Date(s + 'T00:00:00'); }
function fmtDate(d) { return d.toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.round((parseDate(b) - parseDate(a)) / 86400000); }
function addDays(s, n) { const d = parseDate(s); d.setDate(d.getDate() + n); return fmtDate(d); }
function dateToX(date, tripStart) { return daysBetween(tripStart, date) * DAY_W; }

function getTripBounds() {
  return {
    start: document.getElementById('tripStart').value,
    end: document.getElementById('tripEnd').value,
  };
}

function renderTimeline() {
  const { start, end } = getTripBounds();
  const totalDays = daysBetween(start, end);
  const totalW = totalDays * DAY_W;

  // Header: one cell per month
  const header = document.getElementById('timelineHeader');
  header.innerHTML = '';
  const trackEl = document.getElementById('timelineTrack');
  trackEl.style.width = totalW + 'px';
  header.style.minWidth = totalW + 'px';

  let cur = parseDate(start);
  const endDate = parseDate(end);
  while (cur < endDate) {
    const monthStart = new Date(cur);
    const monthEnd = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    const clampedEnd = monthEnd < endDate ? monthEnd : endDate;
    const days = Math.round((clampedEnd - monthStart) / 86400000);
    const cell = document.createElement('div');
    cell.className = 'timeline-month';
    cell.style.width = (days * DAY_W) + 'px';
    cell.textContent = monthStart.toLocaleDateString('en', { month: 'short', year: '2-digit' });
    header.appendChild(cell);
    cur = monthEnd;
  }

  // Grid columns
  const grid = document.getElementById('timelineGrid');
  grid.innerHTML = '';
  grid.style.width = totalW + 'px';
  for (let d = 0; d < totalDays; d++) {
    const col = document.createElement('div');
    col.className = 'timeline-grid-col';
    col.style.width = DAY_W + 'px';
    grid.appendChild(col);
  }

  // Blocks
  const blocksEl = document.getElementById('timelineBlocks');
  blocksEl.innerHTML = '';
  blocksEl.style.width = totalW + 'px';

  blocks.forEach(b => {
    const x = dateToX(b.start, start);
    const w = daysBetween(b.start, b.end) * DAY_W;
    if (w < 1) return;

    const el = document.createElement('div');
    el.className = `country-block c-${b.country}`;
    el.style.left = x + 'px';
    el.style.width = w + 'px';
    el.dataset.id = b.id;

    const inner = document.createElement('div');
    inner.className = 'country-block-inner';
    inner.innerHTML = `<span class="block-name">${COUNTRY_FLAGS[b.country] || ''} ${b.country}</span>
      <span class="block-dates">${b.start} → ${b.end}</span>`;
    el.appendChild(inner);

    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'resize-handle';
    el.appendChild(resizeHandle);

    const delBtn = document.createElement('button');
    delBtn.className = 'block-delete owner-only';
    delBtn.innerHTML = '×';
    delBtn.addEventListener('click', ev => {
      ev.stopPropagation();
      blocks = blocks.filter(x => x.id !== b.id);
      store.set('blocks', blocks);
      renderTimeline();
      renderCalendar();
    });
    el.appendChild(delBtn);

    // Click to show country page
    el.addEventListener('click', () => showCountryPage(b.country, 'timeline'));

    // Drag to move
    makeDraggable(el, b, start, totalDays);
    makeResizable(resizeHandle, el, b, start, totalDays);

    blocksEl.appendChild(el);
  });
}

function makeDraggable(el, block, tripStart, totalDays) {
  let startMouseX, startLeft, origStart;

  el.addEventListener('mousedown', e => {
    if (!personalUnlocked) return;
    if (e.target.classList.contains('resize-handle') || e.target.classList.contains('block-delete')) return;
    e.preventDefault();
    el.classList.add('dragging');
    startMouseX = e.clientX;
    startLeft = parseInt(el.style.left);
    origStart = block.start;

    const onMove = e => {
      const dx = e.clientX - startMouseX;
      const newLeft = Math.max(0, Math.min(startLeft + dx, (totalDays - daysBetween(block.start, block.end)) * DAY_W));
      el.style.left = newLeft + 'px';
      const newDay = Math.round(newLeft / DAY_W);
      const dur = daysBetween(block.start, block.end);
      block.start = addDays(tripStart, newDay);
      block.end = addDays(block.start, dur);
      el.querySelector('.block-dates').textContent = `${block.start} → ${block.end}`;
    };

    const onUp = () => {
      el.classList.remove('dragging');
      store.set('blocks', blocks);
      renderTimeline();
      renderCalendar();
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function makeResizable(handle, el, block, tripStart, totalDays) {
  handle.addEventListener('mousedown', e => {
    if (!personalUnlocked) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = parseInt(el.style.width);

    const onMove = e => {
      const dx = e.clientX - startX;
      const newW = Math.max(DAY_W, startW + dx);
      el.style.width = newW + 'px';
      const newDur = Math.round(newW / DAY_W);
      block.end = addDays(block.start, newDur);
      el.querySelector('.block-dates').textContent = `${block.start} → ${block.end}`;
    };

    const onUp = () => {
      store.set('blocks', blocks);
      renderTimeline();
      renderCalendar();
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// Add country
document.getElementById('addCountryBtn').addEventListener('click', () => {
  const { start } = getTripBounds();
  document.getElementById('newStart').value = start;
  document.getElementById('newEnd').value = addDays(start, 14);
  document.getElementById('addCountryModal').style.display = 'flex';
});
document.getElementById('cancelCountry').addEventListener('click', () => {
  document.getElementById('addCountryModal').style.display = 'none';
});
document.getElementById('confirmCountry').addEventListener('click', () => {
  const country = document.getElementById('newCountry').value.trim();
  const start = document.getElementById('newStart').value;
  const end = document.getElementById('newEnd').value;
  if (!country || !start || !end || end <= start) return;
  blocks.push({ id: Date.now(), country, start, end });
  store.set('blocks', blocks);
  document.getElementById('addCountryModal').style.display = 'none';
  document.getElementById('newCountry').value = '';
  renderTimeline();
  renderCalendar();
});

document.getElementById('tripStart').addEventListener('change', () => {
  store.set('tripStart', document.getElementById('tripStart').value);
  renderTimeline(); renderCalendar();
});
document.getElementById('tripEnd').addEventListener('change', () => {
  store.set('tripEnd', document.getElementById('tripEnd').value);
  renderTimeline(); renderCalendar();
});

// ─── Calendar ────────────────────────────────────────────────────────────────
// Assign stable colors to each block id (cycles through palette)
const CAL_PALETTE = [
  '#f76a8c','#6af7c0','#f7c26a','#6ab5f7','#c26af7',
  '#f7826a','#6af7a0','#f76ab5','#6acef7','#a0f76a',
];
function getBlockColor(blockId) {
  const idx = blocks.findIndex(b => b.id === blockId);
  return CAL_PALETTE[idx % CAL_PALETTE.length];
}

function renderCalendar() {
  const { start, end } = getTripBounds();
  const container = document.getElementById('calendarSection');
  container.innerHTML = '';

  const startD = parseDate(start);
  const endD = parseDate(end);

  // Walk month by month
  let cur = new Date(startD.getFullYear(), startD.getMonth(), 1);
  while (cur <= endD) {
    const year = cur.getFullYear();
    const month = cur.getMonth();
    const monthLabel = cur.toLocaleDateString('en', { month: 'long', year: 'numeric' });

    const monthEl = document.createElement('div');
    monthEl.className = 'cal-month';

    const header = document.createElement('div');
    header.className = 'cal-month-title';
    header.textContent = monthLabel;
    monthEl.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'cal-grid';

    // Day-of-week headers
    ['Su','Mo','Tu','We','Th','Fr','Sa'].forEach(d => {
      const h = document.createElement('div');
      h.className = 'cal-dow';
      h.textContent = d;
      grid.appendChild(h);
    });

    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    // Empty cells before first day
    for (let i = 0; i < firstDay; i++) {
      grid.appendChild(Object.assign(document.createElement('div'), { className: 'cal-day cal-day-empty' }));
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = fmtDate(new Date(year, month, d));
      const dayD = parseDate(dateStr);

      // Find which block this day falls in
      const block = blocks.find(b => dateStr >= b.start && dateStr < b.end);

      const cell = document.createElement('div');
      cell.className = 'cal-day';

      if (dayD < startD || dayD >= endD) {
        cell.classList.add('cal-day-outside');
      } else if (block) {
        cell.classList.add('cal-day-active');
        cell.style.background = getBlockColor(block.id) + '33'; // translucent fill
        cell.style.borderColor = getBlockColor(block.id);
        cell.title = block.country;
        cell.addEventListener('click', () => showCountryPage(block.country, 'timeline'));
      }

      cell.innerHTML = `<span class="cal-day-num">${d}</span>
        ${block ? `<span class="cal-day-country">${COUNTRY_FLAGS[block.country] || '🌍'}</span>` : ''}`;
      grid.appendChild(cell);
    }

    monthEl.appendChild(grid);
    container.appendChild(monthEl);
    cur = new Date(year, month + 1, 1);
  }
}

// ─── Country page navigation ─────────────────────────────────────────────────
let currentCountryPage = null;
let cpBackPage = 'timeline';

function navigateTo(pageId) {
  document.querySelectorAll('.nav-link, .nav-dropdown-trigger').forEach(l => l.classList.remove('active'));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + pageId)?.classList.add('active');
  // Highlight correct nav item
  const link = document.querySelector(`.nav-link[data-page="${pageId}"], .nav-dropdown-item[data-page="${pageId}"]`);
  if (link) {
    link.classList.add('active');
    // If inside a dropdown, also highlight the trigger
    const trigger = link.closest('.nav-dropdown')?.querySelector('.nav-dropdown-trigger');
    if (trigger) trigger.classList.add('active');
  }
  // Close any open dropdowns
  document.querySelectorAll('.nav-dropdown').forEach(d => d.classList.remove('open'));
  if (pageId === 'places') setTimeout(() => map && map.invalidateSize(), 100);
  if (pageId === 'personal') {
    if (!personalUnlocked) {
      document.getElementById('personalLock').style.display = 'flex';
      document.getElementById('personalContent').style.display = 'none';
      initLock();
    }
  }
}

function showCountryPage(country, fromPage) {
  cpBackPage = fromPage || 'timeline';
  currentCountryPage = country;

  // Header
  const block = blocks.find(b => b.country === country);
  document.getElementById('countryPageTitle').textContent = `${COUNTRY_FLAGS[country] || '🌍'} ${country}`;
  document.getElementById('countryPageDates').textContent = block ? `${block.start} → ${block.end}` : '';

  // Activate first tab
  document.querySelectorAll('.cpTab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.cp-panel').forEach(p => p.classList.remove('active'));
  document.querySelector('.cpTab[data-tab="cp-places"]').classList.add('active');
  document.getElementById('cp-places').classList.add('active');

  renderCpPlaces(country);
  renderCpPhotos(country);
  renderCpNotes(country);

  navigateTo('country');
}

document.getElementById('backFromCountry').addEventListener('click', () => navigateTo(cpBackPage));

document.querySelectorAll('.cpTab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.cpTab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.cp-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.tab).classList.add('active');
  });
});

// Places tab
function renderCpPlaces(country) {
  const places = store.get('places', []).filter(p => p.country === country);
  const list = document.getElementById('cpPlacesList');
  list.innerHTML = '';
  if (!places.length) {
    list.innerHTML = `<p class="cp-empty">No places saved for ${country} yet — add some below or in the Places tab.</p>`;
    return;
  }
  places.forEach(p => {
    const card = document.createElement('div');
    card.className = 'cp-place-card';
    card.innerHTML = `
      <div class="cp-place-top">
        <span class="cp-place-icon">${TYPE_ICONS[p.type] || '📍'}</span>
        <div class="cp-place-info">
          <div class="cp-place-name">${p.name}</div>
          ${p.city ? `<div class="cp-place-city">${p.city}</div>` : ''}
          ${p.notes ? `<div class="cp-place-notes">${p.notes}</div>` : ''}
        </div>
        <div class="cp-place-right">
          <span class="badge badge-type-${p.type}">${p.type}</span>
          <span class="badge badge-cost-${p.cost}">${p.cost}</span>
          ${p.link ? `<a class="cp-map-link" href="${p.link}" target="_blank">map ↗</a>` : ''}
        </div>
      </div>
    `;
    list.appendChild(card);
  });
}

document.getElementById('cpAddPlaceBtn').addEventListener('click', () => {
  // Pre-fill country in add place modal and open it
  document.getElementById('placeCountry').value = currentCountryPage || '';
  document.getElementById('addPlaceModal').style.display = 'flex';
  // After saving, go back to country page
  window._cpAddingForCountry = true;
});

// Photos tab
function renderCpPhotos(country) {
  const photos = store.get('photos_' + country, []);
  const grid = document.getElementById('cpPhotosGrid');
  grid.innerHTML = '';
  photos.forEach((src, idx) => {
    const wrap = document.createElement('div');
    wrap.className = 'cp-photo-wrap';
    wrap.innerHTML = `<img src="${src}" class="cp-photo-img"><button class="cp-photo-del" data-idx="${idx}">×</button>`;
    wrap.querySelector('.cp-photo-img').addEventListener('click', () => openLightbox(photos, idx));
    wrap.querySelector('.cp-photo-del').addEventListener('click', () => {
      const updated = store.get('photos_' + country, []);
      updated.splice(idx, 1);
      store.set('photos_' + country, updated);
      renderCpPhotos(country);
    });
    grid.appendChild(wrap);
  });
  if (!photos.length) {
    grid.innerHTML = `<p class="cp-empty">No photos yet — upload some memories!</p>`;
  }
}

document.getElementById('cpPhotoUpload').addEventListener('change', async e => {
  const files = Array.from(e.target.files);
  const country = currentCountryPage;
  for (const file of files) {
    const url = await uploadPhoto(file, `photos/${country}`);
    const photos = store.get('photos_' + country, []);
    photos.push(url);
    store.set('photos_' + country, photos);
  }
  renderCpPhotos(country);
  e.target.value = '';
});

// Lightbox
function openLightbox(photos, idx) {
  let cur = idx;
  const overlay = document.createElement('div');
  overlay.className = 'lightbox-overlay';
  const render = () => {
    overlay.innerHTML = `
      <div class="lightbox-inner">
        <button class="lightbox-close">×</button>
        <button class="lightbox-prev">‹</button>
        <img src="${photos[cur]}" class="lightbox-img">
        <button class="lightbox-next">›</button>
        <div class="lightbox-counter">${cur + 1} / ${photos.length}</div>
      </div>`;
    overlay.querySelector('.lightbox-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('.lightbox-prev').addEventListener('click', e => { e.stopPropagation(); cur = (cur - 1 + photos.length) % photos.length; render(); });
    overlay.querySelector('.lightbox-next').addEventListener('click', e => { e.stopPropagation(); cur = (cur + 1) % photos.length; render(); });
  };
  render();
  document.body.appendChild(overlay);
}

// Notes tab
function renderCpNotes(country) {
  const notes = store.get('notes_' + country, '');
  document.getElementById('cpNotesArea').value = notes;
  document.getElementById('cpNotesSaved').textContent = '';
}

document.getElementById('cpSaveNotes').addEventListener('click', () => {
  store.set('notes_' + currentCountryPage, document.getElementById('cpNotesArea').value);
  const saved = document.getElementById('cpNotesSaved');
  saved.textContent = 'Saved ✓';
  setTimeout(() => saved.textContent = '', 2000);
});

// Countries list page
function renderCountriesList() {
  const grid = document.getElementById('countriesGrid');
  grid.innerHTML = '';
  const allCountries = [...new Set(blocks.map(b => b.country))];
  const placesData = store.get('places', []);

  if (!allCountries.length) {
    grid.innerHTML = `<p style="color:var(--text-muted)">Add countries to your timeline first.</p>`;
    return;
  }

  allCountries.forEach(country => {
    const block = blocks.find(b => b.country === country);
    const places = placesData.filter(p => p.country === country);
    const photos = store.get('photos_' + country, []);
    const notes = store.get('notes_' + country, '');
    const dur = block ? daysBetween(block.start, block.end) : null;

    const card = document.createElement('div');
    card.className = `country-card c-border-${country.replace(/\s/g,'-')}`;
    card.innerHTML = `
      <div class="country-card-flag">${COUNTRY_FLAGS[country] || '🌍'}</div>
      <div class="country-card-body">
        <div class="country-card-name">${country}</div>
        ${block ? `<div class="country-card-dates">${block.start} → ${block.end} · ${dur} days</div>` : ''}
        <div class="country-card-stats">
          <span>📍 ${places.length} places</span>
          <span>📷 ${photos.length} photos</span>
          <span>📝 ${notes ? 'notes' : 'no notes'}</span>
        </div>
        ${photos.length ? `<div class="country-card-preview">${photos.slice(0,3).map(s=>`<img src="${s}">`).join('')}</div>` : ''}
      </div>
    `;
    card.addEventListener('click', () => showCountryPage(country, 'countries'));
    grid.appendChild(card);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// PLACES
// ═══════════════════════════════════════════════════════════════════════════
let map = null;
let mapMarkers = [];

function initMap() {
  if (map) return;
  map = L.map('placesMap', { zoomControl: true }).setView([10, 105], 4);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap © CartoDB',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map);
}

function renderPlaces() {
  initMap();
  const places = store.get('places', []);
  const filterCountry = document.getElementById('filterCountry').value;
  const filterType = document.getElementById('filterType').value;
  const filterCost = document.getElementById('filterCost').value;

  const filtered = places.filter(p =>
    (!filterCountry || p.country === filterCountry) &&
    (!filterType || p.type === filterType) &&
    (!filterCost || p.cost === filterCost)
  );

  // Update country filter options
  const countries = [...new Set(places.map(p => p.country))];
  const fc = document.getElementById('filterCountry');
  const prevVal = fc.value;
  fc.innerHTML = '<option value="">All Countries</option>';
  countries.forEach(c => fc.innerHTML += `<option value="${c}">${COUNTRY_FLAGS[c] || ''} ${c}</option>`);
  fc.value = prevVal;

  // Group by country
  const byCountry = {};
  filtered.forEach(p => { (byCountry[p.country] = byCountry[p.country] || []).push(p); });

  const list = document.getElementById('placesList');
  list.innerHTML = '';
  Object.keys(byCountry).sort().forEach(country => {
    const group = document.createElement('div');
    group.className = 'country-group';
    group.innerHTML = `<div class="country-group-header">${COUNTRY_FLAGS[country] || ''} ${country} (${byCountry[country].length})</div>`;
    byCountry[country].forEach(p => {
      const card = document.createElement('div');
      card.className = 'place-card';
      card.innerHTML = `
        <div class="place-card-top">
          <div class="place-name">${TYPE_ICONS[p.type] || '📍'} ${p.name}</div>
          <div style="display:flex;gap:6px;align-items:center">
            <div class="place-badges">
              <span class="badge badge-type-${p.type}">${p.type}</span>
              <span class="badge badge-cost-${p.cost}">${p.cost}</span>
            </div>
            <button class="place-delete owner-only" data-id="${p.id}">×</button>
          </div>
        </div>
        ${p.city ? `<div class="place-city">📍 ${p.city}</div>` : ''}
        ${p.notes ? `<div class="place-notes">${p.notes}</div>` : ''}
        ${p.link ? `<div class="place-link"><a href="${p.link}" target="_blank">Open in Google Maps ↗</a></div>` : ''}
      `;
      group.appendChild(card);
    });
    list.appendChild(group);
  });

  list.querySelectorAll('.place-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const places = store.get('places', []).filter(p => p.id != btn.dataset.id);
      store.set('places', places);
      renderPlaces();
    });
  });

  // Map markers
  mapMarkers.forEach(m => m.remove());
  mapMarkers = [];
  filtered.forEach(p => {
    const coords = p.coords || COUNTRY_COORDS[p.country];
    if (!coords) return;
    const icon = L.divIcon({
      html: `<div style="background:var(--accent);width:10px;height:10px;border-radius:50%;border:2px solid #fff;"></div>`,
      className: '',
      iconSize: [10, 10],
    });
    const marker = L.marker(coords, { icon })
      .addTo(map)
      .bindPopup(`<strong>${p.name}</strong><br>${p.country}${p.city ? ', ' + p.city : ''}<br>${p.type} · ${p.cost}`);
    mapMarkers.push(marker);
  });
}

document.getElementById('filterCountry').addEventListener('change', renderPlaces);
document.getElementById('filterType').addEventListener('change', renderPlaces);
document.getElementById('filterCost').addEventListener('change', renderPlaces);

document.getElementById('addPlaceBtn').addEventListener('click', () => {
  document.getElementById('addPlaceModal').style.display = 'flex';
});
document.getElementById('cancelPlace').addEventListener('click', () => {
  document.getElementById('addPlaceModal').style.display = 'none';
});
document.getElementById('confirmPlace').addEventListener('click', () => {
  const name = document.getElementById('placeName').value.trim();
  if (!name) return;
  const place = {
    id: Date.now(),
    name,
    country: document.getElementById('placeCountry').value.trim(),
    type: document.getElementById('placeType').value,
    cost: document.getElementById('placeCost').value,
    city: document.getElementById('placeCity').value.trim(),
    link: document.getElementById('placeLink').value.trim(),
    notes: document.getElementById('placeNotes').value.trim(),
  };
  const places = store.get('places', []);
  places.push(place);
  store.set('places', places);
  document.getElementById('addPlaceModal').style.display = 'none';
  document.getElementById('placeName').value = '';
  document.getElementById('placeCity').value = '';
  document.getElementById('placeLink').value = '';
  document.getElementById('placeNotes').value = '';
  if (window._cpAddingForCountry) {
    window._cpAddingForCountry = false;
    renderCpPlaces(currentCountryPage);
  } else {
    renderPlaces();
  }
});

// CSV import from Google Maps export
document.getElementById('importCSV').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const lines = ev.target.result.split('\n').filter(Boolean);
    const places = store.get('places', []);
    let added = 0;
    lines.slice(1).forEach(line => {
      const cols = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
      if (!cols[0]) return;
      places.push({
        id: Date.now() + Math.random(),
        name: cols[0] || 'Unnamed',
        country: cols[2] || 'Thailand',
        type: 'other',
        cost: '$',
        city: cols[1] || '',
        link: cols[3] || '',
        notes: cols[4] || '',
      });
      added++;
    });
    store.set('places', places);
    renderPlaces();
    alert(`Imported ${added} places!`);
  };
  reader.readAsText(file);
  e.target.value = '';
});

// ═══════════════════════════════════════════════════════════════════════════
// PERSONAL / LOCK
// ═══════════════════════════════════════════════════════════════════════════
let personalUnlocked = false;

async function initLock() {
  document.getElementById('lockSub').textContent = 'Your private space';
  document.getElementById('lockSubmit').textContent = 'Unlock';
}

document.getElementById('lockSubmit').addEventListener('click', async () => {
  const val = document.getElementById('lockInput').value;
  if (!val) return;
  const entered = await sha256(val);
  if (entered === OWNER_PW_HASH) {
    unlockPersonal();
  } else {
    document.getElementById('lockError').textContent = 'Wrong password';
    document.getElementById('lockInput').value = '';
    setTimeout(() => document.getElementById('lockError').textContent = '', 2500);
  }
});

document.getElementById('lockInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('lockSubmit').click();
});

document.getElementById('showSetPassword').addEventListener('click', () => {
  alert('To change the password, update OWNER_PW_HASH in app.js with the SHA-256 of your new password.');
});

function unlockPersonal() {
  personalUnlocked = true;
  document.getElementById('lockInput').value = '';
  document.getElementById('lockError').textContent = '';
  document.getElementById('personalLock').style.display = 'none';
  document.getElementById('personalContent').style.display = 'block';
  renderBudget();
  renderPacking();
  updateOutfitDisplay();
  renderWardrobeGrid();
  renderSavedOutfits();
  renderPsDashboard();
}

document.getElementById('lockAgainBtn').addEventListener('click', () => {
  personalUnlocked = false;
  document.getElementById('personalContent').style.display = 'none';
  document.getElementById('personalLock').style.display = 'flex';
  document.getElementById('lockInput').value = '';
  navigateTo('timeline');
});

// Personal sub-nav
document.querySelectorAll('.psnav-btn[data-pspage]').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.id === 'lockAgainBtn') return;
    document.querySelectorAll('.psnav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.ps-page').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.pspage).classList.add('active');
  });
});

// ── Personal dashboard ───────────────────────────────────────────────────────
function renderPsDashboard() {
  const expenses = store.get('expenses', []);
  const totalCAD = expenses.reduce((s, e) => s + toCAD(parseFloat(e.amount) || 0, e.currency || 'CAD'), 0);
  const dates = [...new Set(expenses.map(e => e.date))];
  const avgDay = dates.length ? totalCAD / dates.length : 0;
  const items = store.get('packing', DEFAULT_PACKING);
  const pct = items.length ? Math.round(items.filter(i => i.checked).length / items.length * 100) : 0;

  document.getElementById('psDashTotal').textContent = fmtCAD(totalCAD);
  document.getElementById('psDashAvg').textContent = fmtCAD(avgDay);
  document.getElementById('psDashPacking').textContent = pct + '%';
  document.getElementById('psDashCountries').textContent = blocks.length;

  renderPsLinks();
  renderAccessList();
  initSheetUI();
  refreshOwnerControls();
}

// ── Quick links ──────────────────────────────────────────────────────────────
function renderPsLinks() {
  const links = store.get('psLinks', []);
  const grid = document.getElementById('psLinksGrid');
  grid.innerHTML = '';
  if (!links.length) {
    grid.innerHTML = `<p class="ps-links-empty">Add links to your Google Drive, spreadsheets, or anything useful.</p>`;
    return;
  }
  links.forEach((link, i) => {
    const card = document.createElement('a');
    card.className = 'ps-link-card';
    card.href = link.url;
    card.target = '_blank';
    card.rel = 'noopener';
    card.innerHTML = `
      <span class="ps-link-icon">${link.icon || '🔗'}</span>
      <span class="ps-link-label">${link.label}</span>
      <button class="ps-link-del" data-i="${i}">×</button>
    `;
    card.querySelector('.ps-link-del').addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      const links = store.get('psLinks', []);
      links.splice(i, 1);
      store.set('psLinks', links);
      renderPsLinks();
    });
    grid.appendChild(card);
  });
}

document.getElementById('addLinkBtn').addEventListener('click', () => {
  document.getElementById('addLinkModal').style.display = 'flex';
});
document.getElementById('cancelLink').addEventListener('click', () => {
  document.getElementById('addLinkModal').style.display = 'none';
});
document.getElementById('confirmLink').addEventListener('click', () => {
  const label = document.getElementById('linkLabel').value.trim();
  const url = document.getElementById('linkUrl').value.trim();
  const icon = document.getElementById('linkIcon').value.trim() || '🔗';
  if (!label || !url) return;
  const links = store.get('psLinks', []);
  links.push({ label, url, icon });
  store.set('psLinks', links);
  document.getElementById('addLinkModal').style.display = 'none';
  document.getElementById('linkLabel').value = '';
  document.getElementById('linkUrl').value = '';
  document.getElementById('linkIcon').value = '🔗';
  renderPsLinks();
});

// ── Google Sheets connection ─────────────────────────────────────────────────
function initSheetUI() {
  const saved = store.get('sheetURL', '');
  document.getElementById('sheetURL').value = saved;
  if (saved) updateSheetStatus(saved);
}

async function fetchAndPreviewSheet(url) {
  const statusEl = document.getElementById('sheetStatus');
  const previewEl = document.getElementById('sheetPreview');
  statusEl.textContent = 'Fetching...';
  statusEl.className = 'sheet-status';
  previewEl.innerHTML = '';
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    const rows = text.split('\n').map(l => l.split(',').map(c => c.replace(/^"|"$/g,'').trim())).filter(r => r[0]);
    if (rows.length <= 1) { statusEl.textContent = '⚠ Sheet appears empty'; statusEl.className = 'sheet-status warn'; return; }
    // Cache it
    const entries = rows.slice(1).filter(r => r[1]).map(r => ({ name: r[0], value: r[1] }));
    localStorage.setItem('sea_sheetCache', JSON.stringify(entries));
    localStorage.setItem('sea_sheetCachedAt', Date.now().toString());
    statusEl.textContent = `✓ Connected · ${entries.length} people`;
    statusEl.className = 'sheet-status ok';
    // Show preview table
    previewEl.innerHTML = `<table class="sheet-table">
      <thead><tr><th>Name</th><th>Email / Phone</th></tr></thead>
      <tbody>${entries.map(e => `<tr><td>${e.name}</td><td>${e.value}</td></tr>`).join('')}</tbody>
    </table>`;
  } catch(e) {
    statusEl.textContent = '✗ Could not fetch — check the URL';
    statusEl.className = 'sheet-status err';
  }
}

function updateSheetStatus(url) {
  const cached = localStorage.getItem('sea_sheetCache');
  const cachedAt = parseInt(localStorage.getItem('sea_sheetCachedAt') || '0');
  const statusEl = document.getElementById('sheetStatus');
  const previewEl = document.getElementById('sheetPreview');
  if (cached) {
    const entries = JSON.parse(cached);
    const mins = Math.round((Date.now() - cachedAt) / 60000);
    statusEl.textContent = `✓ ${entries.length} people · cached ${mins}m ago`;
    statusEl.className = 'sheet-status ok';
    previewEl.innerHTML = `<table class="sheet-table">
      <thead><tr><th>Name</th><th>Email / Phone</th></tr></thead>
      <tbody>${entries.map(e => `<tr><td>${e.name}</td><td>${e.value}</td></tr>`).join('')}</tbody>
    </table>`;
  } else {
    statusEl.textContent = 'Not fetched yet — click Test';
    statusEl.className = 'sheet-status';
  }
}

document.getElementById('saveSheetURL').addEventListener('click', () => {
  const url = document.getElementById('sheetURL').value.trim();
  store.set('sheetURL', url);
  if (url) fetchAndPreviewSheet(url);
  else {
    document.getElementById('sheetStatus').textContent = 'Cleared';
    document.getElementById('sheetPreview').innerHTML = '';
    localStorage.removeItem('sea_sheetCache');
  }
});
document.getElementById('testSheetURL').addEventListener('click', () => {
  const url = document.getElementById('sheetURL').value.trim();
  if (url) fetchAndPreviewSheet(url);
});

// ── Access list management ───────────────────────────────────────────────────
function renderAccessList() {
  const list = store.get('accessList', []);
  const grid = document.getElementById('accessListGrid');
  grid.innerHTML = '';
  if (!list.length) {
    grid.innerHTML = `<p class="ps-links-empty">No one added yet. Add people so they can enter the site.</p>`;
    return;
  }
  list.forEach((entry, i) => {
    const row = document.createElement('div');
    row.className = 'access-row';
    row.innerHTML = `
      <span class="access-name">${entry.name}</span>
      <span class="access-value">${entry.value}</span>
      <button class="access-del" data-i="${i}">×</button>
    `;
    row.querySelector('.access-del').addEventListener('click', () => {
      const list = store.get('accessList', []);
      list.splice(i, 1);
      store.set('accessList', list);
      renderAccessList();
    });
    grid.appendChild(row);
  });
}

document.getElementById('addAccessBtn').addEventListener('click', () => {
  document.getElementById('addAccessModal').style.display = 'flex';
});
document.getElementById('cancelAccess').addEventListener('click', () => {
  document.getElementById('addAccessModal').style.display = 'none';
});
document.getElementById('confirmAccess').addEventListener('click', () => {
  const name = document.getElementById('accessName').value.trim();
  const value = document.getElementById('accessValue').value.trim();
  if (!name || !value) return;
  const list = store.get('accessList', []);
  list.push({ name, value });
  store.set('accessList', list);
  document.getElementById('addAccessModal').style.display = 'none';
  document.getElementById('accessName').value = '';
  document.getElementById('accessValue').value = '';
  renderAccessList();
});

// ═══════════════════════════════════════════════════════════════════════════
// BUDGET
// ═══════════════════════════════════════════════════════════════════════════
function renderBudget() {
  const expenses = store.get('expenses', []);

  // Convert every entry using its own stored currency
  const totalCAD = expenses.reduce((s, e) => s + toCAD(parseFloat(e.amount) || 0, e.currency || 'CAD'), 0);
  const dates = [...new Set(expenses.map(e => e.date))];
  const countries = [...new Set(expenses.map(e => e.country).filter(Boolean))];
  const avgDayCAD = dates.length ? totalCAD / dates.length : 0;

  document.getElementById('statTotalCAD').textContent = fmtCAD(totalCAD);
  document.getElementById('statAvgDay').textContent = fmtCAD(avgDayCAD);
  document.getElementById('statDays').textContent = dates.length;
  document.getElementById('statCountries').textContent = countries.length;

  // Per-country breakdown (in CAD)
  const byCountry = {};
  expenses.forEach(e => {
    const c = e.country || 'Unknown';
    byCountry[c] = (byCountry[c] || 0) + toCAD(parseFloat(e.amount) || 0, e.currency || 'CAD');
  });
  const totalCADForPct = Object.values(byCountry).reduce((a, b) => a + b, 0);
  const breakdown = document.getElementById('countryBreakdown');
  breakdown.innerHTML = '';
  if (totalCADForPct > 0) {
    Object.entries(byCountry).sort((a, b) => b[1] - a[1]).forEach(([c, amt]) => {
      const pct = (amt / totalCADForPct) * 100;
      breakdown.innerHTML += `
        <div class="country-stat-row">
          <div class="country-stat-name">${COUNTRY_FLAGS[c] || '🌍'} ${c}</div>
          <div class="country-stat-bar-wrap"><div class="country-stat-bar" style="width:${pct}%"></div></div>
          <div class="country-stat-amount">${fmtCAD(amt)}</div>
        </div>`;
    });
  }

  // Expense list
  const list = document.getElementById('expenseList');
  list.innerHTML = '';
  [...expenses].reverse().forEach(e => {
    const cur = e.currency || 'CAD';
    const sym = CURRENCY_SYMBOLS[cur] || cur + ' ';
    const row = document.createElement('div');
    row.className = 'expense-item';
    row.innerHTML = `
      <span class="expense-date">${e.date}</span>
      <span class="expense-desc">${e.desc}</span>
      <span class="expense-country">${COUNTRY_FLAGS[e.country] || '🌍'} ${e.country || ''}</span>
      <span class="expense-cat">${e.category}</span>
      <span class="expense-amount">${sym}${parseFloat(e.amount).toFixed(2)}</span>
      <span class="expense-amount-cad">${fmtCAD(toCAD(parseFloat(e.amount) || 0, cur))}</span>
      <button class="expense-delete" data-id="${e.id}">×</button>
    `;
    list.appendChild(row);
  });
  list.querySelectorAll('.expense-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const expenses = store.get('expenses', []).filter(e => e.id != btn.dataset.id);
      store.set('expenses', expenses);
      renderBudget();
    });
  });
}

// Default date to today
document.getElementById('expDate').value = new Date().toISOString().slice(0, 10);

document.getElementById('addExpense').addEventListener('click', () => {
  const date = document.getElementById('expDate').value;
  const desc = document.getElementById('expDesc').value.trim();
  const amount = document.getElementById('expAmount').value;
  const country = document.getElementById('expCountry').value.trim();
  if (!desc || !amount || !date) return;
  const expenses = store.get('expenses', []);
  expenses.push({
    id: Date.now(),
    date,
    desc,
    country,
    category: document.getElementById('expCategory').value,
    amount: parseFloat(amount),
    currency: document.getElementById('expCurrency').value,
  });
  store.set('expenses', expenses);
  document.getElementById('expDesc').value = '';
  document.getElementById('expAmount').value = '';
  renderBudget();
});

// ═══════════════════════════════════════════════════════════════════════════
// PACKING
// ═══════════════════════════════════════════════════════════════════════════
const DEFAULT_PACKING = [
  { id: 1, text: 'Passport + copies', category: 'documents', checked: false },
  { id: 2, text: 'Travel insurance docs', category: 'documents', checked: false },
  { id: 3, text: 'Visa paperwork', category: 'documents', checked: false },
  { id: 4, text: 'Credit / debit cards', category: 'documents', checked: false },
  { id: 5, text: 'Lightweight t-shirts (×5)', category: 'clothing', checked: false },
  { id: 6, text: 'Quick-dry shorts (×3)', category: 'clothing', checked: false },
  { id: 7, text: 'Packable rain jacket', category: 'clothing', checked: false },
  { id: 8, text: 'Temple cover-up / sarong', category: 'clothing', checked: false },
  { id: 9, text: 'Sandals (Tevas / Birkenstocks)', category: 'clothing', checked: false },
  { id: 10, text: 'Sneakers', category: 'clothing', checked: false },
  { id: 11, text: 'Sunscreen SPF 50+', category: 'toiletries', checked: false },
  { id: 12, text: 'DEET insect repellent', category: 'toiletries', checked: false },
  { id: 13, text: 'Travel-size shampoo/conditioner', category: 'toiletries', checked: false },
  { id: 14, text: 'Malaria / Hep A & B meds', category: 'health', checked: false },
  { id: 15, text: 'Imodium + Pepto', category: 'health', checked: false },
  { id: 16, text: 'First-aid kit', category: 'health', checked: false },
  { id: 17, text: 'Phone + charger', category: 'electronics', checked: false },
  { id: 18, text: 'Universal adapter', category: 'electronics', checked: false },
  { id: 19, text: 'Portable power bank', category: 'electronics', checked: false },
  { id: 20, text: 'Headphones / earbuds', category: 'electronics', checked: false },
  { id: 21, text: 'Daypack / small backpack', category: 'gear', checked: false },
  { id: 22, text: 'Padlock for lockers', category: 'gear', checked: false },
  { id: 23, text: 'Quick-dry towel', category: 'gear', checked: false },
  { id: 24, text: 'Water bottle', category: 'gear', checked: false },
];

function getPackingItems() {
  return store.get('packing', DEFAULT_PACKING);
}

function renderPacking() {
  const items = getPackingItems();
  const categories = [...new Set(items.map(i => i.category))];
  const checked = items.filter(i => i.checked).length;

  const pct = items.length ? (checked / items.length) * 100 : 0;
  document.getElementById('progressBar').style.width = pct + '%';
  document.getElementById('progressText').textContent = `${checked} / ${items.length} packed`;

  const CAT_LABELS = {
    clothing:'👕 Clothing', toiletries:'🧴 Toiletries', electronics:'🔌 Electronics',
    documents:'📄 Documents', health:'💊 Health / Meds', gear:'🎒 Gear / Outdoor', misc:'📦 Misc',
  };

  const container = document.getElementById('packingCategories');
  container.innerHTML = '';

  categories.forEach(cat => {
    const catItems = items.filter(i => i.category === cat);
    const catChecked = catItems.filter(i => i.checked).length;
    const card = document.createElement('div');
    card.className = 'packing-cat-card';
    card.innerHTML = `
      <div class="packing-cat-header">
        <span class="packing-cat-title">${CAT_LABELS[cat] || cat}</span>
        <span class="packing-cat-count">${catChecked}/${catItems.length}</span>
      </div>
      <div class="packing-items"></div>
    `;
    const itemsEl = card.querySelector('.packing-items');
    catItems.forEach(item => {
      const row = document.createElement('div');
      row.className = 'packing-item' + (item.checked ? ' checked' : '');
      row.innerHTML = `
        <div class="packing-check"></div>
        <span class="item-text">${item.text}</span>
        <button class="item-delete" data-id="${item.id}">×</button>
      `;
      row.addEventListener('click', e => {
        if (e.target.classList.contains('item-delete')) return;
        const items = getPackingItems();
        const found = items.find(i => i.id === item.id);
        if (found) found.checked = !found.checked;
        store.set('packing', items);
        renderPacking();
      });
      row.querySelector('.item-delete').addEventListener('click', () => {
        const items = getPackingItems().filter(i => i.id !== item.id);
        store.set('packing', items);
        renderPacking();
      });
      itemsEl.appendChild(row);
    });
    container.appendChild(card);
  });
}

document.getElementById('addPackingItem').addEventListener('click', () => {
  const text = document.getElementById('newItemText').value.trim();
  if (!text) return;
  const items = getPackingItems();
  items.push({
    id: Date.now(),
    text,
    category: document.getElementById('newItemCategory').value,
    checked: false,
  });
  store.set('packing', items);
  document.getElementById('newItemText').value = '';
  renderPacking();
});
document.getElementById('newItemText').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('addPackingItem').click();
});

// ═══════════════════════════════════════════════════════════════════════════
// OUTFITS
// ═══════════════════════════════════════════════════════════════════════════
let currentSlot = 'top';
const slotIndices = { hat: 0, top: 0, bottom: 0, shoes: 0, bag: 0 };

function getWardrobe() { return store.get('wardrobe', { hat: [], top: [], bottom: [], shoes: [], bag: [] }); }
function getSavedOutfits() { return store.get('savedOutfits', []); }

function renderWardrobeGrid() {
  const wardrobe = getWardrobe();
  const items = wardrobe[currentSlot] || [];
  const grid = document.getElementById('wardrobeGrid');
  grid.innerHTML = '';
  items.forEach((src, idx) => {
    const div = document.createElement('div');
    div.className = 'wardrobe-item' + (slotIndices[currentSlot] === idx ? ' selected' : '');
    div.innerHTML = `<img src="${src}"><button class="wardrobe-item-del" data-slot="${currentSlot}" data-idx="${idx}">×</button>`;
    div.addEventListener('click', e => {
      if (e.target.classList.contains('wardrobe-item-del')) return;
      slotIndices[currentSlot] = idx;
      updateOutfitDisplay();
      renderWardrobeGrid();
    });
    div.querySelector('.wardrobe-item-del').addEventListener('click', () => {
      const w = getWardrobe();
      w[currentSlot].splice(idx, 1);
      store.set('wardrobe', w);
      if (slotIndices[currentSlot] >= w[currentSlot].length) slotIndices[currentSlot] = 0;
      updateOutfitDisplay();
      renderWardrobeGrid();
    });
    grid.appendChild(div);
  });
}

function updateOutfitDisplay() {
  const wardrobe = getWardrobe();
  ['hat','top','bottom','shoes','bag'].forEach(slot => {
    const items = wardrobe[slot] || [];
    const idx = slotIndices[slot];
    const display = document.getElementById(slot + 'Display');
    if (items.length && items[idx]) {
      display.innerHTML = `<img src="${items[idx]}">`;
    } else {
      const labels = { hat:'Hat / Head', top:'Top', bottom:'Bottom', shoes:'Shoes', bag:'Bag / Accessories' };
      display.innerHTML = `<span class="slot-empty">${labels[slot]}</span>`;
    }
  });
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentSlot = btn.dataset.slot;
    renderWardrobeGrid();
  });
});

document.querySelectorAll('.slot-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const slot = btn.dataset.slot;
    const dir = parseInt(btn.dataset.dir);
    const wardrobe = getWardrobe();
    const items = wardrobe[slot] || [];
    if (!items.length) return;
    slotIndices[slot] = (slotIndices[slot] + dir + items.length) % items.length;
    updateOutfitDisplay();
    if (currentSlot === slot) renderWardrobeGrid();
  });
});

document.getElementById('uploadClothing').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  const url = await uploadPhoto(file, `wardrobe/${currentSlot}`);
  const w = getWardrobe();
  w[currentSlot] = w[currentSlot] || [];
  w[currentSlot].push(url);
  store.set('wardrobe', w);
  slotIndices[currentSlot] = w[currentSlot].length - 1;
  updateOutfitDisplay();
  renderWardrobeGrid();
  e.target.value = '';
});

document.getElementById('saveOutfit').addEventListener('click', () => {
  const wardrobe = getWardrobe();
  const imgs = ['hat','top','bottom','shoes','bag']
    .map(s => wardrobe[s]?.[slotIndices[s]])
    .filter(Boolean);
  if (!imgs.length) return;
  const name = prompt('Name this outfit:', 'Outfit ' + (getSavedOutfits().length + 1));
  if (!name) return;
  const saved = getSavedOutfits();
  saved.push({ id: Date.now(), name, imgs });
  store.set('savedOutfits', saved);
  renderSavedOutfits();
});

function renderSavedOutfits() {
  const saved = getSavedOutfits();
  const grid = document.getElementById('savedOutfitsGrid');
  grid.innerHTML = '';
  saved.forEach(outfit => {
    const card = document.createElement('div');
    card.className = 'saved-outfit-card';
    const imgHtml = outfit.imgs.map(s => `<img src="${s}">`).join('');
    card.innerHTML = `
      <div class="saved-outfit-title">${outfit.name}</div>
      <div class="saved-outfit-imgs">${imgHtml}</div>
      <button class="saved-outfit-del" data-id="${outfit.id}">Delete</button>
    `;
    card.querySelector('.saved-outfit-del').addEventListener('click', () => {
      const saved = getSavedOutfits().filter(o => o.id !== outfit.id);
      store.set('savedOutfits', saved);
      renderSavedOutfits();
    });
    grid.appendChild(card);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// HERO CAROUSEL
// ═══════════════════════════════════════════════════════════════════════════
let carouselIdx = 0;
let carouselTimer = null;

function getCarouselPhotos() { return store.get('carouselPhotos', []); }

function renderCarousel() {
  const photos = getCarouselPhotos();
  const track = document.getElementById('carouselTrack');
  const dots = document.getElementById('carouselDots');
  const empty = document.getElementById('carouselEmpty');
  const prevBtn = document.getElementById('carouselPrev');
  const nextBtn = document.getElementById('carouselNext');

  if (!photos.length) {
    empty.style.display = 'flex';
    track.style.display = 'none';
    prevBtn.style.display = 'none';
    nextBtn.style.display = 'none';
    dots.innerHTML = '';
    return;
  }

  empty.style.display = 'none';
  track.style.display = 'flex';
  prevBtn.style.display = 'flex';
  nextBtn.style.display = 'flex';

  if (carouselIdx >= photos.length) carouselIdx = 0;

  track.innerHTML = photos.map((src, i) =>
    `<div class="carousel-slide ${i === carouselIdx ? 'active' : ''}" style="background-image:url('${src}')" data-i="${i}">
      ${personalUnlocked ? `<button class="carousel-del-btn" data-i="${i}">×</button>` : ''}
    </div>`
  ).join('');

  track.querySelectorAll('.carousel-slide').forEach(slide => {
    slide.addEventListener('click', e => {
      if (e.target.classList.contains('carousel-del-btn')) return;
      openLightbox(photos, parseInt(slide.dataset.i));
    });
  });

  dots.innerHTML = photos.map((_, i) =>
    `<button class="carousel-dot ${i === carouselIdx ? 'active' : ''}" data-i="${i}"></button>`
  ).join('');

  track.querySelectorAll('.carousel-del-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const photos = getCarouselPhotos();
      photos.splice(parseInt(btn.dataset.i), 1);
      store.set('carouselPhotos', photos);
      if (carouselIdx >= photos.length) carouselIdx = Math.max(0, photos.length - 1);
      renderCarousel();
    });
  });

  dots.querySelectorAll('.carousel-dot').forEach(dot => {
    dot.addEventListener('click', () => { carouselIdx = parseInt(dot.dataset.i); renderCarousel(); });
  });

  clearInterval(carouselTimer);
  if (photos.length > 1) {
    carouselTimer = setInterval(() => {
      carouselIdx = (carouselIdx + 1) % photos.length;
      renderCarousel();
    }, 4000);
  }
}

// Touch swipe for carousel
let touchStartX = 0;
document.getElementById('carouselWrap').addEventListener('touchstart', e => {
  touchStartX = e.touches[0].clientX;
}, { passive: true });
document.getElementById('carouselWrap').addEventListener('touchend', e => {
  const dx = e.changedTouches[0].clientX - touchStartX;
  if (Math.abs(dx) < 40) return;
  const photos = getCarouselPhotos();
  if (!photos.length) return;
  carouselIdx = dx < 0
    ? (carouselIdx + 1) % photos.length
    : (carouselIdx - 1 + photos.length) % photos.length;
  renderCarousel();
}, { passive: true });

document.getElementById('carouselPrev').addEventListener('click', () => {
  const photos = getCarouselPhotos();
  carouselIdx = (carouselIdx - 1 + photos.length) % photos.length;
  renderCarousel();
});
document.getElementById('carouselNext').addEventListener('click', () => {
  const photos = getCarouselPhotos();
  carouselIdx = (carouselIdx + 1) % photos.length;
  renderCarousel();
});

document.getElementById('carouselUpload').addEventListener('change', async e => {
  const files = Array.from(e.target.files);
  for (const file of files) {
    const url = await uploadPhoto(file, 'carousel');
    const photos = getCarouselPhotos();
    photos.push(url);
    store.set('carouselPhotos', photos);
  }
  carouselIdx = getCarouselPhotos().length - 1;
  renderCarousel();
  e.target.value = '';
});

// ═══════════════════════════════════════════════════════════════════════════
// TRIP NOTES
// ═══════════════════════════════════════════════════════════════════════════
function renderTripNotes() {
  const notes = store.get('tripNotes', '');
  const display = document.getElementById('tripNotesDisplay');
  if (notes) {
    // Render newlines as <br> paragraphs
    display.innerHTML = notes.split('\n\n').map(p =>
      `<p>${p.replace(/\n/g, '<br>')}</p>`
    ).join('');
  } else {
    display.innerHTML = `<p class="trip-notes-placeholder">Notes about the trip will appear here.</p>`;
  }
}

document.getElementById('tripNotesEditBtn').addEventListener('click', () => {
  const notes = store.get('tripNotes', '');
  document.getElementById('tripNotesTextarea').value = notes;
  document.getElementById('tripNotesDisplay').style.display = 'none';
  document.getElementById('tripNotesEditor').style.display = 'flex';
});
document.getElementById('tripNotesCancel').addEventListener('click', () => {
  document.getElementById('tripNotesDisplay').style.display = 'block';
  document.getElementById('tripNotesEditor').style.display = 'none';
});
document.getElementById('tripNotesSave').addEventListener('click', () => {
  store.set('tripNotes', document.getElementById('tripNotesTextarea').value);
  document.getElementById('tripNotesDisplay').style.display = 'block';
  document.getElementById('tripNotesEditor').style.display = 'none';
  renderTripNotes();
});

// Show/hide all owner-only controls via body class
function refreshOwnerControls() {
  document.body.classList.toggle('owner-unlocked', personalUnlocked);
  renderCarousel(); // re-render to show/hide per-photo delete buttons
}

// ═══════════════════════════════════════════════════════════════════════════
// PHOTO GALLERY
// ═══════════════════════════════════════════════════════════════════════════
let galleryFilter = '';
let galleryPendingFiles = [];

function getAllGalleryPhotos() {
  // Aggregate all photos from every country + untagged
  const all = [];
  const countries = [...new Set(blocks.map(b => b.country))];
  countries.forEach(country => {
    (store.get('photos_' + country, [])).forEach(src => {
      all.push({ src, country });
    });
  });
  // Also grab any untagged photos stored directly
  (store.get('photos_untagged', [])).forEach(src => {
    all.push({ src, country: '' });
  });
  return all;
}

function renderGallery() {
  const all = getAllGalleryPhotos();
  const countries = [...new Set(all.map(p => p.country).filter(Boolean))];

  // Filter buttons
  const filtersEl = document.getElementById('galleryFilters');
  filtersEl.innerHTML = '';
  [{ label: 'All', value: '' }, ...countries.map(c => ({ label: (COUNTRY_FLAGS[c] || '') + ' ' + c, value: c }))].forEach(f => {
    const btn = document.createElement('button');
    btn.className = 'gallery-filter-btn' + (galleryFilter === f.value ? ' active' : '');
    btn.dataset.country = f.value;
    btn.textContent = f.label;
    btn.addEventListener('click', () => { galleryFilter = f.value; renderGallery(); });
    filtersEl.appendChild(btn);
  });

  // Populate country datalist for upload modal
  const dl = document.getElementById('galleryCountryList');
  dl.innerHTML = countries.map(c => `<option value="${c}">`).join('') +
    blocks.map(b => `<option value="${b.country}">`).join('');

  const filtered = galleryFilter ? all.filter(p => p.country === galleryFilter) : all;
  const grid = document.getElementById('galleryGrid');
  grid.innerHTML = '';

  if (!filtered.length) {
    grid.innerHTML = `<p class="gallery-empty">${galleryFilter ? 'No photos for ' + galleryFilter + ' yet.' : 'No photos yet — add some!'}</p>`;
    return;
  }

  filtered.forEach((photo, idx) => {
    const wrap = document.createElement('div');
    wrap.className = 'gallery-item';
    wrap.innerHTML = `
      <img src="${photo.src}" class="gallery-img" loading="lazy">
      ${photo.country ? `<span class="gallery-tag">${COUNTRY_FLAGS[photo.country] || '🌍'} ${photo.country}</span>` : ''}
      <button class="gallery-del owner-only" data-country="${photo.country}" data-src="${photo.src}">×</button>
    `;
    wrap.querySelector('.gallery-img').addEventListener('click', () => {
      openLightbox(filtered.map(p => p.src), idx);
    });
    const delBtn = wrap.querySelector('.gallery-del');
    if (delBtn) {
      delBtn.addEventListener('click', e => {
        e.stopPropagation();
        const country = delBtn.dataset.country;
        const src = delBtn.dataset.src;
        if (country) {
          const photos = store.get('photos_' + country, []).filter(s => s !== src);
          store.set('photos_' + country, photos);
        } else {
          const photos = store.get('photos_untagged', []).filter(s => s !== src);
          store.set('photos_untagged', photos);
        }
        renderGallery();
        // Also refresh country page if open
        if (currentCountryPage === country) renderCpPhotos(country);
      });
    }
    grid.appendChild(wrap);
  });
}

// Upload flow
document.getElementById('galleryUpload').addEventListener('change', e => {
  const files = Array.from(e.target.files);
  if (!files.length) return;
  galleryPendingFiles = files;
  // Pre-fill country if we know blocks
  const firstCountry = blocks[0]?.country || '';
  document.getElementById('galleryCountryTag').value = firstCountry;
  document.getElementById('galleryUploadModal').style.display = 'flex';
  e.target.value = '';
});

document.getElementById('galleryUploadCancel').addEventListener('click', () => {
  galleryPendingFiles = [];
  document.getElementById('galleryUploadModal').style.display = 'none';
});

document.getElementById('galleryUploadConfirm').addEventListener('click', async () => {
  const country = document.getElementById('galleryCountryTag').value.trim();
  const key = country ? 'photos_' + country : 'photos_untagged';
  const folder = country ? `photos/${country}` : 'photos/untagged';
  for (const file of galleryPendingFiles) {
    const url = await uploadPhoto(file, folder);
    const photos = store.get(key, []);
    photos.push(url);
    store.set(key, photos);
  }
  galleryPendingFiles = [];
  document.getElementById('galleryUploadModal').style.display = 'none';
  renderGallery();
  if (country && currentCountryPage === country) renderCpPhotos(country);
  renderCountriesList();
});

// ─── Init ────────────────────────────────────────────────────────────────────
async function initApp() {
  // Load all synced data from Firestore before first render
  try {
    const snap = await db.collection('tripdata').doc('main').get();
    if (snap.exists) {
      Object.entries(snap.data()).forEach(([k, v]) => {
        try { _cache[k] = JSON.parse(v); } catch { _cache[k] = v; }
      });
      // Mirror access list to localStorage so the entry gate can read it
      if (_cache.accessList) localStorage.setItem('sea_accessList', JSON.stringify(_cache.accessList));
    }
  } catch(e) { console.error('Firestore load failed:', e); }

  // Apply loaded data
  blocks = store.get('blocks', DEFAULT_BLOCKS);
  document.getElementById('tripStart').value = store.get('tripStart', '2027-01-15');
  document.getElementById('tripEnd').value = store.get('tripEnd', '2027-04-15');

  renderTimeline();
  renderCalendar();
  renderPlaces();
  renderCarousel();
  renderTripNotes();

  // Real-time listener — re-renders whenever any device makes a change
  db.collection('tripdata').doc('main').onSnapshot(snap => {
    if (!snap.exists) return;
    Object.entries(snap.data()).forEach(([k, v]) => {
      try { _cache[k] = JSON.parse(v); } catch { _cache[k] = v; }
    });
    if (_cache.accessList) localStorage.setItem('sea_accessList', JSON.stringify(_cache.accessList));

    blocks = store.get('blocks', DEFAULT_BLOCKS);
    document.getElementById('tripStart').value = store.get('tripStart', '2027-01-15');
    document.getElementById('tripEnd').value = store.get('tripEnd', '2027-04-15');

    renderTimeline();
    renderCalendar();
    renderPlaces();
    renderCarousel();
    renderTripNotes();
    renderCountriesList();
    renderGallery();
    if (currentCountryPage) { renderCpPlaces(currentCountryPage); renderCpPhotos(currentCountryPage); renderCpNotes(currentCountryPage); }
    if (personalUnlocked) { renderBudget(); renderPacking(); renderPsDashboard(); updateOutfitDisplay(); renderWardrobeGrid(); renderSavedOutfits(); }
  });
}

initApp();
// Budget / Packing / Outfits render on unlock inside unlockPersonal()

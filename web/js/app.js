/* YT-MP3 — front-end. No framework, no build step: parse, run, done. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const el = {
    url: $('url'), clear: $('btn-clear'), paste: $('btn-paste'),
    previewLoading: $('preview-loading'), preview: $('preview'),
    thumb: $('pv-thumb'), title: $('pv-title'), meta: $('pv-meta'),
    qualityCard: $('quality-card'), chips: $('chips'), qualityHint: $('quality-hint'),
    progressCard: $('progress-card'), pgLabel: $('pg-label'), pgPct: $('pg-pct'),
    pgBar: $('pg-bar'), pgTrack: document.querySelector('.pg-track'), pgSub: $('pg-sub'),
    doneCard: $('done-card'), doneTitle: $('done-title'), doneMeta: $('done-meta'),
    errorCard: $('error-card'), errorText: $('error-text'),
    empty: $('empty'), history: $('history'), histList: $('hist-list'),
    clearHistory: $('btn-clear-history'),
    main: $('btn-main'), mainLabel: $('btn-main-label'),
    sheet: $('sheet'), scrim: $('sheet-scrim'), settings: $('btn-settings'),
    server: $('server'), serverStatus: $('server-status'),
    test: $('btn-test'), save: $('btn-save'),
    toast: $('toast'),
  };

  const LS = { server: 'ytmp3.server', bitrate: 'ytmp3.bitrate', history: 'ytmp3.history' };

  const state = {
    server: localStorage.getItem(LS.server) || '',
    bitrate: localStorage.getItem(LS.bitrate) || '192',
    info: null,
    job: null,
    phase: 'idle', // idle | loading | ready | working | done | error
    lastFile: null,
    es: null,
    poll: null,
  };

  /* ---------- utils ---------- */

  const YT_RE = /(?:youtube\.com|youtu\.be|music\.youtube\.com|m\.youtube\.com)/i;
  const URL_RE = /https?:\/\/[^\s<>"']+/i;

  const firstUrl = (text) => (String(text || '').match(URL_RE) || [null])[0];

  const isUrl = (v) => {
    try { const u = new URL(v); return u.protocol === 'http:' || u.protocol === 'https:'; }
    catch { return false; }
  };

  const trimApi = (v) => String(v || '').trim().replace(/\/+$/, '');

  const fmtTime = (s) => {
    if (!s) return '';
    s = Math.round(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
  };

  const fmtSize = (b) => (!b ? '' : b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);
  const fmtSpeed = (b) => (!b ? '' : `${(b / 1048576).toFixed(1)} MB/s`);

  // Wraps a Latin/numeric run so RTL bidi cannot reorder it ("320 kbps", "3:33").
  const ltr = (v) => (v ? `\u2066${v}\u2069` : '');

  const buzz = (ms = 12) => { try { navigator.vibrate?.(ms); } catch { /* not supported */ } };

  let toastTimer;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2600);
  }

  async function api(path, options = {}) {
    if (!state.server) throw new Error('לא הוגדרה כתובת שרת. פתחו את ההגדרות ⚙︎');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), options.timeout || 45000);
    try {
      const res = await fetch(state.server + path, {
        ...options,
        signal: ctrl.signal,
        headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `שגיאת שרת (${res.status})`);
      return data;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('השרת לא הגיב בזמן');
      if (err instanceof TypeError) throw new Error('אין חיבור לשרת. בדקו את הכתובת בהגדרות');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------- rendering ---------- */

  el.thumb.addEventListener('error', () => { el.thumb.hidden = true; });

  function render() {
    const p = state.phase;

    el.previewLoading.hidden = p !== 'loading';
    el.preview.hidden = !(state.info && p !== 'loading');
    el.qualityCard.hidden = !(state.info && (p === 'ready' || p === 'error'));
    el.progressCard.hidden = p !== 'working';
    el.doneCard.hidden = p !== 'done';
    el.errorCard.hidden = p !== 'error';
    el.empty.hidden = !(p === 'idle' && !state.info && !readHistory().length);
    el.clear.hidden = !el.url.value;

    renderHistory();

    const label = {
      idle: 'הדביקו קישור',
      loading: 'טוען פרטים…',
      ready: 'הורדה כ‑MP3',
      working: 'ממיר…',
      done: 'שמירת הקובץ',
      error: 'ניסיון נוסף',
    }[p];

    el.mainLabel.textContent = label;
    el.main.disabled = p === 'loading' || p === 'working' || (p === 'idle' && !isUrl(el.url.value.trim()));
    if (p === 'idle' && isUrl(el.url.value.trim())) el.mainLabel.textContent = 'הורדה כ‑MP3';
  }

  function showInfo(info) {
    state.info = info;
    el.title.textContent = info.title || '—';
    el.meta.textContent = [info.uploader, ltr(fmtTime(info.duration))].filter(Boolean).join(' · ');
    if (info.thumbnail) { el.thumb.src = info.thumbnail; el.thumb.hidden = false; }
    else el.thumb.hidden = true;
  }

  function setProgress(pct, indeterminate = false) {
    el.pgTrack.classList.toggle('indeterminate', indeterminate);
    el.pgBar.style.width = indeterminate ? '40%' : `${Math.max(2, pct)}%`;
    el.pgPct.textContent = indeterminate ? '' : `${Math.round(pct)}%`;
  }

  function fail(message) {
    state.phase = 'error';
    el.errorText.textContent = message;
    render();
    buzz(30);
  }

  /* ---------- history ---------- */

  const readHistory = () => {
    try { return JSON.parse(localStorage.getItem(LS.history) || '[]'); }
    catch { return []; }
  };

  function pushHistory(entry) {
    const list = readHistory().filter((h) => h.url !== entry.url);
    list.unshift(entry);
    localStorage.setItem(LS.history, JSON.stringify(list.slice(0, 12)));
  }

  function renderHistory() {
    const list = readHistory();
    el.history.hidden = list.length === 0;
    if (!list.length) { el.histList.textContent = ''; return; }

    const frag = document.createDocumentFragment();
    for (const item of list) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hist-item';

      if (item.thumbnail) {
        const img = document.createElement('img');
        img.src = item.thumbnail;
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        btn.appendChild(img);
      }

      const body = document.createElement('div');
      body.className = 'hist-body';
      const strong = document.createElement('strong');
      strong.textContent = item.title || item.url;
      const span = document.createElement('span');
      span.textContent = [ltr(`${item.bitrate} kbps`), ltr(fmtSize(item.filesize))].filter(Boolean).join(' · ');
      body.append(strong, span);
      btn.appendChild(body);

      btn.addEventListener('click', () => {
        el.url.value = item.url;
        buzz();
        loadInfo(item.url);
      });

      li.appendChild(btn);
      frag.appendChild(li);
    }
    el.histList.replaceChildren(frag);
  }

  /* ---------- flow ---------- */

  let infoToken = 0;

  async function loadInfo(rawUrl, { autostart = false } = {}) {
    const url = firstUrl(rawUrl) || String(rawUrl || '').trim();
    if (!isUrl(url)) return;

    el.url.value = url;
    stopStream();
    state.info = null;
    state.lastFile = null;
    state.phase = 'loading';
    render();

    const token = ++infoToken;
    try {
      const info = await api('/api/info', { method: 'POST', body: JSON.stringify({ url }), timeout: 30000 });
      if (token !== infoToken) return; // a newer request won
      showInfo(info);
      state.phase = 'ready';
      render();
      if (autostart) start();
    } catch (err) {
      if (token !== infoToken) return;
      fail(err.message);
    }
  }

  function stopStream() {
    if (state.es) { state.es.close(); state.es = null; }
    if (state.poll) { clearInterval(state.poll); state.poll = null; }
  }

  async function start() {
    const url = firstUrl(el.url.value) || el.url.value.trim();
    if (!isUrl(url)) { toast('הקישור לא תקין'); return; }

    stopStream();
    state.phase = 'working';
    el.pgLabel.textContent = 'מתחיל…';
    el.pgSub.textContent = 'שולח בקשה לשרת';
    setProgress(0, true);
    render();
    buzz();

    let job;
    try {
      job = await api('/api/jobs', {
        method: 'POST',
        body: JSON.stringify({ url, bitrate: state.bitrate }),
      });
    } catch (err) {
      fail(err.message);
      return;
    }

    state.job = job.id;
    watch(job.id);
  }

  function applyStatus(s) {
    if (s.status === 'downloading') {
      el.pgLabel.textContent = 'מוריד';
      setProgress(s.progress || 0, !s.progress);
      el.pgSub.textContent = [ltr(fmtSpeed(s.speed)), s.eta ? `נותרו ${ltr(fmtTime(s.eta))}` : '']
        .filter(Boolean).join(' · ') || 'מוריד את פס הקול';
    } else if (s.status === 'converting') {
      el.pgLabel.textContent = 'ממיר ל‑MP3';
      setProgress(100, true);
      el.pgSub.textContent = `מקודד ב‑${ltr(`${state.bitrate} kbps`)}`;
    } else if (s.status === 'queued') {
      el.pgLabel.textContent = 'בתור';
      setProgress(0, true);
      el.pgSub.textContent = 'ממתין לשרת';
    } else if (s.status === 'done') {
      finish(s);
    } else if (s.status === 'error') {
      stopStream();
      fail(s.error || 'ההמרה נכשלה');
    }
  }

  function watch(id) {
    // SSE is the fast path; polling covers proxies that buffer event streams.
    let gotEvent = false;
    try {
      const es = new EventSource(`${state.server}/api/jobs/${id}/events`);
      state.es = es;
      es.onmessage = (ev) => {
        gotEvent = true;
        try { applyStatus(JSON.parse(ev.data)); } catch { /* ignore malformed frame */ }
      };
      es.onerror = () => { es.close(); state.es = null; if (!gotEvent) startPolling(id); };
    } catch {
      startPolling(id);
    }
    setTimeout(() => { if (!gotEvent && state.phase === 'working') { stopStream(); startPolling(id); } }, 3000);
  }

  function startPolling(id) {
    if (state.poll) return;
    state.poll = setInterval(async () => {
      try { applyStatus(await api(`/api/jobs/${id}`, { timeout: 15000 })); }
      catch (err) { stopStream(); fail(err.message); }
    }, 900);
  }

  function finish(s) {
    stopStream();
    state.phase = 'done';
    state.lastFile = `${state.server}/api/jobs/${state.job}/file`;

    el.doneTitle.textContent = s.title || state.info?.title || 'הקובץ מוכן';
    el.doneMeta.textContent = [ltr(`${state.bitrate} kbps`), ltr(fmtSize(s.filesize)), ltr(fmtTime(s.duration))]
      .filter(Boolean).join(' · ');

    pushHistory({
      url: firstUrl(el.url.value) || el.url.value.trim(),
      title: s.title || state.info?.title || '',
      thumbnail: s.thumbnail || state.info?.thumbnail || '',
      bitrate: state.bitrate,
      filesize: s.filesize || 0,
      at: Date.now(),
    });

    render();
    buzz([10, 40, 10]);
    saveFile();           // most browsers keep the gesture chain from the original tap
    toast('הקובץ מוכן להורדה');
  }

  function saveFile() {
    if (!state.lastFile) return;
    const a = document.createElement('a');
    a.href = state.lastFile;
    a.download = '';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /* ---------- events ---------- */

  let typeTimer;
  el.url.addEventListener('input', () => {
    render();
    clearTimeout(typeTimer);
    const v = el.url.value.trim();
    if (!isUrl(v)) return;
    typeTimer = setTimeout(() => loadInfo(v), 450);
  });

  el.url.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { el.url.blur(); loadInfo(el.url.value); }
  });

  el.clear.addEventListener('click', () => {
    el.url.value = '';
    state.info = null;
    state.phase = 'idle';
    stopStream();
    render();
    el.url.focus();
  });

  el.paste.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      const url = firstUrl(text);
      if (!url) { toast('אין קישור בלוח'); return; }
      buzz();
      loadInfo(url);
    } catch {
      el.url.focus();
      toast('הדביקו ידנית בשדה');
    }
  });

  el.chips.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.bitrate = chip.dataset.v;
    localStorage.setItem(LS.bitrate, state.bitrate);
    for (const c of el.chips.children) {
      const on = c === chip;
      c.classList.toggle('is-on', on);
      c.setAttribute('aria-checked', String(on));
    }
    el.qualityHint.textContent = ltr(`${state.bitrate} kbps`);
    buzz();
  });

  el.main.addEventListener('click', () => {
    if (state.phase === 'done') { saveFile(); return; }
    if (state.phase === 'ready' || state.phase === 'error') { start(); return; }
    const v = el.url.value.trim();
    if (isUrl(v)) loadInfo(v, { autostart: true });
    else el.url.focus();
  });

  el.clearHistory.addEventListener('click', () => {
    localStorage.removeItem(LS.history);
    render();
    toast('ההיסטוריה נוקתה');
  });

  /* ---------- settings sheet ---------- */

  const openSheet = () => {
    el.server.value = state.server;
    el.serverStatus.hidden = true;
    el.sheet.hidden = false;
  };
  const closeSheet = () => { el.sheet.hidden = true; };

  el.settings.addEventListener('click', openSheet);
  el.scrim.addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el.sheet.hidden) closeSheet(); });

  el.save.addEventListener('click', () => {
    state.server = trimApi(el.server.value);
    localStorage.setItem(LS.server, state.server);
    closeSheet();
    toast(state.server ? 'הכתובת נשמרה' : 'הכתובת נוקתה');
    if (state.server && isUrl(el.url.value.trim())) loadInfo(el.url.value);
  });

  el.test.addEventListener('click', async () => {
    const base = trimApi(el.server.value);
    el.serverStatus.hidden = false;
    el.serverStatus.className = 'sheet-status';
    el.serverStatus.textContent = 'בודק…';
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(8000) });
      const data = await res.json();
      if (!data.ok) throw new Error('תשובה לא צפויה');
      el.serverStatus.className = 'sheet-status ok';
      el.serverStatus.textContent = data.ffmpeg ? 'השרת מחובר ומוכן ✓' : 'השרת מחובר, אבל ffmpeg חסר';
    } catch {
      el.serverStatus.className = 'sheet-status bad';
      el.serverStatus.textContent = 'לא הצלחנו להתחבר לכתובת הזו';
    }
  });

  /* ---------- boot ---------- */

  async function probeSameOrigin() {
    try {
      const res = await fetch('./api/health', { signal: AbortSignal.timeout(2500) });
      const data = await res.json();
      if (!data.ok) return false;
      state.server = location.origin;
      localStorage.setItem(LS.server, state.server);
      return true;
    } catch {
      return false;
    }
  }

  function init() {
    for (const c of el.chips.children) {
      const on = c.dataset.v === state.bitrate;
      c.classList.toggle('is-on', on);
      c.setAttribute('aria-checked', String(on));
    }
    el.qualityHint.textContent = ltr(`${state.bitrate} kbps`);

    // First run on a desktop-ish origin: guess the local bridge.
    if (!state.server && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
      state.server = `${location.protocol}//${location.hostname}:8000`;
      localStorage.setItem(LS.server, state.server);
    }

    render();

    // Shared in from YouTube (Web Share Target) or opened with ?url=
    const q = new URLSearchParams(location.search);
    const shared = firstUrl(q.get('url') || q.get('text') || q.get('title') || '');
    if (shared) {
      window.history.replaceState(null, '', location.pathname);
      el.url.value = shared;
      render();
      const go = () => loadInfo(shared, { autostart: YT_RE.test(shared) });
      if (state.server) go();
      else probeSameOrigin().then((found) => {
        if (found) go();
        else { openSheet(); toast('הגדירו כתובת שרת כדי להוריד'); }
      });
    } else if (!state.server) {
      // Same-origin deploy (Firebase Hosting -> Cloud Run) needs no setup at all.
      probeSameOrigin().then((found) => { if (!found) openSheet(); });
    }

    if ('serviceWorker' in navigator) {
      addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
    }
  }

  init();
})();

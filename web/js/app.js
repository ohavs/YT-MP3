/* YT-MP3 — front-end. No framework, no build step: parse, run, done. */
(() => {
  'use strict';

  const BUILD = '15';   // must match the tag in sw.js and the ?v= on the assets

  const $ = (id) => document.getElementById(id);

  const el = {
    url: $('url'), clear: $('btn-clear'), paste: $('btn-paste'),
    previewLoading: $('preview-loading'), preview: $('preview'),
    thumb: $('pv-thumb'), title: $('pv-title'), meta: $('pv-meta'),
    qualityCard: $('quality-card'), chips: $('chips'), qualityHint: $('quality-hint'),
    progressCard: $('progress-card'), pgLabel: $('pg-label'), pgPct: $('pg-pct'),
    pgBar: $('pg-bar'), pgTrack: document.querySelector('.pg-track'), pgSub: $('pg-sub'),
    doneCard: $('done-card'), doneTitle: $('done-title'), doneMeta: $('done-meta'),
    errorCard: $('error-card'), errorText: $('error-text'), errorReason: $('error-reason'),
    empty: $('empty'), history: $('history'), histList: $('hist-list'),
    clearHistory: $('btn-clear-history'), build: $('build'),
    theme: $('btn-theme'), topLoad: $('topbar-load'),
    resultsCard: $('results-card'), results: $('results'), resultsCount: $('results-count'),
    nameCard: $('name-card'), name: $('name'),
    trimCard: $('trim-card'), trimToggle: $('trim-toggle'), trimBody: $('trim-body'),
    range: $('range'), rangeFill: $('range-fill'),
    handleStart: $('handle-start'), handleEnd: $('handle-end'),
    timeStart: $('time-start'), timeEnd: $('time-end'), trimSummary: $('trim-summary'),
    markRow: $('mark-row'), markStart: $('mark-start'), markEnd: $('mark-end'),
    playerCard: $('player-card'), fieldHint: $('field-hint'),
    iconSearch: document.querySelector('.ic-search'), iconLink: document.querySelector('.ic-link'),
    queueSection: $('queue-section'), queueList: $('queue-list'),
    clearQueue: $('btn-clear-queue'), queueAdd: $('btn-queue'),
    spinner: $('btn-spinner'), loadingNote: $('loading-note'),
    main: $('btn-main'), mainLabel: $('btn-main-label'),
    toast: $('toast'),
  };

  const LS = { bitrate: 'ytmp3.bitrate', history: 'ytmp3.history', theme: 'ytmp3.theme' };

  // Deployed backend, used if the same-origin route is not answering. Keeping it
  // here means the app still works when only one of the two paths is healthy.
  const FALLBACK_API = 'https://api-wdmkdg3ysa-uc.a.run.app';

  const state = {
    server: '',
    bitrate: localStorage.getItem(LS.bitrate) || '192',
    info: null,
    job: null,
    mode: null,     // 'jobs' = live progress from a server you run; 'sync' = one-shot (serverless)
    direct: '',     // set at boot: a hosting proxy caps dynamic requests, this bypasses it
    lastName: '',
    results: [],       // search hits waiting to be picked
    searching: false,
    trimOn: false,
    span: { from: 0, to: 0, total: 0 },   // the cut, in seconds
    player: null,
    queue: [],         // items waiting their turn, plus the finished ones
    running: false,
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
    // The backend's own address goes first: a hosting proxy caps how long a
    // dynamic request may run, and a lookup can legitimately exceed that cap —
    // which the proxy reports as a gateway error, not as anything informative.
    const bases = [state.direct, state.server].filter((v, i, a) => v && a.indexOf(v) === i);
    const budget = options.timeout || 45000;
    let lastError = null;

    for (const base of bases) {
      // Per route, so one that hangs cannot spend the other's turn.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), budget);
      try {
        let res;
        try {
          res = await fetch(base + path, {
            ...options,
            signal: ctrl.signal,
            headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
          });
        } catch (err) {
          lastError = err.name === 'AbortError'
            ? new Error('השרת לא הגיב בזמן')
            : new Error('אין חיבור לשרת ההמרה. נסו שוב בעוד רגע');
          continue;   // this route failed us; the other one may not
        }

        const data = await res.json().catch(() => ({}));
        if (res.ok) return data;

        const detail = data.detail;
        if (detail && typeof detail === 'object') {
          const err = new Error(detail.message || `שגיאת שרת (${res.status})`);
          err.reason = detail.reason || '';
          throw err;                     // the backend answered; that answer stands
        }
        lastError = new Error(detail || `שגיאת שרת (${res.status})`);
        // a gateway or missing route is the path's fault, not the request's
        if (![502, 503, 504, 404].includes(res.status)) throw lastError;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || new Error('אין חיבור לשרת ההמרה');
  }

  async function loadHealth() {
    const tried = [];
    for (const base of [state.server, FALLBACK_API]) {
      const candidate = trimApi(base);
      if (!candidate || tried.includes(candidate)) continue;
      tried.push(candidate);
      try {
        // A serverless backend has to boot before it can answer, so this waits.
        const res = await fetch(`${candidate}/api/health`, { signal: AbortSignal.timeout(25000) });
        const data = await res.json();
        if (!data.ok) continue;
        state.server = candidate;
        state.mode = data.mode === 'sync' ? 'sync' : 'jobs';
        if (data.direct_url) state.direct = trimApi(data.direct_url);
        return true;
      } catch {
        // a wrong address answers fast (404); only a waking instance is slow
      }
    }
    return false;
  }

  /* ---------- what to convert ---------- */

  function currentSpec(url) {
    const { from, to, total } = state.span;
    const on = state.trimOn && total > 0;
    return {
      url: url || firstUrl(el.url.value) || el.url.value.trim(),
      bitrate: state.bitrate,
      name: el.name.value.trim(),
      start: on ? from : 0,
      end: on && to < total ? to : null,
      title: state.info?.title || '',
      thumbnail: state.info?.thumbnail || '',
      duration: on ? to - from : total || null,
    };
  }

  /* ---------- theme ---------- */

  function applyTheme(mode) {
    const root = document.documentElement;
    if (mode) root.setAttribute('data-theme', mode);
    else root.removeAttribute('data-theme');   // no choice stored: follow the system

    const dark = mode ? mode === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    // The browser chrome reads a single tag, so replace the media-split pair.
    for (const tag of document.querySelectorAll('meta[name="theme-color"]')) tag.remove();
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = dark ? '#0b0b0f' : '#f6f6f8';
    document.head.appendChild(meta);
  }

  function toggleTheme() {
    const stored = localStorage.getItem(LS.theme);
    const dark = stored ? stored === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    localStorage.setItem(LS.theme, next);
    applyTheme(next);
    buzz();
  }

  /* ---------- rendering ---------- */

  el.thumb.addEventListener('error', () => { el.thumb.hidden = true; });

  function render() {
    const p = state.phase;

    const busy = p === 'loading' || p === 'working';

    el.previewLoading.hidden = p !== 'loading';
    el.loadingNote.hidden = p !== 'loading';
    el.preview.hidden = !(state.info && p !== 'loading');
    // Quality stays reachable for as long as there is a video on screen —
    // including after a download, so another bitrate is one tap away.
    el.qualityCard.hidden = !(state.info && p !== 'loading');
    el.nameCard.hidden = !(state.info && p !== 'loading');
    el.trimCard.hidden = !(state.info && state.info.duration && p !== 'loading');
    el.queueAdd.hidden = !(state.info && (p === 'ready' || p === 'done' || p === 'error'));
    el.resultsCard.hidden = state.results.length === 0;
    el.chips.classList.toggle('is-locked', p === 'working');
    el.progressCard.hidden = p !== 'working';
    el.doneCard.hidden = p !== 'done';
    el.errorCard.hidden = p !== 'error';
    el.empty.hidden = !(p === 'idle' && !state.info && !readHistory().length
                        && !state.results.length && !state.queue.length);
    el.clear.hidden = !el.url.value;
    reflectFieldMode();

    renderHistory();
    renderQueue();

    const label = {
      idle: 'הדביקו קישור',
      loading: 'טוען פרטים…',
      ready: 'הורדה כ‑MP3',
      working: 'ממיר…',
      done: 'שמירת הקובץ',
      error: 'ניסיון נוסף',
    }[p];

    el.mainLabel.textContent = label;
    el.main.disabled = busy || (p === 'idle' && !isUrl(el.url.value.trim()));
    if (p === 'idle' && isUrl(el.url.value.trim())) el.mainLabel.textContent = 'הורדה כ‑MP3';

    // Three signals for one state, because waiting is the moment the app feels broken.
    el.topLoad.hidden = !busy;
    el.spinner.hidden = !busy;
    el.main.classList.toggle('is-busy', busy);
  }

  function showInfo(info) {
    state.info = info;
    el.name.value = (info.title || 'audio').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 120);
    setupTrim(info.duration);
    clearResults();
    showPlayer(info);
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

  function fail(message, reason) {
    state.phase = 'error';
    el.errorText.textContent = message;
    el.errorReason.textContent = reason || '';
    el.errorReason.hidden = !reason;
    render();
    buzz(30);
  }

  /* ---------- search ---------- */

  let searchToken = 0;

  async function runSearch(query) {
    const token = ++searchToken;
    state.searching = true;
    el.resultsCount.textContent = 'מחפש…';
    el.resultsCard.hidden = false;

    try {
      const data = await api(`/api/search?q=${encodeURIComponent(query)}`, { timeout: 45000 });
      if (token !== searchToken) return;          // a newer query won
      state.results = data.results || [];
      renderResults();
    } catch (err) {
      if (token !== searchToken) return;
      state.results = [];
      el.results.textContent = '';
      el.resultsCount.textContent = err.message;
    } finally {
      if (token === searchToken) state.searching = false;
      render();
    }
  }

  function clearResults() {
    searchToken++;
    state.results = [];
    el.results.textContent = '';
    el.resultsCount.textContent = '';
  }

  function renderResults() {
    el.resultsCount.textContent = state.results.length
      ? ltr(`${state.results.length}`)
      : 'לא נמצאו תוצאות';

    const frag = document.createDocumentFragment();
    for (const item of state.results) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'result';

      const thumb = document.createElement('div');
      thumb.className = 'result-thumb';
      const img = document.createElement('img');
      img.src = item.thumbnail;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      // a broken image icon is worse than the plain placeholder behind it
      img.addEventListener('error', () => img.remove());
      thumb.appendChild(img);
      if (item.duration) {
        const len = document.createElement('span');
        len.className = 'len';
        len.textContent = fmtTime(item.duration);
        thumb.appendChild(len);
      }
      btn.appendChild(thumb);

      const body = document.createElement('div');
      body.className = 'result-body';
      const title = document.createElement('strong');
      title.textContent = item.title;
      const who = document.createElement('span');
      who.textContent = item.uploader || '';
      body.append(title, who);
      btn.appendChild(body);

      btn.addEventListener('click', () => {
        clearResults();
        el.url.value = item.url;
        buzz();
        loadInfo(item.url);
      });

      li.appendChild(btn);
      frag.appendChild(li);
    }
    el.results.replaceChildren(frag);
  }

  /* ---------- trim ---------- */

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /** Accepts "1:23", "1:02:03" or a plain number of seconds. */
  function parseTime(text) {
    const raw = String(text || '').trim();
    if (!/\d/.test(raw)) return null;              // nothing numeric: not a time at all
    const parts = raw.split(':').map((n) => {
      const digits = n.replace(/\D/g, '');
      return digits === '' ? NaN : Number(digits);
    });
    if (parts.some((n) => Number.isNaN(n))) return null;
    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
  }

  function setupTrim(duration) {
    const total = Math.max(0, Math.round(duration || 0));
    state.span = { from: 0, to: total, total };
    state.trimOn = false;
    el.trimToggle.setAttribute('aria-checked', 'false');
    el.trimBody.hidden = true;
    renderTrim();
  }

  function setSpan(from, to, { silent = false } = {}) {
    const { total } = state.span;
    if (!total) return;
    state.span.from = clamp(Math.round(from), 0, total - 1);
    state.span.to = clamp(Math.round(to), state.span.from + 1, total);
    renderTrim();
    if (!silent && state.phase === 'done') { state.phase = 'ready'; render(); }
  }

  function renderTrim() {
    const { from, to, total } = state.span;
    const pct = (v) => (total ? (v / total) * 100 : 0);

    el.handleStart.style.left = `${pct(from)}%`;
    el.handleEnd.style.left = `${pct(to)}%`;
    el.rangeFill.style.left = `${pct(from)}%`;
    el.rangeFill.style.width = `${pct(to - from)}%`;

    for (const [node, value] of [[el.handleStart, from], [el.handleEnd, to]]) {
      node.setAttribute('aria-valuemax', String(total));
      node.setAttribute('aria-valuenow', String(value));
      node.setAttribute('aria-valuetext', fmtTime(value) || '0:00');
    }

    if (document.activeElement !== el.timeStart) el.timeStart.value = fmtTime(from) || '0:00';
    if (document.activeElement !== el.timeEnd) el.timeEnd.value = fmtTime(to) || '0:00';
    el.trimSummary.textContent = ltr(fmtTime(Math.max(0, to - from)) || '0:00');
  }

  /** Drag either handle; the track keeps its own left-to-right axis. */
  function dragHandle(handle, isStart) {
    handle.addEventListener('pointerdown', (e) => {
      if (!state.span.total) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('is-held');

      const rect = el.range.getBoundingClientRect();
      const move = (ev) => {
        const ratio = clamp((ev.clientX - rect.left) / rect.width, 0, 1);
        const seconds = ratio * state.span.total;
        if (isStart) setSpan(seconds, state.span.to);
        else setSpan(state.span.from, seconds);
      };
      const up = () => {
        handle.classList.remove('is-held');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        buzz();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });

    handle.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 5 : 1;
      let delta = 0;
      if (e.key === 'ArrowLeft') delta = -step;
      else if (e.key === 'ArrowRight') delta = step;
      else return;
      e.preventDefault();
      if (isStart) setSpan(state.span.from + delta, state.span.to);
      else setSpan(state.span.from, state.span.to + delta);
    });
  }

  dragHandle(el.handleStart, true);
  dragHandle(el.handleEnd, false);

  for (const [input, isStart] of [[el.timeStart, true], [el.timeEnd, false]]) {
    const commit = () => {
      const value = parseTime(input.value);
      if (value === null) { renderTrim(); return; }
      if (isStart) setSpan(value, state.span.to);
      else setSpan(state.span.from, value);
    };
    input.addEventListener('change', commit);
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
  }

  /* ---------- player ---------- */

  const YT_ID = /^[\w-]{11}$/;

  /**
   * Load YouTube's iframe API once, lazily.
   * Playing the audio ourselves is not an option: the stream URLs yt-dlp
   * resolves are tied to the address that asked for them, so they answer the
   * server and refuse the phone. The official player has no such problem.
   */
  let apiReady = null;
  function loadPlayerApi() {
    if (apiReady) return apiReady;
    apiReady = new Promise((resolve, reject) => {
      if (window.YT?.Player) { resolve(window.YT); return; }
      window.onYouTubeIframeAPIReady = () => resolve(window.YT);
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.onerror = () => reject(new Error('player unavailable'));
      document.head.appendChild(tag);
      setTimeout(() => reject(new Error('player timed out')), 12000);
    });
    return apiReady;
  }

  async function showPlayer(info) {
    const id = info?.id;
    const isYouTube = YT_ID.test(id || '') && YT_RE.test(info.webpage_url || '');
    if (!isYouTube) { hidePlayer(); return; }

    try {
      const YT = await loadPlayerApi();
      if (state.info?.id !== id) return;            // a newer video took over

      el.playerCard.hidden = false;
      el.markRow.hidden = false;
      if (state.player?.loadVideoById) {
        state.player.loadVideoById(id);
      } else {
        state.player = new YT.Player('player', {
          videoId: id,
          playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
        });
      }
    } catch {
      hidePlayer();                                  // the sliders still work
    }
  }

  function hidePlayer() {
    el.playerCard.hidden = true;
    el.markRow.hidden = true;
    try { state.player?.stopVideo?.(); } catch { /* the frame may be gone */ }
  }

  function playerTime() {
    try {
      const t = state.player?.getCurrentTime?.();
      return Number.isFinite(t) ? Math.round(t) : null;
    } catch {
      return null;
    }
  }

  el.markStart.addEventListener('click', () => {
    const t = playerTime();
    if (t === null) { toast('הנגן עוד לא מוכן'); return; }
    setSpan(t, Math.max(t + 1, state.span.to));
    buzz();
  });

  el.markEnd.addEventListener('click', () => {
    const t = playerTime();
    if (t === null) { toast('הנגן עוד לא מוכן'); return; }
    setSpan(Math.min(state.span.from, t - 1), t);
    buzz();
  });

  /* ---------- queue ---------- */  /* ---------- queue ---------- */

  function renderQueue() {
    el.queueSection.hidden = state.queue.length === 0;
    if (!state.queue.length) { el.queueList.textContent = ''; return; }

    const words = { waiting: 'ממתין', running: 'ממיר', done: 'מוכן', error: 'נכשל' };
    const frag = document.createDocumentFragment();

    for (const item of state.queue) {
      const li = document.createElement('li');
      const row = document.createElement('div');
      row.className = 'hist-item';

      if (item.thumbnail) {
        const img = document.createElement('img');
        img.src = item.thumbnail;
        img.alt = '';
        img.loading = 'lazy';
        img.addEventListener('error', () => img.remove());
        row.appendChild(img);
      }

      const body = document.createElement('div');
      body.className = 'hist-body';
      const title = document.createElement('strong');
      title.textContent = item.name || item.title || item.url;
      const meta = document.createElement('span');
      meta.textContent = item.status === 'error'
        ? item.error
        : [ltr(`${item.bitrate} kbps`), item.blob ? ltr(fmtSize(item.blob.size)) : ''].filter(Boolean).join(' · ');
      body.append(title, meta);
      row.appendChild(body);

      if (item.status === 'done' && item.blob) {
        const save = document.createElement('button');
        save.type = 'button';
        save.className = 'q-save';
        save.textContent = 'שמירה';
        save.addEventListener('click', () => saveBlob(item));
        row.appendChild(save);
      } else {
        const state_ = document.createElement('span');
        state_.className = `q-state is-${item.status}`;
        state_.textContent = words[item.status] || item.status;
        row.appendChild(state_);
      }

      li.appendChild(row);
      frag.appendChild(li);
    }
    el.queueList.replaceChildren(frag);
  }

  function saveBlob(item) {
    const href = URL.createObjectURL(item.blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = item.fileName || 'audio.mp3';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 30000);
  }

  function enqueue() {
    const spec = currentSpec();
    if (!isUrl(spec.url)) { toast('אין קישור להוסיף'); return; }

    state.queue.push({ ...spec, id: `${Date.now()}-${state.queue.length}`, status: 'waiting', blob: null });
    toast('נוסף לתור');
    buzz();

    // Clear the picker for the next one, leaving the queue to run on its own.
    el.url.value = '';
    state.info = null;
    state.phase = 'idle';
    clearResults();
    hidePlayer();
    render();
    runQueue();
  }

  async function runQueue() {
    if (state.running) return;             // one at a time: the server converts serially anyway
    state.running = true;
    try {
      for (;;) {
        const item = state.queue.find((q) => q.status === 'waiting');
        if (!item) break;
        item.status = 'running';
        renderQueue();
        try {
          const { blob, name } = await fetchMp3(item);
          item.blob = blob;
          item.fileName = name;
          item.status = 'done';
          pushHistory({
            url: item.url, title: item.name || item.title, thumbnail: item.thumbnail,
            bitrate: item.bitrate, filesize: blob.size, at: Date.now(),
          });
          saveBlob(item);                  // browsers may refuse a burst; the row keeps a button
        } catch (err) {
          item.status = 'error';
          item.error = err.message;
        }
        render();
      }
    } finally {
      state.running = false;
      render();
    }
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
      const info = await api('/api/info', { method: 'POST', body: JSON.stringify({ url }), timeout: 45000 });
      if (token !== infoToken) return; // a newer request won
      showInfo(info);
      state.phase = 'ready';
      render();
      if (autostart) start();
    } catch (err) {
      if (token !== infoToken) return;
      fail(err.message, err.reason);
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

    if (!state.mode) {
      el.pgLabel.textContent = 'מתחבר לשרת';
      el.pgSub.textContent = 'מעיר את השרת — כמה שניות בפעם הראשונה';
      if (!(await loadHealth())) {
        fail('שרת ההמרה לא זמין כרגע. נסו שוב בעוד רגע');
        return;
      }
    }

    if (state.mode === 'sync') { syncDownload(url); return; }

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

  function filenameFrom(header, fallback) {
    const raw = header || '';
    const utf8 = raw.match(/filename\*=(?:UTF-8|utf-8)''([^;]+)/);
    if (utf8) { try { return decodeURIComponent(utf8[1]); } catch { /* keep looking */ } }
    const plain = raw.match(/filename="([^"]+)"/) || raw.match(/filename=([^;]+)/);
    return plain ? plain[1].trim() : fallback;
  }

  function buildQuery(spec) {
    const q = new URLSearchParams({ url: spec.url, bitrate: spec.bitrate });
    if (spec.name) q.set('name', spec.name);
    if (spec.start) q.set('start', String(Math.round(spec.start)));
    if (spec.end) q.set('end', String(Math.round(spec.end)));
    return q.toString();
  }

  /**
   * Convert one video and return the finished audio.
   * `onProgress(received, total)` is called while the file is transferred; the
   * conversion itself gives nothing to report until the server starts sending.
   */
  async function fetchMp3(spec, onProgress) {
    // The direct endpoint avoids a hosting proxy's request cap; same origin is
    // the fallback if it cannot be reached.
    const bases = [state.direct, state.server].filter((v, i, a) => v && a.indexOf(v) === i);
    const query = buildQuery(spec);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 900000);
    try {
      let res = null;
      let lastError = null;
      for (const base of bases) {
        try {
          const attempt = await fetch(`${base}/api/download?${query}`, { signal: ctrl.signal });
          if (attempt.ok) { res = attempt; break; }
          const data = await attempt.json().catch(() => ({}));
          const detail = data.detail;
          const message = detail && typeof detail === 'object'
            ? (detail.message || `שגיאת שרת (${attempt.status})`)
            : (detail || `שגיאת שרת (${attempt.status})`);
          lastError = new Error(message);
          if (detail && typeof detail === 'object') lastError.reason = detail.reason || '';
          // a gateway or missing route is the path's fault, not the request's
          if (![502, 503, 504, 404].includes(attempt.status)) break;
        } catch (err) {
          if (err.name === 'AbortError') throw err;
          lastError = new Error('אין חיבור לשרת ההמרה');
        }
      }
      if (!res) throw lastError || new Error('ההמרה נכשלה');

      const name = filenameFrom(res.headers.get('Content-Disposition'), 'audio.mp3');
      const total = Number(res.headers.get('Content-Length')) || 0;

      let blob;
      if (res.body && total) {
        const reader = res.body.getReader();
        const chunks = [];
        let got = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          got += value.length;
          onProgress?.(got, total);
        }
        blob = new Blob(chunks, { type: 'audio/mpeg' });
      } else {
        onProgress?.(0, 0);
        blob = await res.blob();
      }
      return { blob, name };
    } finally {
      clearTimeout(timer);
    }
  }

  async function syncDownload(url) {
    const spec = currentSpec(url);

    el.pgLabel.textContent = 'מוריד וממיר';
    el.pgSub.textContent = `מקודד ב‑${ltr(`${state.bitrate} kbps`)} · זה יכול לקחת עד דקה`;
    setProgress(0, true);

    try {
      const { blob, name } = await fetchMp3(spec, (got, total) => {
        if (!total) return;
        el.pgLabel.textContent = 'מעביר את הקובץ';
        setProgress((got / total) * 100);
        el.pgSub.textContent = `${ltr(fmtSize(got))} מתוך ${ltr(fmtSize(total))}`;
      });

      if (state.lastFile && state.lastFile.startsWith('blob:')) URL.revokeObjectURL(state.lastFile);
      finish(
        { title: spec.name || state.info?.title, filesize: blob.size, duration: spec.duration },
        URL.createObjectURL(blob),
        name
      );
    } catch (err) {
      fail(err.name === 'AbortError' ? 'ההמרה ארכה יותר מדי וההורדה בוטלה' : err.message, err.reason);
    }
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

  function finish(s, fileUrl, fileName) {
    stopStream();
    state.phase = 'done';
    state.lastFile = fileUrl || `${state.server}/api/jobs/${state.job}/file`;
    state.lastName = fileName || s.filename || '';

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
    a.download = state.lastName || '';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /* ---------- events ---------- */

  function reflectFieldMode() {
    // SVG elements are not HTMLElements, so setting .hidden on them does
    // nothing; the state lives on the container as a class instead.
    el.iconSearch.parentElement.classList.toggle('is-link', isUrl(el.url.value.trim()));
    el.fieldHint.hidden = Boolean(el.url.value.trim());
  }

  let typeTimer;
  el.url.addEventListener('input', () => {
    reflectFieldMode();
    render();
    clearTimeout(typeTimer);
    const v = el.url.value.trim();

    if (isUrl(v)) {
      clearResults();
      typeTimer = setTimeout(() => loadInfo(v), 450);
    } else if (v.length >= 2) {
      typeTimer = setTimeout(() => runSearch(v), 550);   // plain words are a search
    } else {
      clearResults();
      render();
    }
  });

  el.url.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    el.url.blur();
    const v = el.url.value.trim();
    if (isUrl(v)) loadInfo(v);
    else if (v.length >= 2) runSearch(v);
  });

  el.clear.addEventListener('click', () => {
    el.url.value = '';
    state.info = null;
    state.phase = 'idle';
    clearResults();
    hidePlayer();
    stopStream();
    render();
    el.url.focus();
  });

  el.paste.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      const url = firstUrl(text);
      buzz();
      if (url) { el.url.value = url; loadInfo(url); return; }
      const words = (text || '').trim();
      if (words.length >= 2) { el.url.value = words; runSearch(words); return; }
      toast('אין קישור בלוח');
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

    // The finished file is at the old bitrate, so offer the download again.
    if (state.phase === 'done') {
      state.phase = 'ready';
      render();
    }
  });

  el.main.addEventListener('click', () => {
    if (state.phase === 'done') { saveFile(); return; }
    if (state.phase === 'ready' || state.phase === 'error') { start(); return; }
    const v = el.url.value.trim();
    if (isUrl(v)) loadInfo(v, { autostart: true });
    else el.url.focus();
  });

  el.trimToggle.addEventListener('click', () => {
    state.trimOn = !state.trimOn;
    el.trimToggle.setAttribute('aria-checked', String(state.trimOn));
    el.trimBody.hidden = !state.trimOn;
    buzz();
    if (state.phase === 'done') { state.phase = 'ready'; render(); }
  });

  el.name.addEventListener('input', () => {
    if (state.phase === 'done') { state.phase = 'ready'; render(); }
  });

  el.queueAdd.addEventListener('click', enqueue);

  el.clearQueue.addEventListener('click', () => {
    state.queue = state.queue.filter((q) => q.status === 'running');
    render();
  });

  el.theme.addEventListener('click', toggleTheme);

  el.clearHistory.addEventListener('click', () => {
    localStorage.removeItem(LS.history);
    render();
    toast('ההיסטוריה נוקתה');
  });

  /* ---------- boot ---------- */

  function init() {
    applyTheme(localStorage.getItem(LS.theme));

    for (const c of el.chips.children) {
      const on = c.dataset.v === state.bitrate;
      c.classList.toggle('is-on', on);
      c.setAttribute('aria-checked', String(on));
    }
    el.qualityHint.textContent = ltr(`${state.bitrate} kbps`);
    el.build.textContent = ltr(`build ${BUILD}`);

    // Where the backend lives. Nothing here is configurable: the deployed app
    // serves its API from the same origin, and localhost gets the dev port.
    const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    state.server = local ? `${location.protocol}//${location.hostname}:8000` : location.origin;

    if (!local) state.direct = FALLBACK_API;   // a dev machine talks to its own bridge
    render();
    loadHealth();   // also wakes a cold instance, before anything is asked of it

    // Shared in from YouTube (Web Share Target) or opened with ?url=
    // A share can put the link in any of these — Android usually uses `text`,
    // and often wraps it in a sentence — so scan all of them together.
    const q = new URLSearchParams(location.search);
    const handoff = ['url', 'text', 'title'].map((k) => q.get(k)).filter(Boolean).join(' ');
    if (handoff) {
      const shared = firstUrl(handoff);
      window.history.replaceState(null, '', location.pathname);
      if (shared) {
        el.url.value = shared;
        render();
        loadInfo(shared, { autostart: YT_RE.test(shared) });
      } else {
        toast('לא נמצא קישור במה ששותף');
      }
    }

    if ('serviceWorker' in navigator) {
      // A page that is already open keeps running the old script until it is
      // reloaded, so hand control over as soon as a new build takes charge.
      const hadController = !!navigator.serviceWorker.controller;
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || reloading) return;
        reloading = true;
        location.reload();
      });
      addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
    }
  }

  init();
})();

/* YT-MP3 — front-end. No framework, no build step: parse, run, done. */
(() => {
  'use strict';

  const BUILD = '10';   // must match the tag in sw.js and the ?v= on the assets

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
    main: $('btn-main'), mainLabel: $('btn-main-label'),
    toast: $('toast'),
  };

  const LS = { bitrate: 'ytmp3.bitrate', history: 'ytmp3.history' };

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

  function fail(message, reason) {
    state.phase = 'error';
    el.errorText.textContent = message;
    el.errorReason.textContent = reason || '';
    el.errorReason.hidden = !reason;
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

  async function syncDownload(url) {
    // One request does the whole job, so there is no progress to poll until
    // the server starts sending the finished file.
    const query = `url=${encodeURIComponent(url)}&bitrate=${state.bitrate}`;
    // The direct endpoint avoids a hosting proxy's request cap; same origin is
    // the fallback if it cannot be reached.
    const bases = [state.direct, state.server].filter((v, i, a) => v && a.indexOf(v) === i);

    el.pgLabel.textContent = 'מוריד וממיר';
    el.pgSub.textContent = `מקודד ב‑${ltr(`${state.bitrate} kbps`)} · זה יכול לקחת עד דקה`;
    setProgress(0, true);

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
          lastError = new Error(data.detail || `שגיאת שרת (${attempt.status})`);
          // 4xx other than "not found" is the server's verdict, not a routing fault
          if (attempt.status < 500 && attempt.status !== 404) break;
        } catch (err) {
          if (err.name === 'AbortError') throw err;
          lastError = new Error('אין חיבור לשרת ההמרה');
        }
      }
      if (!res) throw lastError || new Error('ההמרה נכשלה');

      const name = filenameFrom(res.headers.get('Content-Disposition'), 'audio.mp3');
      const total = Number(res.headers.get('Content-Length')) || 0;

      el.pgLabel.textContent = 'מעביר את הקובץ';
      setProgress(0, !total);

      // Read the body so the transfer itself can drive the bar.
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
          setProgress((got / total) * 100);
          el.pgSub.textContent = `${ltr(fmtSize(got))} מתוך ${ltr(fmtSize(total))}`;
        }
        blob = new Blob(chunks, { type: 'audio/mpeg' });
      } else {
        blob = await res.blob();
      }

      if (state.lastFile && state.lastFile.startsWith('blob:')) URL.revokeObjectURL(state.lastFile);
      finish(
        { title: state.info?.title, filesize: blob.size, duration: state.info?.duration },
        URL.createObjectURL(blob),
        name
      );
    } catch (err) {
      fail(err.name === 'AbortError' ? 'ההמרה ארכה יותר מדי וההורדה בוטלה' : err.message);
    } finally {
      clearTimeout(timer);
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

  /* ---------- boot ---------- */

  function init() {
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

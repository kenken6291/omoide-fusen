/* おもいで付箋ボード — app.js  v1.6.0 */
(() => {
  'use strict';

  /* ============================================================
   * 設定・状態
   * ============================================================ */
  const CFG = window.APP_CONFIG || {};
  const VERSION = CFG.VERSION || '0.0.0';
  const KEY = { gas: 'omoide.gasUrl', token: 'omoide.token', user: 'omoide.user', view: 'omoide.view', voice: 'omoide.voice' };
  const COLORS = [
    { v: '#FFEF7A', n: 'きいろ' }, { v: '#FFB8D2', n: 'ピンク' }, { v: '#A9E3F2', n: 'みずいろ' },
    { v: '#CBEB98', n: 'きみどり' }, { v: '#FFC98A', n: 'オレンジ' },
  ];
  const PRESETS = ['海に行った日', '美味しいご飯', '笑顔の思い出', '旅先の風景', '季節の花', '家族の集まり'];
  const VOICES = [
    { v: 'Kore', n: 'Kore（落ち着いた声）' }, { v: 'Aoede', n: 'Aoede（軽やかな声）' },
    { v: 'Sulafat', n: 'Sulafat（あたたかい声）' }, { v: 'Achird', n: 'Achird（やさしい声）' },
    { v: 'Charon', n: 'Charon（低めの声）' }, { v: 'Puck', n: 'Puck（明るい声）' },
  ];
  const NOTE_W = 220, NOTE_H = 280;
  const MIN_SEC = Number(CFG.NARRATION_MIN_SEC) || 6.5;
  const FLIGHT_KM = Number(CFG.FLIGHT_DISTANCE_KM) || 30;
  const UPLOAD_PARALLEL = Number(CFG.UPLOAD_PARALLEL) || 3;
  const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
  const LEAFLET_JS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
  const LEAFLET_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
  /** 閲覧のみのボードで使える操作（サーバー側の READONLY_ACTIONS と同じ） */
  const RO_ACTIONS = new Set(['bootstrap', 'getImages', 'listComments', 'tts']);
  /** 閲覧中でも自分のアカウントに対して行う操作 */
  const ACCOUNT_ACTIONS = new Set(['logout', 'listShares', 'addShare', 'removeShare', 'usage', 'me', 'changePassword']);
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const S = {
    token: localStorage.getItem(KEY.token) || '',
    user: parseJson(localStorage.getItem(KEY.user)),
    photos: [], photoMap: new Map(), themes: [], folder: null,
    view: { x: 40, y: 90, k: 1 },
    tempPassword: '', suggestions: [], menuTheme: null, editTheme: null,
    viewing: null, readOnly: false,
    shares: { granted: [], sharedWithMe: [] }, usage: null,
  };

  /* ============================================================
   * ユーティリティ
   * ============================================================ */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  function parseJson(s, d = null) { try { return s ? JSON.parse(s) : d; } catch (_) { return d; } }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const uniq = a => Array.from(new Set(a));
  const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
  const splitList = s => String(s || '').split(/[、,，\n]+/).map(x => x.trim()).filter(Boolean);
  const gasUrl = () => (localStorage.getItem(KEY.gas) || CFG.GAS_URL || '').trim();
  const voice = () => localStorage.getItem(KEY.voice) || CFG.TTS_VOICE || 'Kore';
  const theme = id => S.themes.find(t => t.themeId === id);
  const photo = id => S.photoMap.get(id) || { fileId: id };
  const viewKey = () => KEY.view + (S.viewing ? ':' + S.viewing.email : '');

  function fmtDate(s) {
    if (!s) return '';
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return '';
    return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
  }
  function fmtDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return String(iso);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function ymd() { return fmtDateTime(new Date().toISOString()).slice(0, 10).replace(/-/g, ''); }
  /** 撮影日時の正規化（空なら ''、読めなければ null） */
  function normDate(s) {
    s = String(s || '').trim();
    if (!s) return '';
    const m = s.match(/^(\d{4})[\/\-年.](\d{1,2})[\/\-月.](\d{1,2})日?(?:[ T]+(\d{1,2}):(\d{2}))?/);
    if (!m) return null;
    const p = n => String(n).padStart(2, '0');
    return `${m[1]}-${p(m[2])}-${p(m[3])}` + (m[4] ? ` ${p(m[4])}:${m[5]}` : '');
  }
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  function chrono(list) { return [...list].sort((a, b) => String(a.takenAt || '9').localeCompare(String(b.takenAt || '9'))); }
  function sampleEven(arr, n) {
    if (arr.length <= n) return arr;
    return Array.from({ length: n }, (_, i) => arr[Math.floor(i * arr.length / n)]);
  }
  function km(a, b) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const hasLoc = p => p && typeof p.lat === 'number' && typeof p.lng === 'number';

  let toastTimer;
  function toast(msg, type = 'info') {
    const t = $('#toast');
    t.textContent = msg; t.dataset.type = type; t.hidden = false;
    t.classList.remove('show'); void t.offsetWidth; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.classList.remove('show');
      toastTimer = setTimeout(() => { t.hidden = true; }, 300);
    }, type === 'error' ? 6500 : 3800);
  }
  function busy(msg) {
    if (msg === false) { $('#busy').hidden = true; return; }
    $('#busy-msg').textContent = msg || '処理しています…';
    $('#busy').hidden = false;
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('コピーしました。'); }
    catch (_) { toast('コピーできませんでした。手動で選択してください。', 'warn'); }
  }

  /* 外部ライブラリは必要になったときだけ読み込む（初回表示を速く） */
  const loadedScripts = {};
  function loadScript(src) {
    if (!loadedScripts[src]) {
      loadedScripts[src] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src; s.async = true;
        s.onload = resolve;
        s.onerror = () => { delete loadedScripts[src]; reject(new Error('ライブラリを読み込めませんでした。通信状態を確認してください。')); };
        document.head.appendChild(s);
      });
    }
    return loadedScripts[src];
  }
  function loadCss(href) {
    if (document.querySelector(`link[href="${href}"]`)) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = href;
    document.head.appendChild(l);
  }
  async function ensureLeaflet() {
    if (window.L) return;
    loadCss(LEAFLET_CSS);
    await loadScript(LEAFLET_JS);
  }

  /* ============================================================
   * 画像キャッシュ（IndexedDB：2回目以降はサーバーに取りに行かない）
   * ============================================================ */
  const IDB = (() => {
    let dbp = null;
    function db() {
      if (!dbp) {
        dbp = new Promise(resolve => {
          try {
            const r = indexedDB.open('omoide-fusen', 1);
            r.onupgradeneeded = () => r.result.createObjectStore('img');
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => resolve(null);
          } catch (_) { resolve(null); }
        });
      }
      return dbp;
    }
    return {
      async get(k) {
        const d = await db();
        if (!d) return null;
        return new Promise(resolve => {
          try {
            const q = d.transaction('img').objectStore('img').get(k);
            q.onsuccess = () => resolve(q.result || null);
            q.onerror = () => resolve(null);
          } catch (_) { resolve(null); }
        });
      },
      async set(k, v) {
        const d = await db();
        if (!d) return;
        try { d.transaction('img', 'readwrite').objectStore('img').put(v, k); } catch (_) { /* 容量不足は無視 */ }
      },
      async clear() {
        const d = await db();
        if (!d) return;
        try { d.transaction('img', 'readwrite').objectStore('img').clear(); } catch (_) { /* noop */ }
      },
    };
  })();

  /* ============================================================
   * API
   * ============================================================ */
  async function api(action, data = {}) {
    const url = gasUrl();
    if (!url || url.includes('XXXX')) {
      openSettings();
      throw new Error('GASのURLが設定されていません。設定画面で入力してください。');
    }
    const body = Object.assign({ action, token: S.token }, data);
    if (S.viewing) {
      if (RO_ACTIONS.has(action)) body.asOwner = S.viewing.email;
      else if (!ACCOUNT_ACTIONS.has(action)) throw new Error('閲覧のみのボードでは、この操作はできません。');
    }
    let res;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
      });
      res = await r.json();
    } catch (_) {
      throw new Error('サーバーに接続できません。GASのURLと、デプロイの「アクセスできるユーザー：全員」を確認してください。');
    }
    if (!res.ok) {
      if (res.code === 'AUTH') { clearSession(); showAuth('login'); }
      else if (res.code === 'FIRST_LOGIN') { showAuth('change'); }
      else if (res.code === 'NOSHARE' && S.viewing) { setTimeout(() => switchBoard(''), 0); }
      throw new Error(res.error || 'エラーが発生しました。');
    }
    if (res.usage) S.usage = res.usage;
    return res;
  }

  /* 画像ローダー：まとめて取得（サムネ16枚／中6枚／大3枚ずつ）＋ IndexedDB キャッシュ */
  const imgCache = new Map();
  const imgQueues = { full: [], mid: [], thumb: [] };
  const imgWaiters = new Map();
  const IMG_BATCH = { full: 3, mid: 6, thumb: 16 };
  let imgInflight = 0, imgTimer = null;
  function loadImg(fileId, size = 'thumb', priority = false) {
    const k = fileId + ':' + size;
    if (imgCache.has(k)) return imgCache.get(k);
    const p = IDB.get(k).then(hit => hit || new Promise((resolve, reject) => {
      imgWaiters.set(k, { resolve, reject });
      priority ? imgQueues[size].unshift(fileId) : imgQueues[size].push(fileId);
      if (!imgTimer) imgTimer = setTimeout(() => { imgTimer = null; pumpImg(); }, 25);
    }));
    imgCache.set(k, p);
    p.catch(() => imgCache.delete(k));
    return p;
  }
  function pumpImg() {
    while (imgInflight < 3) {
      const size = ['full', 'mid', 'thumb'].find(s => imgQueues[s].length);
      if (!size) return;
      const ids = uniq(imgQueues[size].splice(0, IMG_BATCH[size]));
      imgInflight++;
      api('getImages', { fileIds: ids, size })
        .then(r => {
          ids.forEach(id => {
            const k = id + ':' + size;
            const w = imgWaiters.get(k);
            imgWaiters.delete(k);
            const u = r.images && r.images[id];
            if (!w) return;
            if (u) { w.resolve(u); IDB.set(k, u); } else w.reject(new Error('画像を読み込めませんでした'));
          });
        })
        .catch(err => {
          ids.forEach(id => {
            const k = id + ':' + size;
            const w = imgWaiters.get(k);
            imgWaiters.delete(k);
            if (w) w.reject(err);
          });
        })
        .finally(() => { imgInflight--; pumpImg(); });
    }
  }

  /* ============================================================
   * 認証
   * ============================================================ */
  function setSession(token, user) {
    S.token = token; S.user = user;
    localStorage.setItem(KEY.token, token);
    localStorage.setItem(KEY.user, JSON.stringify(user));
  }
  function saveUser() { localStorage.setItem(KEY.user, JSON.stringify(S.user)); }
  function clearSession() {
    S.token = ''; S.user = null; S.viewing = null; S.readOnly = false;
    document.body.classList.remove('readonly');
    localStorage.removeItem(KEY.token); localStorage.removeItem(KEY.user);
    imgCache.clear();
    IDB.clear();
  }

  function showAuth(panel) {
    closeViewer(); closeLibrary(); hideMenu();
    $('#app').hidden = true; $('#auth').hidden = false;
    $$('#auth [data-panel]').forEach(p => { p.hidden = p.dataset.panel !== panel; });
    if (panel === 'change') $('[data-form="change"] [name="currentPassword"]').value = S.tempPassword || '';
    const first = $$(`#auth [data-panel="${panel}"] input`).find(i => !i.value);
    if (first) first.focus();
  }

  const EYE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
  $$('.eye').forEach(b => {
    b.innerHTML = EYE;
    b.addEventListener('click', () => {
      const input = b.previousElementSibling;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      b.innerHTML = show ? EYE_OFF : EYE;
      b.setAttribute('aria-pressed', String(show));
      b.setAttribute('aria-label', show ? 'パスワードを隠す' : 'パスワードを表示');
    });
  });

  $$('#auth [data-go]').forEach(b => b.addEventListener('click', () => showAuth(b.dataset.go)));
  $('#reg-copy').addEventListener('click', () => copyText($('#reg-temp-value').textContent));

  const authHandlers = {
    async login(f) {
      const email = f.elements.namedItem('email').value.trim(), password = f.elements.namedItem('password').value;
      if (!email || !password) throw new Error('メールアドレスとパスワードを入力してください。');
      const r = await api('login', { email, password });
      setSession(r.token, r.user);
      f.elements.namedItem('password').value = '';
      if (r.user.isFirstLogin) {
        S.tempPassword = password;
        showAuth('change');
        toast('仮パスワードでログインしました。新しいパスワードを設定してください。');
      } else {
        enterApp();
      }
    },
    async register(f) {
      const email = f.elements.namedItem('email').value.trim(), nickname = f.elements.namedItem('nickname').value.trim();
      if (!email || !nickname) throw new Error('メールアドレスとニックネームを入力してください。');
      const r = await api('register', { email, nickname });
      $('#reg-msg').textContent = r.message;
      $('#reg-temp').hidden = !r.tempPassword;
      $('#reg-temp-value').textContent = r.tempPassword || '';
      $('[data-form="login"] [name="email"]').value = email;
      f.reset();
      showAuth('registered');
    },
    async forgot(f) {
      const email = f.elements.namedItem('email').value.trim();
      if (!email) throw new Error('メールアドレスを入力してください。');
      const r = await api('forgotPassword', { email });
      $('[data-form="login"] [name="email"]').value = email;
      f.reset();
      showAuth('login');
      toast(r.message);
    },
    async change(f) {
      const cur = f.elements.namedItem('currentPassword').value, nw = f.elements.namedItem('newPassword').value, cf = f.elements.namedItem('confirmPassword').value;
      if (nw !== cf) throw new Error('確認用のパスワードが一致しません。');
      if (!/^(?=.*[A-Za-z])(?=.*\d).{8,64}$/.test(nw)) throw new Error('新しいパスワードは8文字以上で、英字と数字を両方含めてください。');
      await api('changePassword', { currentPassword: cur, newPassword: nw });
      S.user.isFirstLogin = false; saveUser();
      S.tempPassword = '';
      f.reset();
      toast('パスワードを変更しました。');
      enterApp();
    },
  };
  $$('#auth form[data-form]').forEach(f => f.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = f.querySelector('[type=submit]');
    btn.disabled = true;
    try { await authHandlers[f.dataset.form](f); }
    catch (err) { toast(err.message, 'error'); }
    finally { btn.disabled = false; }
  }));

  async function logout() {
    try { await api('logout'); } catch (_) { /* 期限切れでも続行 */ }
    clearSession();
    if ($('#dlg-settings').open) $('#dlg-settings').close();
    showAuth('login');
    toast('ログアウトしました。');
  }
  document.addEventListener('click', e => {
    if (e.target.closest('[data-action="logout"]')) logout();
    if (e.target.closest('[data-open-settings]')) openSettings();
    if (e.target.closest('[data-open-library]')) openLibrary();
  });

  /* ============================================================
   * 起動・ボード読み込み
   * ============================================================ */
  async function enterApp() {
    $('#auth').hidden = true; $('#app').hidden = false;
    await loadBoard();
    afterBoardLoaded();
  }
  async function loadBoard() {
    loadView(); applyView();
    busy(S.viewing ? `${S.viewing.nickname || S.viewing.email} さんのボードを読み込んでいます…` : 'ボードを読み込んでいます…');
    try {
      const r = await api('bootstrap');
      if (!S.viewing) {
        S.user = Object.assign({}, S.user, r.user); saveUser();
        S.folder = r.folder;
        S.shares = r.shares || S.shares;
        renderBoardSwitch();
      }
      S.themes = r.themes;
      setPhotos(r.photos);
      renderBoard();
      if (!localStorage.getItem(viewKey()) && S.themes.length) fitView();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      busy(false);
    }
  }

  /* 閲覧を許可されたボードへの切り替え */
  function renderBoardSwitch() {
    const list = S.shares.sharedWithMe || [];
    $('#board-switch-wrap').hidden = !list.length;
    $('#board-switch').innerHTML = '<option value="">自分のボード</option>' +
      list.map(o => `<option value="${esc(o.email)}">${esc(o.nickname || o.email)} さんのボード（閲覧のみ）</option>`).join('');
    $('#board-switch').value = S.viewing ? S.viewing.email : '';
  }
  $('#board-switch').addEventListener('change', e => switchBoard(e.target.value));
  async function switchBoard(email) {
    closeViewer(); closeLibrary(); hideMenu();
    const o = (S.shares.sharedWithMe || []).find(x => x.email === email);
    S.viewing = email && o ? o : null;
    S.readOnly = !!S.viewing;
    document.body.classList.toggle('readonly', S.readOnly);
    const banner = $('#readonly-banner');
    banner.hidden = !S.readOnly;
    if (S.readOnly) banner.textContent = `${S.viewing.nickname || S.viewing.email} さんのボードを見ています（閲覧のみ）`;
    $('#board-switch').value = S.viewing ? S.viewing.email : '';
    await loadBoard();
  }

  function setPhotos(list) {
    S.photos = list;
    S.photoMap = new Map(list.map(p => [p.fileId, p]));
    updatePhotoCount();
  }
  function mergePhotos(list) {
    list.forEach(p => {
      const i = S.photos.findIndex(x => x.fileId === p.fileId);
      if (i >= 0) S.photos[i] = p; else S.photos.push(p);
      S.photoMap.set(p.fileId, p);
    });
    updatePhotoCount();
  }
  function updatePhotoCount() { $('#photo-count').textContent = S.photos.length; }
  const analyzedCount = () => S.photos.filter(p => p.status === 'done').length;
  /** 対象の写真か（重複で外した写真・存在しない写真は除く） */
  const isActive = id => { const p = S.photoMap.get(id); return !!p && p.status !== 'dup'; };
  function membershipCount() {
    const m = new Map();
    S.themes.forEach(t => t.photoIds.forEach(id => m.set(id, (m.get(id) || 0) + 1)));
    return m;
  }

  /* ============================================================
   * ボード（付箋・パン・ズーム）
   * ============================================================ */
  const vp = $('#viewport');
  const boardEl = $('#board');

  function tilt(id) {
    let h = 0;
    for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
    return ((Math.abs(h) % 9) - 4) * 0.7;
  }
  function noteEl(t) {
    const el = document.createElement('article');
    const count = t.photoIds.filter(isActive).length;
    el.className = 'note';
    el.dataset.id = t.themeId;
    el.style.left = t.x + 'px';
    el.style.top = t.y + 'px';
    el.style.setProperty('--c', t.color || COLORS[0].v);
    el.style.setProperty('--r', tilt(t.themeId) + 'deg');
    el.tabIndex = 0;
    el.setAttribute('aria-label', `${t.title}（${count}枚）`);
    el.innerHTML = `
      <div class="note-photo"><img alt="" draggable="false"></div>
      <h3 class="note-title">${esc(t.title)}</h3>
      <span class="note-count">${count}枚</span>
      <button class="note-menu-btn" aria-label="${esc(t.title)}のメニュー">⋯</button>`;
    const cover = S.photoMap.has(t.coverFileId) ? t.coverFileId : t.photoIds.find(id => S.photoMap.has(id));
    const box = el.querySelector('.note-photo');
    if (cover) {
      loadImg(cover, 'thumb').then(u => { box.querySelector('img').src = u; box.classList.add('loaded'); }).catch(() => box.classList.add('empty'));
    } else {
      box.classList.add('empty');
    }
    return el;
  }
  function renderBoard() {
    boardEl.innerHTML = '';
    S.themes.forEach(t => boardEl.appendChild(noteEl(t)));
    $('#board-empty').hidden = S.themes.length > 0 || S.readOnly;
  }
  function replaceNote(t) {
    const old = boardEl.querySelector(`.note[data-id="${t.themeId}"]`);
    const el = noteEl(t);
    old ? old.replaceWith(el) : boardEl.appendChild(el);
    $('#board-empty').hidden = S.themes.length > 0;
  }
  function upsertTheme(t) {
    const i = S.themes.findIndex(x => x.themeId === t.themeId);
    if (i >= 0) S.themes[i] = t; else S.themes.push(t);
    replaceNote(t);
  }

  function applyView() {
    const { x, y, k } = S.view;
    boardEl.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
    vp.style.backgroundSize = `${24 * k}px ${24 * k}px`;
    vp.style.backgroundPosition = `${x}px ${y}px`;
  }
  let viewTimer;
  function saveView() {
    clearTimeout(viewTimer);
    const key = viewKey();
    viewTimer = setTimeout(() => localStorage.setItem(key, JSON.stringify(S.view)), 300);
  }
  function loadView() {
    const v = parseJson(localStorage.getItem(viewKey()));
    S.view = (v && isFinite(v.x) && isFinite(v.y) && isFinite(v.k)) ? v : { x: 40, y: 90, k: 1 };
  }
  function zoomAt(px, py, k) {
    k = clamp(k, 0.25, 2.5);
    const wx = (px - S.view.x) / S.view.k, wy = (py - S.view.y) / S.view.k;
    S.view = { k, x: px - wx * k, y: py - wy * k };
    applyView(); saveView();
  }
  function fitView() {
    const r = vp.getBoundingClientRect();
    if (!S.themes.length) { S.view = { x: 40, y: 90, k: 1 }; applyView(); saveView(); return; }
    const xs = S.themes.map(t => t.x), ys = S.themes.map(t => t.y);
    const minX = Math.min(...xs) - 40, minY = Math.min(...ys) - 40;
    const maxX = Math.max(...xs) + NOTE_W + 40, maxY = Math.max(...ys) + NOTE_H + 40;
    const top = 80;
    const k = clamp(Math.min(r.width / (maxX - minX), (r.height - top) / (maxY - minY)), 0.25, 1.2);
    S.view = { k, x: (r.width - (maxX - minX) * k) / 2 - minX * k, y: top + (r.height - top - (maxY - minY) * k) / 2 - minY * k };
    applyView(); saveView();
  }
  function viewCenterWorld() {
    const r = vp.getBoundingClientRect();
    return { x: (r.width / 2 - S.view.x) / S.view.k, y: (r.height / 2 - S.view.y) / S.view.k };
  }

  /* ポインター操作 */
  const pointers = new Map();
  let gesture = null;
  const rel = e => { const r = vp.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  vp.addEventListener('pointerdown', e => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (e.target.closest('.note-menu-btn')) return;
    hideMenu();
    vp.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, rel(e));
    if (pointers.size === 2) {
      if (gesture && gesture.type === 'note') gesture.el.classList.remove('dragging');
      const [a, b] = [...pointers.values()];
      gesture = { type: 'pinch', d0: dist(a, b), m0: mid(a, b), v0: Object.assign({}, S.view) };
      return;
    }
    if (pointers.size > 2) return;
    const note = e.target.closest('.note');
    if (note && !S.readOnly) {
      const t = theme(note.dataset.id);
      gesture = { type: 'note', el: note, t, sx: e.clientX, sy: e.clientY, ox: t.x, oy: t.y, moved: false };
      note.classList.add('dragging');
      boardEl.appendChild(note);
    } else {
      gesture = { type: 'pan', sx: e.clientX, sy: e.clientY, v0: Object.assign({}, S.view), moved: false, note };
      vp.classList.add('panning');
    }
  });
  vp.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId) || !gesture) return;
    pointers.set(e.pointerId, rel(e));
    if (gesture.type === 'pinch' && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const k = clamp(gesture.v0.k * dist(a, b) / gesture.d0, 0.25, 2.5);
      const m = mid(a, b);
      const wx = (gesture.m0.x - gesture.v0.x) / gesture.v0.k, wy = (gesture.m0.y - gesture.v0.y) / gesture.v0.k;
      S.view = { k, x: m.x - wx * k, y: m.y - wy * k };
      applyView();
    } else if (gesture.type === 'note') {
      const dx = (e.clientX - gesture.sx) / S.view.k, dy = (e.clientY - gesture.sy) / S.view.k;
      if (Math.abs(dx) + Math.abs(dy) > 4 / S.view.k) gesture.moved = true;
      gesture.t.x = Math.round(gesture.ox + dx);
      gesture.t.y = Math.round(gesture.oy + dy);
      gesture.el.style.left = gesture.t.x + 'px';
      gesture.el.style.top = gesture.t.y + 'px';
    } else if (gesture.type === 'pan') {
      const dx = e.clientX - gesture.sx, dy = e.clientY - gesture.sy;
      if (Math.abs(dx) + Math.abs(dy) > 4) gesture.moved = true;
      S.view = { k: gesture.v0.k, x: gesture.v0.x + dx, y: gesture.v0.y + dy };
      applyView();
    }
  });
  function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (!gesture) return;
    if (gesture.type === 'note') {
      gesture.el.classList.remove('dragging');
      if (gesture.moved) saveNotePos(gesture.t);
      else if (e.type === 'pointerup') openViewer(gesture.t);
      gesture = null;
    } else if (gesture.type === 'pinch') {
      if (pointers.size < 2) { gesture = null; saveView(); }
    } else {
      vp.classList.remove('panning');
      if (!gesture.moved && gesture.note && e.type === 'pointerup') openViewer(theme(gesture.note.dataset.id));
      gesture = null; saveView();
    }
  }
  vp.addEventListener('pointerup', endPointer);
  vp.addEventListener('pointercancel', endPointer);
  vp.addEventListener('wheel', e => {
    e.preventDefault();
    const p = rel(e);
    zoomAt(p.x, p.y, S.view.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
  }, { passive: false });
  vp.addEventListener('keydown', e => {
    const note = e.target.closest('.note');
    if (note && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openViewer(theme(note.dataset.id)); }
  });

  $$('[data-zoom]').forEach(b => b.addEventListener('click', () => {
    const r = vp.getBoundingClientRect();
    if (b.dataset.zoom === 'fit') return fitView();
    zoomAt(r.width / 2, r.height / 2, S.view.k * (b.dataset.zoom === 'in' ? 1.25 : 0.8));
  }));

  const posTimers = {};
  function saveNotePos(t) {
    clearTimeout(posTimers[t.themeId]);
    posTimers[t.themeId] = setTimeout(() => {
      api('updateTheme', { themeId: t.themeId, fields: { x: t.x, y: t.y } })
        .catch(err => toast('位置を保存できませんでした: ' + err.message, 'error'));
    }, 500);
  }

  /* 付箋メニュー */
  const menu = $('#note-menu');
  boardEl.addEventListener('click', e => {
    const btn = e.target.closest('.note-menu-btn');
    if (!btn || S.readOnly) return;
    e.stopPropagation();
    S.menuTheme = theme(btn.closest('.note').dataset.id);
    const r = btn.getBoundingClientRect();
    menu.hidden = false;
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = clamp(r.right - mw, 8, innerWidth - mw - 8) + 'px';
    menu.style.top = (r.bottom + mh + 8 > innerHeight ? r.top - mh - 6 : r.bottom + 6) + 'px';
    menu.querySelector('button').focus();
  });
  function hideMenu() { menu.hidden = true; }
  document.addEventListener('pointerdown', e => { if (!menu.hidden && !e.target.closest('#note-menu')) hideMenu(); });
  menu.addEventListener('keydown', e => { if (e.key === 'Escape') hideMenu(); });
  menu.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const t = S.menuTheme;
    hideMenu();
    if (!t) return;
    const act = b.dataset.act;
    if (act === 'open') return openViewer(t);
    if (act === 'organize') return openOrganize(t);
    if (act === 'edit') return openEdit(t);
    if (act === 'earth') return openEarth(t);
    if (act === 'delete') {
      if (!confirm(`「${t.title}」の付箋をはがしますか？（写真そのものは消えません）`)) return;
      try {
        await api('deleteTheme', { themeId: t.themeId });
        S.themes = S.themes.filter(x => x.themeId !== t.themeId);
        renderBoard();
        toast('付箋をはがしました。');
      } catch (err) { toast(err.message, 'error'); }
      return;
    }
    if (act === 'refresh') {
      busy('写真を探し直しています…');
      try {
        const r = await api('refreshTheme', { themeId: t.themeId, mode: 'auto' });
        upsertTheme(r.theme);
        toast(`${r.matched}枚の写真が見つかりました（${r.method === 'ai' ? 'AIで検索' : 'キーワードで検索・AI不使用'}）。外した写真は戻していません。`);
      } catch (err) { toast(err.message, 'error'); } finally { busy(false); }
      return;
    }
    if (act === 'narration') {
      busy('ナレーションを書いています…');
      try {
        const r = await api('generateNarration', { themeId: t.themeId });
        t.narration = r.narration;
        toast('ナレーションを作り直しました。走馬灯で流れます。');
      } catch (err) { toast(err.message, 'error'); } finally { busy(false); }
    }
  });

  /* ============================================================
   * ダイアログ共通
   * ============================================================ */
  $$('dialog [data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
  function renderSwatches(name, current) {
    const box = $(`[data-swatches="${name}"]`);
    box.innerHTML = COLORS.map((c, i) => `
      <label title="${c.n}"><input type="radio" name="color" value="${c.v}" ${(current ? c.v === current : i === 0) ? 'checked' : ''} aria-label="${c.n}"><span style="--c:${c.v}"></span></label>`).join('');
  }
  const nextColor = () => COLORS[S.themes.length % COLORS.length].v;
  function newNotePos(i = 0, cols = 1) {
    const c = viewCenterWorld();
    return {
      x: Math.round(c.x - NOTE_W / 2 + (i % cols) * 260 + (Math.random() * 40 - 20)),
      y: Math.round(c.y - NOTE_H / 2 + Math.floor(i / cols) * 310 + (Math.random() * 40 - 20)),
    };
  }

  /* テーマを作る */
  $('#preset-chips').innerHTML = PRESETS.map(p => `<button type="button">${esc(p)}</button>`).join('');
  $('#preset-chips').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b) $('#dlg-new [name=title]').value = b.textContent;
  });
  $('#btn-new').addEventListener('click', () => {
    if (!S.photos.length) { toast('先に写真を用意してください。', 'warn'); openLibrary(); return; }
    $('#dlg-new form').reset();
    renderSwatches('new', nextColor());
    $('#dlg-new').showModal();
  });
  $('#dlg-new form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const title = f.elements.namedItem('title').value.trim();
    if (!title) return toast('テーマを入力してください。', 'warn');
    const color = (f.querySelector('[name=color]:checked') || {}).value;
    const mode = (f.querySelector('[name=mode]:checked') || {}).value || 'auto';
    $('#dlg-new').close();
    busy(`「${title}」に合う写真を探しています…`);
    try {
      const r = await api('createTheme', Object.assign({ title, color, mode }, newNotePos()));
      upsertTheme(r.theme);
      const how = r.method === 'ai' ? 'AIで検索' : 'キーワードで検索・AI不使用';
      toast(r.matched ? `${r.matched}枚の写真で付箋を貼りました（${how}）。` : `合う写真が見つかりませんでした（${how}）。別の言葉か「AIで探す」を試してください。`, r.matched ? 'info' : 'warn');
    } catch (err) { toast(err.message, 'error'); } finally { busy(false); }
  });

  /* 名前と色 */
  function openEdit(t) {
    S.editTheme = t;
    const f = $('#dlg-edit form');
    f.elements.namedItem('title').value = t.title;
    renderSwatches('edit', t.color);
    $('#dlg-edit').showModal();
  }
  $('#dlg-edit form').addEventListener('submit', async e => {
    e.preventDefault();
    const t = S.editTheme, f = e.target;
    const title = f.elements.namedItem('title').value.trim();
    const color = (f.querySelector('[name=color]:checked') || {}).value;
    if (!title) return toast('テーマを入力してください。', 'warn');
    try {
      const r = await api('updateTheme', { themeId: t.themeId, fields: { title, color } });
      upsertTheme(r.theme);
      $('#dlg-edit').close();
      toast('変更を保存しました。');
    } catch (err) { toast(err.message, 'error'); }
  });

  /* 写真を整理する（関係ない写真を外す・表紙を選ぶ） */
  let ORG = null;
  function openOrganize(t) {
    const ids = t.photoIds.filter(id => S.photoMap.has(id));
    ORG = { t, ids, out: new Set(), cover: ids.includes(t.coverFileId) ? t.coverFileId : (ids[0] || '') };
    $('#org-title').textContent = `「${t.title}」の写真を整理する`;
    const grid = $('#org-grid');
    grid.innerHTML = ids.length ? ids.map(id => `
      <div class="org-item${id === ORG.cover ? ' cover' : ''}" data-file="${esc(id)}">
        <img alt="">
        <button type="button" class="cover-btn" aria-label="表紙にする">★</button>
        <button type="button" class="out-btn">外す</button>
      </div>`).join('') : '<p class="muted">写真がありません。</p>';
    $$('.org-item', grid).forEach(el => loadImg(el.dataset.file, 'thumb').then(u => { el.querySelector('img').src = u; }).catch(() => {}));
    updateOrgCount();
    $('#dlg-organize').showModal();
  }
  function updateOrgCount() {
    $('#org-count').textContent = `${ORG.ids.length}枚中 ${ORG.out.size}枚を外します。`;
  }
  $('#org-grid').addEventListener('click', e => {
    const item = e.target.closest('.org-item');
    if (!item || !ORG) return;
    const id = item.dataset.file;
    if (e.target.closest('.cover-btn')) {
      ORG.cover = id;
      ORG.out.delete(id);
      $$('.org-item', $('#org-grid')).forEach(el => el.classList.toggle('cover', el.dataset.file === id));
      item.classList.remove('out');
      item.querySelector('.out-btn').textContent = '外す';
    } else {
      const out = !ORG.out.has(id);
      out ? ORG.out.add(id) : ORG.out.delete(id);
      item.classList.toggle('out', out);
      item.querySelector('.out-btn').textContent = out ? '戻す' : '外す';
    }
    updateOrgCount();
  });
  $('#dlg-organize form').addEventListener('submit', async e => {
    e.preventDefault();
    const t = ORG.t;
    const keep = ORG.ids.filter(id => !ORG.out.has(id));
    const cover = keep.includes(ORG.cover) ? ORG.cover : (keep[0] || '');
    if (!ORG.out.size && cover === t.coverFileId && keep.length === t.photoIds.length) { $('#dlg-organize').close(); return; }
    try {
      const r = await api('updateTheme', {
        themeId: t.themeId,
        fields: { photoIds: keep, excludedIds: uniq((t.excludedIds || []).concat([...ORG.out])), coverFileId: cover },
      });
      upsertTheme(r.theme);
      $('#dlg-organize').close();
      toast(ORG.out.size ? `${ORG.out.size}枚を付箋から外しました。` : '保存しました。');
    } catch (err) { toast(err.message, 'error'); }
  });

  /* AIにテーマを提案してもらう */
  $('#btn-suggest').addEventListener('click', async () => {
    if (analyzedCount() < 3) { toast('解析済みの写真が3枚以上必要です。', 'warn'); openLibrary(); return; }
    busy('AIが写真を見比べて、テーマを考えています…');
    let r;
    try { r = await api('suggestThemes'); }
    catch (err) { toast(err.message, 'error'); return; }
    finally { busy(false); }
    S.suggestions = r.suggestions || [];
    if (!S.suggestions.length) return toast('テーマを提案できませんでした。写真を増やして試してください。', 'warn');
    const ul = $('#suggest-list');
    ul.innerHTML = S.suggestions.map((s, i) => `
      <li>
        <input type="checkbox" checked data-i="${i}" aria-label="${esc(s.title)}を貼る">
        <span class="sg-thumb" data-file="${esc(s.coverFileId)}"></span>
        <input type="text" value="${esc(s.title)}" data-title="${i}" maxlength="30" aria-label="テーマ名">
        <span class="muted">${s.photoIds.length}枚</span>
      </li>`).join('');
    $$('.sg-thumb', ul).forEach(el => {
      if (el.dataset.file) loadImg(el.dataset.file, 'thumb').then(u => { el.style.backgroundImage = `url("${u}")`; }).catch(() => {});
    });
    $('#dlg-suggest').showModal();
  });
  $('#dlg-suggest form').addEventListener('submit', async e => {
    e.preventDefault();
    const picks = $$('#suggest-list [data-i]').filter(c => c.checked).map(c => {
      const i = Number(c.dataset.i);
      return Object.assign({}, S.suggestions[i], { title: ($(`#suggest-list [data-title="${i}"]`).value || '').trim() || S.suggestions[i].title });
    });
    if (!picks.length) return toast('テーマを1つ以上選んでください。', 'warn');
    $('#dlg-suggest').close();
    const cols = Math.min(4, picks.length);
    let added = 0;
    for (let i = 0; i < picks.length; i++) {
      busy(`付箋を貼っています… ${i + 1} / ${picks.length}`);
      const p = picks[i];
      try {
        const r = await api('createTheme', Object.assign({
          title: p.title, photoIds: p.photoIds, coverFileId: p.coverFileId, color: nextColor(),
        }, newNotePos(i, cols)));
        upsertTheme(r.theme);
        added++;
      } catch (err) { toast(err.message, 'error'); }
    }
    busy(false);
    if (added) toast(`${added}枚の付箋を貼りました。`);
  });

  /* 撮影地と映像（Google Earth Studio 連携） */
  function openEarth(t) {
    S.editTheme = t;
    const seen = new Set();
    const pts = chrono(t.photoIds.map(photo)).filter(hasLoc).filter(p => {
      const k = p.lat.toFixed(2) + ',' + p.lng.toFixed(2);
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
    $('#earth-list').innerHTML = pts.length ? pts.map(p => {
      const link = `https://earth.google.com/web/@${p.lat},${p.lng},200a,2500d,35y,0h,60t,0r`;
      const coord = `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`;
      return `<li>
        <span class="place">${esc(p.place || '撮影地')}</span>
        <span class="acts"><a class="link" href="${link}" target="_blank" rel="noopener">Google Earthで見る</a><button type="button" class="link" data-copy="${coord}">座標をコピー</button></span>
        <span class="muted">${esc(fmtDate(p.takenAt))}　緯度 ${p.lat.toFixed(5)} ／ 経度 ${p.lng.toFixed(5)}</span>
      </li>`;
    }).join('') : '<li class="muted">位置情報つきの写真がありません。写真の情報で緯度・経度を入れると表示されます。</li>';
    $('#dlg-earth [name=earthVideoUrl]').value = t.earthVideoUrl || '';
    $('#dlg-earth').showModal();
  }
  $('#earth-list').addEventListener('click', e => {
    const b = e.target.closest('[data-copy]');
    if (b) copyText(b.dataset.copy);
  });
  $('#dlg-earth form').addEventListener('submit', async e => {
    e.preventDefault();
    const t = S.editTheme;
    try {
      const r = await api('updateTheme', { themeId: t.themeId, fields: { earthVideoUrl: e.target.elements.namedItem('earthVideoUrl').value.trim() } });
      upsertTheme(r.theme);
      $('#dlg-earth').close();
      toast('映像を保存しました。走馬灯の最初に流れます。');
    } catch (err) { toast(err.message, 'error'); }
  });

  /* ============================================================
   * 設定（AI利用状況・閲覧の許可）
   * ============================================================ */
  const voiceSel = $('#dlg-settings [name=voice]');
  voiceSel.innerHTML = VOICES.map(v => `<option value="${v.v}">${esc(v.n)}</option>`).join('');
  function renderUsage() {
    const u = S.usage;
    if (!u) { $('#usage-text').textContent = '—'; return; }
    const used = (u.t || 0) + (u.i || 0) + (u.s || 0);
    $('#usage-text').textContent =
      `文章 ${u.t || 0}回 ／ 画像解析 ${u.i || 0}枚 ／ 音声生成 ${u.s || 0}回（保存済み音声の再利用 ${u.c || 0}回）` +
      (u.limit > 0 ? `　上限 ${u.limit}回のうち残り ${Math.max(0, u.limit - used)}回` : '　上限なし');
  }
  function renderShares() {
    const list = S.shares.granted || [];
    $('#share-list').innerHTML = list.length ? list.map(s => `
      <li><span>${esc(s.nickname || '（未登録）')}　<span class="muted small">${esc(s.email)}</span></span>
      <button type="button" class="link danger" data-unshare="${esc(s.email)}">やめる</button></li>`).join('')
      : '<li class="empty">まだ誰にも許可していません。</li>';
  }
  async function openSettings() {
    const d = $('#dlg-settings');
    if (d.open) return;
    d.querySelector('[name=gasUrl]').value = localStorage.getItem(KEY.gas) || '';
    d.querySelector('[name=gasUrl]').placeholder = CFG.GAS_URL || 'https://script.google.com/macros/s/…/exec';
    voiceSel.value = voice();
    const member = !!(S.token && S.user && !S.user.isFirstLogin);
    $('#settings-member').hidden = !member;
    if (member) {
      $('#acc-name').textContent = S.user.nickname || '';
      $('#acc-email').textContent = S.user.email || '';
      renderUsage(); renderShares();
    }
    d.showModal();
    if (member) {
      api('usage').then(r => { S.usage = r.usage; renderUsage(); }).catch(() => {});
      api('listShares').then(r => { S.shares = r; renderShares(); renderBoardSwitch(); }).catch(() => {});
    }
  }
  $('#dlg-settings form').addEventListener('submit', e => {
    e.preventDefault();
    const url = e.target.elements.namedItem('gasUrl').value.trim();
    if (url && !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) {
      return toast('URLは https://script.google.com/macros/s/…/exec の形式で入力してください。', 'warn');
    }
    url ? localStorage.setItem(KEY.gas, url) : localStorage.removeItem(KEY.gas);
    localStorage.setItem(KEY.voice, voiceSel.value);
    $('#dlg-settings').close();
    toast('設定を保存しました。');
  });
  $('#btn-test').addEventListener('click', async () => {
    const url = $('#dlg-settings [name=gasUrl]').value.trim() || CFG.GAS_URL;
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'ping' }) });
      const j = await r.json();
      toast(j.ok ? `接続できました（サーバー v${j.version}）。` : 'サーバーから応答はありましたが、エラーでした。', j.ok ? 'info' : 'warn');
    } catch (_) { toast('接続できませんでした。URLとデプロイ設定を確認してください。', 'error'); }
  });
  $('#btn-clear-cache').addEventListener('click', async () => {
    await IDB.clear();
    imgCache.clear();
    toast('画像キャッシュを消しました。');
  });
  $('#share-add').addEventListener('click', async () => {
    const email = $('#share-email').value.trim();
    if (!email) return toast('メールアドレスを入力してください。', 'warn');
    try {
      const r = await api('addShare', { email });
      S.shares = r.shares;
      renderShares();
      $('#share-email').value = '';
      toast(r.registered ? '閲覧を許可し、お知らせメールを送りました。' : 'まだ未登録の方です。このメールアドレスで登録すると見られるようになります（お知らせメールを送りました）。');
    } catch (err) { toast(err.message, 'error'); }
  });
  $('#share-list').addEventListener('click', async e => {
    const b = e.target.closest('[data-unshare]');
    if (!b || !confirm(`${b.dataset.unshare} さんへの閲覧の許可をやめますか？`)) return;
    try {
      const r = await api('removeShare', { email: b.dataset.unshare });
      S.shares = r.shares;
      renderShares();
    } catch (err) { toast(err.message, 'error'); }
  });

  /* ============================================================
   * 写真ライブラリ
   * ============================================================ */
  const lib = $('#library');
  const LIB = { selecting: false, selected: new Set(), q: '', filter: 'all' };
  let gridObserver;
  $('#btn-photos').addEventListener('click', openLibrary);
  $('[data-close-library]').addEventListener('click', closeLibrary);
  function openLibrary() {
    if (!S.token || S.readOnly) return;
    lib.hidden = false;
    document.body.classList.add('lock');
    renderFolder();
    renderPhotoGrid();
    renderShareBar();
  }
  function closeLibrary() {
    if (lib.hidden) return;
    lib.hidden = true;
    document.body.classList.remove('lock');
    setSelecting(false, true);
    renderBoard();
  }
  function renderFolder() {
    const f = S.folder;
    $('#folder-label').textContent = f ? (f.error || ((f.name || '—') + (f.isHome ? '（最初のフォルダ）' : ''))) : '—';
    const a = $('#folder-link');
    if (f && f.url) a.href = f.url; else a.removeAttribute('href');
    $('#folder-home').hidden = !f || f.isHome;
  }
  $('#folder-form').addEventListener('submit', async e => {
    e.preventDefault();
    const v = e.target.elements.namedItem('folder').value.trim();
    if (!v) return toast('フォルダのURLまたはIDを入力してください。', 'warn');
    await changeFolder(v);
    e.target.reset();
  });
  $('#folder-home').addEventListener('click', () => changeFolder('home'));
  async function changeFolder(v) {
    busy('フォルダを確認しています…');
    try {
      const r = await api('setFolder', { folder: v });
      S.folder = r.folder;
      renderFolder();
      toast('フォルダを変更しました。「フォルダを読み込む」で写真を取り込めます。');
    } catch (err) { toast(err.message, 'error'); } finally { busy(false); }
  }

  $('#btn-scan').addEventListener('click', async () => {
    busy('フォルダの写真を読み込んでいます…（2階層下まで）');
    try {
      const r = await api('scanFolder');
      setPhotos(r.photos);
      renderPhotoGrid();
      toast(`${r.added}枚を追加${r.removed ? `、${r.removed}枚をリストから外しました` : 'しました'}。${r.duplicates ? `うち${r.duplicates}枚は重複のため対象から外しました（「重複で外した写真」で確認できます）。` : ''}`);
    } catch (err) { toast(err.message, 'error'); } finally { busy(false); }
  });

  let stopFlag = false;
  $('#btn-stop').addEventListener('click', () => { stopFlag = true; });
  function progress(show, ratio = 0, text = '') {
    const p = $('#progress');
    p.hidden = !show;
    if (!show) return;
    p.querySelector('i').style.width = Math.round(clamp(ratio, 0, 1) * 100) + '%';
    p.querySelector('p').textContent = text;
  }
  function libBusy(on) {
    ['#btn-scan', '#btn-analyze', '#file-input', '#dir-input', '#sel-analyze', '#sel-to-theme', '#sel-bulk', '#sel-dup', '#sel-restore', '#btn-dups', '#excel-in', '#btn-excel-out']
      .forEach(s => { $(s).disabled = on; });
  }

  /* AI解析（未解析のみ。1回のサーバー呼び出しで8枚、Geminiへは4枚ずつまとめて送る） */
  async function runAnalyze(opts) {
    stopFlag = false; libBusy(true);
    let done = 0;
    const total = opts.total;
    progress(true, 0, `解析中… 0 / ${total}`);
    try {
      if (opts.fileIds) {
        for (let i = 0; i < opts.fileIds.length && !stopFlag; i += 8) {
          const r = await api('analyzeBatch', { fileIds: opts.fileIds.slice(i, i + 8), limit: 8 });
          mergePhotos(r.photos || []);
          done += r.processed;
          progress(true, done / total, `解析中… ${Math.min(done, total)} / ${total}`);
          renderPhotoGrid();
        }
      } else {
        while (!stopFlag) {
          const r = await api('analyzeBatch', { limit: 8, retryErrors: opts.retryErrors });
          mergePhotos(r.photos || []);
          done += r.processed;
          progress(true, done / total, `解析中… ${Math.min(done, total)} / ${total}`);
          renderPhotoGrid();
          if (!r.remaining || !r.processed) break;
        }
      }
      toast(stopFlag ? '解析を止めました。続きはもう一度「AIで解析する」を押してください。' : '解析が終わりました。');
    } catch (err) { toast(err.message, 'error'); }
    finally { progress(false); libBusy(false); }
  }
  $('#btn-analyze').addEventListener('click', () => {
    const pending = S.photos.filter(p => (p.status || 'pending') === 'pending').length;
    if (pending) return runAnalyze({ total: pending });
    const errs = S.photos.filter(p => p.status === 'error').length;
    if (errs && confirm(`解析できなかった写真が${errs}枚あります。もう一度解析しますか？`)) return runAnalyze({ total: errs, retryErrors: true });
    toast(S.photos.length ? 'すべて解析済みです。' : '先に写真を用意してください。');
  });

  /* 写真の追加（複数枚・フォルダごと、並列アップロード） */
  $('#file-input').addEventListener('change', e => { const f = [...e.target.files]; e.target.value = ''; uploadFiles(f, false); });
  $('#dir-input').addEventListener('change', e => { const f = [...e.target.files]; e.target.value = ''; uploadFiles(f, true); });
  async function uploadFiles(files, withPath) {
    let list = files.filter(f => /^image\//.test(f.type) || /\.(heic|heif)$/i.test(f.name));
    if (!list.length) return toast('画像ファイルがありませんでした。', 'warn');
    const big = list.filter(f => f.size > 15 * 1024 * 1024);
    list = list.filter(f => f.size <= 15 * 1024 * 1024);
    if (big.length) toast(`15MBを超える${big.length}枚は追加できません。`, 'warn');
    const names = new Set(S.photos.map(p => p.fileName));
    const dup = list.filter(f => names.has(f.name));
    if (dup.length && confirm(`同じファイル名の写真が${dup.length}枚あります。重なっている分は飛ばしますか？\n（「キャンセル」ですべて追加します）`)) {
      list = list.filter(f => !names.has(f.name));
    }
    if (!list.length) return;
    const folders = withPath ? uniq(list.map(f => (f.webkitRelativePath || '').split('/').slice(0, -1).join('/')).filter(Boolean)) : [];
    stopFlag = false; libBusy(true);
    let idx = 0, done = 0, ok = 0, fail = 0, same = 0;
    progress(true, 0, `アップロード中… 0 / ${list.length}`);
    const worker = async () => {
      while (!stopFlag && idx < list.length) {
        const f = list[idx++];
        try {
          const data = await fileToBase64(f);
          const subPath = withPath ? (f.webkitRelativePath || '').split('/').slice(0, -1).join('/') : '';
          const r = await api('uploadPhoto', { fileName: f.name, mimeType: f.type || 'image/heic', data, subPath });
          if (r.duplicate) same++;
          else { mergePhotos([r.photo]); ok++; }
        } catch (err) { fail++; console.warn(f.name, err); }
        done++;
        progress(true, done / list.length, `アップロード中… ${done} / ${list.length}`);
      }
    };
    try { await Promise.all(Array.from({ length: Math.min(UPLOAD_PARALLEL, list.length) }, worker)); }
    finally { progress(false); libBusy(false); renderPhotoGrid(); }
    const where = folders.length ? `（フォルダ「${folders[0].split('/')[0]}」として保存）` : '';
    toast(`${ok}枚を追加しました${where}${same ? `。${same}枚は同じ写真がすでにあるため追加しませんでした` : ''}${fail ? `。${fail}枚は失敗しました` : ''}。`, fail ? 'warn' : 'info');
  }
  function fileToBase64(f) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1]);
      fr.onerror = () => reject(new Error('ファイルを読み込めませんでした。'));
      fr.readAsDataURL(f);
    });
  }

  /* 一覧（絞り込み・選択） */
  function filteredPhotos() {
    const words = LIB.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const mc = membershipCount();
    return chrono(S.photos).reverse().filter(p => {
      const st = p.status || 'pending';
      if (LIB.filter === 'dup') { if (st !== 'dup') return false; }
      else if (st === 'dup') return false;
      else if (LIB.filter === 'orphan') { if (mc.get(p.fileId)) return false; }
      else if (LIB.filter !== 'all' && st !== LIB.filter) return false;
      if (!words.length) return true;
      const text = [p.fileName, p.takenAt, p.place, (p.tags || []).join(' '), p.scene, p.mood, p.description].join(' ').toLowerCase();
      return words.every(w => text.includes(w));
    });
  }
  function renderPhotoGrid() {
    if (lib.hidden) return;
    const grid = $('#photo-grid');
    if (gridObserver) gridObserver.disconnect();
    const list = filteredPhotos();
    const mc = membershipCount();
    const label = { pending: '未解析', done: '解析済み', error: 'エラー', dup: '重複' };
    grid.classList.toggle('selecting', LIB.selecting);
    grid.innerHTML = list.map(p => `
      <button type="button" class="ph${LIB.selected.has(p.fileId) ? ' sel' : ''}" data-file="${esc(p.fileId)}" data-status="${p.status || 'pending'}"
        title="${esc([p.fileName, fmtDate(p.takenAt), p.place, (p.tags || []).join('、')].filter(Boolean).join('\n'))}">
        <img alt="" hidden><span class="ck"></span><span class="st">${label[p.status] || '未解析'}</span>
        ${mc.get(p.fileId) ? `<span class="tc">付箋${mc.get(p.fileId)}</span>` : ''}
      </button>`).join('');
    gridObserver = new IntersectionObserver(entries => {
      entries.forEach(en => {
        if (!en.isIntersecting) return;
        gridObserver.unobserve(en.target);
        const img = en.target.querySelector('img');
        loadImg(en.target.dataset.file, 'thumb').then(u => { img.src = u; img.hidden = false; }).catch(() => {});
      });
    }, { root: $('.lib-scroll'), rootMargin: '300px' });
    $$('.ph', grid).forEach(el => gridObserver.observe(el));

    const dupN = S.photos.filter(p => p.status === 'dup').length;
    const n = S.photos.length - dupN;
    const done = S.photos.filter(p => p.status === 'done').length;
    const err = S.photos.filter(p => p.status === 'error').length;
    $('#photo-stats').textContent = (n + dupN)
      ? `全${n}枚（解析済み ${done} ／ 未解析 ${n - done - err}${err ? ` ／ エラー ${err}` : ''}）${dupN ? `　重複で外した写真 ${dupN}枚` : ''}　表示中 ${list.length}枚`
      : 'まだ写真がありません。写真やフォルダを追加するか、ドライブのフォルダを読み込んでください。';
    updateSelBar();
  }
  let qTimer;
  $('#lib-q').addEventListener('input', e => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { LIB.q = e.target.value; renderPhotoGrid(); }, 200);
  });
  $('#lib-filter').addEventListener('change', e => { LIB.filter = e.target.value; renderPhotoGrid(); });
  function setSelecting(on, silent) {
    LIB.selecting = on;
    if (!on) LIB.selected.clear();
    $('#btn-select').setAttribute('aria-pressed', String(on));
    $('#btn-select').textContent = on ? '選択をやめる' : '選択する';
    if (!silent) renderPhotoGrid();
  }
  function updateSelBar() {
    $('#lib-selbar').hidden = !LIB.selecting;
    $('#sel-restore').hidden = LIB.filter !== 'dup';
    $('#sel-dup').hidden = LIB.filter === 'dup';
    ['#sel-to-theme', '#sel-bulk', '#sel-analyze'].forEach(x => { $(x).hidden = LIB.filter === 'dup'; });
    $('#sel-count').textContent = `${LIB.selected.size}枚を選択中`;
  }
  $('#btn-select').addEventListener('click', () => setSelecting(!LIB.selecting));
  $('#photo-grid').addEventListener('click', e => {
    const el = e.target.closest('.ph');
    if (!el) return;
    const id = el.dataset.file;
    if (LIB.selecting) {
      LIB.selected.has(id) ? LIB.selected.delete(id) : LIB.selected.add(id);
      el.classList.toggle('sel', LIB.selected.has(id));
      updateSelBar();
    } else {
      openPhotoEdit(id, () => renderPhotoGrid());
    }
  });
  $('#sel-all').addEventListener('click', () => { filteredPhotos().forEach(p => LIB.selected.add(p.fileId)); renderPhotoGrid(); });
  $('#sel-clear').addEventListener('click', () => { LIB.selected.clear(); renderPhotoGrid(); });
  $('#sel-analyze').addEventListener('click', () => {
    const ids = [...LIB.selected];
    if (!ids.length) return toast('写真を選んでください。', 'warn');
    if (!confirm(`選んだ${ids.length}枚をAIで解析します（解析済みの写真も解析し直します）。よろしいですか？`)) return;
    runAnalyze({ total: ids.length, fileIds: ids });
  });
  $('#sel-to-theme').addEventListener('click', () => {
    const ids = [...LIB.selected];
    if (!ids.length) return toast('写真を選んでください。', 'warn');
    openAssign(ids);
  });

  /* 付箋に入れる */
  let ASSIGN = [];
  function openAssign(ids) {
    const skipped = ids.filter(id => !isActive(id)).length;
    ids = ids.filter(isActive);
    if (!ids.length) return toast('重複で外した写真は付箋に入れられません。', 'warn');
    if (skipped) toast(`重複で外した${skipped}枚は除きます。`, 'warn');
    ASSIGN = ids;
    $('#assign-count').textContent = `${ids.length}枚の写真を付箋に入れます。`;
    $('#assign-theme').innerHTML = '<option value="__new">＋ 新しい付箋を作る</option>' +
      S.themes.map(t => `<option value="${esc(t.themeId)}">${esc(t.title)}（${t.photoIds.length}枚）</option>`).join('');
    $('#assign-theme').value = S.themes.length ? S.themes[0].themeId : '__new';
    $('#dlg-assign [name=title]').value = '';
    $('#assign-new-wrap').hidden = $('#assign-theme').value !== '__new';
    $('#dlg-assign').showModal();
  }
  $('#assign-theme').addEventListener('change', e => { $('#assign-new-wrap').hidden = e.target.value !== '__new'; });
  $('#dlg-assign form').addEventListener('submit', async e => {
    e.preventDefault();
    const tid = $('#assign-theme').value;
    try {
      let r;
      if (tid === '__new') {
        const title = e.target.elements.namedItem('title').value.trim();
        if (!title) return toast('新しい付箋のテーマを入力してください。', 'warn');
        r = await api('createTheme', Object.assign({ title, photoIds: ASSIGN, coverFileId: ASSIGN[0], color: nextColor() }, newNotePos()));
      } else {
        r = await api('assignPhotos', { themeId: tid, fileIds: ASSIGN, mode: 'add' });
      }
      upsertTheme(r.theme);
      $('#dlg-assign').close();
      setSelecting(false);
      toast(`「${r.theme.title}」に${ASSIGN.length}枚を入れました。`);
    } catch (err) { toast(err.message, 'error'); }
  });

  /* 写真の情報を修正 */
  let PE = null;
  function openPhotoEdit(fileId, onSaved) {
    const p = S.photoMap.get(fileId);
    if (!p || S.readOnly) return;
    PE = { fileId, onSaved };
    fillPhotoForm(p);
    const img = $('#dlg-photo .pe-img img');
    img.removeAttribute('src');
    loadImg(fileId, 'mid', true).then(u => { if (PE && PE.fileId === fileId) img.src = u; }).catch(() => {});
    renderPeThemes();
    $('#dlg-photo').showModal();
    applySharedLoc($('#dlg-photo form'));
  }
  function fillPhotoForm(p) {
    const f = $('#dlg-photo form');
    f.elements.namedItem('takenAt').value = p.takenAt || '';
    f.elements.namedItem('place').value = p.place || '';
    f.elements.namedItem('lat').value = p.lat == null ? '' : p.lat;
    f.elements.namedItem('lng').value = p.lng == null ? '' : p.lng;
    f.elements.namedItem('tags').value = (p.tags || []).join('、');
    f.elements.namedItem('scene').value = p.scene || '';
    f.elements.namedItem('mood').value = p.mood || '';
    f.elements.namedItem('description').value = p.description || '';
    f.elements.namedItem('done').checked = p.status === 'done';
    f.elements.namedItem('done').disabled = p.status === 'dup';
    f.elements.namedItem('dup').checked = p.status === 'dup';
    resetMapsPaste(f);
    const dupBox = $('#pe-dup');
    dupBox.hidden = p.status !== 'dup';
    if (p.status === 'dup') {
      const orig = p.dupOf && S.photoMap.get(p.dupOf);
      dupBox.querySelector('span').textContent = `重複のため対象から外しています${orig ? `（残している写真：${orig.fileName || ''}）` : ''}。チェックを外して保存すると対象に戻ります。`;
    }
    $('#pe-name').textContent = p.fileName || '';
  }
  function renderPeThemes() {
    const id = PE.fileId;
    const inT = S.themes.filter(t => t.photoIds.includes(id));
    $('#pe-theme-chips').innerHTML = inT.length
      ? inT.map(t => `<span class="pe-chip" style="--c:${esc(t.color)}">${esc(t.title)}<button type="button" data-out="${esc(t.themeId)}" aria-label="${esc(t.title)}から外す">×</button></span>`).join('')
      : '<span class="muted small">どの付箋にも入っていません。</span>';
    const others = S.themes.filter(t => !t.photoIds.includes(id));
    $('#pe-add-theme').innerHTML = others.map(t => `<option value="${esc(t.themeId)}">${esc(t.title)}</option>`).join('');
    $('#pe-add-theme').disabled = $('#pe-add-btn').disabled = !others.length;
  }
  $('#pe-theme-chips').addEventListener('click', async e => {
    const b = e.target.closest('[data-out]');
    if (!b) return;
    try {
      const r = await api('assignPhotos', { themeId: b.dataset.out, fileIds: [PE.fileId], mode: 'remove' });
      upsertTheme(r.theme);
      renderPeThemes();
      toast(`「${r.theme.title}」から外しました。`);
    } catch (err) { toast(err.message, 'error'); }
  });
  $('#pe-add-btn').addEventListener('click', async () => {
    const tid = $('#pe-add-theme').value;
    if (!tid) return;
    try {
      const r = await api('assignPhotos', { themeId: tid, fileIds: [PE.fileId], mode: 'add' });
      upsertTheme(r.theme);
      renderPeThemes();
      toast(`「${r.theme.title}」に入れました。`);
    } catch (err) { toast(err.message, 'error'); }
  });
  $('#pe-ai').addEventListener('click', async () => {
    const id = PE.fileId;
    const btn = $('#pe-ai');
    btn.disabled = true; btn.textContent = 'AIが解析しています…';
    try {
      const r = await api('analyzeBatch', { fileIds: [id], limit: 1 });
      mergePhotos(r.photos || []);
      if (PE && PE.fileId === id) fillPhotoForm(S.photoMap.get(id));
      toast('解析し直しました。内容を確認して「保存」を押すと、手直しも反映されます。');
    } catch (err) { toast(err.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = 'AIで解析し直す'; }
  });
  // 「重複として外す」を付けている間は「解析済みにする」を使えなくする
  $('#dlg-photo form').addEventListener('change', e => {
    if (e.target.name === 'dup') e.currentTarget.elements.namedItem('done').disabled = e.target.checked;
  });
  $('#dlg-photo form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.currentTarget;
    const p = S.photoMap.get(PE.fileId);
    const wasDup = p.status === 'dup';
    const wantDup = f.elements.namedItem('dup').checked;
    if (wantDup && !wasDup) {
      const inT = S.themes.filter(t => t.photoIds.includes(p.fileId)).length;
      if (!confirm(`この写真を重複として対象から外しますか？${inT ? `\n入っている付箋（${inT}枚）からも外れます。` : ''}\n（写真ファイルは消えません）`)) return;
    }
    const takenAt = normDate(f.elements.namedItem('takenAt').value);
    if (takenAt === null) return toast('撮影日時は 2024-08-15 14:30 の形式で入力してください。', 'warn');
    const fields = {
      takenAt, place: f.elements.namedItem('place').value.trim(),
      lat: f.elements.namedItem('lat').value.trim(), lng: f.elements.namedItem('lng').value.trim(),
      tags: splitList(f.elements.namedItem('tags').value),
      scene: f.elements.namedItem('scene').value.trim(), mood: f.elements.namedItem('mood').value.trim(), description: f.elements.namedItem('description').value.trim(),
      status: wantDup ? undefined : (f.elements.namedItem('done').checked ? 'done' : 'pending'),
    };
    if (!wantDup && !wasDup && p.status === 'error' && !f.elements.namedItem('done').checked) fields.status = 'error';
    try {
      if (wasDup && !wantDup) await api('restoreDuplicates', { fileIds: [PE.fileId] });
      let r = await api('updatePhoto', { fileId: PE.fileId, fields });
      let photo = r.photo;
      if (wantDup && !wasDup) {
        const m = await api('markDuplicates', { items: [{ fileId: PE.fileId, dupOf: '' }] });
        (m.themes || []).forEach(upsertTheme);
        photo = (m.photos || [])[0] || photo;
      }
      mergePhotos([photo]);
      if (f.dataset.shared === '1') clearSharedLoc();
      $('#dlg-photo').close();
      if (PE.onSaved) PE.onSaved(photo);
      renderPhotoGrid();
      toast(wantDup && !wasDup ? '重複として対象から外しました。' : (wasDup && !wantDup ? '対象に戻して保存しました。' : '写真の情報を保存しました。'));
    } catch (err) { toast(err.message, 'error'); }
  });

  /* ============================================================
   * Googleマップから貼り付け → 緯度・経度（座標・URL・共有リンク・住所）
   * ============================================================ */
  function parseLatLng(s) {
    s = String(s || '').trim();
    try { s = decodeURIComponent(s.replace(/\+/g, ' ')); } catch (_) { s = s.replace(/\+/g, ' ').replace(/%2C/gi, ','); }
    // Googleマップの「共有」は「座標／住所／リンク」の複数行。文章のどこかにある座標も読み取る
    const m = s.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/) ||
      s.match(/@(-?\d+\.\d+),\s*(-?\d+\.\d+)/) ||
      s.match(/(-?\d{1,2}\.\d{3,})\s*[,，、]\s*(-?\d{1,3}\.\d{3,})/) ||
      s.match(/^\(?\s*(-?\d{1,2}(?:\.\d+)?)\s*[,，、\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*\)?$/);
    let lat, lng;
    if (m) {
      lat = Number(m[1]); lng = Number(m[2]);
    } else {
      // 35°31'52.3"N 139°41'48.6"E の形式
      const d = s.match(/(\d+(?:\.\d+)?)°\s*(?:(\d+(?:\.\d+)?)['′]\s*)?(?:(\d+(?:\.\d+)?)["″]\s*)?([NS北南])[\s,，]*(\d+(?:\.\d+)?)°\s*(?:(\d+(?:\.\d+)?)['′]\s*)?(?:(\d+(?:\.\d+)?)["″]\s*)?([EW東西])/i);
      if (!d) return null;
      const dms = (a, b, c) => Number(a) + Number(b || 0) / 60 + Number(c || 0) / 3600;
      lat = dms(d[1], d[2], d[3]) * (/[S南]/i.test(d[4]) ? -1 : 1);
      lng = dms(d[5], d[6], d[7]) * (/[W西]/i.test(d[8]) ? -1 : 1);
    }
    if (isNaN(lat) || isNaN(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat, lng };
  }
  function resetMapsPaste(form) {
    const inp = form.elements.namedItem('mapsPaste');
    if (inp) inp.value = '';
    const out = form.querySelector('.maps-result');
    if (out) { out.textContent = ''; out.className = 'muted small maps-result'; }
  }
  function tickUse(form, name) {
    const c = form.elements.namedItem('use_' + name);
    if (c) c.checked = true;
  }
  function setField(form, name, v) {
    const el = form.elements.namedItem(name);
    if (!el) return;
    el.value = v;
    tickUse(form, name);
  }
  async function convertMaps(form) {
    const inp = form.elements.namedItem('mapsPaste');
    const out = form.querySelector('.maps-result');
    const q = inp.value.trim();
    if (!q) return;
    const show = (t, cls) => { out.textContent = t; out.className = 'small maps-result ' + (cls || 'muted'); };
    let r = parseLatLng(q);
    const placeEl = form.elements.namedItem('place');
    const wantPlace = !!placeEl && (!placeEl.value.trim() || placeEl.value.trim().startsWith('（推定）'));
    try {
      if (!r) {
        show('Googleマップの情報から位置を調べています…');
        r = await api('geocode', { query: q });
      } else if (wantPlace) {
        show('地名を調べています…');
        const g = await api('geocode', { lat: r.lat, lng: r.lng }).catch(() => null);
        if (g) r.place = g.place;
      }
    } catch (err) { show(err.message, 'ng'); return; }
    setField(form, 'lat', Number(r.lat).toFixed(6));
    setField(form, 'lng', Number(r.lng).toFixed(6));
    if (r.place && wantPlace) setField(form, 'place', r.place);
    show(`緯度 ${Number(r.lat).toFixed(6)} ／ 経度 ${Number(r.lng).toFixed(6)}${r.place ? `（${r.place}）` : ''} を入れました。`, 'ok');
  }
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-maps-convert]');
    if (b) convertMaps(b.closest('form'));
  });
  document.addEventListener('paste', e => {
    const t = e.target;
    if (!t || !t.form) return;
    if (t.name === 'mapsPaste') { setTimeout(() => convertMaps(t.form), 0); return; }
    // 緯度・経度の欄に「35.53, 139.69」を貼ったら両方に分けて入れる
    if (t.name === 'lat' || t.name === 'lng') {
      const text = (e.clipboardData || window.clipboardData).getData('text');
      const r = parseLatLng(text);
      if (r) {
        e.preventDefault();
        setField(t.form, 'lat', r.lat.toFixed(6));
        setField(t.form, 'lng', r.lng.toFixed(6));
      }
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target && e.target.name === 'mapsPaste') { e.preventDefault(); convertMaps(e.target.form); }
  });


  /* ============================================================
   * Googleマップの「共有」から受け取った位置
   *  - ホーム画面に追加したアプリは、Googleマップの共有先に「おもいで付箋」が出る（Android）
   *  - 受け取った位置は、次に開く写真の情報・一括修正の画面に自動で入る
   * ============================================================ */
  const SHARE_KEY = 'omoide.share';
  S.sharedLoc = sessionStorage.getItem(SHARE_KEY) || '';
  function receiveShare() {
    const q = new URLSearchParams(location.search);
    const parts = ['share_title', 'share_text', 'share_url'].map(k => (q.get(k) || '').trim()).filter(Boolean);
    if (!parts.length) return;
    S.sharedLoc = uniq(parts).join('\n');
    sessionStorage.setItem(SHARE_KEY, S.sharedLoc);
    history.replaceState(null, '', location.pathname);
  }
  function renderShareBar() {
    const bar = $('#share-bar');
    bar.hidden = !S.sharedLoc || S.readOnly;
    if (bar.hidden) return;
    const c = parseLatLng(S.sharedLoc);
    const addr = S.sharedLoc.split('\n').find(x => /〒|[都道府県]/.test(x)) || '';
    $('#share-text').textContent = c
      ? `緯度 ${c.lat.toFixed(6)} ／ 経度 ${c.lng.toFixed(6)}${addr ? `　${addr}` : ''}`
      : S.sharedLoc.replace(/\n/g, '　');
  }
  function clearSharedLoc() {
    S.sharedLoc = '';
    sessionStorage.removeItem(SHARE_KEY);
    renderShareBar();
  }
  function applySharedLoc(form) {
    form.dataset.shared = '';
    if (!S.sharedLoc || S.readOnly) return;
    const inp = form.elements.namedItem('mapsPaste');
    if (!inp) return;
    inp.value = S.sharedLoc;
    form.dataset.shared = '1';
    convertMaps(form);
  }
  $('#share-cancel').addEventListener('click', () => { clearSharedLoc(); toast('受け取った位置を取り消しました。'); });
  function afterBoardLoaded() {
    if (!S.sharedLoc || S.readOnly) return;
    openLibrary();
    if (!LIB.selecting) setSelecting(true);
    renderShareBar();
    toast('Googleマップの位置を受け取りました。写真を選んで「情報を一括修正」を押してください。');
  }

  /* ============================================================
   * 写真の情報の一括修正
   * ============================================================ */
  let BULK = [];
  const BULK_TEXT = ['takenAt', 'place', 'lat', 'lng', 'tags', 'scene', 'mood', 'description'];
  const BULK_LABEL = { takenAt: '撮影日時', place: '撮影地', lat: '緯度', lng: '経度', tags: 'タグ', scene: '場面', mood: '雰囲気', description: '説明' };
  let BULK_DONE = null;
  $('#sel-bulk').addEventListener('click', () => openBulk([...LIB.selected], () => setSelecting(false)));
  /** 一括修正画面を開く（写真ライブラリ・付箋の一覧の両方から使う） */
  function openBulk(ids, done) {
    if (!ids.length) return toast('写真を選んでください。', 'warn');
    BULK = ids;
    BULK_DONE = done || null;
    const f = $('#dlg-bulk form');
    f.reset();
    resetMapsPaste(f);
    $('#bulk-count').textContent = `選んだ ${ids.length}枚の写真を修正します。`;
    // 全員同じ値の項目はあらかじめ入れておく
    const ps = ids.map(id => S.photoMap.get(id)).filter(Boolean);
    const same = get => { const v = ps.map(get); return v.every(x => x === v[0]) ? v[0] : ''; };
    const dates = uniq(ps.map(p => String(p.takenAt || '').slice(0, 10)));
    f.elements.namedItem('takenAt').value = dates.length === 1 ? dates[0] : '';
    ['place', 'scene', 'mood', 'description'].forEach(k => { f.elements.namedItem(k).value = same(p => String(p[k] || '')); });
    ['lat', 'lng'].forEach(k => { f.elements.namedItem(k).value = same(p => (p[k] == null ? '' : String(p[k]))); });
    f.elements.namedItem('tags').value = same(p => (p.tags || []).join('、'));
    const opts = S.themes.map(t => `<option value="${esc(t.themeId)}">${esc(t.title)}</option>`).join('');
    $('#bulk-add-theme').innerHTML = '<option value="">入れない</option>' + opts;
    $('#bulk-remove-theme').innerHTML = '<option value="">外さない</option>' +
      S.themes.filter(t => t.photoIds.some(id => ids.includes(id))).map(t => `<option value="${esc(t.themeId)}">${esc(t.title)}</option>`).join('');
    $('#dlg-bulk').showModal();
    applySharedLoc(f);
  }
  // 入力したら自動で「変更する」にチェック
  $('#dlg-bulk form').addEventListener('input', e => {
    const n = e.target.name === 'tagMode' ? 'tags' : e.target.name;
    if (BULK_TEXT.includes(n)) tickUse(e.currentTarget, n);
  });
  $('#dlg-bulk form').addEventListener('change', e => {
    if (e.target.name === 'tagMode') tickUse(e.currentTarget, 'tags');
  });
  $('#dlg-bulk form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.currentTarget;
    const val = n => f.elements.namedItem(n).value;
    const fields = {};
    for (const k of BULK_TEXT) {
      if (!f.elements.namedItem('use_' + k).checked) continue;
      const v = val(k).trim();
      if (k === 'takenAt') {
        const d = normDate(v);
        if (d === null) return toast('撮影日時は 2024-08-15 または 2024-08-15 14:30 の形式で入力してください。', 'warn');
        fields.takenAt = d;
      } else if (k === 'lat' || k === 'lng') {
        if (v !== '' && isNaN(Number(v))) return toast(`${BULK_LABEL[k]}は数字で入力してください。`, 'warn');
        fields[k] = v;
      } else if (k === 'tags') {
        fields.tags = splitList(v);
        if (val('tagMode') !== 'replace' && !fields.tags.length) return toast('追加・削除するタグを入力してください。', 'warn');
      } else {
        fields[k] = v;
      }
    }
    const tagMode = val('tagMode');
    const status = val('status'), dup = val('dup'), addT = val('addTheme'), remT = val('removeTheme');
    if (status) fields.status = status;
    if (addT && addT === remT) return toast('同じ付箋に「入れる」と「外す」は同時に選べません。', 'warn');
    if (!Object.keys(fields).length && !dup && !addT && !remT) return toast('変更する項目を選んでください。', 'warn');

    const tagWord = { replace: '置き換え', add: '追加', remove: '削除' }[tagMode];
    const lines = Object.keys(fields).filter(k => k !== 'status').map(k => (k === 'tags' ? `タグ（${tagWord}）` : BULK_LABEL[k]));
    if (status) lines.push(status === 'done' ? '解析済みにする' : '未解析に戻す');
    if (dup) lines.push(dup === 'mark' ? '重複として外す' : '重複から対象に戻す');
    if (addT) lines.push(`「${theme(addT).title}」に入れる`);
    if (remT) lines.push(`「${theme(remT).title}」から外す`);
    if (!confirm(`${BULK.length}枚の写真に次の変更をします。よろしいですか？\n・${lines.join('\n・')}`)) return;

    busy(`${BULK.length}枚の写真を修正しています…`);
    try {
      if (dup === 'restore') {
        const ids = BULK.filter(id => (S.photoMap.get(id) || {}).status === 'dup');
        if (ids.length) { const r = await api('restoreDuplicates', { fileIds: ids }); mergePhotos(r.photos || []); }
      }
      if (Object.keys(fields).length) {
        const r = await api('bulkUpdatePhotos', { fileIds: BULK, fields, tagMode });
        mergePhotos(r.photos || []);
      }
      if (remT) {
        const ids = BULK.filter(id => theme(remT).photoIds.includes(id));
        if (ids.length) { const r = await api('assignPhotos', { themeId: remT, fileIds: ids, mode: 'remove' }); upsertTheme(r.theme); }
      }
      if (addT && dup !== 'mark') {
        const ids = BULK.filter(isActive);
        if (ids.length) { const r = await api('assignPhotos', { themeId: addT, fileIds: ids, mode: 'add' }); upsertTheme(r.theme); }
      }
      if (dup === 'mark') {
        const ids = BULK.filter(isActive);
        if (ids.length) {
          const r = await api('markDuplicates', { items: ids.map(id => ({ fileId: id, dupOf: '' })) });
          mergePhotos(r.photos || []);
          (r.themes || []).forEach(upsertTheme);
        }
      }
      $('#dlg-bulk').close();
      if (f.dataset.shared === '1' && ['lat', 'lng'].some(k => f.elements.namedItem('use_' + k).checked)) clearSharedLoc();
      if (BULK_DONE) BULK_DONE();
      toast(`${BULK.length}枚の写真を修正しました。`);
    } catch (err) {
      toast(err.message, 'error');
      renderPhotoGrid();
    } finally { busy(false); }
  });

  /* ============================================================
   * 重複している写真
   * ============================================================ */
  let DUP = null;
  $('#btn-dups').addEventListener('click', async () => {
    busy('重複している写真を探しています…');
    let r;
    try { r = await api('findDuplicates'); }
    catch (err) { toast(err.message, 'error'); return; }
    finally { busy(false); }
    setPhotos(r.photos || S.photos);
    renderPhotoGrid();
    const groups = r.groups || [];
    if (!groups.length) return toast('重複している写真はありませんでした。');
    DUP = { groups, out: new Set() };
    groups.forEach(g => g.fileIds.forEach((id, i) => {
      const p = S.photoMap.get(id);
      if (i > 0 || (p && p.status === 'dup')) DUP.out.add(id);
    }));
    groups.forEach(g => { if (g.fileIds.every(id => DUP.out.has(id))) DUP.out.delete(g.fileIds[0]); });
    renderDupList();
    $('#dlg-dup').showModal();
  });
  function renderDupList() {
    const extra = DUP.groups.reduce((n, g) => n + g.fileIds.length - 1, 0);
    $('#dup-summary').textContent = `${DUP.groups.length}組・${extra}枚の重複が見つかりました。`;
    $('#dup-list').innerHTML = DUP.groups.map((g, gi) => `
      <div class="dup-group" data-g="${gi}">
        <p>${g.exact ? '内容がまったく同じ写真' : 'ファイル名と大きさが同じ写真'}（${g.fileIds.length}枚）</p>
        <div class="dup-items">${g.fileIds.map(id => {
          const p = S.photoMap.get(id) || {};
          const out = DUP.out.has(id);
          return `<button type="button" class="dup-item${out ? ' out' : ''}" data-file="${esc(id)}" aria-pressed="${!out}">
            <span class="im"></span><span class="lb">${out ? '外す' : '残す'}</span>
            <span class="nm">${esc(p.fileName || id)}</span></button>`;
        }).join('')}</div>
      </div>`).join('');
    $$('.dup-item', $('#dup-list')).forEach(el => {
      loadImg(el.dataset.file, 'thumb').then(u => { el.querySelector('.im').style.backgroundImage = `url("${u}")`; }).catch(() => {});
    });
  }
  $('#dup-list').addEventListener('click', e => {
    const b = e.target.closest('.dup-item');
    if (!b) return;
    const g = DUP.groups[Number(b.closest('.dup-group').dataset.g)];
    const id = b.dataset.file;
    if (DUP.out.has(id)) DUP.out.delete(id);
    else {
      if (g.fileIds.filter(x => !DUP.out.has(x)).length <= 1) return toast('各組で1枚は残してください。', 'warn');
      DUP.out.add(id);
    }
    const out = DUP.out.has(id);
    b.classList.toggle('out', out);
    b.setAttribute('aria-pressed', String(!out));
    b.querySelector('.lb').textContent = out ? '外す' : '残す';
  });
  $('#dlg-dup form').addEventListener('submit', async e => {
    e.preventDefault();
    const items = [], restore = [];
    DUP.groups.forEach(g => {
      const keep = g.fileIds.find(id => !DUP.out.has(id));
      g.fileIds.forEach(id => {
        const p = S.photoMap.get(id);
        if (DUP.out.has(id)) { if (!p || p.status !== 'dup' || p.dupOf !== keep) items.push({ fileId: id, dupOf: keep }); }
        else if (p && p.status === 'dup') restore.push(id);
      });
    });
    $('#dlg-dup').close();
    if (!items.length && !restore.length) return toast('変更はありませんでした。');
    busy('重複の写真を対象から外しています…');
    try {
      if (restore.length) { const r = await api('restoreDuplicates', { fileIds: restore }); mergePhotos(r.photos || []); }
      if (items.length) {
        const r = await api('markDuplicates', { items });
        mergePhotos(r.photos || []);
        (r.themes || []).forEach(upsertTheme);
      }
      renderPhotoGrid();
      toast(`${items.length}枚を重複として対象から外しました${restore.length ? `（${restore.length}枚は対象に戻しました）` : ''}。`);
    } catch (err) { toast(err.message, 'error'); } finally { busy(false); }
  });
  $('#sel-dup').addEventListener('click', async () => {
    const ids = [...LIB.selected].filter(isActive);
    if (!ids.length) return toast('写真を選んでください。', 'warn');
    if (!confirm(`選んだ${ids.length}枚を重複として対象から外しますか？\n（AI解析・テーマ検索・付箋・スライドショーの対象外になります。写真ファイルは消えません）`)) return;
    busy('対象から外しています…');
    try {
      const r = await api('markDuplicates', { items: ids.map(id => ({ fileId: id, dupOf: '' })) });
      mergePhotos(r.photos || []);
      (r.themes || []).forEach(upsertTheme);
      setSelecting(false);
      toast(`${ids.length}枚を対象から外しました。「重複で外した写真」から戻せます。`);
    } catch (err) { toast(err.message, 'error'); } finally { busy(false); }
  });
  async function restoreDups(ids) {
    busy('対象に戻しています…');
    try {
      const r = await api('restoreDuplicates', { fileIds: ids });
      mergePhotos(r.photos || []);
      return r.photos || [];
    } finally { busy(false); }
  }
  $('#sel-restore').addEventListener('click', async () => {
    const ids = [...LIB.selected].filter(id => (S.photoMap.get(id) || {}).status === 'dup');
    if (!ids.length) return toast('戻す写真を選んでください。', 'warn');
    try {
      await restoreDups(ids);
      setSelecting(false);
      toast(`${ids.length}枚を対象に戻しました。必要なら付箋に入れ直してください。`);
    } catch (err) { toast(err.message, 'error'); }
  });

  /* ============================================================
   * Excel 書き出し・読み込み
   * ============================================================ */
  const XL = {
    photos: { sheet: '写真', cols: [
      { k: 'fileId', h: '写真ID（変更しない）', w: 36 }, { k: 'fileName', h: 'ファイル名（参考）', w: 24 },
      { k: 'status', h: '状態（pending/done）', w: 12 }, { k: 'takenAt', h: '撮影日時', w: 18 },
      { k: 'place', h: '撮影地', w: 24 }, { k: 'lat', h: '緯度', w: 12 }, { k: 'lng', h: '経度', w: 12 },
      { k: 'tags', h: 'タグ（、区切り）', w: 36 }, { k: 'scene', h: '場面', w: 14 }, { k: 'mood', h: '雰囲気', w: 14 },
      { k: 'description', h: '説明', w: 60 },
    ] },
    themes: { sheet: '付箋', cols: [
      { k: 'themeId', h: '付箋ID（新規は new1 など）', w: 20 }, { k: 'title', h: 'テーマ', w: 24 }, { k: 'color', h: '色', w: 10 },
      { k: 'x', h: 'X位置', w: 8 }, { k: 'y', h: 'Y位置', w: 8 },
      { k: 'excludedIds', h: '外した写真ID（、区切り）', w: 40 }, { k: 'earthVideoUrl', h: '映像URL', w: 30 },
      { k: 'delete', h: '削除（○で削除）', w: 10 },
    ] },
    members: { sheet: '付箋の写真', cols: [
      { k: 'themeId', h: '付箋ID', w: 20 }, { k: 'title', h: 'テーマ（参考）', w: 24 },
      { k: 'fileId', h: '写真ID', w: 36 }, { k: 'fileName', h: 'ファイル名（参考）', w: 24 }, { k: 'cover', h: '表紙（○）', w: 8 },
    ] },
    comments: { sheet: 'コメント', cols: [
      { k: 'commentId', h: 'コメントID（新規は空欄）', w: 22 }, { k: 'fileId', h: '写真ID', w: 36 },
      { k: 'fileName', h: 'ファイル名（参考）', w: 24 }, { k: 'type', h: '種類（manual/ai）', w: 10 },
      { k: 'text', h: 'コメント', w: 60 }, { k: 'createdAt', h: '作成日時（参考）', w: 18 }, { k: 'delete', h: '削除（○で削除）', w: 10 },
    ] },
  };
  const colorName = v => (COLORS.find(c => c.v.toLowerCase() === String(v || '').toLowerCase()) || {}).n || v || '';
  const colorValue = v => {
    v = String(v || '').trim();
    const c = COLORS.find(x => x.n === v || x.v.toLowerCase() === v.toLowerCase());
    return c ? c.v : (/^#[0-9a-f]{6}$/i.test(v) ? v : null);
  };
  const isMark = v => /^(○|◯|〇|o|O|1|true|TRUE|削除|x|X|×|✕)$/.test(String(v || '').trim());

  $('#btn-excel-out').addEventListener('click', exportExcel);
  async function exportExcel() {
    busy('Excelファイルを作っています…');
    try {
      await loadScript(XLSX_URL);
      const cr = await api('listComments', { all: true });
      const nameOf = id => (S.photoMap.get(id) || {}).fileName || '';
      const data = {
        photos: chrono(S.photos).map(p => Object.assign({}, p, { tags: (p.tags || []).join('、'), lat: p.lat == null ? '' : p.lat, lng: p.lng == null ? '' : p.lng })),
        themes: S.themes.map(t => ({ themeId: t.themeId, title: t.title, color: colorName(t.color), x: t.x, y: t.y, excludedIds: (t.excludedIds || []).join('、'), earthVideoUrl: t.earthVideoUrl || '', delete: '' })),
        members: S.themes.flatMap(t => t.photoIds.filter(id => S.photoMap.has(id)).map(id => ({ themeId: t.themeId, title: t.title, fileId: id, fileName: nameOf(id), cover: id === t.coverFileId ? '○' : '' }))),
        comments: (cr.comments || []).map(c => Object.assign({}, c, { fileName: nameOf(c.fileId), createdAt: fmtDateTime(c.createdAt), delete: '' })),
      };
      const wb = XLSX.utils.book_new();
      const readme = [
        ['おもいで付箋ボード 管理データ'],
        ['書き出し日時：' + fmtDateTime(new Date().toISOString())],
        [''],
        ['使い方'],
        ['・各シートを直して保存し、アプリの「写真」画面にある「Excelから読み込む」で読み込みます。変更した所だけが反映されます。'],
        ['・「写真ID」「付箋ID」「コメントID」と「（参考）」の列は変更しないでください。'],
        ['・撮影日時は 2024-08-15 14:30 の形式、タグは「、」区切りで入力します。'],
        ['・付箋の色は、きいろ／ピンク／みずいろ／きみどり／オレンジ のどれかを入れます。'],
        ['・新しい付箋を作るときは、「付箋」シートの付箋IDに new1 のように new で始まる名前を入れ、「付箋の写真」シートでも同じIDを使います。'],
        ['・写真を付箋から外すときは「付箋の写真」シートの行を削除します。外した写真は「写真を探し直す」でも戻りません。'],
        ['・「表紙（○）」に○を付けた写真が付箋の表紙になります。'],
        ['・付箋やコメントを消すときは「削除」列に ○ を入れます。シートから行を消しただけでは削除されません（「付箋の写真」シートを除く）。'],
        ['・写真ファイルそのものの追加・削除はできません。アプリの「写真」画面から行ってください。'],
      ];
      const ws0 = XLSX.utils.aoa_to_sheet(readme);
      ws0['!cols'] = [{ wch: 120 }];
      XLSX.utils.book_append_sheet(wb, ws0, '説明');
      Object.keys(XL).forEach(key => {
        const def = XL[key];
        const aoa = [def.cols.map(c => c.h)].concat(data[key].map(o => def.cols.map(c => (o[c.k] == null ? '' : o[c.k]))));
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!cols'] = def.cols.map(c => ({ wch: c.w }));
        ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(aoa.length - 1, 0), c: def.cols.length - 1 } }) };
        XLSX.utils.book_append_sheet(wb, ws, def.sheet);
      });
      XLSX.writeFile(wb, `omoide-fusen_${ymd()}.xlsx`);
      toast('Excelに書き出しました。');
    } catch (err) { toast(err.message, 'error'); } finally { busy(false); }
  }

  let IMPORT = null;
  $('#excel-in').addEventListener('change', e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importExcel(f);
  });
  async function importExcel(file) {
    busy('Excelファイルを読んでいます…');
    try {
      await loadScript(XLSX_URL);
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const read = key => {
        const def = XL[key];
        const ws = wb.Sheets[def.sheet];
        if (!ws) return null;
        const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
        if (!aoa.length) return [];
        const head = aoa[0].map(h => String(h).trim());
        const idx = {};
        def.cols.forEach(c => { idx[c.k] = head.indexOf(c.h); });
        return aoa.slice(1).filter(r => r.some(v => String(v).trim() !== '')).map(r => {
          const o = {};
          def.cols.forEach(c => { o[c.k] = idx[c.k] >= 0 ? String(r[idx[c.k]] == null ? '' : r[idx[c.k]]).trim() : undefined; });
          return o;
        });
      };
      const P = read('photos'), T = read('themes'), M = read('members'), C = read('comments');
      if (!P && !T && !M && !C) throw new Error('読み込めるシートがありません。「Excelに書き出す」で作ったファイルを使ってください。');
      const payload = { photos: [], themes: [], comments: [] };

      // 写真
      (P || []).forEach(r => {
        const cur = S.photoMap.get(r.fileId);
        if (!cur) return;
        const f = {};
        const name = cur.fileName || cur.fileId;
        if (r.takenAt !== undefined) {
          const d = normDate(r.takenAt);
          if (d === null) throw new Error(`写真「${name}」の撮影日時「${r.takenAt}」が読めません。2024-08-15 14:30 の形式にしてください。`);
          if (d !== (cur.takenAt || '')) f.takenAt = d;
        }
        ['place', 'scene', 'mood', 'description'].forEach(k => { if (r[k] !== undefined && r[k] !== (cur[k] || '')) f[k] = r[k]; });
        ['lat', 'lng'].forEach(k => {
          if (r[k] === undefined) return;
          const label = k === 'lat' ? '緯度' : '経度';
          if (r[k] === '') { if (cur[k] != null) f[k] = ''; return; }
          const n = Number(r[k]);
          if (isNaN(n)) throw new Error(`写真「${name}」の${label}「${r[k]}」が数字ではありません。`);
          if (cur[k] == null || Math.abs(n - cur[k]) > 1e-6) f[k] = n;
        });
        if (r.tags !== undefined) {
          const t = splitList(r.tags);
          if (t.join('、') !== (cur.tags || []).join('、')) f.tags = t;
        }
        if (r.status && ['pending', 'done', 'error'].includes(r.status) && r.status !== (cur.status || 'pending')) f.status = r.status;
        if (Object.keys(f).length) payload.photos.push(Object.assign({ fileId: r.fileId, fileName: cur.fileName }, f));
      });

      // 付箋（「付箋の写真」シートで写真の出し入れ）
      const members = new Map();
      (M || []).forEach(r => {
        if (!r.themeId || !r.fileId || !S.photoMap.has(r.fileId)) return;
        if (!members.has(r.themeId)) members.set(r.themeId, { ids: [], cover: '' });
        const m = members.get(r.themeId);
        if (!m.ids.includes(r.fileId)) m.ids.push(r.fileId);
        if (isMark(r.cover) && !m.cover) m.cover = r.fileId;
      });
      (T || []).forEach(r => {
        const id = r.themeId || '';
        const cur = S.themes.find(t => t.themeId === id);
        if (isMark(r.delete)) { if (cur) payload.themes.push({ themeId: id, title: cur.title, delete: true }); return; }
        if (!cur && !r.title) return;
        const o = { themeId: cur ? id : '' };
        if (r.title !== undefined && r.title && (!cur || r.title !== cur.title)) o.title = r.title;
        if (r.color !== undefined && r.color) {
          const col = colorValue(r.color);
          if (!col) throw new Error(`付箋「${r.title || id}」の色「${r.color}」が分かりません。きいろ／ピンク／みずいろ／きみどり／オレンジ のどれかにしてください。`);
          if (!cur || col.toLowerCase() !== String(cur.color).toLowerCase()) o.color = col;
        }
        ['x', 'y'].forEach(k => {
          if (r[k] === undefined || r[k] === '' || isNaN(Number(r[k]))) return;
          const v = Math.round(Number(r[k]));
          if (!cur || v !== cur[k]) o[k] = v;
        });
        if (r.earthVideoUrl !== undefined && r.earthVideoUrl !== (cur ? cur.earthVideoUrl || '' : '')) o.earthVideoUrl = r.earthVideoUrl;
        let excl = r.excludedIds !== undefined ? splitList(r.excludedIds).filter(x => S.photoMap.has(x)) : (cur ? (cur.excludedIds || []) : []);
        if (M) {
          const m = members.get(id) || { ids: [], cover: '' };
          const curIds = cur ? cur.photoIds.filter(x => S.photoMap.has(x)) : [];
          if (!cur || !sameSet(m.ids, curIds) || (m.cover && m.cover !== cur.coverFileId)) {
            o.photoIds = m.ids;
            o.coverFileId = m.cover || (cur && m.ids.includes(cur.coverFileId) ? cur.coverFileId : (m.ids[0] || ''));
            if (cur) excl = uniq(excl.concat(curIds.filter(x => !m.ids.includes(x))));
          }
          excl = excl.filter(x => !m.ids.includes(x));
        }
        if (!cur ? excl.length : !sameSet(excl, cur.excludedIds || [])) o.excludedIds = excl;
        if (!cur) { o.title = r.title; payload.themes.push(Object.assign({ isNew: true }, o)); }
        else if (Object.keys(o).length > 1) payload.themes.push(Object.assign({ titleForSummary: cur.title }, o));
      });

      // コメント
      if (C) {
        const cr = await api('listComments', { all: true });
        const cur = new Map((cr.comments || []).map(c => [c.commentId, c]));
        C.forEach(r => {
          const id = r.commentId || '';
          const c = cur.get(id);
          if (c) {
            if (isMark(r.delete)) payload.comments.push({ commentId: id, delete: true });
            else if (r.text && r.text !== c.text) payload.comments.push({ commentId: id, text: r.text });
            return;
          }
          if (!id && r.text && S.photoMap.has(r.fileId) && !isMark(r.delete)) {
            payload.comments.push({ fileId: r.fileId, text: r.text, type: r.type === 'ai' ? 'ai' : 'manual' });
          }
        });
      }

      const n = {
        photos: payload.photos.length,
        tNew: payload.themes.filter(t => t.isNew).length,
        tDel: payload.themes.filter(t => t.delete).length,
        cNew: payload.comments.filter(c => !c.commentId).length,
        cDel: payload.comments.filter(c => c.delete).length,
      };
      n.tUpd = payload.themes.length - n.tNew - n.tDel;
      n.cUpd = payload.comments.length - n.cNew - n.cDel;
      const lines = [
        n.photos && `写真の情報を ${n.photos}枚 更新`,
        n.tUpd && `付箋を ${n.tUpd}枚 更新`, n.tNew && `付箋を ${n.tNew}枚 追加`, n.tDel && `付箋を ${n.tDel}枚 削除`,
        n.cUpd && `コメントを ${n.cUpd}件 更新`, n.cNew && `コメントを ${n.cNew}件 追加`, n.cDel && `コメントを ${n.cDel}件 削除`,
      ].filter(Boolean);
      if (!lines.length) { toast('変更はありませんでした。'); return; }
      IMPORT = payload;
      $('#import-summary').innerHTML = lines.map(l => `<li>${esc(l)}</li>`).join('');
      busy(false);
      $('#dlg-import').showModal();
    } catch (err) { toast(err.message, 'error'); } finally { busy(false); }
  }
  $('#dlg-import form').addEventListener('submit', async e => {
    e.preventDefault();
    if (!IMPORT) return;
    $('#dlg-import').close();
    busy('Excelの内容を反映しています…');
    try {
      const r = await api('importData', IMPORT);
      IMPORT = null;
      const x = r.result || {};
      await loadBoard();
      renderPhotoGrid();
      toast(`反映しました（写真 ${x.photos || 0}枚、付箋 更新${x.themesUpdated || 0}・追加${x.themesAdded || 0}・削除${x.themesDeleted || 0}、コメント ${(x.commentsUpdated || 0) + (x.commentsAdded || 0) + (x.commentsDeleted || 0)}件）。`);
    } catch (err) { toast(err.message, 'error'); } finally { busy(false); }
  });

  /* ============================================================
   * ビューワー
   * ============================================================ */
  const V = { theme: null, list: [], mode: 'random', session: 0, cleanup: null, current: null, comments: new Map(), keys: null };
  const viewer = $('#viewer');
  const stage = $('#v-stage');
  const controls = $('#v-controls');

  function openViewer(t, mode) {
    if (!t) return;
    const list = t.photoIds.filter(isActive).map(photo);
    if (!list.length) {
      if (S.readOnly) return toast('このテーマには写真がありません。', 'warn');
      mode = 'grid';
    }
    V.theme = t; V.list = list; V.current = null; V.comments = new Map();
    $('#v-title').textContent = t.title;
    viewer.hidden = false;
    viewer.classList.remove('side-open');
    document.body.classList.add('lock');
    api('listComments', { fileIds: t.photoIds }).then(r => {
      (r.comments || []).forEach(c => {
        if (!V.comments.has(c.fileId)) V.comments.set(c.fileId, []);
        V.comments.get(c.fileId).push(c);
      });
      renderSide();
    }).catch(() => {});
    setMode(mode || 'random');
  }
  function closeViewer() {
    if (viewer.hidden) return;
    stopMode();
    V.session++;
    viewer.hidden = true;
    document.body.classList.remove('lock');
  }
  $('#v-close').addEventListener('click', closeViewer);
  $$('.mode-tabs [data-mode]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
  document.addEventListener('keydown', e => {
    if (viewer.hidden) return;
    if (e.key === 'Escape' && !document.querySelector('dialog[open]')) { closeViewer(); return; }
    if (V.keys && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) V.keys(e);
  });

  function stopMode() {
    if (V.cleanup) { try { V.cleanup(); } catch (_) { /* noop */ } }
    V.cleanup = null; V.keys = null;
  }
  function setMode(m) {
    stopMode();
    V.session++;
    V.mode = m;
    viewer.dataset.mode = m;
    $$('.mode-tabs [data-mode]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.mode === m)));
    stage.innerHTML = ''; stage.className = 'v-stage'; controls.innerHTML = '';
    if (m === 'cinema' || m === 'grid') viewer.classList.remove('side-open');
    if (m !== 'grid' && !V.list.length) { setMode('grid'); return; }
    ({ grid: startGrid, random: startRandom, album: startAlbum, cinema: startCinema })[m](V.session);
  }
  function sideToggleBtn() {
    const b = document.createElement('button');
    b.className = 'btn small'; b.textContent = 'コメント';
    b.setAttribute('aria-pressed', String(viewer.classList.contains('side-open')));
    b.addEventListener('click', () => {
      const on = viewer.classList.toggle('side-open');
      b.setAttribute('aria-pressed', String(on));
      renderSide();
    });
    return b;
  }
  function ctrlBtn(label, fn, cls = 'btn small') {
    const b = document.createElement('button');
    b.className = cls; b.textContent = label; b.addEventListener('click', fn);
    return b;
  }
  const commentsOf = id => V.comments.get(id) || [];
  function captionOf(p) {
    const cs = commentsOf(p.fileId);
    const c = cs.find(x => x.type === 'manual') || cs[0];
    return c ? c.text : (p.description || '');
  }
  function setCurrent(p) {
    V.current = p;
    if (viewer.classList.contains('side-open')) renderSide();
  }

  /* サイドパネル（情報・コメント） */
  function renderSide() {
    const side = $('#v-side');
    const p = V.current;
    if (!viewer.classList.contains('side-open')) return;
    if (!p) { side.innerHTML = '<p class="muted">写真を表示すると、ここに情報とコメントが出ます。</p>'; return; }
    const cs = commentsOf(p.fileId);
    const ro = S.readOnly;
    side.innerHTML = `
      <div class="side-meta">
        <p class="side-date">${esc(fmtDate(p.takenAt) || '撮影日不明')}</p>
        <p class="side-place">${esc(p.place || '場所の情報なし')}</p>
        <p class="side-tags">${(p.tags || []).map(t => `<span>${esc(t)}</span>`).join('')}</p>
        ${p.description ? `<p class="side-desc">${esc(p.description)}</p>` : ''}
        ${ro ? '' : `<p class="side-actions">
          <button type="button" class="btn small" data-out>この付箋から外す</button>
          <button type="button" class="link" data-edit>写真の情報を直す</button></p>`}
      </div>
      <ul class="comments">${cs.length ? cs.map(c => `
        <li data-type="${c.type}">
          <p>${esc(c.text)}</p>
          <span class="who">${c.type === 'ai' ? 'AIの回想' : 'コメント'}　${esc(fmtDate(c.createdAt))}</span>
          ${ro ? '' : `<button type="button" class="link danger" data-del="${esc(c.commentId)}">削除</button>`}
        </li>`).join('') : '<li class="empty">まだコメントはありません。</li>'}
      </ul>
      ${ro ? '' : `<form class="comment-form">
        <textarea name="text" rows="3" maxlength="500" placeholder="この写真の思い出を書く" aria-label="コメント"></textarea>
        <div class="row">
          <button class="btn primary small" type="submit">コメントを保存</button>
          <button class="btn small" type="button" data-ai>AIで回想コメント</button>
        </div>
      </form>`}`;
  }
  const sideEl = $('#v-side');
  sideEl.addEventListener('submit', async e => {
    e.preventDefault();
    const p = V.current, f = e.target;
    const text = f.elements.namedItem('text').value.trim();
    if (!p || !text || S.readOnly) return;
    const btn = f.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const r = await api('addComment', { fileId: p.fileId, text });
      addLocalComment(r.comment);
      renderSide();
      toast('コメントを保存しました。');
    } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
  });
  sideEl.addEventListener('click', async e => {
    const p = V.current;
    if (!p || S.readOnly) return;
    const ai = e.target.closest('[data-ai]');
    const del = e.target.closest('[data-del]');
    if (ai) {
      ai.disabled = true; ai.textContent = 'AIが思い出しています…';
      try {
        const r = await api('aiComment', { fileId: p.fileId });
        addLocalComment(r.comment);
        renderSide();
      } catch (err) { toast(err.message, 'error'); ai.disabled = false; ai.textContent = 'AIで回想コメント'; }
    }
    if (del) {
      if (!confirm('このコメントを削除しますか？')) return;
      try {
        await api('deleteComment', { commentId: del.dataset.del });
        V.comments.set(p.fileId, commentsOf(p.fileId).filter(c => c.commentId !== del.dataset.del));
        renderSide();
      } catch (err) { toast(err.message, 'error'); }
    }
    if (e.target.closest('[data-out]')) {
      if (!confirm('この写真を「' + V.theme.title + '」から外しますか？（「写真を探し直す」でも戻りません）')) return;
      try {
        const r = await api('assignPhotos', { themeId: V.theme.themeId, fileIds: [p.fileId], mode: 'remove' });
        upsertTheme(r.theme);
        V.theme = r.theme;
        V.list = V.list.filter(x => x.fileId !== p.fileId);
        toast('付箋から外しました。');
        if (!V.list.length) closeViewer(); else setMode(V.mode);
      } catch (err) { toast(err.message, 'error'); }
    }
    if (e.target.closest('[data-edit]')) {
      openPhotoEdit(p.fileId, np => {
        V.list = V.list.map(x => (x.fileId === np.fileId ? np : x));
        V.current = np;
        renderSide();
      });
    }
  });
  function addLocalComment(c) {
    const list = commentsOf(c.fileId);
    list.unshift(c);
    V.comments.set(c.fileId, list);
  }

  /* ---------- モード0: 一覧（サムネイル・選択・一括修正・外す・追加） ---------- */
  function refreshViewerList() {
    const t = theme(V.theme.themeId);
    if (t) V.theme = t;
    V.list = V.theme.photoIds.filter(isActive).map(photo);
  }
  function startGrid(sess) {
    stage.classList.add('gridview');
    const ro = S.readOnly;
    const sel = new Set();
    const alive = () => sess === V.session;
    let obs = null;
    stage.innerHTML = '<p class="vg-info"></p><div class="vg-grid"></div>';
    const grid = $('.vg-grid', stage);

    const allBtn = ctrlBtn('すべて選ぶ', () => { V.list.forEach(p => sel.add(p.fileId)); render(); });
    const clearBtn = ctrlBtn('選択を解除', () => { sel.clear(); render(); });
    const bulkBtn = ctrlBtn('情報を一括修正', () => {
      openBulk([...sel], () => { if (!alive()) return; sel.clear(); refreshViewerList(); render(); });
    });
    const outBtn = ctrlBtn('この付箋から外す', async () => {
      const ids = [...sel];
      if (!ids.length) return;
      if (!confirm(`選んだ${ids.length}枚を「${V.theme.title}」から外しますか？\n（外した写真は「写真を探し直す」でも戻りません。写真ファイルは消えません）`)) return;
      busy('付箋から外しています…');
      try {
        const r = await api('assignPhotos', { themeId: V.theme.themeId, fileIds: ids, mode: 'remove' });
        upsertTheme(r.theme);
        sel.clear(); refreshViewerList(); render();
        toast(`${ids.length}枚を付箋から外しました。`);
      } catch (err) { toast(err.message, 'error'); } finally { busy(false); }
    });
    const addBtn = ctrlBtn('写真を追加', () => {
      openPicker(V.theme, () => { if (!alive()) return; refreshViewerList(); render(); });
    }, 'btn small primary');
    if (!ro) controls.append(allBtn, clearBtn, bulkBtn, outBtn, addBtn);

    function update() {
      $('.vg-info', stage).textContent = ro ? `${V.list.length}枚` : `${V.list.length}枚　${sel.size}枚を選択中`;
      bulkBtn.disabled = outBtn.disabled = clearBtn.disabled = !sel.size;
    }
    function render() {
      if (obs) obs.disconnect();
      const list = chrono(V.list);
      grid.innerHTML = list.length ? list.map(p => {
        const on = sel.has(p.fileId);
        return `<div class="vg-item${on ? ' sel' : ''}" data-file="${esc(p.fileId)}"${ro ? '' : ` role="checkbox" tabindex="0" aria-checked="${on}"`}>
          <span class="im"><img alt="" hidden></span>
          ${ro ? '' : '<span class="ck"></span>'}
          ${p.fileId === V.theme.coverFileId ? '<span class="cv">表紙</span>' : ''}
          ${ro ? '' : '<button type="button" class="ed" aria-label="写真の情報を開く">✎</button>'}
          <span class="cap">${esc([fmtDate(p.takenAt), p.place].filter(Boolean).join('　') || p.fileName || '')}</span>
        </div>`;
      }).join('') : '<p class="vg-empty">この付箋には写真がありません。「写真を追加」で入れられます。</p>';
      obs = new IntersectionObserver(entries => {
        entries.forEach(en => {
          if (!en.isIntersecting) return;
          obs.unobserve(en.target);
          const img = en.target.querySelector('img');
          loadImg(en.target.dataset.file, 'thumb').then(u => { img.src = u; img.hidden = false; }).catch(() => {});
        });
      }, { root: stage, rootMargin: '300px' });
      $$('.vg-item', grid).forEach(el => obs.observe(el));
      update();
    }
    function toggle(el) {
      const id = el.dataset.file;
      sel.has(id) ? sel.delete(id) : sel.add(id);
      const on = sel.has(id);
      el.classList.toggle('sel', on);
      el.setAttribute('aria-checked', String(on));
      update();
    }
    grid.addEventListener('click', e => {
      const el = e.target.closest('.vg-item');
      if (!el || ro) return;
      if (e.target.closest('.ed')) {
        openPhotoEdit(el.dataset.file, () => { if (!alive()) return; refreshViewerList(); render(); });
        return;
      }
      toggle(el);
    });
    grid.addEventListener('keydown', e => {
      const el = e.target.closest('.vg-item');
      if (el && (e.key === ' ' || e.key === 'Enter') && !e.target.closest('.ed')) { e.preventDefault(); toggle(el); }
    });
    V.cleanup = () => { if (obs) obs.disconnect(); };
    render();
  }

  /* 付箋に写真を追加（ライブラリから選ぶ） */
  let PICK = null;
  let pickObs = null;
  function openPicker(t, done) {
    PICK = { themeId: t.themeId, done, sel: new Set() };
    $('#pick-title').textContent = `「${t.title}」に写真を追加`;
    $('#pick-q').value = '';
    $('#pick-filter').value = 'all';
    renderPick();
    $('#dlg-pick').showModal();
  }
  function renderPick() {
    const t = theme(PICK.themeId);
    const words = $('#pick-q').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const orphanOnly = $('#pick-filter').value === 'orphan';
    const mc = membershipCount();
    const list = chrono(S.photos).reverse().filter(p => {
      if (p.status === 'dup' || t.photoIds.includes(p.fileId)) return false;
      if (orphanOnly && mc.get(p.fileId)) return false;
      if (!words.length) return true;
      const text = [p.fileName, p.takenAt, p.place, (p.tags || []).join(' '), p.scene, p.mood, p.description].join(' ').toLowerCase();
      return words.every(w => text.includes(w));
    });
    const grid = $('#pick-grid');
    if (pickObs) pickObs.disconnect();
    grid.innerHTML = list.length ? list.map(p => `
      <div class="vg-item light${PICK.sel.has(p.fileId) ? ' sel' : ''}" data-file="${esc(p.fileId)}" role="checkbox" tabindex="0" aria-checked="${PICK.sel.has(p.fileId)}">
        <span class="im"><img alt="" hidden></span><span class="ck"></span>
        <span class="cap">${esc([fmtDate(p.takenAt), p.place].filter(Boolean).join('　') || p.fileName || '')}</span>
      </div>`).join('') : '<p class="muted">追加できる写真がありません。</p>';
    pickObs = new IntersectionObserver(entries => {
      entries.forEach(en => {
        if (!en.isIntersecting) return;
        pickObs.unobserve(en.target);
        const img = en.target.querySelector('img');
        loadImg(en.target.dataset.file, 'thumb').then(u => { img.src = u; img.hidden = false; }).catch(() => {});
      });
    }, { root: grid, rootMargin: '300px' });
    $$('.vg-item', grid).forEach(el => pickObs.observe(el));
    $('#pick-count').textContent = `${list.length}枚から選べます　${PICK.sel.size}枚を選択中`;
  }
  let pickTimer;
  $('#pick-q').addEventListener('input', () => { clearTimeout(pickTimer); pickTimer = setTimeout(renderPick, 200); });
  $('#pick-filter').addEventListener('change', renderPick);
  function pickToggle(el) {
    const id = el.dataset.file;
    PICK.sel.has(id) ? PICK.sel.delete(id) : PICK.sel.add(id);
    const on = PICK.sel.has(id);
    el.classList.toggle('sel', on);
    el.setAttribute('aria-checked', String(on));
    $('#pick-count').textContent = $('#pick-count').textContent.replace(/\d+枚を選択中/, `${PICK.sel.size}枚を選択中`);
  }
  $('#pick-grid').addEventListener('click', e => { const el = e.target.closest('.vg-item'); if (el) pickToggle(el); });
  $('#pick-grid').addEventListener('keydown', e => {
    const el = e.target.closest('.vg-item');
    if (el && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); pickToggle(el); }
  });
  $('#dlg-pick form').addEventListener('submit', async e => {
    e.preventDefault();
    const ids = [...PICK.sel];
    if (!ids.length) return toast('追加する写真を選んでください。', 'warn');
    busy(`${ids.length}枚を付箋に入れています…`);
    try {
      const r = await api('assignPhotos', { themeId: PICK.themeId, fileIds: ids, mode: 'add' });
      upsertTheme(r.theme);
      $('#dlg-pick').close();
      if (PICK.done) PICK.done();
      toast(`「${r.theme.title}」に${ids.length}枚を入れました。`);
    } catch (err) { toast(err.message, 'error'); } finally { busy(false); }
  });

  /* ---------- モード1: ランダム ---------- */
  function startRandom(sess) {
    stage.classList.add('table');
    let order = shuffle([...V.list]);
    let i = 0, playing = true, speed = 2800, timer;
    const alive = () => sess === V.session;

    async function show() {
      if (i >= order.length) { order = shuffle(order); i = 0; }
      const p = order[i++];
      let url;
      try { url = await loadImg(p.fileId, 'mid', true); } catch (_) { return; }
      if (!alive()) return;
      const card = document.createElement('figure');
      card.className = 'print';
      card.style.setProperty('--rot', (Math.random() * 14 - 7).toFixed(1) + 'deg');
      card.style.setProperty('--dx', (Math.random() * 12 - 6).toFixed(1) + 'vw');
      card.style.setProperty('--dy', (Math.random() * 8 - 4).toFixed(1) + 'vh');
      card.innerHTML = `<img src="${url}" alt=""><figcaption>${esc([fmtDate(p.takenAt), p.place].filter(Boolean).join('　'))}</figcaption>`;
      stage.appendChild(card);
      requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add('in')));
      const prints = stage.querySelectorAll('.print');
      if (prints.length > 6) prints[0].remove();
      setCurrent(p);
      const next = order[i % order.length];
      if (next) loadImg(next.fileId, 'mid', true).catch(() => {});
    }
    function loop() {
      clearTimeout(timer);
      if (!playing || !alive()) return;
      show().finally(() => { if (playing && alive()) timer = setTimeout(loop, speed); });
    }

    const playBtn = ctrlBtn('一時停止', () => {
      playing = !playing;
      playBtn.textContent = playing ? '一時停止' : '再生';
      if (playing) loop(); else clearTimeout(timer);
    });
    const nextBtn = ctrlBtn('次の写真', () => { clearTimeout(timer); show().finally(() => { if (playing && alive()) timer = setTimeout(loop, speed); }); });
    const shuffleBtn = ctrlBtn('混ぜ直す', () => { order = shuffle(order); i = 0; stage.innerHTML = ''; loop(); });
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', '切り替えの速さ');
    sel.innerHTML = '<option value="4500">ゆっくり</option><option value="2800" selected>ふつう</option><option value="1500">はやい</option>';
    sel.addEventListener('change', () => { speed = Number(sel.value); });
    controls.append(playBtn, nextBtn, shuffleBtn, sel, sideToggleBtn());

    V.keys = e => {
      if (e.key === ' ') { e.preventDefault(); playBtn.click(); }
      if (e.key === 'ArrowRight') nextBtn.click();
    };
    V.cleanup = () => { playing = false; clearTimeout(timer); };
    loop();
  }

  /* ---------- モード2: アルバム（ページめくり） ---------- */
  function startAlbum(sess) {
    stage.classList.add('desk');
    const list = chrono(V.list);
    let idx = 0, turning = false;
    const alive = () => sess === V.session;
    stage.innerHTML = '<div><div class="book"><div class="page base"></div></div><p class="page-no"></p></div>';
    const book = $('.book', stage), base = $('.page.base', stage);

    async function pageHTML(p) {
      let url = '';
      try { url = await loadImg(p.fileId, 'full', true); } catch (_) { /* 空のページ */ }
      return `<div class="page-inner">
        <div class="mount">${url ? `<img src="${url}" alt="">` : '<p class="muted">写真を読み込めませんでした</p>'}</div>
        <p class="cap-date">${esc([fmtDate(p.takenAt), p.place].filter(Boolean).join('　'))}</p>
        <p class="cap-text">${esc(captionOf(p))}</p>
      </div>`;
    }
    function updateNo() {
      $('.page-no', stage).textContent = `${idx + 1} / ${list.length}`;
      counter.textContent = `${idx + 1} / ${list.length}`;
      prevBtn.disabled = idx === 0;
      nextBtn.disabled = idx === list.length - 1;
    }
    function prefetch() {
      [idx - 1, idx + 1, idx + 2].forEach(n => { if (list[n]) loadImg(list[n].fileId, 'full').catch(() => {}); });
    }
    async function go(dir) {
      const ni = idx + dir;
      if (turning || ni < 0 || ni >= list.length) return;
      turning = true;
      const curHTML = base.innerHTML;
      const nextHTML = await pageHTML(list[ni]);
      if (!alive()) return;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (dir < 0) base.innerHTML = nextHTML;
        turn.remove();
        idx = ni; updateNo(); setCurrent(list[idx]); prefetch();
        turning = false;
      };
      const turn = document.createElement('div');
      turn.className = 'page turn';
      turn.innerHTML = '<div class="face front"></div><div class="face back"></div>';
      if (dir > 0) {
        base.innerHTML = nextHTML;
        turn.querySelector('.front').innerHTML = curHTML;
        book.appendChild(turn);
        turn.getBoundingClientRect();
        turn.classList.add('flipped');
      } else {
        turn.classList.add('flipped', 'instant');
        turn.querySelector('.front').innerHTML = nextHTML;
        book.appendChild(turn);
        turn.getBoundingClientRect();
        turn.classList.remove('instant');
        turn.getBoundingClientRect();
        turn.classList.remove('flipped');
      }
      if (reduceMotion) finish();
      else { turn.addEventListener('transitionend', finish, { once: true }); setTimeout(finish, 1300); }
    }

    const prevBtn = ctrlBtn('前のページ', () => go(-1));
    const counter = document.createElement('span');
    counter.className = 'counter';
    const nextBtn = ctrlBtn('次のページ', () => go(1));
    controls.append(prevBtn, counter, nextBtn, sideToggleBtn());

    let sx = null;
    const onDown = e => { sx = e.clientX; };
    const onUp = e => {
      if (sx == null) return;
      const dx = e.clientX - sx; sx = null;
      if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
    };
    stage.addEventListener('pointerdown', onDown);
    stage.addEventListener('pointerup', onUp);
    V.keys = e => {
      if (e.key === 'ArrowRight') go(1);
      if (e.key === 'ArrowLeft') go(-1);
    };
    V.cleanup = () => {
      stage.removeEventListener('pointerdown', onDown);
      stage.removeEventListener('pointerup', onUp);
    };

    pageHTML(list[0]).then(h => {
      if (!alive()) return;
      base.innerHTML = h; updateNo(); setCurrent(list[0]); prefetch();
    });
  }

  /* ---------- モード3: 走馬灯（Ken Burns + TTS + 地図/Earth映像） ---------- */
  const ttsCache = new Map();
  function pcmToWav(bytes, rate) {
    const buf = new ArrayBuffer(44 + bytes.length);
    const v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + bytes.length, true); w(8, 'WAVE');
    w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, bytes.length, true);
    new Uint8Array(buf, 44).set(bytes);
    return new Blob([buf], { type: 'audio/wav' });
  }
  function audioBlob(b64, mime) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (/L16|pcm/i.test(mime || '')) {
      const m = String(mime).match(/rate=(\d+)/);
      return pcmToWav(bytes, m ? Number(m[1]) : 24000);
    }
    return new Blob([bytes], { type: mime || 'audio/wav' });
  }
  function ttsUrl(text) {
    const k = voice() + '|' + text;
    if (!ttsCache.has(k)) {
      const p = api('tts', { text, voice: voice() }).then(r => URL.createObjectURL(audioBlob(r.audio, r.mimeType)));
      p.catch(() => ttsCache.delete(k));
      ttsCache.set(k, p);
    }
    return ttsCache.get(k);
  }

  function startCinema(sess) {
    stage.classList.add('cinema');
    const t = V.theme;
    stage.innerHTML = `
      <div class="c-layers"></div>
      <div class="c-sub" aria-live="polite"><p class="c-meta"></p><p class="c-text"></p></div>
      <div class="c-start">
        <h3>${esc(t.title)}</h3>
        <p>${V.list.length}枚の写真を、撮った順にゆっくり振り返ります。</p>
        <label class="check"><input type="checkbox" id="c-voice" checked> ナレーション音声を流す</label>
        <button class="btn primary big" id="c-play">再生する</button>
      </div>`;
    const layers = $('.c-layers', stage);
    const startBox = $('.c-start', stage);
    const STOP = {};
    let paused = false, voiceOn = true, running = false, warned = false, started = false;
    const player = new Audio();
    player.preload = 'auto';
    const alive = () => sess === V.session;

    const pauseBtn = ctrlBtn('一時停止', () => {
      if (!running) return;
      paused = !paused;
      pauseBtn.textContent = paused ? '再生' : '一時停止';
      stage.classList.toggle('paused', paused);
      if (paused) player.pause(); else if (player.src && !player.ended && player.currentTime > 0) player.play().catch(() => {});
      $$('video', stage).forEach(v => (paused ? v.pause() : v.play().catch(() => {})));
    });
    const voiceBtn = ctrlBtn('音声 オン', () => {
      voiceOn = !voiceOn;
      voiceBtn.textContent = voiceOn ? '音声 オン' : '音声 オフ';
      voiceBtn.setAttribute('aria-pressed', String(!voiceOn));
      if (!voiceOn) player.pause();
    });
    const restartBtn = ctrlBtn('最初から', () => setMode('cinema'));
    pauseBtn.disabled = true;
    restartBtn.disabled = true;
    controls.append(pauseBtn, voiceBtn, restartBtn);
    V.keys = e => { if (e.key === ' ') { e.preventDefault(); pauseBtn.click(); } };
    V.cleanup = () => {
      player.pause(); player.removeAttribute('src');
      $$('.c-layer', stage).forEach(l => { if (l._map) l._map.remove(); });
    };

    async function wait(ms) {
      let t0 = 0;
      while (t0 < ms) {
        if (!alive()) throw STOP;
        await sleep(100);
        if (!paused) t0 += 100;
      }
    }
    function setSub(meta, text) {
      const tx = $('.c-text', stage);
      $('.c-meta', stage).textContent = meta || '';
      tx.classList.add('fade');
      setTimeout(() => { tx.textContent = text || ''; tx.classList.remove('fade'); }, 300);
    }
    function swap(layer) {
      layers.appendChild(layer);
      requestAnimationFrame(() => requestAnimationFrame(() => layer.classList.add('on')));
      [...layers.children].filter(c => c !== layer).forEach(o => {
        o.classList.remove('on');
        $$('video', o).forEach(v => v.pause());
        setTimeout(() => { if (o._map) o._map.remove(); o.remove(); }, 1800);
      });
    }
    async function prepareAudio(text) {
      if (!voiceOn || !text) return 0;
      try {
        const url = await ttsUrl(text);
        if (!alive()) throw STOP;
        player.src = url;
        await new Promise(res => {
          const done = () => { player.removeEventListener('loadedmetadata', done); res(); };
          player.addEventListener('loadedmetadata', done);
          setTimeout(done, 3000);
        });
        return isFinite(player.duration) ? player.duration : 0;
      } catch (e) {
        if (e === STOP) throw e;
        if (!warned) { warned = true; toast('ナレーション音声を作れませんでした。字幕だけで続けます。', 'warn'); }
        return 0;
      }
    }
    async function speakAndWait(text, minMs) {
      const dur = await prepareAudio(text);
      if (dur && voiceOn && !paused) player.play().catch(() => {});
      await wait(Math.max(minMs, dur * 1000 + 900));
      player.pause();
    }

    /* 区間 */
    async function titleSeg(main, sub, text) {
      const l = document.createElement('div');
      l.className = 'c-layer c-title';
      l.innerHTML = `<h3>${esc(main)}</h3>${sub ? `<p>${esc(sub)}</p>` : ''}`;
      swap(l);
      setSub('', text);
      await speakAndWait(text, 4200);
    }
    async function photoSeg(p, text, nextText) {
      let url;
      try { url = await loadImg(p.fileId, 'full', true); } catch (_) { return; }
      if (!alive()) throw STOP;
      if (nextText && voiceOn) ttsUrl(nextText).catch(() => {});
      const dur = await prepareAudio(text);
      const secs = Math.max(MIN_SEC, dur + 1.6);
      const l = document.createElement('div');
      l.className = 'c-layer';
      const ang = Math.random() * Math.PI * 2, d = 2.4;
      const vars = {
        '--s0': (1 + Math.random() * 0.04).toFixed(3), '--s1': (1.1 + Math.random() * 0.08).toFixed(3),
        '--x0': (-Math.cos(ang) * d).toFixed(2) + '%', '--y0': (-Math.sin(ang) * d).toFixed(2) + '%',
        '--x1': (Math.cos(ang) * d).toFixed(2) + '%', '--y1': (Math.sin(ang) * d).toFixed(2) + '%',
        '--d': (secs + 1.8).toFixed(1) + 's',
      };
      l.innerHTML = `<div class="c-bg" style="background-image:url('${url}')"></div><div class="c-fg"><img src="${url}" alt=""></div>`;
      const img = l.querySelector('.c-fg img');
      Object.keys(vars).forEach(k => img.style.setProperty(k, vars[k]));
      swap(l);
      setCurrent(p);
      setSub([fmtDate(p.takenAt), p.place].filter(Boolean).join('　'), text);
      if (dur && voiceOn && !paused) player.play().catch(() => {});
      await wait(secs * 1000);
      player.pause();
    }
    async function flightSeg(from, to) {
      if (!window.L) return;
      const l = document.createElement('div');
      l.className = 'c-layer c-map';
      const box = document.createElement('div');
      box.className = 'c-mapbox';
      l.appendChild(box);
      swap(l);
      const map = L.map(box, { zoomControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false });
      l._map = map;
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap contributors' }).addTo(map);
      map.setView([from.lat, from.lng], 9);
      L.circleMarker([from.lat, from.lng], { radius: 6, color: '#fff', weight: 2, fillColor: '#A9E3F2', fillOpacity: 1 }).addTo(map);
      setSub('', `${to.place || '次の場所'}へ`);
      await wait(900);
      map.invalidateSize();
      const far = km(from, to);
      map.flyTo([to.lat, to.lng], far > 500 ? 9 : 11, { duration: reduceMotion ? 0 : 3.6 });
      await wait(3900);
      L.circleMarker([to.lat, to.lng], { radius: 10, color: '#fff', weight: 3, fillColor: '#FFEF7A', fillOpacity: 1 }).addTo(map);
      await wait(1300);
    }
    async function earthSeg(url) {
      const l = document.createElement('div');
      l.className = 'c-layer c-media';
      const yt = url.match(/(?:youtu\.be\/|[?&]v=|shorts\/|embed\/)([\w-]{11})/);
      const dr = url.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=)([\w-]+)/);
      let video = null;
      if (yt) {
        l.innerHTML = `<iframe src="https://www.youtube.com/embed/${yt[1]}?autoplay=1&mute=1&controls=0&playsinline=1&rel=0" allow="autoplay; encrypted-media" title="フライト映像"></iframe>`;
      } else if (dr) {
        l.innerHTML = `<iframe src="https://drive.google.com/file/d/${dr[1]}/preview" allow="autoplay" title="フライト映像"></iframe>`;
      } else {
        video = document.createElement('video');
        video.src = url; video.muted = true; video.playsInline = true; video.autoplay = true;
        l.appendChild(video);
      }
      swap(l);
      setSub('', '撮影地の上空へ');
      if (video) {
        const ended = new Promise(res => { video.addEventListener('ended', res, { once: true }); video.addEventListener('error', res, { once: true }); });
        video.play().catch(() => {});
        let elapsed = 0;
        let finished = false;
        ended.then(() => { finished = true; });
        while (!finished && elapsed < 40000) { await wait(200); elapsed += 200; }
      } else {
        await wait(dr ? 25000 : 20000);
      }
    }

    async function run() {
      running = true;
      startBox.hidden = true;
      pauseBtn.disabled = false;
      restartBtn.disabled = false;
      if (!S.readOnly && (!t.narration || !Array.isArray(t.narration.lines))) {
        setSub('', 'ナレーションを用意しています…');
        try {
          const r = await api('generateNarration', { themeId: t.themeId });
          t.narration = r.narration;
        } catch (err) {
          toast('ナレーションを作れませんでした: ' + err.message, 'warn');
        }
        if (!alive()) return;
      }
      const nar = t.narration && Array.isArray(t.narration.lines) ? t.narration : null;
      const lineMap = new Map((nar ? nar.lines : []).map(l => [l.fileId, l.text]));
      const photos = nar
        ? chrono(nar.lines.map(l => photo(l.fileId)).filter(p => S.photoMap.has(p.fileId)))
        : sampleEven(chrono(V.list), 24);

      const dates = photos.map(p => p.takenAt).filter(Boolean).sort();
      const span = dates.length ? [fmtDate(dates[0]), fmtDate(dates[dates.length - 1])].filter((v, i, a) => a.indexOf(v) === i).join(' 〜 ') : '';

      try {
        await titleSeg(t.title, span, nar ? nar.intro : '');
        if (t.earthVideoUrl) await earthSeg(t.earthVideoUrl);
        let last = null;
        for (let i = 0; i < photos.length; i++) {
          const p = photos[i];
          if (hasLoc(p)) {
            if (last && km(last, p) >= FLIGHT_KM) await flightSeg(last, p);
            last = p;
          }
          const text = lineMap.get(p.fileId) || '';
          const next = photos[i + 1] ? lineMap.get(photos[i + 1].fileId) : (nar ? nar.outro : '');
          await photoSeg(p, text, next);
        }
        await titleSeg('おわり', t.title, nar ? nar.outro : '');
        setSub('', '');
        startBox.querySelector('h3').textContent = t.title;
        startBox.querySelector('p').textContent = '最後まで再生しました。';
        startBox.querySelector('#c-play').textContent = 'もう一度再生する';
        startBox.hidden = false;
        running = false;
        pauseBtn.disabled = true;
      } catch (e) {
        if (e !== STOP) toast(e.message || '再生を続けられませんでした。', 'error');
      }
    }

    $('#c-play', stage).addEventListener('click', () => {
      if (started && running) return;
      voiceOn = $('#c-voice', stage).checked;
      voiceBtn.textContent = voiceOn ? '音声 オン' : '音声 オフ';
      // iOS 等の自動再生制限を解除するため、クリック内で無音を一度鳴らす
      player.src = URL.createObjectURL(pcmToWav(new Uint8Array(4800), 24000));
      player.play().catch(() => {});
      if (running) return;
      if (startBox.querySelector('#c-play').textContent.startsWith('もう一度')) { setMode('cinema'); return; }
      started = true;
      ensureLeaflet().catch(() => {}).then(run);
    });
  }
  /* ============================================================
   * 起動
   * ============================================================ */
  $$('.ver').forEach(el => { el.textContent = VERSION; });
  receiveShare();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  document.title = CFG.APP_NAME || document.title;
  if (S.token && S.user) {
    if (S.user.isFirstLogin) showAuth('change'); else enterApp();
  } else {
    showAuth('login');
  }
})();

/* おもいで付箋ボード — app.js  v1.0.0 */
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
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const S = {
    token: localStorage.getItem(KEY.token) || '',
    user: parseJson(localStorage.getItem(KEY.user)),
    photos: [], photoMap: new Map(), themes: [], folder: null,
    view: { x: 40, y: 90, k: 1 },
    tempPassword: '', suggestions: [], menuTheme: null, editTheme: null,
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
  const gasUrl = () => (localStorage.getItem(KEY.gas) || CFG.GAS_URL || '').trim();
  const voice = () => localStorage.getItem(KEY.voice) || CFG.TTS_VOICE || 'Kore';
  const theme = id => S.themes.find(t => t.themeId === id);
  const photo = id => S.photoMap.get(id) || { fileId: id };

  function fmtDate(s) {
    if (!s) return '';
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return '';
    return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
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
    toastTimer = setTimeout(() => t.classList.remove('show'), type === 'error' ? 6500 : 3800);
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

  /* ============================================================
   * API
   * ============================================================ */
  async function api(action, data = {}) {
    const url = gasUrl();
    if (!url || url.includes('XXXX')) {
      openSettings();
      throw new Error('GASのURLが設定されていません。設定画面で入力してください。');
    }
    let res;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action, token: S.token }, data)),
      });
      res = await r.json();
    } catch (_) {
      throw new Error('サーバーに接続できません。GASのURLと、デプロイの「アクセスできるユーザー：全員」を確認してください。');
    }
    if (!res.ok) {
      if (res.code === 'AUTH') { clearSession(); showAuth('login'); }
      else if (res.code === 'FIRST_LOGIN') { showAuth('change'); }
      throw new Error(res.error || 'エラーが発生しました。');
    }
    return res;
  }

  /* 画像ローダー（同時4件・優先キュー付き） */
  const imgCache = new Map();
  const imgQueue = [];
  let imgActive = 0;
  function loadImg(fileId, size = 'thumb', priority = false) {
    const k = fileId + ':' + size;
    if (imgCache.has(k)) return imgCache.get(k);
    const p = new Promise((resolve, reject) => {
      const job = { fileId, size, resolve, reject };
      priority ? imgQueue.unshift(job) : imgQueue.push(job);
      pumpImg();
    });
    imgCache.set(k, p);
    p.catch(() => imgCache.delete(k));
    return p;
  }
  function pumpImg() {
    while (imgActive < 4 && imgQueue.length) {
      const j = imgQueue.shift();
      imgActive++;
      api('getImage', { fileId: j.fileId, size: j.size })
        .then(r => j.resolve(r.dataUrl), j.reject)
        .finally(() => { imgActive--; pumpImg(); });
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
    S.token = ''; S.user = null;
    localStorage.removeItem(KEY.token); localStorage.removeItem(KEY.user);
    imgCache.clear();
  }

  function showAuth(panel) {
    closeViewer(); closeDrawer(); hideMenu();
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
      const email = f.email.value.trim(), password = f.password.value;
      if (!email || !password) throw new Error('メールアドレスとパスワードを入力してください。');
      const r = await api('login', { email, password });
      setSession(r.token, r.user);
      f.password.value = '';
      if (r.user.isFirstLogin) {
        S.tempPassword = password;
        showAuth('change');
        toast('仮パスワードでログインしました。新しいパスワードを設定してください。');
      } else {
        enterApp();
      }
    },
    async register(f) {
      const email = f.email.value.trim(), nickname = f.nickname.value.trim();
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
      const email = f.email.value.trim();
      if (!email) throw new Error('メールアドレスを入力してください。');
      const r = await api('forgotPassword', { email });
      $('[data-form="login"] [name="email"]').value = email;
      f.reset();
      showAuth('login');
      toast(r.message);
    },
    async change(f) {
      const cur = f.currentPassword.value, nw = f.newPassword.value, cf = f.confirmPassword.value;
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
    $('#dlg-settings').open && $('#dlg-settings').close();
    showAuth('login');
    toast('ログアウトしました。');
  }
  document.addEventListener('click', e => {
    if (e.target.closest('[data-action="logout"]')) logout();
    if (e.target.closest('[data-open-settings]')) openSettings();
    if (e.target.closest('[data-open-drawer]')) openDrawer();
  });

  /* ============================================================
   * アプリ起動
   * ============================================================ */
  async function enterApp() {
    $('#auth').hidden = true; $('#app').hidden = false;
    loadView(); applyView();
    busy('ボードを読み込んでいます…');
    try {
      const [me, th, ph] = await Promise.all([api('me'), api('listThemes'), api('listPhotos')]);
      S.user = Object.assign({}, S.user, me.user); saveUser();
      S.folder = me.folder;
      S.themes = th.themes;
      setPhotos(ph.photos);
      renderBoard();
      if (!localStorage.getItem(KEY.view) && S.themes.length) fitView();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      busy(false);
    }
  }

  function setPhotos(list) {
    S.photos = list;
    S.photoMap = new Map(list.map(p => [p.fileId, p]));
    updatePhotoStats();
  }
  function mergePhotos(list) {
    list.forEach(p => {
      const i = S.photos.findIndex(x => x.fileId === p.fileId);
      if (i >= 0) S.photos[i] = p; else S.photos.push(p);
      S.photoMap.set(p.fileId, p);
    });
    updatePhotoStats();
  }
  function updatePhotoStats() {
    const n = S.photos.length;
    const done = S.photos.filter(p => p.status === 'done').length;
    const err = S.photos.filter(p => p.status === 'error').length;
    $('#photo-count').textContent = n;
    $('#photo-stats').textContent = n
      ? `全${n}枚（解析済み ${done} ／ 未解析 ${n - done - err}${err ? ` ／ エラー ${err}` : ''}）`
      : 'まだ写真がありません。フォルダを読み込むか、写真を追加してください。';
  }
  const analyzedCount = () => S.photos.filter(p => p.status === 'done').length;

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
    el.className = 'note';
    el.dataset.id = t.themeId;
    el.style.left = t.x + 'px';
    el.style.top = t.y + 'px';
    el.style.setProperty('--c', t.color || COLORS[0].v);
    el.style.setProperty('--r', tilt(t.themeId) + 'deg');
    el.tabIndex = 0;
    el.setAttribute('aria-label', `${t.title}（${t.photoIds.length}枚）`);
    el.innerHTML = `
      <div class="note-photo"><img alt="" draggable="false"></div>
      <h3 class="note-title">${esc(t.title)}</h3>
      <span class="note-count">${t.photoIds.length}枚</span>
      <button class="note-menu-btn" aria-label="${esc(t.title)}のメニュー">⋯</button>`;
    const cover = t.coverFileId || t.photoIds[0];
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
    $('#board-empty').hidden = S.themes.length > 0;
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
    viewTimer = setTimeout(() => localStorage.setItem(KEY.view, JSON.stringify(S.view)), 300);
  }
  function loadView() {
    const v = parseJson(localStorage.getItem(KEY.view));
    if (v && isFinite(v.x) && isFinite(v.y) && isFinite(v.k)) S.view = v;
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
    if (note) {
      const t = theme(note.dataset.id);
      gesture = { type: 'note', el: note, t, sx: e.clientX, sy: e.clientY, ox: t.x, oy: t.y, moved: false };
      note.classList.add('dragging');
      boardEl.appendChild(note);
    } else {
      gesture = { type: 'pan', sx: e.clientX, sy: e.clientY, v0: Object.assign({}, S.view), moved: false };
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
      if (Math.abs(dx) + Math.abs(dy) > 3) gesture.moved = true;
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
    if (!btn) return;
    e.stopPropagation();
    const t = theme(btn.closest('.note').dataset.id);
    S.menuTheme = t;
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
      busy('AIが写真を探し直しています…');
      try {
        const r = await api('refreshTheme', { themeId: t.themeId });
        upsertTheme(r.theme);
        toast(`${r.matched}枚の写真が見つかりました。`);
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

  /* テーマを作る */
  $('#preset-chips').innerHTML = PRESETS.map(p => `<button type="button">${esc(p)}</button>`).join('');
  $('#preset-chips').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b) $('#dlg-new [name=title]').value = b.textContent;
  });
  $('#btn-new').addEventListener('click', () => {
    if (!analyzedCount()) { toast('先に写真をAIで解析してください。', 'warn'); openDrawer(); return; }
    const f = $('#dlg-new form');
    f.reset();
    renderSwatches('new', COLORS[S.themes.length % COLORS.length].v);
    $('#dlg-new').showModal();
  });
  $('#dlg-new form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const title = f.title.value.trim();
    if (!title) return toast('テーマを入力してください。', 'warn');
    const color = (f.querySelector('[name=color]:checked') || {}).value;
    const c = viewCenterWorld();
    $('#dlg-new').close();
    busy(`「${title}」に合う写真をAIが探しています…`);
    try {
      const r = await api('createTheme', {
        title, color,
        x: Math.round(c.x - NOTE_W / 2 + (Math.random() * 60 - 30)),
        y: Math.round(c.y - NOTE_H / 2 + (Math.random() * 60 - 30)),
      });
      upsertTheme(r.theme);
      toast(r.matched ? `${r.matched}枚の写真で付箋を貼りました。` : '合う写真が見つかりませんでした。別の言葉で試してみてください。', r.matched ? 'info' : 'warn');
    } catch (err) { toast(err.message, 'error'); } finally { busy(false); }
  });

  /* 名前と色 */
  function openEdit(t) {
    S.editTheme = t;
    const f = $('#dlg-edit form');
    f.title.value = t.title;
    renderSwatches('edit', t.color);
    $('#dlg-edit').showModal();
  }
  $('#dlg-edit form').addEventListener('submit', async e => {
    e.preventDefault();
    const t = S.editTheme, f = e.target;
    const title = f.title.value.trim();
    const color = (f.querySelector('[name=color]:checked') || {}).value;
    if (!title) return toast('テーマを入力してください。', 'warn');
    try {
      const r = await api('updateTheme', { themeId: t.themeId, fields: { title, color } });
      upsertTheme(r.theme);
      $('#dlg-edit').close();
      toast('変更を保存しました。');
    } catch (err) { toast(err.message, 'error'); }
  });

  /* AIにテーマを提案してもらう */
  $('#btn-suggest').addEventListener('click', async () => {
    if (analyzedCount() < 3) { toast('解析済みの写真が3枚以上必要です。', 'warn'); openDrawer(); return; }
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
    const c = viewCenterWorld();
    const cols = Math.min(4, picks.length);
    const startX = c.x - (cols * 260) / 2, startY = c.y - NOTE_H / 2 - (Math.ceil(picks.length / cols) - 1) * 150;
    let added = 0;
    for (let i = 0; i < picks.length; i++) {
      busy(`付箋を貼っています… ${i + 1} / ${picks.length}`);
      const p = picks[i];
      try {
        const r = await api('createTheme', {
          title: p.title, photoIds: p.photoIds, coverFileId: p.coverFileId,
          color: COLORS[(S.themes.length) % COLORS.length].v,
          x: Math.round(startX + (i % cols) * 260), y: Math.round(startY + Math.floor(i / cols) * 310),
        });
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
    }).join('') : '<li class="muted">位置情報つきの写真がありません。スマートフォンの位置情報をオンにして撮った写真で表示されます。</li>';
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
      const r = await api('updateTheme', { themeId: t.themeId, fields: { earthVideoUrl: e.target.earthVideoUrl.value.trim() } });
      upsertTheme(r.theme);
      $('#dlg-earth').close();
      toast('映像を保存しました。走馬灯の最初に流れます。');
    } catch (err) { toast(err.message, 'error'); }
  });

  /* 設定 */
  const voiceSel = $('#dlg-settings [name=voice]');
  voiceSel.innerHTML = VOICES.map(v => `<option value="${v.v}">${esc(v.n)}</option>`).join('');
  function openSettings() {
    const d = $('#dlg-settings');
    if (d.open) return;
    d.querySelector('[name=gasUrl]').value = localStorage.getItem(KEY.gas) || '';
    d.querySelector('[name=gasUrl]').placeholder = CFG.GAS_URL || 'https://script.google.com/macros/s/…/exec';
    voiceSel.value = voice();
    const acc = $('#settings-account');
    acc.hidden = !S.user;
    if (S.user) { $('#acc-name').textContent = S.user.nickname || ''; $('#acc-email').textContent = S.user.email || ''; }
    d.showModal();
  }
  $('#dlg-settings form').addEventListener('submit', e => {
    e.preventDefault();
    const url = e.target.gasUrl.value.trim();
    if (url && !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) {
      return toast('URLは https://script.google.com/macros/s/…/exec の形式で入力してください。', 'warn');
    }
    url ? localStorage.setItem(KEY.gas, url) : localStorage.removeItem(KEY.gas);
    localStorage.setItem(KEY.voice, voiceSel.value);
    $('#dlg-settings').close();
    toast('設定を保存しました。');
  });
  $('#btn-test').addEventListener('click', async () => {
    const input = $('#dlg-settings [name=gasUrl]').value.trim();
    const url = input || CFG.GAS_URL;
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'ping' }) });
      const j = await r.json();
      toast(j.ok ? `接続できました（サーバー v${j.version}）。` : 'サーバーから応答はありましたが、エラーでした。', j.ok ? 'info' : 'warn');
    } catch (_) { toast('接続できませんでした。URLとデプロイ設定を確認してください。', 'error'); }
  });

  /* ============================================================
   * 写真ドロワー
   * ============================================================ */
  const drawer = $('#drawer');
  let gridObserver;
  $('#btn-photos').addEventListener('click', openDrawer);
  $('[data-close-drawer]').addEventListener('click', closeDrawer);
  function openDrawer() {
    if (!S.token) return;
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    renderFolder();
    renderPhotoGrid();
  }
  function closeDrawer() {
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
  }
  function renderFolder() {
    const a = $('#folder-link'), f = S.folder;
    a.textContent = f ? (f.error ? f.error : (f.name || '—') + (f.isHome ? '（アップロード先）' : '')) : '—';
    if (f && f.url) a.href = f.url; else a.removeAttribute('href');
    $('#folder-home').hidden = !f || f.isHome;
  }
  $('#folder-form').addEventListener('submit', async e => {
    e.preventDefault();
    const v = e.target.folder.value.trim();
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
    busy('フォルダの写真を読み込んでいます…');
    try {
      const r = await api('scanFolder');
      setPhotos(r.photos);
      renderPhotoGrid();
      toast(`${r.added}枚を追加${r.removed ? `、${r.removed}枚をリストから外しました` : 'しました'}。`);
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
  function drawerBusy(on) { ['#btn-scan', '#btn-analyze', '#file-input'].forEach(s => { $(s).disabled = on; }); }

  $('#btn-analyze').addEventListener('click', async () => {
    let pending = S.photos.filter(p => p.status === 'pending' || !p.status).length;
    let retryErrors = false;
    if (!pending) {
      const errs = S.photos.filter(p => p.status === 'error').length;
      if (errs && confirm(`解析できなかった写真が${errs}枚あります。もう一度解析しますか？`)) { retryErrors = true; pending = errs; }
      else { toast(S.photos.length ? 'すべて解析済みです。' : '先に写真を読み込んでください。'); return; }
    }
    stopFlag = false; drawerBusy(true);
    let done = 0;
    progress(true, 0, `解析中… 0 / ${pending}`);
    try {
      while (!stopFlag) {
        const r = await api('analyzeBatch', { limit: 3, retryErrors });
        mergePhotos(r.photos || []);
        done += r.processed;
        progress(true, done / pending, `解析中… ${Math.min(done, pending)} / ${pending}`);
        renderPhotoGrid();
        if (!r.remaining || !r.processed) break;
      }
      toast(stopFlag ? '解析を止めました。続きはもう一度「AIで解析する」を押してください。' : '解析が終わりました。「テーマを作る」で付箋を貼れます。');
    } catch (err) { toast(err.message, 'error'); }
    finally { progress(false); drawerBusy(false); }
  });

  $('#file-input').addEventListener('change', async e => {
    const files = [...e.target.files].filter(f => /^image\//.test(f.type) || /\.(heic|heif)$/i.test(f.name));
    e.target.value = '';
    if (!files.length) return;
    stopFlag = false; drawerBusy(true);
    let ok = 0;
    try {
      for (let i = 0; i < files.length && !stopFlag; i++) {
        const f = files[i];
        progress(true, i / files.length, `アップロード中… ${i + 1} / ${files.length}`);
        if (f.size > 15 * 1024 * 1024) { toast(`${f.name} は15MBを超えるため追加できません。`, 'warn'); continue; }
        const data = await fileToBase64(f);
        const r = await api('uploadPhoto', { fileName: f.name, mimeType: f.type || 'image/heic', data });
        mergePhotos([r.photo]);
        ok++;
      }
      toast(`${ok}枚を追加しました。「AIで解析する」で内容を読み取りましょう。`);
    } catch (err) { toast(err.message, 'error'); }
    finally { progress(false); drawerBusy(false); renderPhotoGrid(); }
  });
  function fileToBase64(f) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1]);
      fr.onerror = () => reject(new Error('ファイルを読み込めませんでした。'));
      fr.readAsDataURL(f);
    });
  }

  function renderPhotoGrid() {
    const grid = $('#photo-grid');
    if (gridObserver) gridObserver.disconnect();
    const label = { pending: '未解析', done: '解析済み', error: 'エラー' };
    grid.innerHTML = chrono(S.photos).reverse().map(p => `
      <div class="ph" data-file="${esc(p.fileId)}" data-status="${p.status || 'pending'}"
        title="${esc([p.fileName, fmtDate(p.takenAt), p.place, (p.tags || []).join('、')].filter(Boolean).join('\n'))}">
        <img alt="" hidden><span class="st">${label[p.status] || '未解析'}</span>
      </div>`).join('');
    gridObserver = new IntersectionObserver(entries => {
      entries.forEach(en => {
        if (!en.isIntersecting) return;
        gridObserver.unobserve(en.target);
        const img = en.target.querySelector('img');
        loadImg(en.target.dataset.file, 'thumb').then(u => { img.src = u; img.hidden = false; }).catch(() => {});
      });
    }, { root: grid, rootMargin: '200px' });
    $$('.ph', grid).forEach(el => gridObserver.observe(el));
  }

  /* ============================================================
   * ビューワー
   * ============================================================ */
  const V = { theme: null, list: [], mode: 'random', session: 0, cleanup: null, current: null, comments: new Map(), keys: null };
  const viewer = $('#viewer');
  const stage = $('#v-stage');
  const controls = $('#v-controls');

  function openViewer(t) {
    if (!t) return;
    const list = t.photoIds.map(photo);
    if (!list.length) return toast('このテーマには写真がありません。「写真を探し直す」を試してください。', 'warn');
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
    setMode('random');
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
    if (m === 'cinema') viewer.classList.remove('side-open');
    ({ random: startRandom, album: startAlbum, cinema: startCinema })[m](V.session);
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
    side.innerHTML = `
      <div class="side-meta">
        <p class="side-date">${esc(fmtDate(p.takenAt) || '撮影日不明')}</p>
        <p class="side-place">${esc(p.place || '場所の情報なし')}</p>
        <p class="side-tags">${(p.tags || []).map(t => `<span>${esc(t)}</span>`).join('')}</p>
        ${p.description ? `<p class="side-desc">${esc(p.description)}</p>` : ''}
      </div>
      <ul class="comments">${cs.length ? cs.map(c => `
        <li data-type="${c.type}">
          <p>${esc(c.text)}</p>
          <span class="who">${c.type === 'ai' ? 'AIの回想' : '自分のコメント'}　${esc(fmtDate(c.createdAt))}</span>
          <button type="button" class="link danger" data-del="${esc(c.commentId)}">削除</button>
        </li>`).join('') : '<li class="empty">まだコメントはありません。</li>'}
      </ul>
      <form class="comment-form">
        <textarea name="text" rows="3" maxlength="500" placeholder="この写真の思い出を書く" aria-label="コメント"></textarea>
        <div class="row">
          <button class="btn primary small" type="submit">コメントを保存</button>
          <button class="btn small" type="button" data-ai>AIで回想コメント</button>
        </div>
      </form>`;
  }
  const sideEl = $('#v-side');
  sideEl.addEventListener('submit', async e => {
    e.preventDefault();
    const p = V.current, f = e.target;
    const text = f.text.value.trim();
    if (!p || !text) return;
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
    if (!p) return;
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
  });
  function addLocalComment(c) {
    const list = commentsOf(c.fileId);
    list.unshift(c);
    V.comments.set(c.fileId, list);
  }

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
    let paused = false, voiceOn = true, running = false, warned = false;
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
      if (!t.narration || !Array.isArray(t.narration.lines)) {
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
      } catch (e) {
        if (e !== STOP) toast(e.message || '再生を続けられませんでした。', 'error');
      }
    }

    $('#c-play', stage).addEventListener('click', () => {
      voiceOn = $('#c-voice', stage).checked;
      voiceBtn.textContent = voiceOn ? '音声 オン' : '音声 オフ';
      // iOS 等の自動再生制限を解除するため、クリック内で無音を一度鳴らす
      player.src = URL.createObjectURL(pcmToWav(new Uint8Array(4800), 24000));
      player.play().catch(() => {});
      if (running) return;
      if (startBox.querySelector('#c-play').textContent.startsWith('もう一度')) { setMode('cinema'); return; }
      run();
    });
  }

  /* ============================================================
   * 起動
   * ============================================================ */
  $$('.ver').forEach(el => { el.textContent = VERSION; });
  document.title = CFG.APP_NAME || document.title;
  if (S.token && S.user) {
    if (S.user.isFirstLogin) showAuth('change'); else enterApp();
  } else {
    showAuth('login');
  }
})();

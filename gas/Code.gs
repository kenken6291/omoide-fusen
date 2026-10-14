/**
 * おもいで付箋ボード (omoide-fusen) — Google Apps Script バックエンド
 * Version 1.0.0
 *
 * ── スクリプトプロパティ ──────────────────────────────
 *   GEMINI_API_KEY      (必須) Google AI Studio の API キー
 *   GEMINI_MODEL        (任意) 既定: gemini-2.5-flash
 *   TTS_MODEL           (任意) 既定: gemini-2.5-flash-preview-tts
 *   TTS_VOICE           (任意) 既定: Kore
 *   APP_URL             (任意) GitHub Pages の URL（メール本文に記載）
 *   SHOW_TEMP_PASSWORD  (任意) 'true' で新規登録時に仮パスワードを画面にも表示（既定 false）
 *   SPREADSHEET_ID / ROOT_FOLDER_ID / PEPPER … setup() が自動作成
 *
 * ── 初回 ──────────────────────────────────────────
 *   1) GASエディタで setup() を実行（権限を承認）
 *   2) デプロイ > 新しいデプロイ > ウェブアプリ（実行: 自分 / アクセス: 全員）
 *   ※ コードを変更したら「デプロイを管理 > 編集 > 新バージョン」で再デプロイ
 */

const APP_VERSION = '1.0.0';

const DEF = {
  users:    { name: 'Users',    cols: ['email', 'nickname', 'passwordHash', 'salt', 'isFirstLogin', 'failCount', 'lockedUntil', 'folderId', 'homeFolderId', 'createdAt', 'lastLoginAt'] },
  sessions: { name: 'Sessions', cols: ['token', 'email', 'expiresAt', 'createdAt'] },
  photos:   { name: 'Photos',   cols: ['fileId', 'email', 'fileName', 'mimeType', 'takenAt', 'lat', 'lng', 'place', 'tags', 'mood', 'scene', 'description', 'status', 'analyzedAt', 'addedAt'] },
  themes:   { name: 'Themes',   cols: ['themeId', 'email', 'title', 'color', 'x', 'y', 'photoIds', 'coverFileId', 'narration', 'earthVideoUrl', 'createdAt', 'updatedAt'] },
  comments: { name: 'Comments', cols: ['commentId', 'email', 'fileId', 'text', 'type', 'createdAt'] },
};

const SESSION_DAYS = 30;
const MAX_FAIL = 5;
const LOCK_MINUTES = 15;
const MAX_NARRATION_PHOTOS = 24;

/* ================================================================
 * セットアップ
 * ================================================================ */
function setup() {
  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty('SPREADSHEET_ID')) {
    p.setProperty('SPREADSHEET_ID', SpreadsheetApp.create('omoide-fusen DB').getId());
  }
  if (!p.getProperty('ROOT_FOLDER_ID')) {
    p.setProperty('ROOT_FOLDER_ID', DriveApp.createFolder('omoide-fusen 写真').getId());
  }
  if (!p.getProperty('PEPPER')) {
    p.setProperty('PEPPER', Utilities.getUuid() + Utilities.getUuid());
  }
  const ss = SpreadsheetApp.openById(p.getProperty('SPREADSHEET_ID'));
  Object.keys(DEF).forEach(k => {
    const d = DEF[k];
    const sh = ss.getSheetByName(d.name) || ss.insertSheet(d.name);
    sh.getRange(1, 1, 1, d.cols.length).setValues([d.cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
  ['シート1', 'Sheet1'].forEach(n => {
    const s = ss.getSheetByName(n);
    if (s && ss.getSheets().length > 1) ss.deleteSheet(s);
  });
  Logger.log('スプレッドシート: ' + ss.getUrl());
  Logger.log('写真ルートフォルダ: ' + DriveApp.getFolderById(p.getProperty('ROOT_FOLDER_ID')).getUrl());
  Logger.log('GEMINI_API_KEY: ' + (p.getProperty('GEMINI_API_KEY') ? '設定済み' : '未設定（スクリプトプロパティに追加してください）'));
}

/** 期限切れセッションの掃除（時間主導トリガーで1日1回などに設定） */
function cleanupSessions() {
  withLock_(() => {
    const now = new Date();
    const sh = sh_(DEF.sessions);
    rows_(DEF.sessions)
      .filter(r => new Date(r.expiresAt) < now)
      .map(r => r._row).sort((a, b) => b - a)
      .forEach(row => sh.deleteRow(row));
  });
}

/* ================================================================
 * エントリポイント
 * ================================================================ */
function doGet() {
  return out_({ ok: true, app: 'omoide-fusen', version: APP_VERSION });
}

function doPost(e) {
  let res;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const action = String(req.action || '');
    if (PUBLIC_ACTIONS[action]) {
      res = PUBLIC_ACTIONS[action](req);
    } else if (PRIVATE_ACTIONS[action]) {
      const user = auth_(req.token, action);
      res = PRIVATE_ACTIONS[action](req, user);
    } else {
      throw err_('不明な操作です: ' + action);
    }
    res = Object.assign({ ok: true, version: APP_VERSION }, res || {});
  } catch (ex) {
    res = { ok: false, error: (ex && ex.message) || String(ex), code: (ex && ex.code) || 'ERROR', version: APP_VERSION };
  }
  return out_(res);
}

const PUBLIC_ACTIONS = {
  ping: () => ({ message: 'pong' }),
  register: register_,
  login: login_,
  forgotPassword: forgotPassword_,
};

const PRIVATE_ACTIONS = {
  me: me_,
  logout: logout_,
  changePassword: changePassword_,
  setFolder: setFolder_,
  listPhotos: listPhotos_,
  scanFolder: scanFolder_,
  uploadPhoto: uploadPhoto_,
  analyzeBatch: analyzeBatch_,
  getImage: getImage_,
  listThemes: listThemes_,
  createTheme: createTheme_,
  updateTheme: updateTheme_,
  deleteTheme: deleteTheme_,
  refreshTheme: refreshTheme_,
  suggestThemes: suggestThemes_,
  generateNarration: generateNarration_,
  tts: tts_,
  listComments: listComments_,
  addComment: addComment_,
  deleteComment: deleteComment_,
  aiComment: aiComment_,
};

/* ================================================================
 * 会員認証
 * ================================================================ */
function register_(req) {
  const email = normEmail_(req.email);
  const nickname = String(req.nickname || '').trim().slice(0, 30);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw err_('メールアドレスの形式が正しくありません。');
  if (!nickname) throw err_('ニックネームを入力してください。');

  const temp = tempPassword_();
  withLock_(() => {
    if (findUser_(email)) throw err_('このメールアドレスは登録済みです。パスワードを忘れた場合は再発行してください。');
    const salt = Utilities.getUuid();
    const folder = rootFolder_().createFolder(email);
    insert_(DEF.users, {
      email, nickname,
      passwordHash: hash_(temp, salt), salt,
      isFirstLogin: 'TRUE', failCount: 0, lockedUntil: '',
      folderId: folder.getId(), homeFolderId: folder.getId(),
      createdAt: now_(), lastLoginAt: '',
    });
  });

  const mailed = sendMail_(email, '【おもいで付箋ボード】仮パスワードのお知らせ',
    nickname + ' さん\n\nご登録ありがとうございます。\n\n仮パスワード: ' + temp +
    '\n\n初回ログイン後に、ご自身のパスワードへ変更してください。\n' + appUrlLine_());
  const show = prop_('SHOW_TEMP_PASSWORD', 'false') === 'true' || !mailed;
  return {
    message: mailed ? '仮パスワードをメールで送りました。メールを確認してログインしてください。'
                    : 'メールを送れなかったため、仮パスワードをこの画面に表示しています。',
    tempPassword: show ? temp : undefined,
  };
}

function login_(req) {
  const email = normEmail_(req.email);
  const pw = String(req.password || '');
  return withLock_(() => {
    const u = findUser_(email);
    if (!u) throw err_('メールアドレスまたはパスワードが違います。');
    if (u.lockedUntil && new Date(u.lockedUntil) > new Date()) {
      throw err_('ログインに続けて失敗したため、' + jst_(u.lockedUntil, 'HH:mm') + ' までロックしています。');
    }
    if (hash_(pw, u.salt) !== u.passwordHash) {
      const fc = (Number(u.failCount) || 0) + 1;
      if (fc >= MAX_FAIL) {
        patch_(DEF.users, u._row, { failCount: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() });
        throw err_('ログインに' + MAX_FAIL + '回失敗したため、' + LOCK_MINUTES + '分間ロックしました。');
      }
      patch_(DEF.users, u._row, { failCount: fc });
      throw err_('メールアドレスまたはパスワードが違います（あと' + (MAX_FAIL - fc) + '回でロック）。');
    }
    const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    insert_(DEF.sessions, {
      token, email,
      expiresAt: new Date(Date.now() + SESSION_DAYS * 86400000).toISOString(),
      createdAt: now_(),
    });
    patch_(DEF.users, u._row, { failCount: 0, lockedUntil: '', lastLoginAt: now_() });
    CacheService.getScriptCache().put('s:' + token, email, 21600);
    return { token, user: userPub_(u) };
  });
}

function forgotPassword_(req) {
  const email = normEmail_(req.email);
  const message = '登録済みのメールアドレスであれば、新しい仮パスワードを送りました。';
  if (!email) throw err_('メールアドレスを入力してください。');
  let nickname = '';
  const temp = tempPassword_();
  const found = withLock_(() => {
    const u = findUser_(email);
    if (!u) return false;
    nickname = u.nickname;
    const salt = Utilities.getUuid();
    patch_(DEF.users, u._row, { passwordHash: hash_(temp, salt), salt, isFirstLogin: 'TRUE', failCount: 0, lockedUntil: '' });
    return true;
  });
  if (found) {
    sendMail_(email, '【おもいで付箋ボード】仮パスワード再発行のお知らせ',
      nickname + ' さん\n\n新しい仮パスワード: ' + temp +
      '\n\nログイン後に、ご自身のパスワードへ変更してください。\nお心当たりがない場合は、このメールを破棄してください。\n' + appUrlLine_());
  }
  return { message };
}

function changePassword_(req, u) {
  const cur = String(req.currentPassword || '');
  const nw = String(req.newPassword || '');
  if (hash_(cur, u.salt) !== u.passwordHash) throw err_('現在のパスワード（仮パスワード）が違います。');
  if (!/^(?=.*[A-Za-z])(?=.*\d).{8,64}$/.test(nw)) throw err_('新しいパスワードは8文字以上で、英字と数字を両方含めてください。');
  if (nw === cur) throw err_('仮パスワードとは別のパスワードにしてください。');
  withLock_(() => {
    const x = findUser_(u.email);
    const salt = Utilities.getUuid();
    patch_(DEF.users, x._row, { passwordHash: hash_(nw, salt), salt, isFirstLogin: 'FALSE' });
  });
  return { message: 'パスワードを変更しました。' };
}

function logout_(req) {
  CacheService.getScriptCache().remove('s:' + req.token);
  withLock_(() => {
    const s = rows_(DEF.sessions).find(r => r.token === req.token);
    if (s) sh_(DEF.sessions).deleteRow(s._row);
  });
  return {};
}

function me_(req, u) {
  return { user: userPub_(u), folder: folderInfo_(u.folderId, u) };
}

function auth_(token, action) {
  if (!token) throw err_('ログインしてください。', 'AUTH');
  const cache = CacheService.getScriptCache();
  let email = cache.get('s:' + token);
  if (!email) {
    const s = rows_(DEF.sessions).find(r => r.token === token);
    if (!s || new Date(s.expiresAt) < new Date()) throw err_('ログインの有効期限が切れました。もう一度ログインしてください。', 'AUTH');
    email = s.email;
    cache.put('s:' + token, email, 21600);
  }
  const u = findUser_(email);
  if (!u) throw err_('アカウントが見つかりません。', 'AUTH');
  if (isTrue_(u.isFirstLogin) && ['changePassword', 'logout', 'me'].indexOf(action) < 0) {
    throw err_('パスワードを変更してから利用してください。', 'FIRST_LOGIN');
  }
  return u;
}

function userPub_(u) {
  return { email: u.email, nickname: u.nickname, isFirstLogin: isTrue_(u.isFirstLogin) };
}

/* ================================================================
 * フォルダ
 * ================================================================ */
function setFolder_(req, u) {
  const raw = String(req.folder || '').trim();
  let id;
  if (raw === 'home') {
    id = u.homeFolderId;
  } else {
    const m = raw.match(/folders\/([\w-]{10,})/) || raw.match(/[?&]id=([\w-]{10,})/) || raw.match(/^([\w-]{10,})$/);
    if (!m) throw err_('フォルダのURLまたはIDを入力してください。');
    id = m[1];
  }
  let f;
  try { f = DriveApp.getFolderById(id); f.getName(); }
  catch (e) { throw err_('このフォルダにアクセスできません。フォルダをアプリ管理者のGoogleアカウントと共有してください。'); }
  if (id !== u.homeFolderId && !canUseFolder_(f, u)) {
    throw err_('このフォルダは、登録したメールアドレスのアカウントが所有または共有されているものだけ使えます。');
  }
  withLock_(() => {
    const x = findUser_(u.email);
    patch_(DEF.users, x._row, { folderId: id });
  });
  CacheService.getScriptCache().remove('own:' + u.email);
  return { folder: folderInfo_(id, u) };
}

function canUseFolder_(f, u) {
  try {
    const o = f.getOwner();
    if (o && normEmail_(o.getEmail()) === u.email) return true;
  } catch (e) { /* 共有ドライブなど */ }
  try {
    return f.getEditors().concat(f.getViewers()).some(x => normEmail_(x.getEmail()) === u.email);
  } catch (e) { return false; }
}

function folderInfo_(id, u) {
  try {
    const f = DriveApp.getFolderById(id);
    return { id, name: f.getName(), url: f.getUrl(), isHome: id === u.homeFolderId };
  } catch (e) {
    return { id, name: '', url: '', isHome: id === u.homeFolderId, error: 'フォルダにアクセスできません' };
  }
}

function getFolder_(id) {
  try { return DriveApp.getFolderById(id); }
  catch (e) { throw err_('写真フォルダにアクセスできません。「写真」画面でフォルダを設定し直してください。'); }
}

/* ================================================================
 * 写真
 * ================================================================ */
function listPhotos_(req, u) {
  return { photos: rows_(DEF.photos).filter(r => r.email === u.email).map(photoPub_) };
}

function photoPub_(r) {
  return {
    fileId: r.fileId, fileName: r.fileName, takenAt: r.takenAt,
    lat: num_(r.lat), lng: num_(r.lng), place: r.place,
    tags: parseArr_(r.tags), mood: r.mood, scene: r.scene,
    description: r.description, status: r.status || 'pending',
  };
}

function collectImages_(folder, depth, out) {
  const it = folder.getFiles();
  while (it.hasNext() && out.length < 3000) {
    const f = it.next();
    const mt = f.getMimeType();
    if (/^image\//.test(mt)) out.push({ id: f.getId(), name: f.getName(), mime: mt });
  }
  if (depth > 0) {
    const fi = folder.getFolders();
    while (fi.hasNext() && out.length < 3000) collectImages_(fi.next(), depth - 1, out);
  }
  return out;
}

function scanFolder_(req, u) {
  const found = collectImages_(getFolder_(u.folderId), 2, []);
  const foundIds = {};
  found.forEach(f => { foundIds[f.id] = true; });
  const res = withLock_(() => {
    const mine = rows_(DEF.photos).filter(r => r.email === u.email);
    const have = {};
    mine.forEach(r => { have[r.fileId] = true; });
    const add = found.filter(f => !have[f.id]).map(f => ({
      fileId: f.id, email: u.email, fileName: f.name, mimeType: f.mime, status: 'pending', addedAt: now_(),
    }));
    if (add.length) insertMany_(DEF.photos, add);
    const gone = mine.filter(r => !foundIds[r.fileId]).map(r => r._row).sort((a, b) => b - a);
    const sh = sh_(DEF.photos);
    gone.forEach(row => sh.deleteRow(row));
    return { added: add.length, removed: gone.length };
  });
  CacheService.getScriptCache().remove('own:' + u.email);
  return Object.assign(res, listPhotos_(req, u));
}

function uploadPhoto_(req, u) {
  const name = String(req.fileName || 'photo.jpg').slice(0, 120);
  const mime = String(req.mimeType || 'image/jpeg');
  if (!/^image\//.test(mime)) throw err_('画像ファイルだけ追加できます。');
  if (!req.data) throw err_('ファイルが空です。');
  const blob = Utilities.newBlob(Utilities.base64Decode(req.data), mime, name);
  const file = getFolder_(u.folderId).createFile(blob);
  const row = { fileId: file.getId(), email: u.email, fileName: name, mimeType: mime, status: 'pending', addedAt: now_() };
  withLock_(() => insert_(DEF.photos, row));
  CacheService.getScriptCache().remove('own:' + u.email);
  return { photo: photoPub_(row) };
}

function analyzeBatch_(req, u) {
  const start = Date.now();
  const limit = Math.min(Math.max(Number(req.limit) || 3, 1), 6);
  const targetStatus = req.retryErrors ? ['pending', 'error'] : ['pending'];
  const targets = rows_(DEF.photos)
    .filter(r => r.email === u.email && targetStatus.indexOf(r.status || 'pending') >= 0)
    .slice(0, limit);

  const results = [];
  for (let i = 0; i < targets.length; i++) {
    if (Date.now() - start > 240000) break;
    const r = targets[i];
    try {
      results.push({ fileId: r.fileId, patch: analyzeOne_(r.fileId) });
    } catch (e) {
      results.push({ fileId: r.fileId, patch: { status: 'error', description: '解析できませんでした: ' + e.message, analyzedAt: now_() } });
    }
  }

  let updated = [];
  withLock_(() => {
    const all = rows_(DEF.photos);
    results.forEach(x => {
      const row = all.find(r => r.email === u.email && r.fileId === x.fileId);
      if (!row) return;
      patch_(DEF.photos, row._row, x.patch);
      updated.push(photoPub_(Object.assign({}, row, x.patch)));
    });
  });

  const remaining = rows_(DEF.photos)
    .filter(r => r.email === u.email && targetStatus.indexOf(r.status || 'pending') >= 0).length;
  return { processed: results.length, remaining, photos: updated };
}

function analyzeOne_(fileId) {
  const meta = driveMeta_(fileId);
  const img = imageBlob_(fileId, 768, meta);
  const im = meta.imageMediaMetadata || {};
  const takenAt = exifTime_(im.time) || (meta.createdTime ? jst_(meta.createdTime, 'yyyy-MM-dd HH:mm') : '');
  let lat = null, lng = null, place = '';
  if (im.location && im.location.latitude != null && im.location.longitude != null) {
    lat = Number(im.location.latitude);
    lng = Number(im.location.longitude);
    place = reverseGeocode_(lat, lng);
  }

  const prompt =
    'あなたは写真アルバムの整理係です。この写真を見て、次の形式のJSONだけを返してください。\n' +
    '{"tags":["写っているもの・場面・雰囲気を表す日本語タグを5〜10個"],' +
    '"scene":"場面の種類（例：海、食事、街歩き、家族の集まり、旅行、イベント）",' +
    '"mood":"雰囲気を一言（例：楽しい、穏やか、懐かしい、にぎやか）",' +
    '"season":"季節（分からなければ空文字）",' +
    '"placeGuess":"写っている場所の推測（分からなければ空文字）",' +
    '"description":"写真の内容を60字程度で"}\n' +
    '参考情報: 撮影日時=' + (takenAt || '不明') + ' / 撮影地=' + (place || '不明');

  const j = geminiJson_([
    { text: prompt },
    { inlineData: { mimeType: img.getContentType() || 'image/jpeg', data: Utilities.base64Encode(img.getBytes()) } },
  ]);

  const tags = (Array.isArray(j.tags) ? j.tags : []).map(String).slice(0, 12);
  if (j.season && tags.indexOf(j.season) < 0) tags.push(String(j.season));
  if (!place && j.placeGuess) place = '（推定）' + String(j.placeGuess).slice(0, 40);

  return {
    takenAt, lat: lat == null ? '' : lat, lng: lng == null ? '' : lng, place,
    tags: JSON.stringify(tags),
    mood: String(j.mood || '').slice(0, 30),
    scene: String(j.scene || '').slice(0, 30),
    description: String(j.description || '').slice(0, 200),
    status: 'done', analyzedAt: now_(),
  };
}

function getImage_(req, u) {
  const fileId = String(req.fileId || '');
  if (!ownSet_(u.email)[fileId]) throw err_('この写真は表示できません。');
  const size = req.size === 'full' ? 1600 : (req.size === 'mid' ? 900 : 400);
  const cache = CacheService.getScriptCache();
  const key = 'img:' + fileId + ':' + size;
  const hit = cache.get(key);
  if (hit) return { dataUrl: hit };
  const b = imageBlob_(fileId, size);
  const dataUrl = 'data:' + (b.getContentType() || 'image/jpeg') + ';base64,' + Utilities.base64Encode(b.getBytes());
  if (dataUrl.length < 95000) cache.put(key, dataUrl, 21600);
  return { dataUrl };
}

function ownSet_(email) {
  const c = CacheService.getScriptCache();
  const k = 'own:' + email;
  const v = c.get(k);
  const ids = v ? JSON.parse(v) : rows_(DEF.photos).filter(r => r.email === email).map(r => r.fileId);
  if (!v) {
    const s = JSON.stringify(ids);
    if (s.length < 95000) c.put(k, s, 600);
  }
  const set = {};
  ids.forEach(id => { set[id] = true; });
  return set;
}

function driveMeta_(fileId) {
  const fields = 'id,name,mimeType,createdTime,thumbnailLink,imageMediaMetadata(time,location,width,height)';
  const url = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) +
    '?supportsAllDrives=true&fields=' + encodeURIComponent(fields);
  const r = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw err_('ドライブのファイル情報を取得できません（' + r.getResponseCode() + '）');
  return JSON.parse(r.getContentText());
}

function imageBlob_(fileId, size, meta) {
  meta = meta || driveMeta_(fileId);
  if (meta.thumbnailLink) {
    const link = meta.thumbnailLink.replace(/=s\d+[^/]*$/, '') + '=s' + size;
    const r = UrlFetchApp.fetch(link, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
    if (r.getResponseCode() === 200) return r.getBlob();
  }
  const f = DriveApp.getFileById(fileId);
  if (f.getSize() > 8 * 1024 * 1024) throw err_('画像が大きすぎてプレビューを作れません。少し時間をおいて再度お試しください。');
  return f.getBlob();
}

function reverseGeocode_(lat, lng) {
  try {
    const r = Maps.newGeocoder().setLanguage('ja').reverseGeocode(lat, lng);
    const res = r && r.results && r.results[0];
    if (!res) return '';
    const pick = type => {
      const c = res.address_components.find(a => a.types.indexOf(type) >= 0);
      return c ? c.long_name : '';
    };
    const country = pick('country');
    const parts = [
      country && country !== '日本' ? country : '',
      pick('administrative_area_level_1'),
      pick('locality'),
      pick('sublocality_level_1') || pick('sublocality_level_2'),
    ].filter(Boolean);
    return parts.length ? parts.join(' ') : String(res.formatted_address || '').replace(/^日本、(〒\d{3}-\d{4} )?/, '');
  } catch (e) {
    return '';
  }
}

/* ================================================================
 * テーマ（付箋）
 * ================================================================ */
function themePub_(r) {
  return {
    themeId: r.themeId, title: r.title, color: r.color,
    x: num_(r.x) || 0, y: num_(r.y) || 0,
    photoIds: parseArr_(r.photoIds), coverFileId: r.coverFileId,
    narration: parseObj_(r.narration), earthVideoUrl: r.earthVideoUrl,
    updatedAt: r.updatedAt,
  };
}

function listThemes_(req, u) {
  return { themes: rows_(DEF.themes).filter(r => r.email === u.email).map(themePub_) };
}

function createTheme_(req, u) {
  const title = String(req.title || '').trim().slice(0, 30);
  if (!title) throw err_('テーマ名を入力してください。');
  let photoIds, cover;
  if (Array.isArray(req.photoIds)) {
    const own = ownSet_(u.email);
    photoIds = unique_(req.photoIds.map(String).filter(id => own[id]));
    cover = own[req.coverFileId] && photoIds.indexOf(req.coverFileId) >= 0 ? req.coverFileId : (photoIds[0] || '');
  } else {
    const m = matchTheme_(u, title);
    photoIds = m.photoIds;
    cover = m.cover;
  }
  const row = {
    themeId: 't_' + Utilities.getUuid().slice(0, 13).replace(/-/g, ''),
    email: u.email, title,
    color: safeColor_(req.color),
    x: Math.round(Number(req.x) || 80), y: Math.round(Number(req.y) || 80),
    photoIds: JSON.stringify(photoIds), coverFileId: cover,
    narration: '', earthVideoUrl: '',
    createdAt: now_(), updatedAt: now_(),
  };
  withLock_(() => insert_(DEF.themes, row));
  return { theme: themePub_(row), matched: photoIds.length };
}

function updateTheme_(req, u) {
  const f = req.fields || {};
  const patch = {};
  if (f.title !== undefined) {
    const t = String(f.title).trim().slice(0, 30);
    if (!t) throw err_('テーマ名を入力してください。');
    patch.title = t;
  }
  if (f.color !== undefined) patch.color = safeColor_(f.color);
  if (f.x !== undefined) patch.x = Math.round(Number(f.x) || 0);
  if (f.y !== undefined) patch.y = Math.round(Number(f.y) || 0);
  if (f.photoIds !== undefined) {
    const own = ownSet_(u.email);
    patch.photoIds = JSON.stringify(unique_((f.photoIds || []).map(String).filter(id => own[id])));
    patch.narration = '';
  }
  if (f.coverFileId !== undefined) patch.coverFileId = String(f.coverFileId);
  if (f.earthVideoUrl !== undefined) {
    const v = String(f.earthVideoUrl).trim();
    if (v && !/^(https:\/\/|media\/|\.\/)/.test(v)) throw err_('映像のURLは https:// から始まるもの、またはリポジトリ内の media/ のパスにしてください。');
    patch.earthVideoUrl = v.slice(0, 500);
  }
  patch.updatedAt = now_();
  const theme = withLock_(() => {
    const r = findTheme_(u, req.themeId);
    patch_(DEF.themes, r._row, patch);
    return themePub_(Object.assign({}, r, patch));
  });
  return { theme };
}

function deleteTheme_(req, u) {
  withLock_(() => {
    const r = findTheme_(u, req.themeId);
    sh_(DEF.themes).deleteRow(r._row);
  });
  return {};
}

function refreshTheme_(req, u) {
  const r0 = findTheme_(u, req.themeId);
  const m = matchTheme_(u, r0.title);
  const patch = { photoIds: JSON.stringify(m.photoIds), coverFileId: m.cover, narration: '', updatedAt: now_() };
  const theme = withLock_(() => {
    const r = findTheme_(u, req.themeId);
    patch_(DEF.themes, r._row, patch);
    return themePub_(Object.assign({}, r, patch));
  });
  return { theme, matched: m.photoIds.length };
}

function findTheme_(u, themeId) {
  const r = rows_(DEF.themes).find(x => x.email === u.email && x.themeId === themeId);
  if (!r) throw err_('付箋が見つかりません。画面を再読み込みしてください。');
  return r;
}

function analyzedPhotos_(u) {
  return rows_(DEF.photos)
    .filter(r => r.email === u.email && r.status === 'done')
    .sort((a, b) => String(a.takenAt).localeCompare(String(b.takenAt)));
}

function photoLine_(p) {
  return [
    p.fileId, p.takenAt || '-', p.place || '-',
    parseArr_(p.tags).join('/'), p.scene || '-', p.mood || '-',
    String(p.description || '').slice(0, 70),
  ].join(' | ');
}

function matchTheme_(u, title) {
  const ph = analyzedPhotos_(u);
  if (!ph.length) throw err_('解析済みの写真がありません。先に「写真」からAI解析を実行してください。');
  const valid = {};
  ph.forEach(p => { valid[p.fileId] = p; });
  let ids = [];
  let cover = '';
  for (let i = 0; i < ph.length; i += 400) {
    const chunk = ph.slice(i, i + 400);
    const prompt =
      '次は写真の一覧です（ID | 撮影日時 | 撮影地 | タグ | 場面 | 雰囲気 | 説明）。\n' +
      'テーマ「' + title + '」に合う写真をすべて選んでください。' +
      '気持ちや雰囲気を表すテーマは、表情・場面・色合いなども手がかりに広めに解釈してください。' +
      '合う写真がなければ空の配列にしてください。\n' +
      'JSONのみで回答: {"photoIds":["ID", ...], "coverId":"テーマを最もよく表す1枚のID"}\n\n' +
      chunk.map(photoLine_).join('\n');
    const j = geminiJson_([{ text: prompt }]);
    (Array.isArray(j.photoIds) ? j.photoIds : []).forEach(id => { if (valid[id]) ids.push(String(id)); });
    if (!cover && valid[j.coverId]) cover = String(j.coverId);
  }
  ids = unique_(ids).sort((a, b) => String(valid[a].takenAt).localeCompare(String(valid[b].takenAt)));
  if (ids.indexOf(cover) < 0) cover = ids[0] || '';
  return { photoIds: ids, cover };
}

function suggestThemes_(req, u) {
  const ph = analyzedPhotos_(u);
  if (ph.length < 3) throw err_('テーマを提案するには、解析済みの写真が3枚以上必要です。');
  const list = sampleEven_(ph, 500);
  const valid = {};
  list.forEach(p => { valid[p.fileId] = true; });
  const prompt =
    '次は写真の一覧です（ID | 撮影日時 | 撮影地 | タグ | 場面 | 雰囲気 | 説明）。\n' +
    '思い出のアルバムとしてまとめると楽しいテーマを5〜8個提案してください。' +
    '各テーマには3枚以上の写真を含め、同じ写真が複数のテーマに入っても構いません。' +
    'テーマ名は「海に行った日」「美味しいご飯」「笑顔の思い出」のような親しみやすい日本語で15字以内にしてください。\n' +
    'JSONのみで回答: {"themes":[{"title":"...","photoIds":["ID", ...],"coverId":"ID"}]}\n\n' +
    list.map(photoLine_).join('\n');
  const j = geminiJson_([{ text: prompt }]);
  const suggestions = (Array.isArray(j.themes) ? j.themes : []).map(t => {
    const ids = unique_((t.photoIds || []).map(String).filter(id => valid[id]));
    return {
      title: String(t.title || '').slice(0, 30),
      photoIds: ids,
      coverFileId: ids.indexOf(t.coverId) >= 0 ? t.coverId : (ids[0] || ''),
    };
  }).filter(t => t.title && t.photoIds.length);
  return { suggestions };
}

/* ================================================================
 * ナレーション / TTS
 * ================================================================ */
function generateNarration_(req, u) {
  const t = findTheme_(u, req.themeId);
  const ids = parseArr_(t.photoIds);
  const map = {};
  rows_(DEF.photos).filter(r => r.email === u.email).forEach(r => { map[r.fileId] = r; });
  const photos = sampleEven_(
    ids.map(id => map[id]).filter(Boolean).sort((a, b) => String(a.takenAt).localeCompare(String(b.takenAt))),
    MAX_NARRATION_PHOTOS);
  if (!photos.length) throw err_('このテーマには写真がありません。');

  const cm = {};
  rows_(DEF.comments).filter(c => c.email === u.email && c.type === 'manual').forEach(c => {
    (cm[c.fileId] = cm[c.fileId] || []).push(String(c.text).slice(0, 80));
  });

  const prompt =
    'あなたは思い出のスライドショーの語り手です。テーマ「' + t.title + '」の写真を、撮影順に振り返るナレーションを書いてください。\n' +
    '・「です・ます」の柔らかく温かい語り口。懐かしさが伝わるように。\n' +
    '・intro は1〜2文、各写真の text は1〜2文（40〜70字）、outro は1〜2文。\n' +
    '・写真から分からない事実（人の名前や関係など）は断定しない。本人のコメントがあれば内容を大切に活かす。\n' +
    'JSONのみで回答: {"intro":"...","lines":[{"fileId":"ID","text":"..."}],"outro":"..."}\n\n' +
    '写真一覧（ID | 撮影日時 | 撮影地 | タグ | 場面 | 雰囲気 | 説明 | 本人のコメント）:\n' +
    photos.map(p => photoLine_(p) + ' | ' + ((cm[p.fileId] || []).join(' / ') || '-')).join('\n');

  const j = geminiJson_([{ text: prompt }]);
  const got = {};
  (Array.isArray(j.lines) ? j.lines : []).forEach(l => { if (l && l.fileId) got[l.fileId] = String(l.text || '').slice(0, 200); });
  const narration = {
    intro: String(j.intro || '').slice(0, 300),
    lines: photos.map(p => ({ fileId: p.fileId, text: got[p.fileId] || '' })),
    outro: String(j.outro || '').slice(0, 300),
    createdAt: now_(),
  };
  withLock_(() => {
    const r = findTheme_(u, req.themeId);
    patch_(DEF.themes, r._row, { narration: JSON.stringify(narration), updatedAt: now_() });
  });
  return { narration };
}

function tts_(req) {
  const text = String(req.text || '').trim().slice(0, 800);
  if (!text) throw err_('読み上げる文章がありません。');
  const voice = /^[A-Za-z]{2,20}$/.test(req.voice || '') ? req.voice : prop_('TTS_VOICE', 'Kore');
  const body = {
    contents: [{ parts: [{ text: '懐かしい思い出を語りかけるように、ゆっくり穏やかに読み上げてください：\n' + text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  };
  const j = callGemini_(prop_('TTS_MODEL', 'gemini-2.5-flash-preview-tts'), body);
  const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
  const part = parts.find(p => p.inlineData);
  if (!part) throw err_('音声を生成できませんでした。');
  return { audio: part.inlineData.data, mimeType: part.inlineData.mimeType };
}

/* ================================================================
 * コメント
 * ================================================================ */
function commentPub_(r) {
  return { commentId: r.commentId, fileId: r.fileId, text: r.text, type: r.type, createdAt: r.createdAt };
}

function listComments_(req, u) {
  const ids = {};
  (Array.isArray(req.fileIds) ? req.fileIds : [req.fileId]).forEach(id => { ids[id] = true; });
  const comments = rows_(DEF.comments)
    .filter(r => r.email === u.email && ids[r.fileId])
    .map(commentPub_)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return { comments };
}

function addComment_(req, u) {
  const fileId = String(req.fileId || '');
  const text = String(req.text || '').trim().slice(0, 500);
  if (!ownSet_(u.email)[fileId]) throw err_('この写真にはコメントできません。');
  if (!text) throw err_('コメントを入力してください。');
  const row = { commentId: 'c_' + Utilities.getUuid().replace(/-/g, '').slice(0, 16), email: u.email, fileId, text, type: 'manual', createdAt: now_() };
  withLock_(() => insert_(DEF.comments, row));
  return { comment: commentPub_(row) };
}

function deleteComment_(req, u) {
  withLock_(() => {
    const r = rows_(DEF.comments).find(x => x.email === u.email && x.commentId === req.commentId);
    if (!r) throw err_('コメントが見つかりません。');
    sh_(DEF.comments).deleteRow(r._row);
  });
  return {};
}

function aiComment_(req, u) {
  const fileId = String(req.fileId || '');
  const p = rows_(DEF.photos).find(r => r.email === u.email && r.fileId === fileId);
  if (!p) throw err_('写真が見つかりません。');
  const past = rows_(DEF.comments).filter(c => c.email === u.email && c.fileId === fileId && c.type === 'manual')
    .map(c => String(c.text).slice(0, 100));
  const img = imageBlob_(fileId, 768);
  const prompt =
    'この写真を、撮影した本人がアルバムを見返しながら思い出を語るような、温かい回想コメントを日本語で1つ書いてください。\n' +
    '・80〜120字。「〜だったね」「〜したっけ」のような柔らかい語り口。\n' +
    '・写真から分からない事実は断定せず、写真から感じられることを中心に。\n' +
    '・コメント本文だけを出力（かぎかっこや前置きは不要）。\n' +
    '参考: 撮影日時=' + (p.takenAt || '不明') + ' / 撮影地=' + (p.place || '不明') +
    ' / タグ=' + parseArr_(p.tags).join('、') + ' / 本人のコメント=' + (past.join(' / ') || 'なし');
  const text = geminiText_([
    { text: prompt },
    { inlineData: { mimeType: img.getContentType() || 'image/jpeg', data: Utilities.base64Encode(img.getBytes()) } },
  ]).trim().replace(/^[「"]|[」"]$/g, '').slice(0, 300);
  const row = { commentId: 'c_' + Utilities.getUuid().replace(/-/g, '').slice(0, 16), email: u.email, fileId, text, type: 'ai', createdAt: now_() };
  withLock_(() => insert_(DEF.comments, row));
  return { comment: commentPub_(row) };
}

/* ================================================================
 * Gemini
 * ================================================================ */
function callGemini_(model, body) {
  const key = prop_('GEMINI_API_KEY', '');
  if (!key) throw err_('GEMINI_API_KEY が設定されていません（GASのスクリプトプロパティ）。');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
  for (let i = 0; i < 3; i++) {
    const r = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json',
      headers: { 'x-goog-api-key': key },
      payload: JSON.stringify(body), muteHttpExceptions: true,
    });
    const c = r.getResponseCode();
    if (c === 200) return JSON.parse(r.getContentText());
    if ((c === 429 || c >= 500) && i < 2) { Utilities.sleep(1500 * (i + 1) * (i + 1)); continue; }
    let msg = '';
    try { msg = JSON.parse(r.getContentText()).error.message; } catch (e) { msg = r.getContentText().slice(0, 200); }
    throw err_('Gemini API エラー（' + c + '）: ' + msg);
  }
}

function geminiText_(parts, json) {
  const body = { contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.8 } };
  if (json) body.generationConfig.responseMimeType = 'application/json';
  const j = callGemini_(prop_('GEMINI_MODEL', 'gemini-2.5-flash'), body);
  const c = j.candidates && j.candidates[0];
  const t = c && c.content && c.content.parts ? c.content.parts.map(p => p.text || '').join('') : '';
  if (!t) throw err_('AIの応答が空でした。少し時間をおいて再度お試しください。');
  return t;
}

function geminiJson_(parts) {
  const t = geminiText_(parts, true);
  try { return JSON.parse(t); } catch (e) {
    const m = t.match(/[\[{][\s\S]*[\]}]/);
    if (m) { try { return JSON.parse(m[0]); } catch (e2) { /* fallthrough */ } }
    throw err_('AIの応答を読み取れませんでした。もう一度お試しください。');
  }
}

/* ================================================================
 * スプレッドシート ユーティリティ
 * ================================================================ */
function ss_() {
  const id = prop_('SPREADSHEET_ID', '');
  if (!id) throw err_('セットアップが完了していません。GASエディタで setup() を実行してください。');
  return SpreadsheetApp.openById(id);
}
function sh_(d) {
  const sh = ss_().getSheetByName(d.name);
  if (!sh) throw err_('シート「' + d.name + '」がありません。setup() を実行してください。');
  return sh;
}
function rows_(d) {
  const sh = sh_(d);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, d.cols.length).getValues().map((r, i) => {
    const o = { _row: i + 2 };
    d.cols.forEach((c, j) => { o[c] = r[j] instanceof Date ? r[j].toISOString() : r[j]; });
    return o;
  });
}
/** 文字列は先頭に ' を付けて保存（数式化・日付自動変換を防ぐ） */
function cell_(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v;
  if (typeof v === 'object') v = JSON.stringify(v);
  return "'" + String(v);
}
function insert_(d, o) {
  sh_(d).appendRow(d.cols.map(c => cell_(o[c])));
}
function insertMany_(d, objs) {
  const sh = sh_(d);
  sh.getRange(sh.getLastRow() + 1, 1, objs.length, d.cols.length)
    .setValues(objs.map(o => d.cols.map(c => cell_(o[c]))));
}
function patch_(d, row, o) {
  const rg = sh_(d).getRange(row, 1, 1, d.cols.length);
  const v = rg.getValues()[0];
  d.cols.forEach((c, i) => { v[i] = cell_(o[c] !== undefined ? o[c] : v[i]); });
  rg.setValues([v]);
}
function findUser_(email) {
  return rows_(DEF.users).find(r => r.email === email) || null;
}

/* ================================================================
 * 汎用
 * ================================================================ */
function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function err_(msg, code) { const e = new Error(msg); e.code = code || 'ERROR'; return e; }
function prop_(k, d) { return PropertiesService.getScriptProperties().getProperty(k) || d; }
function rootFolder_() { return getFolder_(prop_('ROOT_FOLDER_ID', '')); }
function withLock_(fn) {
  const l = LockService.getScriptLock();
  if (!l.tryLock(20000)) throw err_('混み合っています。少し待ってから再度お試しください。');
  try { return fn(); } finally { l.releaseLock(); }
}
function now_() { return new Date().toISOString(); }
function jst_(iso, fmt) { return Utilities.formatDate(new Date(iso), 'Asia/Tokyo', fmt); }
function normEmail_(s) { return String(s || '').trim().toLowerCase(); }
function isTrue_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
function num_(v) { if (v === '' || v === null || v === undefined) return null; const n = Number(v); return isNaN(n) ? null : n; }
function parseArr_(v) { if (Array.isArray(v)) return v; try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
function parseObj_(v) { if (!v) return null; try { return JSON.parse(v); } catch (e) { return null; } }
function unique_(a) { return a.filter((x, i) => a.indexOf(x) === i); }
function sampleEven_(arr, n) {
  if (arr.length <= n) return arr;
  const out = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * arr.length / n)]);
  return out;
}
function safeColor_(c) { return /^#[0-9A-Fa-f]{6}$/.test(String(c || '')) ? c : '#FFEF7A'; }
function exifTime_(t) {
  const m = String(t || '').match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2})/);
  return m ? m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5] : '';
}
function hash_(pw, salt) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + pw + ':' + prop_('PEPPER', ''), Utilities.Charset.UTF_8);
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}
function tempPassword_() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Date.now() + Utilities.getUuid());
  let s = '';
  for (let i = 0; i < 10; i++) s += chars[(bytes[i] + 256) % chars.length];
  return s + String((bytes[20] + 256) % 10); // 末尾に必ず数字を1つ付ける
}
function sendMail_(to, subject, body) {
  try {
    MailApp.sendEmail({ to, subject, body, name: 'おもいで付箋ボード' });
    return true;
  } catch (e) {
    console.error('mail failed: ' + e);
    return false;
  }
}
function appUrlLine_() {
  const u = prop_('APP_URL', '');
  return u ? '\nアプリ: ' + u + '\n' : '';
}

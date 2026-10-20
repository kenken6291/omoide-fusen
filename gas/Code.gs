/**
 * おもいで付箋ボード (omoide-fusen) — Google Apps Script バックエンド
 * Version 1.7.1
 *
 * ── スクリプトプロパティ ──────────────────────────────
 *   GEMINI_API_KEY          (必須) Google AI Studio の API キー
 *   GEMINI_MODEL            (任意) 既定: gemini-2.5-flash
 *   TTS_MODEL               (任意) 既定: gemini-2.5-flash-preview-tts
 *   TTS_VOICE               (任意) 既定: Kore
 *   GOOGLE_MAPS_SERVER_KEY  (任意) Geocoding API 用サーバーキー。未設定なら GAS 組み込み Maps
 *   APP_URL                 (任意) GitHub Pages の URL（メール本文に記載）
 *   SHOW_TEMP_PASSWORD      (任意) 'true' で登録時に仮パスワードを画面にも表示（既定 false）
 *
 *   ── Gemini の節約設定 ──
 *   DAILY_AI_LIMIT          1人1日あたりのAI呼び出し上限（既定 300、0 で無制限。音声キャッシュは数えない）
 *   GEMINI_THINKING_BUDGET  既定 0（思考トークンを使わない）。'auto' にするとモデル既定
 *   ANALYZE_IMAGE_SIZE      解析に送る画像の長辺 px（既定 384）
 *   ANALYZE_MEDIA_RES       既定 MEDIA_RESOLUTION_LOW。'off' で指定しない
 *   ANALYZE_PER_REQUEST     1回の Gemini 呼び出しで解析する枚数（既定 4、最大 8）
 *
 *   SPREADSHEET_ID / ROOT_FOLDER_ID / PEPPER / TTS_FOLDER_ID … 自動作成
 *
 * ── 初回 ──────────────────────────────────────────
 *   1) GASエディタで setup() を実行（権限を承認）
 *   2) デプロイ > 新しいデプロイ > ウェブアプリ（実行: 自分 / アクセス: 全員）
 *   ※ コードを変更したら「デプロイを管理 > 編集 > 新バージョン」で再デプロイ
 */

const APP_VERSION = '1.7.1';

const DEF = {
  users:    { name: 'Users',    cols: ['email', 'nickname', 'passwordHash', 'salt', 'isFirstLogin', 'failCount', 'lockedUntil', 'folderId', 'homeFolderId', 'createdAt', 'lastLoginAt'] },
  sessions: { name: 'Sessions', cols: ['token', 'email', 'expiresAt', 'createdAt'] },
  photos:   { name: 'Photos',   cols: ['fileId', 'email', 'fileName', 'mimeType', 'takenAt', 'lat', 'lng', 'place', 'tags', 'mood', 'scene', 'description', 'status', 'analyzedAt', 'addedAt', 'md5', 'fileSize', 'dupOf'] },
  themes:   { name: 'Themes',   cols: ['themeId', 'email', 'title', 'color', 'x', 'y', 'photoIds', 'coverFileId', 'narration', 'earthVideoUrl', 'createdAt', 'updatedAt', 'excludedIds'] },
  comments: { name: 'Comments', cols: ['commentId', 'email', 'fileId', 'text', 'type', 'createdAt'] },
  shares:   { name: 'Shares',   cols: ['ownerEmail', 'viewerEmail', 'createdAt'] },
};

const SESSION_DAYS = 30;
const MAX_FAIL = 5;
const LOCK_MINUTES = 15;
const MAX_NARRATION_PHOTOS = 24;
const SCAN_DEPTH = 2;          // 指定フォルダから何階層下まで読むか
const SCAN_MAX_FILES = 4000;   // 1回の読み込みで扱う画像の上限

/** 閲覧のみ許可された会員が使える操作 */
const READONLY_ACTIONS = ['bootstrap', 'getImages', 'listComments', 'tts', 'listThemes', 'listPhotos', 'getImage'];

/** 1回の実行内だけ有効なメモ（シートの二重読み込みを防ぐ） */
let MEMO = {};

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
  ttsFolder_();
  Logger.log('スプレッドシート: ' + ss.getUrl());
  Logger.log('写真ルートフォルダ: ' + DriveApp.getFolderById(p.getProperty('ROOT_FOLDER_ID')).getUrl());
  Logger.log('GEMINI_API_KEY: ' + (p.getProperty('GEMINI_API_KEY') ? '設定済み' : '未設定（スクリプトプロパティに追加してください）'));
}

/** 期限切れセッションの掃除（時間主導トリガーで1日1回などに設定） */
function cleanupSessions() {
  withLock_(() => {
    const now = new Date();
    deleteRows_(DEF.sessions, rows_(DEF.sessions).filter(r => new Date(r.expiresAt) < now).map(r => r._row));
  });
}

/* ================================================================
 * エントリポイント
 * ================================================================ */
function doGet() {
  return out_({ ok: true, app: 'omoide-fusen', version: APP_VERSION });
}

function doPost(e) {
  MEMO = {};
  let res;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const action = String(req.action || '');
    if (PUBLIC_ACTIONS[action]) {
      res = PUBLIC_ACTIONS[action](req);
    } else if (PRIVATE_ACTIONS[action]) {
      const user = auth_(req.token, action);
      MEMO.email = user.email;
      const ctx = { user: user, owner: user, readOnly: false };
      const asOwner = normEmail_(req.asOwner);
      if (asOwner && asOwner !== user.email) {
        if (READONLY_ACTIONS.indexOf(action) < 0) throw err_('閲覧のみ許可されたボードでは、この操作はできません。', 'READONLY');
        if (!hasShare_(asOwner, user.email)) throw err_('このボードの閲覧は許可されていません。', 'NOSHARE');
        const owner = findUser_(asOwner);
        if (!owner) throw err_('ボードの持ち主が見つかりません。', 'NOSHARE');
        ctx.owner = owner;
        ctx.readOnly = true;
      }
      res = PRIVATE_ACTIONS[action](req, ctx.owner, ctx);
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
  bootstrap: bootstrap_,
  diag: diag_,
  logout: logout_,
  changePassword: changePassword_,
  usage: (req, u) => ({ usage: usagePub_(u.email) }),
  // フォルダ・写真
  setFolder: setFolder_,
  scanFolder: scanFolder_,
  uploadPhoto: uploadPhoto_,
  analyzeBatch: analyzeBatch_,
  updatePhoto: updatePhoto_,
  bulkUpdatePhotos: bulkUpdatePhotos_,
  geocode: geocode_,
  findDuplicates: findDuplicates_,
  markDuplicates: markDuplicates_,
  restoreDuplicates: restoreDuplicates_,
  getImages: getImages_,
  // 付箋
  createTheme: createTheme_,
  updateTheme: updateTheme_,
  deleteTheme: deleteTheme_,
  refreshTheme: refreshTheme_,
  assignPhotos: assignPhotos_,
  suggestThemes: suggestThemes_,
  generateNarration: generateNarration_,
  tts: tts_,
  // コメント
  listComments: listComments_,
  addComment: addComment_,
  deleteComment: deleteComment_,
  aiComment: aiComment_,
  // 共有
  listShares: listShares_,
  addShare: addShare_,
  removeShare: removeShare_,
  // Excel
  importData: importData_,
  // 旧バージョン（v1.0.x）の画面が残っていても動くように残している互換用の操作
  listThemes: (req, u) => ({ themes: rows_(DEF.themes).filter(r => r.email === u.email).map(themePub_) }),
  listPhotos: (req, u) => ({ photos: rows_(DEF.photos).filter(r => r.email === u.email).map(photoPub_) }),
  getImage: (req, u) => {
    const r = getImages_({ fileIds: [req.fileId], size: req.size }, u);
    const dataUrl = r.images[req.fileId];
    if (!dataUrl) throw err_('この写真は表示できません。');
    return { dataUrl };
  },
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
    if (s) deleteRows_(DEF.sessions, [s._row]);
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

/** 起動時に必要なデータを1回で返す（通信回数を減らして高速化） */
function bootstrap_(req, u, ctx) {
  const themes = rows_(DEF.themes).filter(r => r.email === u.email).map(themePub_);
  const photos = rows_(DEF.photos).filter(r => r.email === u.email).map(photoPub_);
  if (ctx && ctx.readOnly) {
    return { readOnly: true, owner: { email: u.email, nickname: u.nickname }, themes, photos };
  }
  return {
    user: userPub_(u),
    folder: folderInfo_(u.folderId, u),
    themes, photos,
    shares: listShares_(req, u),
    usage: usagePub_(u.email),
  };
}

/** 起動データの診断（設定画面の「接続を確かめる」から呼ぶ） */
function diag_(req, u, ctx) {
  const out = { email: u.email, sheets: ss_().getSheets().map(s => s.getName()) };
  ['photos', 'themes', 'comments', 'shares'].forEach(k => {
    try {
      const all = rows_(DEF[k]);
      out[k] = { rows: all.length, mine: all.filter(r => (r.email || r.ownerEmail) === u.email).length, cols: sh_(DEF[k]).getLastColumn() };
    } catch (e) { out[k] = { error: e.message }; }
  });
  try {
    const b = bootstrap_(req, u, ctx);
    out.bootstrap = { keys: Object.keys(b), photos: Array.isArray(b.photos) ? b.photos.length : typeof b.photos, themes: Array.isArray(b.themes) ? b.themes.length : typeof b.themes, bytes: JSON.stringify(b).length };
  } catch (e) { out.bootstrap = { error: e.message, stack: String(e.stack || '').split('\n').slice(0, 3).join(' / ') }; }
  return { diag: out };
}

/* ================================================================
 * 閲覧の共有
 * ================================================================ */
function hasShare_(ownerEmail, viewerEmail) {
  return rows_(DEF.shares).some(r => r.ownerEmail === ownerEmail && r.viewerEmail === viewerEmail);
}

function listShares_(req, u) {
  const all = rows_(DEF.shares);
  const nick = {};
  rows_(DEF.users).forEach(r => { nick[r.email] = r.nickname; });
  return {
    granted: all.filter(r => r.ownerEmail === u.email)
      .map(r => ({ email: r.viewerEmail, nickname: nick[r.viewerEmail] || '', registered: !!nick[r.viewerEmail] })),
    sharedWithMe: all.filter(r => r.viewerEmail === u.email)
      .filter(r => nick[r.ownerEmail] !== undefined)
      .map(r => ({ email: r.ownerEmail, nickname: nick[r.ownerEmail] || '' })),
  };
}

function addShare_(req, u) {
  const email = normEmail_(req.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw err_('メールアドレスの形式が正しくありません。');
  if (email === u.email) throw err_('自分自身は追加できません。');
  withLock_(() => {
    if (hasShare_(u.email, email)) throw err_('この会員にはすでに閲覧を許可しています。');
    if (rows_(DEF.shares).filter(r => r.ownerEmail === u.email).length >= 50) throw err_('閲覧を許可できるのは50人までです。');
    insert_(DEF.shares, { ownerEmail: u.email, viewerEmail: email, createdAt: now_() });
  });
  const registered = !!findUser_(email);
  sendMail_(email, '【おもいで付箋ボード】' + u.nickname + ' さんがボードの閲覧を許可しました',
    u.nickname + ' さんが、あなたに「おもいで付箋ボード」の閲覧を許可しました。\n\n' +
    (registered
      ? 'ログイン後、画面上部の「ボード」から ' + u.nickname + ' さんのボードを選ぶと見られます（閲覧のみ）。\n'
      : 'このメールアドレスで新規登録すると、' + u.nickname + ' さんのボードを見られるようになります（閲覧のみ）。\n') +
    appUrlLine_());
  return { shares: listShares_(req, u), registered };
}

function removeShare_(req, u) {
  const email = normEmail_(req.email);
  withLock_(() => {
    const r = rows_(DEF.shares).find(x => x.ownerEmail === u.email && x.viewerEmail === email);
    if (r) deleteRows_(DEF.shares, [r._row]);
  });
  return { shares: listShares_(req, u) };
}

/* ================================================================
 * AI 利用量（Gemini 節約）
 * ================================================================ */
function today_() { return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd'); }

function usageGet_(email) {
  const v = parseObj_(PropertiesService.getScriptProperties().getProperty('u:' + today_())) || {};
  return Object.assign({ t: 0, i: 0, s: 0, c: 0 }, v[email] || {});
}

/** t=文章 / i=画像解析枚数 / s=音声生成 / c=音声キャッシュ利用 */
function usageAdd_(email, field, n) {
  if (!email) return;
  try {
    const p = PropertiesService.getScriptProperties();
    const key = 'u:' + today_();
    const raw = p.getProperty(key);
    const v = parseObj_(raw) || {};
    const e = Object.assign({ t: 0, i: 0, s: 0, c: 0 }, v[email] || {});
    e[field] = (e[field] || 0) + (n || 1);
    v[email] = e;
    p.setProperty(key, JSON.stringify(v));
    if (!raw) {
      const limit = Utilities.formatDate(new Date(Date.now() - 14 * 86400000), 'Asia/Tokyo', 'yyyy-MM-dd');
      p.getKeys().forEach(k => { if (k.indexOf('u:') === 0 && k.slice(2) < limit) p.deleteProperty(k); });
    }
  } catch (e) {
    console.warn('usage: ' + e);
  }
}

function usageLimit_() { return Number(prop_('DAILY_AI_LIMIT', '300')); }

function usageCheck_(email, cost) {
  const limit = usageLimit_();
  if (!email || !(limit > 0)) return;
  const x = usageGet_(email);
  if (x.t + x.i + x.s + (cost || 0) > limit) {
    throw err_('今日のAI利用回数の上限（' + limit + '回）に達しました。明日またお試しください。', 'LIMIT');
  }
}

function usagePub_(email) {
  return Object.assign({ limit: usageLimit_(), date: today_() }, usageGet_(email));
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
  forgetOwn_(u.email);
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

/** フォルダごと追加用：読み込み先フォルダの下にサブフォルダを作る（なければ作成） */
function ensureSubFolder_(parentId, subPath) {
  const segs = String(subPath || '').split('/')
    .map(s => s.replace(/[\\:*?"<>|]/g, '').trim().slice(0, 60))
    .filter(Boolean).slice(0, SCAN_DEPTH);
  if (!segs.length) return parentId;
  return withLock_(() => {
    const cache = CacheService.getScriptCache();
    let cur = parentId;
    segs.forEach(name => {
      const ck = 'fold:' + cur + ':' + name;
      let id = cache.get(ck);
      if (!id) {
        const parent = DriveApp.getFolderById(cur);
        const it = parent.getFoldersByName(name);
        id = it.hasNext() ? it.next().getId() : parent.createFolder(name).getId();
        cache.put(ck, id, 21600);
      }
      cur = id;
    });
    return cur;
  });
}

/* ================================================================
 * 写真
 * ================================================================ */
function photoPub_(r) {
  return {
    fileId: r.fileId, fileName: r.fileName, takenAt: r.takenAt,
    lat: num_(r.lat), lng: num_(r.lng), place: r.place,
    tags: parseArr_(r.tags), mood: r.mood, scene: r.scene,
    description: r.description, status: r.status || 'pending',
    dupOf: r.dupOf || '',
    // AI解析したか（analyzedAt は AI 解析のときだけ記録される）。手で「解析済みにする」にした写真は manual
    analyzedBy: r.status === 'done' ? (r.analyzedAt ? 'ai' : 'manual') : '',
  };
}

/** Drive API でフォルダ内の画像を一覧（MD5・サイズ付き、DriveApp より高速） */
function collectImages_(folderId, depth, out) {
  const token = ScriptApp.getOAuthToken();
  const folders = [];
  let pageToken = '';
  do {
    const url = 'https://www.googleapis.com/drive/v3/files?pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true' +
      '&q=' + encodeURIComponent("'" + folderId + "' in parents and trashed = false") +
      '&fields=' + encodeURIComponent('nextPageToken,files(id,name,mimeType,md5Checksum,size)') +
      (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const r = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) throw err_('フォルダの中身を読み込めませんでした（' + r.getResponseCode() + '）');
    const j = JSON.parse(r.getContentText());
    (j.files || []).forEach(f => {
      if (f.mimeType === 'application/vnd.google-apps.folder') folders.push(f.id);
      else if (/^image\//.test(f.mimeType) && out.length < SCAN_MAX_FILES) {
        out.push({ id: f.id, name: f.name, mime: f.mimeType, md5: f.md5Checksum || '', size: Number(f.size) || '' });
      }
    });
    pageToken = j.nextPageToken || '';
  } while (pageToken && out.length < SCAN_MAX_FILES);
  if (depth > 0) folders.forEach(id => { if (out.length < SCAN_MAX_FILES) collectImages_(id, depth - 1, out); });
  return out;
}

/** 重複判定のキー（MD5。なければ ファイル名＋サイズ） */
function dupKey_(r) {
  if (r.md5) return 'm:' + r.md5;
  if (r.fileName && r.fileSize) return 'n:' + String(r.fileName).toLowerCase() + ':' + r.fileSize;
  return '';
}

function scanFolder_(req, u) {
  getFolder_(u.folderId);
  const found = collectImages_(u.folderId, SCAN_DEPTH, []);
  const foundIds = {};
  found.forEach(f => { foundIds[f.id] = f; });
  const res = withLock_(() => {
    const mine = rows_(DEF.photos).filter(r => r.email === u.email);
    const have = {};
    const keeper = {};
    mine.forEach(r => {
      have[r.fileId] = true;
      const f = foundIds[r.fileId];
      const k = dupKey_({ md5: r.md5 || (f && f.md5), fileName: r.fileName, fileSize: r.fileSize || (f && f.size) });
      if (k && r.status !== 'dup' && !keeper[k]) keeper[k] = r.fileId;
    });
    // 既存の写真に MD5・サイズを記録
    const fill = mine.filter(r => foundIds[r.fileId] && (!r.md5 || !r.fileSize))
      .map(r => ({ row: r._row, obj: { md5: foundIds[r.fileId].md5, fileSize: foundIds[r.fileId].size } }));
    patchMany_(DEF.photos, fill);
    // 新しい写真（同じ内容の写真がすでにあれば「重複」として対象から外す）
    let dup = 0;
    const add = found.filter(f => !have[f.id]).map(f => {
      const row = { fileId: f.id, email: u.email, fileName: f.name, mimeType: f.mime, status: 'pending', addedAt: now_(), md5: f.md5, fileSize: f.size };
      const k = dupKey_(row);
      if (k && keeper[k]) { row.status = 'dup'; row.dupOf = keeper[k]; dup++; }
      else if (k) keeper[k] = f.id;
      return row;
    });
    if (add.length) insertMany_(DEF.photos, add);
    const gone = mine.filter(r => !foundIds[r.fileId]).map(r => r._row);
    deleteRows_(DEF.photos, gone);
    return { added: add.length, removed: gone.length, duplicates: dup };
  });
  forgetOwn_(u.email);
  res.photos = rows_(DEF.photos).filter(r => r.email === u.email).map(photoPub_);
  return res;
}

function uploadPhoto_(req, u) {
  const name = String(req.fileName || 'photo.jpg').split('/').pop().slice(0, 120);
  const mime = String(req.mimeType || 'image/jpeg');
  if (!/^image\//.test(mime)) throw err_('画像ファイルだけ追加できます。');
  if (!req.data) throw err_('ファイルが空です。');
  const bytes = Utilities.base64Decode(req.data);
  const md5 = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, bytes).map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
  // 同じ内容の写真がすでにあればアップロードしない
  const same = rows_(DEF.photos).find(r => r.email === u.email && r.md5 === md5);
  if (same) return { duplicate: true, photo: photoPub_(same) };
  const folderId = ensureSubFolder_(u.folderId, req.subPath);
  const blob = Utilities.newBlob(bytes, mime, name);
  const file = getFolder_(folderId).createFile(blob);
  const row = { fileId: file.getId(), email: u.email, fileName: name, mimeType: mime, status: 'pending', addedAt: now_(), md5, fileSize: bytes.length };
  withLock_(() => insert_(DEF.photos, row));
  forgetOwn_(u.email);
  return { photo: photoPub_(row) };
}

/** 写真の情報を手で修正 */
function updatePhoto_(req, u) {
  const fields = photoFields_(req.fields || {});
  const photo = withLock_(() => {
    const r = rows_(DEF.photos).find(x => x.email === u.email && x.fileId === req.fileId);
    if (!r) throw err_('写真が見つかりません。');
    patch_(DEF.photos, r._row, fields);
    return photoPub_(Object.assign({}, r, fields));
  });
  return { photo };
}

/**
 * 重複している写真を探す（MD5が同じ、MD5がなければ ファイル名＋サイズが同じ）
 * 残す1枚は「付箋に入っている」「解析済み」「先に登録した」ものを優先
 */
function findDuplicates_(req, u) {
  let mine = rows_(DEF.photos).filter(r => r.email === u.email);
  const missing = mine.filter(r => !r.md5 || !r.fileSize).map(r => r.fileId);
  if (missing.length) {
    const metas = driveMetaMany_(missing, 'id,md5Checksum,size');
    withLock_(() => {
      const ups = [];
      rows_(DEF.photos).forEach(r => {
        const m = r.email === u.email && metas[r.fileId];
        if (m) ups.push({ row: r._row, obj: { md5: m.md5Checksum || '', fileSize: Number(m.size) || '' } });
      });
      patchMany_(DEF.photos, ups);
    });
    mine = rows_(DEF.photos).filter(r => r.email === u.email);
  }
  const inTheme = {};
  rows_(DEF.themes).filter(t => t.email === u.email).forEach(t => parseArr_(t.photoIds).forEach(id => { inTheme[id] = (inTheme[id] || 0) + 1; }));
  const groups = {};
  mine.forEach(r => {
    const k = dupKey_(r);
    if (k) (groups[k] = groups[k] || []).push(r);
  });
  const score = r => (r.status !== 'dup' ? 1000 : 0) + (inTheme[r.fileId] ? 100 : 0) + (r.status === 'done' ? 10 : 0);
  const out = Object.keys(groups).map(k => groups[k]).filter(g => g.length > 1).map(g => {
    g.sort((a, b) => score(b) - score(a) || String(a.addedAt).localeCompare(String(b.addedAt)));
    return { fileIds: g.map(r => r.fileId), exact: g[0].md5 ? true : false };
  });
  return { groups: out, photos: mine.map(photoPub_) };
}

/** 重複として対象から外す（付箋に入っていたら残す写真に置き換える） */
function markDuplicates_(req, u) {
  const own = ownSet_(u.email);
  const items = (Array.isArray(req.items) ? req.items : []).filter(x => x && own[x.fileId] && x.fileId !== x.dupOf).slice(0, SCAN_MAX_FILES);
  if (!items.length) throw err_('外す写真を選んでください。');
  const dupOf = {};
  items.forEach(x => { dupOf[x.fileId] = own[x.dupOf] ? String(x.dupOf) : ''; });
  const photos = [], themes = [];
  withLock_(() => {
    const pu = [];
    rows_(DEF.photos).forEach(r => {
      if (r.email !== u.email || dupOf[r.fileId] === undefined) return;
      const obj = { status: 'dup', dupOf: dupOf[r.fileId] };
      pu.push({ row: r._row, obj });
      photos.push(photoPub_(Object.assign({}, r, obj)));
    });
    patchMany_(DEF.photos, pu);
    const tu = [];
    rows_(DEF.themes).forEach(t => {
      if (t.email !== u.email) return;
      const ids = parseArr_(t.photoIds);
      if (!ids.some(id => dupOf[id] !== undefined)) return;
      const next = [];
      ids.forEach(id => {
        const v = dupOf[id] !== undefined ? dupOf[id] : id;
        if (v && dupOf[v] === undefined && next.indexOf(v) < 0) next.push(v);
      });
      let cover = t.coverFileId;
      if (dupOf[cover] !== undefined) cover = dupOf[cover];
      if (next.indexOf(cover) < 0) cover = next[0] || '';
      const obj = { photoIds: JSON.stringify(next), coverFileId: cover, narration: '', updatedAt: now_() };
      tu.push({ row: t._row, obj });
      themes.push(themePub_(Object.assign({}, t, obj)));
    });
    patchMany_(DEF.themes, tu);
  });
  return { photos, themes };
}

/** 重複として外した写真を対象に戻す */
function restoreDuplicates_(req, u) {
  const want = {};
  (Array.isArray(req.fileIds) ? req.fileIds : []).forEach(id => { want[id] = true; });
  const photos = [];
  withLock_(() => {
    const pu = [];
    rows_(DEF.photos).forEach(r => {
      if (r.email !== u.email || !want[r.fileId] || r.status !== 'dup') return;
      const analyzed = !!(r.description || parseArr_(r.tags).length);
      const obj = { status: analyzed ? 'done' : 'pending', dupOf: '' };
      pu.push({ row: r._row, obj });
      photos.push(photoPub_(Object.assign({}, r, obj)));
    });
    patchMany_(DEF.photos, pu);
  });
  return { photos };
}

function dupSet_(email) {
  const set = {};
  rows_(DEF.photos).forEach(r => { if (r.email === email && r.status === 'dup') set[r.fileId] = true; });
  return set;
}

/**
 * 選んだ複数の写真の情報をまとめて書き換える
 *  - 撮影日時：日付だけを渡すと各写真の時刻を残して日付だけ変える
 *  - タグ：tagMode = replace（置き換え）/ add（追加）/ remove（削除）
 *  - 状態：done（解析済みにする）/ pending（未解析に戻す）※重複で外した写真は変えない
 */
function bulkUpdatePhotos_(req, u) {
  const own = ownSet_(u.email);
  const ids = unique_((Array.isArray(req.fileIds) ? req.fileIds : []).map(String).filter(id => own[id])).slice(0, SCAN_MAX_FILES);
  if (!ids.length) throw err_('写真を選んでください。');
  const f = req.fields || {};
  const base = {};
  ['place', 'lat', 'lng', 'scene', 'mood', 'description'].forEach(k => { if (f[k] !== undefined) base[k] = f[k]; });
  let dateOnly = '';
  if (f.takenAt !== undefined) {
    const t = normDate_(f.takenAt);
    if (t === null) throw err_('撮影日時は 2024-08-15 または 2024-08-15 14:30 の形式で入力してください。');
    if (t.length === 10) dateOnly = t; else base.takenAt = t;
  }
  const tagMode = ['add', 'remove'].indexOf(req.tagMode) >= 0 ? req.tagMode : 'replace';
  let tagList = null;
  if (f.tags !== undefined) {
    tagList = unique_((Array.isArray(f.tags) ? f.tags : String(f.tags || '').split(/[、,，\n]+/)).map(x => String(x).trim()).filter(Boolean));
    if (tagMode === 'replace') base.tags = tagList;
    else if (!tagList.length) throw err_('追加・削除するタグを入力してください。');
  }
  const statusTo = ['done', 'pending'].indexOf(f.status) >= 0 ? f.status : '';
  const clean = photoFields_(base);
  if (!Object.keys(clean).length && !dateOnly && !tagList && !statusTo) throw err_('変更する項目にチェックを入れてください。');
  const photos = [];
  withLock_(() => {
    const map = {};
    rows_(DEF.photos).forEach(r => { if (r.email === u.email) map[r.fileId] = r; });
    const ups = [];
    ids.forEach(id => {
      const r = map[id];
      if (!r) return;
      const obj = Object.assign({}, clean);
      if (dateOnly) {
        const old = String(r.takenAt || '');
        obj.takenAt = dateOnly + (old.length >= 16 ? old.slice(10, 16) : '');
      }
      if (tagList && tagMode !== 'replace') {
        const cur = parseArr_(r.tags);
        const next = tagMode === 'add' ? unique_(cur.concat(tagList)) : cur.filter(t => tagList.indexOf(t) < 0);
        obj.tags = JSON.stringify(next.slice(0, 20));
      }
      if (statusTo && r.status !== 'dup') obj.status = statusTo;
      ups.push({ row: r._row, obj });
      photos.push(photoPub_(Object.assign({}, r, obj)));
    });
    patchMany_(DEF.photos, ups);
  });
  return { photos };
}

function photoFields_(f) {
  const o = {};
  if (f.takenAt !== undefined) {
    const t = normDate_(f.takenAt);
    if (t === null) throw err_('撮影日時は 2024-08-15 14:30 の形式で入力してください。');
    o.takenAt = t;
  }
  if (f.place !== undefined) o.place = String(f.place || '').trim().slice(0, 80);
  ['lat', 'lng'].forEach(k => {
    if (f[k] === undefined) return;
    if (f[k] === '' || f[k] === null) { o[k] = ''; return; }
    const n = Number(f[k]);
    if (isNaN(n) || Math.abs(n) > (k === 'lat' ? 90 : 180)) throw err_((k === 'lat' ? '緯度' : '経度') + 'の値が正しくありません。');
    o[k] = n;
  });
  if (f.tags !== undefined) {
    const a = Array.isArray(f.tags) ? f.tags : String(f.tags || '').split(/[、,，\n]+/);
    o.tags = JSON.stringify(unique_(a.map(s => String(s).trim()).filter(Boolean)).slice(0, 20));
  }
  ['scene', 'mood'].forEach(k => { if (f[k] !== undefined) o[k] = String(f[k] || '').trim().slice(0, 30); });
  if (f.description !== undefined) o.description = String(f.description || '').trim().slice(0, 300);
  if (f.status !== undefined && ['pending', 'done', 'error'].indexOf(f.status) >= 0) o.status = f.status;
  return o;
}

/**
 * AI解析（節約版）
 *  - 小さいサムネイル（既定384px）＋低解像度モード
 *  - 1回の Gemini 呼び出しで複数枚（既定4枚）をまとめて解析
 *  - Drive 情報とサムネイルは並列取得
 */
function analyzeBatch_(req, u) {
  const start = Date.now();
  const per = Math.min(Math.max(Number(prop_('ANALYZE_PER_REQUEST', '4')) || 4, 1), 8);
  const limit = Math.min(Math.max(Number(req.limit) || 8, 1), 16);
  const mine = rows_(DEF.photos).filter(r => r.email === u.email);
  let targets;
  if (Array.isArray(req.fileIds) && req.fileIds.length) {
    const want = {};
    req.fileIds.forEach(id => { want[id] = true; });
    targets = mine.filter(r => want[r.fileId] && r.status !== 'dup').slice(0, limit);
  } else {
    const st = req.retryErrors ? ['pending', 'error'] : ['pending'];
    targets = mine.filter(r => st.indexOf(r.status || 'pending') >= 0).slice(0, limit);
  }
  if (!targets.length) return { processed: 0, remaining: 0, photos: [] };
  usageCheck_(MEMO.email, targets.length);

  const ids = targets.map(r => r.fileId);
  const metas = driveMetaMany_(ids);
  const blobs = thumbMany_(metas, Number(prop_('ANALYZE_IMAGE_SIZE', '384')) || 384);

  const patches = {};
  for (let i = 0; i < targets.length; i += per) {
    if (Date.now() - start > 240000) break;
    const chunk = targets.slice(i, i + per);
    const info = chunk.map(r => {
      const meta = metas[r.fileId] || {};
      const im = meta.imageMediaMetadata || {};
      const takenAt = exifTime_(im.time) || (meta.createdTime ? jst_(meta.createdTime, 'yyyy-MM-dd HH:mm') : '');
      let lat = null, lng = null, place = '';
      if (im.location && im.location.latitude != null && im.location.longitude != null) {
        lat = Number(im.location.latitude); lng = Number(im.location.longitude);
        place = reverseGeocode_(lat, lng);
      }
      return { r, takenAt, lat, lng, place, blob: blobs[r.fileId] };
    });
    const ok = info.filter(x => x.blob);
    info.filter(x => !x.blob).forEach(x => {
      patches[x.r.fileId] = { status: 'error', description: '画像を読み込めませんでした', analyzedAt: now_() };
    });
    if (!ok.length) continue;

    const parts = [{
      text: 'あなたは写真アルバムの整理係です。続く' + ok.length + '枚の写真をそれぞれ解析し、次の形式のJSONだけを返してください。\n' +
        '{"results":[{"no":写真番号,"tags":["写っているもの・場面・雰囲気の日本語タグ5〜8個"],"scene":"場面（例：海、食事、街歩き、家族の集まり）",' +
        '"mood":"雰囲気を一言","season":"季節（不明なら空）","placeGuess":"場所の推測（不明なら空）","description":"内容を40字程度で"}]}',
    }];
    ok.forEach((x, k) => {
      parts.push({ text: '[写真' + (k + 1) + '] 撮影日時=' + (x.takenAt || '不明') + ' / 撮影地=' + (x.place || '不明') });
      parts.push({ inlineData: { mimeType: x.blob.getContentType() || 'image/jpeg', data: Utilities.base64Encode(x.blob.getBytes()) } });
    });

    let results = [];
    try {
      const j = geminiJson_(parts);
      results = Array.isArray(j.results) ? j.results : (Array.isArray(j) ? j : []);
    } catch (e) {
      if (e.code === 'LIMIT') throw e;
      ok.forEach(x => { patches[x.r.fileId] = { status: 'error', description: '解析できませんでした: ' + e.message, analyzedAt: now_() }; });
      continue;
    }
    ok.forEach((x, k) => {
      const a = results.find(z => Number(z.no) === k + 1) || results[k];
      if (!a) {
        patches[x.r.fileId] = { status: 'error', description: 'AIの応答に含まれていませんでした', analyzedAt: now_() };
        return;
      }
      const tags = (Array.isArray(a.tags) ? a.tags : []).map(String).slice(0, 10);
      if (a.season && tags.indexOf(a.season) < 0) tags.push(String(a.season));
      patches[x.r.fileId] = {
        takenAt: x.takenAt,
        lat: x.lat == null ? '' : x.lat, lng: x.lng == null ? '' : x.lng,
        place: x.place || (a.placeGuess ? '（推定）' + String(a.placeGuess).slice(0, 40) : ''),
        tags: JSON.stringify(tags),
        mood: String(a.mood || '').slice(0, 30),
        scene: String(a.scene || '').slice(0, 30),
        description: String(a.description || '').slice(0, 200),
        status: 'done', analyzedAt: now_(),
      };
    });
  }

  const updated = [];
  withLock_(() => {
    const rowOf = {};
    rows_(DEF.photos).forEach(r => { if (r.email === u.email) rowOf[r.fileId] = r; });
    const ups = [];
    Object.keys(patches).forEach(id => {
      const row = rowOf[id];
      if (!row) return;
      ups.push({ row: row._row, obj: patches[id] });
      updated.push(photoPub_(Object.assign({}, row, patches[id])));
    });
    patchMany_(DEF.photos, ups);
  });
  const st = req.retryErrors ? ['pending', 'error'] : ['pending'];
  const remaining = (Array.isArray(req.fileIds) && req.fileIds.length) ? 0
    : rows_(DEF.photos).filter(r => r.email === u.email && st.indexOf(r.status || 'pending') >= 0).length;
  return { processed: updated.length, remaining, photos: updated, usage: usagePub_(MEMO.email) };
}

/** サムネイルをまとめて返す（最大16枚。CacheService＋並列取得） */
function getImages_(req, u) {
  const own = ownSet_(u.email);
  const ids = unique_((Array.isArray(req.fileIds) ? req.fileIds : []).map(String)).filter(id => own[id]).slice(0, 16);
  const size = req.size === 'full' ? 1600 : (req.size === 'mid' ? 900 : 320);
  const cache = CacheService.getScriptCache();
  const hit = ids.length ? cache.getAll(ids.map(id => 'img:' + id + ':' + size)) : {};
  const images = {};
  const miss = [];
  ids.forEach(id => {
    const v = hit['img:' + id + ':' + size];
    if (v) images[id] = v; else miss.push(id);
  });
  if (miss.length) {
    const blobs = thumbMany_(driveMetaMany_(miss), size);
    const put = {};
    miss.forEach(id => {
      const b = blobs[id];
      if (!b) return;
      const du = 'data:' + (b.getContentType() || 'image/jpeg') + ';base64,' + Utilities.base64Encode(b.getBytes());
      images[id] = du;
      if (du.length < 95000) put['img:' + id + ':' + size] = du;
    });
    if (Object.keys(put).length) { try { cache.putAll(put, 21600); } catch (e) { /* 容量超過は無視 */ } }
  }
  return { images };
}

function ownSet_(email) {
  const mk = 'own:' + email;
  if (MEMO[mk]) return MEMO[mk];
  const c = CacheService.getScriptCache();
  const v = c.get(mk);
  const ids = v ? JSON.parse(v) : rows_(DEF.photos).filter(r => r.email === email).map(r => r.fileId);
  if (!v) {
    const s = JSON.stringify(ids);
    if (s.length < 95000) c.put(mk, s, 600);
  }
  const set = {};
  ids.forEach(id => { set[id] = true; });
  MEMO[mk] = set;
  return set;
}

function forgetOwn_(email) {
  CacheService.getScriptCache().remove('own:' + email);
  delete MEMO['own:' + email];
}

function driveMetaMany_(ids, fieldsOpt) {
  const fields = fieldsOpt || 'id,name,mimeType,createdTime,thumbnailLink,imageMediaMetadata(time,location,width,height)';
  const token = ScriptApp.getOAuthToken();
  const out = {};
  for (let i = 0; i < ids.length; i += 20) {
    const part = ids.slice(i, i + 20);
    const res = UrlFetchApp.fetchAll(part.map(id => ({
      url: 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) + '?supportsAllDrives=true&fields=' + encodeURIComponent(fields),
      headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true,
    })));
    res.forEach((r, k) => {
      if (r.getResponseCode() === 200) { try { out[part[k]] = JSON.parse(r.getContentText()); } catch (e) { /* skip */ } }
    });
  }
  return out;
}

function thumbMany_(metas, size) {
  const token = ScriptApp.getOAuthToken();
  const ids = Object.keys(metas);
  const out = {};
  const withLink = ids.filter(id => metas[id].thumbnailLink);
  for (let i = 0; i < withLink.length; i += 20) {
    const part = withLink.slice(i, i + 20);
    const res = UrlFetchApp.fetchAll(part.map(id => ({
      url: metas[id].thumbnailLink.replace(/=s\d+[^/]*$/, '') + '=s' + size,
      headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true,
    })));
    res.forEach((r, k) => { if (r.getResponseCode() === 200) out[part[k]] = r.getBlob(); });
  }
  ids.filter(id => !out[id]).forEach(id => {
    try {
      const f = DriveApp.getFileById(id);
      if (f.getSize() <= 6 * 1024 * 1024) out[id] = f.getBlob();
    } catch (e) { /* skip */ }
  });
  return out;
}

function imageBlob_(fileId, size) {
  const b = thumbMany_(driveMetaMany_([fileId]), size)[fileId];
  if (!b) throw err_('画像を読み込めませんでした。');
  return b;
}

/**
 * 撮影地の逆ジオコーディング
 * - GOOGLE_MAPS_SERVER_KEY があれば Geocoding API、なければ GAS 組み込みの Maps サービス
 * - 同じ場所（小数3桁≒100m）の結果は6時間キャッシュ
 */
function reverseGeocode_(lat, lng) {
  const cache = CacheService.getScriptCache();
  const ck = 'geo:' + lat.toFixed(3) + ',' + lng.toFixed(3);
  const hit = cache.get(ck);
  if (hit !== null) return hit;
  const place = reverseGeocodeRaw_(lat, lng);
  if (place) cache.put(ck, place, 21600);
  return place;
}

/**
 * Googleマップから貼り付けた内容を緯度・経度にする
 *  - 座標（35.53, 139.69）、URL（@lat,lng / !3dlat!4dlng）、共有の短縮リンク（maps.app.goo.gl）、住所 に対応
 *  - lat/lng を渡すと、その地点の地名だけ返す
 */
function geocode_(req) {
  if (req.lat !== undefined && req.lng !== undefined) {
    const lat = Number(req.lat), lng = Number(req.lng);
    if (isNaN(lat) || isNaN(lng)) throw err_('緯度・経度が数字ではありません。');
    return { lat, lng, place: reverseGeocode_(lat, lng) };
  }
  const text = String(req.query || '').trim().slice(0, 2000);
  if (!text) throw err_('貼り付けた内容が空です。');
  // 1) 文章のどこかに座標があればそれを使う（Googleマップの「共有」は 座標・住所・リンク の複数行）
  let c = parseLatLng_(text);
  if (c) return { lat: c.lat, lng: c.lng, place: reverseGeocode_(c.lat, c.lng) };
  // 2) 共有リンク（maps.app.goo.gl など）を展開して座標を探す
  const urlM = text.match(/https?:\/\/[^\s<>"'）)]+/i);
  let expanded = '';
  if (urlM) {
    expanded = /^https?:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs|maps\.google\.|www\.google\.[^/]+\/maps|google\.[^/]+\/maps)/i.test(urlM[0]) ? expandUrl_(urlM[0]) : urlM[0];
    c = parseLatLng_(expanded);
    if (c) return { lat: c.lat, lng: c.lng, place: reverseGeocode_(c.lat, c.lng) };
  }
  // 3) 住所・地名で探す（共有テキストの住所の行、またはリンク内の地名）
  let q = '';
  const lines = text.split(/\r?\n/).map(x => x.trim()).filter(x => x && !/^https?:/i.test(x));
  q = lines.find(x => /〒|[都道府県]/.test(x)) || lines.sort((a, b) => b.length - a.length)[0] || '';
  if (!q && expanded) {
    const pm = expanded.match(/\/place\/([^/@?]+)/) || expanded.match(/\/search\/([^/@?]+)/) || expanded.match(/[?&](?:q|query|destination)=([^&]+)/);
    if (pm) { try { q = decodeURIComponent(pm[1].replace(/\+/g, ' ')); } catch (e) { q = pm[1]; } }
  }
  if (!q) throw err_('このリンクから位置を読み取れませんでした。Googleマップの「共有」で出る文章をそのまま貼り付けるか、地点を長押し（右クリック）して出る「35.xxx, 139.xxx」を貼り付けてください。');
  q = q.replace(/^日本、\s*/, '').replace(/^〒?\s*[0-9０-９]{3}[-－ー]?[0-9０-９]{4}\s*/, '').trim();
  const res = forwardGeocode_(q);
  if (!res) throw err_('この住所の位置が見つかりませんでした。住所を短くするか、座標を貼り付けてください。');
  const loc = res.geometry.location;
  return { lat: Number(loc.lat), lng: Number(loc.lng), place: placeFromResult_(res), formatted: res.formatted_address };
}

/** 文章・URL のどこかにある緯度・経度を読み取る */
function parseLatLng_(s) {
  s = String(s || '');
  let d = s;
  try { d = decodeURIComponent(s.replace(/\+/g, ' ')); } catch (e) { d = s.replace(/\+/g, ' ').replace(/%2C/gi, ','); }
  const m = d.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/) ||
    d.match(/@(-?\d+\.\d+),\s*(-?\d+\.\d+)/) ||
    d.match(/(-?\d{1,2}\.\d{3,})\s*[,，、]\s*(-?\d{1,3}\.\d{3,})/) ||
    d.match(/^\s*\(?\s*(-?\d{1,2}(?:\.\d+)?)\s*[,，、\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*\)?\s*$/);
  if (!m) return null;
  const lat = Number(m[1]), lng = Number(m[2]);
  if (isNaN(lat) || isNaN(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function expandUrl_(url) {
  let cur = url;
  for (let i = 0; i < 5; i++) {
    let r;
    try { r = UrlFetchApp.fetch(cur, { followRedirects: false, muteHttpExceptions: true }); } catch (e) { break; }
    const h = r.getAllHeaders();
    let loc = h.Location || h.location;
    if (!loc) break;
    cur = Array.isArray(loc) ? loc[0] : loc;
    if (parseLatLng_(cur) || /\/place\//.test(cur)) break;
  }
  return cur;
}

function forwardGeocode_(q) {
  const cache = CacheService.getScriptCache();
  const ck = 'fgeo:' + digest_(q);
  const hit = cache.get(ck);
  if (hit) return JSON.parse(hit);
  let res = null;
  try {
    const key = prop_('GOOGLE_MAPS_SERVER_KEY', '');
    if (key) {
      const url = 'https://maps.googleapis.com/maps/api/geocode/json?language=ja&region=jp&address=' +
        encodeURIComponent(q) + '&key=' + encodeURIComponent(key);
      const j = JSON.parse(UrlFetchApp.fetch(url, { muteHttpExceptions: true }).getContentText() || '{}');
      if (j.status === 'OK') res = j.results[0];
    }
    if (!res) {
      const r2 = Maps.newGeocoder().setLanguage('ja').setRegion('jp').geocode(q);
      res = r2 && r2.results && r2.results[0];
    }
  } catch (e) { console.warn('geocode: ' + e); }
  if (res) {
    const slim = { geometry: { location: res.geometry.location }, address_components: res.address_components, formatted_address: res.formatted_address };
    cache.put(ck, JSON.stringify(slim), 21600);
    return slim;
  }
  return null;
}

function placeFromResult_(res) {
  const pick = type => {
    const c = (res.address_components || []).find(a => a.types.indexOf(type) >= 0);
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
}

function reverseGeocodeRaw_(lat, lng) {
  try {
    let res = null;
    const key = prop_('GOOGLE_MAPS_SERVER_KEY', '');
    if (key) {
      const url = 'https://maps.googleapis.com/maps/api/geocode/json?language=ja&latlng=' +
        lat + ',' + lng + '&key=' + encodeURIComponent(key);
      const j = JSON.parse(UrlFetchApp.fetch(url, { muteHttpExceptions: true }).getContentText() || '{}');
      if (j.status === 'OK') res = j.results[0];
      else if (j.status !== 'ZERO_RESULTS') console.warn('Geocoding API: ' + j.status + ' ' + (j.error_message || ''));
    }
    if (!res) {
      const r2 = Maps.newGeocoder().setLanguage('ja').reverseGeocode(lat, lng);
      res = r2 && r2.results && r2.results[0];
    }
    if (!res) return '';
    return placeFromResult_(res);
  } catch (e) {
    return '';
  }
}

/* ================================================================
 * 付箋（テーマ）
 * ================================================================ */
function themePub_(r) {
  return {
    themeId: r.themeId, title: r.title, color: r.color,
    x: num_(r.x) || 0, y: num_(r.y) || 0,
    photoIds: parseArr_(r.photoIds), coverFileId: r.coverFileId,
    excludedIds: parseArr_(r.excludedIds),
    narration: parseObj_(r.narration), earthVideoUrl: r.earthVideoUrl,
    updatedAt: r.updatedAt,
  };
}

function newThemeId_() { return 't_' + Utilities.getUuid().replace(/-/g, '').slice(0, 12); }

function createTheme_(req, u) {
  const title = String(req.title || '').trim().slice(0, 30);
  if (!title) throw err_('テーマ名を入力してください。');
  let photoIds, cover, method = 'manual';
  if (Array.isArray(req.photoIds)) {
    const own = ownSet_(u.email);
    const dup = dupSet_(u.email);
    photoIds = unique_(req.photoIds.map(String).filter(id => own[id] && !dup[id]));
    cover = own[req.coverFileId] && photoIds.indexOf(req.coverFileId) >= 0 ? req.coverFileId : (photoIds[0] || '');
  } else {
    const m = matchTheme_(u, title, req.mode, []);
    photoIds = m.photoIds; cover = m.cover; method = m.method;
  }
  const row = {
    themeId: newThemeId_(),
    email: u.email, title,
    color: safeColor_(req.color),
    x: Math.round(Number(req.x) || 80), y: Math.round(Number(req.y) || 80),
    photoIds: JSON.stringify(photoIds), coverFileId: cover,
    narration: '', earthVideoUrl: '', excludedIds: '[]',
    createdAt: now_(), updatedAt: now_(),
  };
  withLock_(() => insert_(DEF.themes, row));
  return { theme: themePub_(row), matched: photoIds.length, method };
}

function themeFields_(f, own) {
  const o = {};
  if (f.title !== undefined) {
    const t = String(f.title).trim().slice(0, 30);
    if (!t) throw err_('テーマ名を入力してください。');
    o.title = t;
  }
  if (f.color !== undefined) o.color = safeColor_(f.color);
  if (f.x !== undefined) o.x = Math.round(Number(f.x) || 0);
  if (f.y !== undefined) o.y = Math.round(Number(f.y) || 0);
  if (f.photoIds !== undefined) {
    o.photoIds = JSON.stringify(unique_((f.photoIds || []).map(String).filter(id => own[id])));
    o.narration = '';
  }
  if (f.excludedIds !== undefined) o.excludedIds = JSON.stringify(unique_((f.excludedIds || []).map(String).filter(id => own[id])));
  if (f.coverFileId !== undefined) o.coverFileId = own[f.coverFileId] ? String(f.coverFileId) : '';
  if (f.earthVideoUrl !== undefined) {
    const v = String(f.earthVideoUrl || '').trim();
    if (v && !/^(https:\/\/|media\/|\.\/)/.test(v)) throw err_('映像のURLは https:// から始まるもの、またはリポジトリ内の media/ のパスにしてください。');
    o.earthVideoUrl = v.slice(0, 500);
  }
  o.updatedAt = now_();
  return o;
}

function updateTheme_(req, u) {
  const patch = themeFields_(req.fields || {}, ownSet_(u.email));
  const theme = withLock_(() => {
    const r = findTheme_(u, req.themeId);
    if (patch.photoIds !== undefined && patch.coverFileId === undefined) {
      const ids = JSON.parse(patch.photoIds);
      if (ids.indexOf(r.coverFileId) < 0) patch.coverFileId = ids[0] || '';
    }
    patch_(DEF.themes, r._row, patch);
    return themePub_(Object.assign({}, r, patch));
  });
  return { theme };
}

function deleteTheme_(req, u) {
  withLock_(() => deleteRows_(DEF.themes, [findTheme_(u, req.themeId)._row]));
  return {};
}

/** 写真を付箋に追加／付箋から外す（外した写真は除外リストへ入り、探し直しても戻らない） */
function assignPhotos_(req, u) {
  const own = ownSet_(u.email);
  const remove = req.mode === 'remove';
  const dup = remove ? {} : dupSet_(u.email);
  const ids = unique_((req.fileIds || []).map(String).filter(id => own[id] && !dup[id]));
  if (!ids.length) throw err_(remove ? '写真を選んでください。' : '入れられる写真がありません（重複で外した写真は入れられません）。');
  const theme = withLock_(() => {
    const r = findTheme_(u, req.themeId);
    let photos = parseArr_(r.photoIds);
    let excl = parseArr_(r.excludedIds);
    if (remove) {
      photos = photos.filter(id => ids.indexOf(id) < 0);
      excl = unique_(excl.concat(ids));
    } else {
      photos = unique_(photos.concat(ids));
      excl = excl.filter(id => ids.indexOf(id) < 0);
    }
    const patch = {
      photoIds: JSON.stringify(photos), excludedIds: JSON.stringify(excl),
      coverFileId: photos.indexOf(r.coverFileId) >= 0 ? r.coverFileId : (photos[0] || ''),
      narration: '', updatedAt: now_(),
    };
    patch_(DEF.themes, r._row, patch);
    return themePub_(Object.assign({}, r, patch));
  });
  return { theme };
}

function refreshTheme_(req, u) {
  const r0 = findTheme_(u, req.themeId);
  const excl = parseArr_(r0.excludedIds);
  const m = matchTheme_(u, r0.title, req.mode, excl);
  const patch = { photoIds: JSON.stringify(m.photoIds), coverFileId: m.photoIds.indexOf(r0.coverFileId) >= 0 ? r0.coverFileId : m.cover, narration: '', updatedAt: now_() };
  const theme = withLock_(() => {
    const r = findTheme_(u, req.themeId);
    patch_(DEF.themes, r._row, patch);
    return themePub_(Object.assign({}, r, patch));
  });
  return { theme, matched: m.photoIds.length, method: m.method };
}

function findTheme_(u, themeId) {
  const r = rows_(DEF.themes).find(x => x.email === u.email && x.themeId === themeId);
  if (!r) throw err_('付箋が見つかりません。画面を再読み込みしてください。');
  return r;
}

function photoLine_(p) {
  return [
    p.fileId, String(p.takenAt || '-').slice(0, 10), String(p.place || '-').replace('（推定）', ''),
    parseArr_(p.tags).slice(0, 8).join('/'), p.scene || '-',
    String(p.description || '').slice(0, 40),
  ].join('|');
}

/**
 * キーワード検索（AIを使わない）
 * タグ・場面・雰囲気・撮影地がテーマ名に含まれるか、テーマ名の語が説明文に含まれるかで判定
 */
function keywordMatch_(photos, title) {
  const q = String(title).toLowerCase();
  const tokens = q.split(/[\s　、,，・]+/).filter(t => t.length >= 2);
  const dm = q.match(/(\d{4})\s*(?:年|[\/\-.])?\s*(\d{1,2})?/);
  const hit = [];
  photos.forEach(p => {
    const words = parseArr_(p.tags).concat([p.scene, p.mood])
      .concat(String(p.place || '').replace('（推定）', '').split(/\s+/))
      .map(s => String(s || '').toLowerCase().trim()).filter(Boolean);
    words.slice().forEach(w => { // 「川崎市」→「川崎」のように地名の末尾を外した形でも探す
      const b = w.replace(/[都道府県市区町村]$/, '');
      if (b !== w && b.length >= 2) words.push(b);
    });
    const text = words.join(' ') + ' ' + String(p.description || '').toLowerCase();
    let s = 0;
    words.forEach(w => { if ((w.length >= 2 || /[\u4e00-\u9fff]/.test(w)) && q.indexOf(w) >= 0) s += w.length; });
    tokens.forEach(t => { if (text.indexOf(t) >= 0) s += 2; });
    if (dm) {
      const ta = String(p.takenAt || '');
      const okY = ta.indexOf(dm[1]) === 0;
      const okM = !dm[2] || Number(ta.slice(5, 7)) === Number(dm[2]);
      s = okY && okM ? s + 3 : 0;
    }
    if (s > 0) hit.push(p);
  });
  return hit.sort((a, b) => String(a.takenAt).localeCompare(String(b.takenAt))).map(p => p.fileId);
}

/**
 * テーマに合う写真を探す
 * mode: 'keyword' … AIを使わない / 'ai' … AIで探す / 'auto'（既定）… キーワードで3枚以上見つかればAIを使わない
 */
function matchTheme_(u, title, mode, excluded) {
  mode = mode || 'auto';
  const ex = {};
  (excluded || []).forEach(id => { ex[id] = true; });
  const mine = rows_(DEF.photos).filter(r => r.email === u.email && r.status !== 'dup')
    .sort((a, b) => String(a.takenAt).localeCompare(String(b.takenAt)));

  if (mode !== 'ai') {
    const k = keywordMatch_(mine, title).filter(id => !ex[id]);
    if (mode === 'keyword' || k.length >= 3) return { photoIds: k, cover: k[0] || '', method: 'keyword' };
  }

  const ph = mine.filter(r => r.status === 'done');
  if (!ph.length) throw err_('解析済みの写真がありません。先に「写真」からAI解析を実行するか、「キーワードのみ」で探してください。');
  const valid = {};
  ph.forEach(p => { valid[p.fileId] = p; });

  const cache = CacheService.getScriptCache();
  const ck = 'match:' + digest_(u.email + '|' + title + '|' + ph.map(p => p.fileId + p.analyzedAt).join(','));
  let ids = parseArr_(cache.get(ck));
  let cover = '';
  if (!ids.length) {
    for (let i = 0; i < ph.length; i += 500) {
      const chunk = ph.slice(i, i + 500);
      const prompt =
        '写真一覧（ID|日付|場所|タグ|場面|説明）から、テーマ「' + title + '」に合う写真をすべて選んでください。' +
        '気持ちや雰囲気のテーマは広めに解釈してください。\n' +
        'JSONのみ: {"photoIds":["ID"],"coverId":"代表の1枚"}\n' + chunk.map(photoLine_).join('\n');
      const j = geminiJson_([{ text: prompt }]);
      (Array.isArray(j.photoIds) ? j.photoIds : []).forEach(id => { if (valid[id]) ids.push(String(id)); });
      if (!cover && valid[j.coverId]) cover = String(j.coverId);
    }
    ids = unique_(ids);
    cache.put(ck, JSON.stringify(ids), 21600);
  }
  ids = ids.filter(id => !ex[id]).sort((a, b) => String(valid[a].takenAt).localeCompare(String(valid[b].takenAt)));
  if (ids.indexOf(cover) < 0) cover = ids[0] || '';
  return { photoIds: ids, cover, method: 'ai' };
}

/**
 * AIにテーマを提案してもらう
 *  画像は送らず、スプレッドシート（Photos シート）の 日付・撮影地・タグ・場面・説明 だけをもとに提案する
 *  includeManual: true のとき、手で「解析済みにする」にした写真（AI解析していない写真）も対象にする
 */
function suggestThemes_(req, u) {
  const includeManual = !!req.includeManual;
  const ph = rows_(DEF.photos).filter(r => r.email === u.email && r.status === 'done' && (r.analyzedAt || includeManual))
    .sort((a, b) => String(a.takenAt).localeCompare(String(b.takenAt)));
  if (ph.length < 3) throw err_('テーマを提案するには、対象の写真が3枚以上必要です。' + (includeManual ? '' : '「解析済みにした写真も含める」を選ぶと増やせます。'));
  const list = sampleEven_(ph, 300);
  const valid = {};
  list.forEach(p => { valid[p.fileId] = true; });
  const prompt =
    '写真一覧（ID|日付|場所|タグ|場面|説明）から、思い出のアルバムとしてまとめると楽しいテーマを5〜8個提案してください。' +
    '各テーマに3枚以上。テーマ名は「海に行った日」「美味しいご飯」のような親しみやすい日本語で15字以内。\n' +
    'JSONのみ: {"themes":[{"title":"...","photoIds":["ID"],"coverId":"ID"}]}\n' + list.map(photoLine_).join('\n');
  const j = geminiJson_([{ text: prompt }]);
  const suggestions = (Array.isArray(j.themes) ? j.themes : []).map(t => {
    const ids = unique_((t.photoIds || []).map(String).filter(id => valid[id]));
    return {
      title: String(t.title || '').slice(0, 30),
      photoIds: ids,
      coverFileId: ids.indexOf(t.coverId) >= 0 ? t.coverId : (ids[0] || ''),
    };
  }).filter(t => t.title && t.photoIds.length);
  return { suggestions, usage: usagePub_(MEMO.email) };
}

/* ================================================================
 * ナレーション / TTS
 * ================================================================ */
function generateNarration_(req, u) {
  const t = findTheme_(u, req.themeId);
  const ids = parseArr_(t.photoIds);
  const map = {};
  rows_(DEF.photos).filter(r => r.email === u.email && r.status !== 'dup').forEach(r => { map[r.fileId] = r; });
  const photos = sampleEven_(
    ids.map(id => map[id]).filter(Boolean).sort((a, b) => String(a.takenAt).localeCompare(String(b.takenAt))),
    MAX_NARRATION_PHOTOS);
  if (!photos.length) throw err_('このテーマには写真がありません。');

  const cm = {};
  rows_(DEF.comments).filter(c => c.email === u.email && c.type === 'manual').forEach(c => {
    (cm[c.fileId] = cm[c.fileId] || []).push(String(c.text).slice(0, 60));
  });

  const prompt =
    'テーマ「' + t.title + '」の写真を撮影順に振り返る、スライドショーのナレーションを書いてください。\n' +
    '「です・ます」の柔らかく温かい語り口。intro と outro は1〜2文、各写真の text は1〜2文（40〜60字）。' +
    '写真から分からない事実は断定せず、本人のコメントがあれば活かす。\n' +
    'JSONのみ: {"intro":"...","lines":[{"fileId":"ID","text":"..."}],"outro":"..."}\n' +
    '写真（ID|日付|場所|タグ|場面|説明|本人のコメント）:\n' +
    photos.map(p => photoLine_(p) + '|' + ((cm[p.fileId] || []).join(' / ') || '-')).join('\n');

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

function ttsFolder_() {
  const id = prop_('TTS_FOLDER_ID', '');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* 作り直す */ } }
  const f = rootFolder_().createFolder('_tts-cache');
  PropertiesService.getScriptProperties().setProperty('TTS_FOLDER_ID', f.getId());
  return f;
}

/** 音声は同じ文章・同じ声なら Drive に保存したものを再利用（2回目以降は Gemini を使わない） */
function tts_(req, u, ctx) {
  const text = String(req.text || '').trim().slice(0, 800);
  if (!text) throw err_('読み上げる文章がありません。');
  const voice = /^[A-Za-z]{2,20}$/.test(req.voice || '') ? req.voice : prop_('TTS_VOICE', 'Kore');
  const model = prop_('TTS_MODEL', 'gemini-2.5-flash-preview-tts');
  const name = digest_(model + '|' + voice + '|' + text) + '.pcm';
  const folder = ttsFolder_();
  const it = folder.getFilesByName(name);
  if (it.hasNext()) {
    const f = it.next();
    usageAdd_(MEMO.email, 'c');
    return { audio: Utilities.base64Encode(f.getBlob().getBytes()), mimeType: f.getDescription() || 'audio/L16;codec=pcm;rate=24000', cached: true };
  }
  usageCheck_(MEMO.email, 1);
  const body = {
    contents: [{ parts: [{ text: text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  };
  const j = callGemini_(model, body);
  const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
  const part = parts.find(p => p.inlineData);
  if (!part) throw err_('音声を生成できませんでした。');
  usageAdd_(MEMO.email, 's');
  try {
    folder.createFile(Utilities.newBlob(Utilities.base64Decode(part.inlineData.data), 'application/octet-stream', name))
      .setDescription(part.inlineData.mimeType || '');
  } catch (e) { console.warn('tts cache: ' + e); }
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
    .filter(r => r.email === u.email && (req.all || ids[r.fileId]))
    .map(commentPub_)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return { comments };
}

function newCommentId_() { return 'c_' + Utilities.getUuid().replace(/-/g, '').slice(0, 16); }

function addComment_(req, u) {
  const fileId = String(req.fileId || '');
  const text = String(req.text || '').trim().slice(0, 500);
  if (!ownSet_(u.email)[fileId]) throw err_('この写真にはコメントできません。');
  if (!text) throw err_('コメントを入力してください。');
  const row = { commentId: newCommentId_(), email: u.email, fileId, text, type: 'manual', createdAt: now_() };
  withLock_(() => insert_(DEF.comments, row));
  return { comment: commentPub_(row) };
}

function deleteComment_(req, u) {
  withLock_(() => {
    const r = rows_(DEF.comments).find(x => x.email === u.email && x.commentId === req.commentId);
    if (!r) throw err_('コメントが見つかりません。');
    deleteRows_(DEF.comments, [r._row]);
  });
  return {};
}

function aiComment_(req, u) {
  const fileId = String(req.fileId || '');
  const p = rows_(DEF.photos).find(r => r.email === u.email && r.fileId === fileId);
  if (!p) throw err_('写真が見つかりません。');
  const past = rows_(DEF.comments).filter(c => c.email === u.email && c.fileId === fileId && c.type === 'manual')
    .map(c => String(c.text).slice(0, 80));
  const img = imageBlob_(fileId, Number(prop_('ANALYZE_IMAGE_SIZE', '384')) || 384);
  const prompt =
    'この写真を、撮った本人がアルバムを見返しながら語るような温かい回想コメントを1つ、日本語80〜120字で。' +
    '「〜だったね」「〜したっけ」のような柔らかい語り口で、分からない事実は断定しない。本文だけを出力。\n' +
    '参考: 撮影日時=' + (p.takenAt || '不明') + ' / 撮影地=' + (p.place || '不明') +
    ' / タグ=' + parseArr_(p.tags).join('、') + ' / 本人のコメント=' + (past.join(' / ') || 'なし');
  const text = geminiText_([
    { text: prompt },
    { inlineData: { mimeType: img.getContentType() || 'image/jpeg', data: Utilities.base64Encode(img.getBytes()) } },
  ]).trim().replace(/^[「"]|[」"]$/g, '').slice(0, 300);
  const row = { commentId: newCommentId_(), email: u.email, fileId, text, type: 'ai', createdAt: now_() };
  withLock_(() => insert_(DEF.comments, row));
  return { comment: commentPub_(row), usage: usagePub_(MEMO.email) };
}

/* ================================================================
 * Excel 読み込み（クライアントで変更分だけを抽出して送る）
 * ================================================================ */
function importData_(req, u) {
  const own = ownSet_(u.email);
  const P = Array.isArray(req.photos) ? req.photos.slice(0, Math.max(5000, SCAN_MAX_FILES)) : [];
  const T = Array.isArray(req.themes) ? req.themes.slice(0, 1000) : [];
  const C = Array.isArray(req.comments) ? req.comments.slice(0, 5000) : [];

  // 入力チェック（ロックの外で）
  const pUp = P.filter(x => own[x.fileId]).map(x => {
    try { return { fileId: x.fileId, obj: photoFields_(x) }; }
    catch (e) { throw err_('写真 ' + (x.fileName || x.fileId) + ': ' + e.message); }
  });
  const tIn = T.map(x => {
    const f = {};
    ['title', 'color', 'x', 'y', 'photoIds', 'excludedIds', 'coverFileId', 'earthVideoUrl'].forEach(k => { if (x[k] !== undefined) f[k] = x[k]; });
    if (f.title !== undefined && !String(f.title).trim()) delete f.title;
    let obj;
    try { obj = x.delete ? {} : themeFields_(f, own); }
    catch (e) { throw err_('付箋「' + (x.title || x.themeId) + '」: ' + e.message); }
    if (obj.photoIds !== undefined) {
      const ids = JSON.parse(obj.photoIds);
      if (ids.indexOf(obj.coverFileId) < 0) obj.coverFileId = ids[0] || '';
    }
    return { id: String(x.themeId || '').trim(), del: !!x.delete, obj };
  });

  const res = { photos: 0, themesUpdated: 0, themesAdded: 0, themesDeleted: 0, commentsUpdated: 0, commentsAdded: 0, commentsDeleted: 0 };
  withLock_(() => {
    // 写真
    const prow = {};
    rows_(DEF.photos).forEach(r => { if (r.email === u.email) prow[r.fileId] = r._row; });
    const pu = pUp.filter(x => prow[x.fileId]).map(x => ({ row: prow[x.fileId], obj: x.obj }));
    patchMany_(DEF.photos, pu);
    res.photos = pu.length;

    // 付箋
    const trow = {};
    rows_(DEF.themes).forEach(r => { if (r.email === u.email) trow[r.themeId] = r._row; });
    const tUpd = [], tNew = [], tDel = [];
    tIn.forEach(x => {
      if (x.del) { if (trow[x.id]) tDel.push(trow[x.id]); return; }
      if (trow[x.id]) { tUpd.push({ row: trow[x.id], obj: x.obj }); return; }
      if (!x.obj.title) return;
      tNew.push(Object.assign({
        themeId: newThemeId_(), email: u.email, color: '#FFEF7A', x: 80 + tNew.length * 30, y: 80 + tNew.length * 30,
        photoIds: '[]', coverFileId: '', narration: '', earthVideoUrl: '', excludedIds: '[]', createdAt: now_(),
      }, x.obj));
    });
    patchMany_(DEF.themes, tUpd);
    if (tNew.length) insertMany_(DEF.themes, tNew);
    deleteRows_(DEF.themes, tDel);
    res.themesUpdated = tUpd.length; res.themesAdded = tNew.length; res.themesDeleted = tDel.length;

    // コメント
    const crow = {};
    rows_(DEF.comments).forEach(r => { if (r.email === u.email) crow[r.commentId] = r._row; });
    const cUpd = [], cNew = [], cDel = [];
    C.forEach(x => {
      const id = String(x.commentId || '').trim();
      const text = String(x.text || '').trim().slice(0, 500);
      if (x.delete) { if (crow[id]) cDel.push(crow[id]); return; }
      if (crow[id]) { if (text) cUpd.push({ row: crow[id], obj: { text } }); return; }
      if (text && own[x.fileId]) {
        cNew.push({ commentId: newCommentId_(), email: u.email, fileId: x.fileId, text, type: x.type === 'ai' ? 'ai' : 'manual', createdAt: now_() });
      }
    });
    patchMany_(DEF.comments, cUpd);
    if (cNew.length) insertMany_(DEF.comments, cNew);
    deleteRows_(DEF.comments, cDel);
    res.commentsUpdated = cUpd.length; res.commentsAdded = cNew.length; res.commentsDeleted = cDel.length;
  });
  return { result: res };
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
    throw err_('Gemini API エラー（' + c + '）: ' + msg, 'GEMINI_' + c);
  }
}

/** 節約設定（思考トークン0・画像低解像度）を付けて呼ぶ。モデルが未対応なら外して再試行 */
function geminiText_(parts, json) {
  const imgs = parts.filter(p => p.inlineData).length;
  usageCheck_(MEMO.email, imgs || 1);
  const gc = { temperature: 0.7 };
  if (json) gc.responseMimeType = 'application/json';
  const tb = prop_('GEMINI_THINKING_BUDGET', '0');
  if (tb !== 'auto') gc.thinkingConfig = { thinkingBudget: Number(tb) || 0 };
  const mr = prop_('ANALYZE_MEDIA_RES', 'MEDIA_RESOLUTION_LOW');
  if (imgs && mr !== 'off') gc.mediaResolution = mr;
  const body = { contents: [{ role: 'user', parts }], generationConfig: gc };
  const model = prop_('GEMINI_MODEL', 'gemini-2.5-flash');
  let j;
  try {
    j = callGemini_(model, body);
  } catch (e) {
    if (e.code !== 'GEMINI_400' || (!gc.thinkingConfig && !gc.mediaResolution)) throw e;
    delete gc.thinkingConfig;
    delete gc.mediaResolution;
    j = callGemini_(model, body);
  }
  usageAdd_(MEMO.email, imgs ? 'i' : 't', imgs || 1);
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
  if (MEMO.ss) return MEMO.ss;
  const id = prop_('SPREADSHEET_ID', '');
  if (!id) throw err_('セットアップが完了していません。GASエディタで setup() を実行してください。');
  MEMO.ss = SpreadsheetApp.openById(id);
  return MEMO.ss;
}
/** シートを取得（なければ作成、列が足りなければ見出しを更新＝自動マイグレーション） */
function sh_(d) {
  const k = 'sh:' + d.name;
  if (MEMO[k]) return MEMO[k];
  const ss = ss_();
  const sh = ss.getSheetByName(d.name) || ss.insertSheet(d.name);
  if (sh.getLastRow() === 0 || sh.getLastColumn() < d.cols.length) {
    sh.getRange(1, 1, 1, d.cols.length).setValues([d.cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  MEMO[k] = sh;
  return sh;
}
function rows_(d) {
  const k = 'rows:' + d.name;
  if (MEMO[k]) return MEMO[k];
  const sh = sh_(d);
  const last = sh.getLastRow();
  const out = last < 2 ? [] : sh.getRange(2, 1, last - 1, d.cols.length).getValues().map((r, i) => {
    const o = { _row: i + 2 };
    d.cols.forEach((c, j) => { o[c] = r[j] instanceof Date ? r[j].toISOString() : r[j]; });
    return o;
  });
  MEMO[k] = out;
  return out;
}
function dirty_(d) { delete MEMO['rows:' + d.name]; }
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
  dirty_(d);
}
function insertMany_(d, objs) {
  if (!objs.length) return;
  const sh = sh_(d);
  sh.getRange(sh.getLastRow() + 1, 1, objs.length, d.cols.length)
    .setValues(objs.map(o => d.cols.map(c => cell_(o[c]))));
  dirty_(d);
}
function patch_(d, row, o) {
  const rg = sh_(d).getRange(row, 1, 1, d.cols.length);
  const v = rg.getValues()[0];
  d.cols.forEach((c, i) => { v[i] = cell_(o[c] !== undefined ? o[c] : v[i]); });
  rg.setValues([v]);
  dirty_(d);
}
/** 複数行をまとめて更新（シート全体を1回で読み書き） */
function patchMany_(d, updates) {
  if (!updates.length) return;
  const sh = sh_(d);
  const last = sh.getLastRow();
  if (last < 2) return;
  const rg = sh.getRange(2, 1, last - 1, d.cols.length);
  const vals = rg.getValues();
  updates.forEach(up => {
    const r = vals[up.row - 2];
    if (!r) return;
    d.cols.forEach((c, i) => {
      const v = up.obj[c];
      if (v !== undefined) r[i] = (v !== null && typeof v === 'object') ? JSON.stringify(v) : v;
    });
  });
  rg.setValues(vals.map(r => r.map(v => cell_(v))));
  dirty_(d);
}
function deleteRows_(d, rows) {
  if (!rows.length) return;
  const sh = sh_(d);
  unique_(rows).sort((a, b) => b - a).forEach(row => sh.deleteRow(row));
  dirty_(d);
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
  Object.keys(MEMO).forEach(k => { if (k.indexOf('rows:') === 0) delete MEMO[k]; });
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
/** 撮影日時の正規化。空なら ''、形式が不正なら null */
function normDate_(s) {
  s = String(s || '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{4})[\/\-年.](\d{1,2})[\/\-月.](\d{1,2})日?(?:[ T]+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const p = n => ('0' + n).slice(-2);
  return m[1] + '-' + p(m[2]) + '-' + p(m[3]) + (m[4] ? ' ' + p(m[4]) + ':' + m[5] : '');
}
function digest_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('').slice(0, 40);
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

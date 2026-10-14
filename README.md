# おもいで付箋ボード（omoide-fusen） v1.0.0

Googleドライブの写真を Gemini が解析し、テーマごとに仮想ホワイトボード上の付箋へまとめて、ランダム・アルバム・走馬灯の3つのモードで振り返る Web アプリです。

## 1. アーキテクチャ

```
omoide-fusen/
├── index.html        画面（認証・ボード・ドロワー・ダイアログ・ビューワー）
├── style.css         ホワイトボード／付箋／3モードのアニメーション
├── config.js         GAS_URL・バージョン・走馬灯の秒数などの設定
├── app.js            認証、パン＆ズーム、ドラッグ、ビューワー、TTS再生、地図フライト
├── media/            （任意）Earth Studio で書き出した MP4 を置く
└── gas/
    ├── Code.gs       Web API（doGet / doPost）
    └── appsscript.json
```

```
[ブラウザ GitHub Pages]
   │  POST (Content-Type: text/plain) {action, token, ...}
   ▼
[GAS Web API  Code.gs] ──► Spreadsheet（Users / Sessions / Photos / Themes / Comments）
   │                  ──► Google Drive（写真フォルダ・サムネイル・EXIF）
   │                  ──► Maps 逆ジオコーディング（撮影地名）
   │                  ──► Gemini API（画像解析・テーマ抽出・提案・ナレーション・回想コメント）
   │                  ──► Gemini TTS（ナレーション音声 PCM → ブラウザで WAV 化）
   ▼
[ブラウザ] 付箋ボード ／ ランダム ／ アルバム ／ 走馬灯（Leaflet 地図フライト・Earth Studio 映像）
```

処理の流れは次のとおりです。

写真の取り込みでは、「フォルダを読み込む」で指定フォルダ（サブフォルダ2階層まで）の画像を Photos シートに登録し、「写真を追加」でブラウザから直接アップロードもできます。

解析では、GAS が Drive API から EXIF の撮影日時・緯度経度とサムネイル（768px）を取得し、位置情報は Maps サービスで地名に変換します。そのうえで Gemini がタグ・場面・雰囲気・説明文を JSON で返し、Photos シートに保存します。1回の呼び出しで3枚ずつ処理し、フロント側がループするので GAS の6分制限にかかりません。

テーマ抽出では、画像は送らずに解析済みメタデータ（ID・日時・地名・タグ・説明）だけを Gemini に渡して該当写真を選ばせます。トークンが少なく、数百枚でも速く動きます。

画像表示では、GAS が所有者確認をしたうえでサムネイルを data URL で返します（400 / 900 / 1600px、小さいものは CacheService に6時間キャッシュ）。写真を「リンクを知っている全員」に公開する必要はありません。

## 2. スプレッドシートのテーブル定義

`setup()` を実行すると自動で作成されます。文字列はすべて先頭に `'` を付けて保存しているため、日付の自動変換や数式インジェクションは起きません。

**Users**

| カラム | 内容 |
|---|---|
| email | ログインID（小文字化） |
| nickname | 表示名 |
| passwordHash | SHA-256(salt + pw + PEPPER) の16進 |
| salt | ユーザーごとの UUID |
| isFirstLogin | TRUE の間は changePassword 以外の操作を拒否 |
| failCount | 連続失敗回数（5回で15分ロック） |
| lockedUntil | ロック解除時刻（ISO） |
| folderId | 現在読み込むフォルダ |
| homeFolderId | 登録時に自動作成したアップロード先フォルダ |
| createdAt / lastLoginAt | ISO 日時 |

**Sessions**: token, email, expiresAt（30日）, createdAt

**Photos**: fileId, email, fileName, mimeType, takenAt（`yyyy-MM-dd HH:mm`）, lat, lng, place, tags（JSON配列）, mood, scene, description, status（pending / done / error）, analyzedAt, addedAt

**Themes**: themeId, email, title, color, x, y, photoIds（JSON配列）, coverFileId, narration（JSON: intro / lines[{fileId,text}] / outro）, earthVideoUrl, createdAt, updatedAt

**Comments**: commentId, email, fileId, text, type（manual / ai）, createdAt

## 3. セットアップ手順

### 3-1. Gemini API キー

1. Google AI Studio（https://aistudio.google.com/apikey）で API キーを作成します。いつもの GCP プロジェクトに紐づけて構いません。
2. TTS モデルを使うため、課金が有効なプロジェクトのキーを推奨します。

### 3-2. GAS プロジェクト

1. https://script.google.com で新しいプロジェクトを作り、名前を `omoide-fusen` にします。
2. 「プロジェクトの設定」で「appsscript.json マニフェスト ファイルをエディタで表示する」をオンにし、`gas/appsscript.json` の内容で置き換えます。
3. `Code.gs` に `gas/Code.gs` の内容を貼り付けます（clasp を使う場合は `gas/` を rootDir にして `clasp push`）。
4. 「プロジェクトの設定 > スクリプト プロパティ」に次を追加します。

| プロパティ | 値 |
|---|---|
| GEMINI_API_KEY | 3-1 のキー（必須） |
| GEMINI_MODEL | 既定 `gemini-2.5-flash`。新しいモデルを使う場合はその名前 |
| TTS_MODEL | 既定 `gemini-2.5-flash-preview-tts`。新しい TTS モデルを使う場合はその名前 |
| TTS_VOICE | 既定 `Kore` |
| APP_URL | `https://kenken6291.github.io/omoide-fusen/`（メール本文に載ります） |
| SHOW_TEMP_PASSWORD | 既定 `false`。`true` にすると登録時に仮パスワードを画面にも表示 |

5. エディタで関数 `setup` を選んで実行し、権限を承認します。ログにスプレッドシートと写真ルートフォルダの URL が出ます。
6. （任意）「トリガー」で `cleanupSessions` を1日1回の時間主導トリガーに設定すると、期限切れセッションが掃除されます。

`SHOW_TEMP_PASSWORD` を `true` にすると、他人のメールアドレスでも登録できてしまい、そのアドレスに共有されたフォルダを読み込めるようになります。公開運用では `false` のままにしてください（メール送信に失敗したときだけ画面に表示されます）。

### 3-3. ウェブアプリとしてデプロイ

1. 「デプロイ > 新しいデプロイ > 種類：ウェブアプリ」
2. 実行ユーザー：自分、アクセスできるユーザー：全員
3. 表示された `https://script.google.com/macros/s/…/exec` を控えます。

**Code.gs を変更したら、必ず「デプロイを管理 > 鉛筆アイコン > バージョン：新バージョン > デプロイ」で再デプロイしてください。** 保存しただけでは公開中の API に反映されません。「新しいデプロイ」を作ると URL が変わるので、その場合は config.js かアプリの設定画面の URL を書き換えます。

### 3-4. GitHub リポジトリと GitHub Pages

1. GitHub で `omoide-fusen` リポジトリを作成します。
2. `config.js` の `GAS_URL` を 3-3 の URL に書き換えます。
3. `index.html` `style.css` `app.js` `config.js`（と任意で `media/`、`gas/`）を push します。
   ```bash
   git init && git add . && git commit -m "v1.0.0"
   git branch -M main
   git remote add origin https://github.com/kenken6291/omoide-fusen.git
   git push -u origin main
   ```
4. リポジトリの Settings > Pages で「Deploy from a branch / main / root」を選びます。
5. `https://kenken6291.github.io/omoide-fusen/` で開けます。

## 4. 使い方

1. 新規登録すると、メールに仮パスワードが届きます。ログインすると本パスワードの設定画面に切り替わります。
2. 「写真」から、写真を追加するか、自分のドライブのフォルダを指定して読み込みます。自分のドライブのフォルダを使う場合は、そのフォルダを GAS をデプロイしたアカウント（管理者）と共有してください。登録したメールアドレスのアカウントが所有・共有しているフォルダだけを指定できます。
3. 「AIで解析する」で写真を解析します。
4. 「テーマを作る」でテーマを入力するか、「AI提案」でまとめて付箋を貼ります。
5. 付箋はドラッグで移動、ボードはドラッグで移動、ホイールまたはピンチで拡大縮小できます。付箋をタップするとビューワーが開きます。

## 5. Google Earth Studio との連携

Earth Studio には外部 API がないため、次の手順で映像を作って取り込みます。

1. 付箋のメニュー「撮影地と映像」を開くと、写真の撮影地が座標つきで並びます。「座標をコピー」で Earth Studio のカメラ目標地点に貼り付けます。
2. Earth Studio（https://earth.google.com/studio/）で「Fly To」などのテンプレートからプロジェクトを作り、MP4 を書き出します（書き出しは画像連番なので、ffmpeg で MP4 にまとめます）。
   ```bash
   ffmpeg -framerate 30 -i footage/project_%03d.jpeg -c:v libx264 -pix_fmt yuv420p -crf 23 media/hawaii.mp4
   ```
3. MP4 をリポジトリの `media/` に置いて push し、「撮影地と映像」に `media/hawaii.mp4` と入力して保存します。GitHub のファイルは100MB未満にしてください。
4. 走馬灯ではタイトルのあとにこの映像が流れます。写真と写真の撮影地が30km以上離れている箇所では、Leaflet の地図が次の撮影地へ飛ぶ演出が自動で入ります（距離は config.js の `FLIGHT_DISTANCE_KM` で変更できます）。

YouTube（限定公開可）の URL も自動再生できます。Google ドライブの URL は埋め込みの仕様上、再生ボタンを押す必要があります。Earth Studio の映像を公開する際は、Google の帰属表示ルールに従ってください。

## 6. 補足と制限

ナレーションは1テーマあたり最大24枚（多い場合は撮影順に均等に抜き出し）です。走馬灯では、ナレーションがまだないテーマは再生時に自動で作成し、付箋メニューの「ナレーションを作り直す」で作り直せます。写真を探し直すとナレーションはリセットされます。

TTS 音声は1文ずつ生成し、次の写真の分を先に取得しておくので、表示中は待ち時間がほとんど出ません。iPhone でも鳴るよう、「再生する」を押した瞬間に無音を一度再生して自動再生制限を解除しています。

HEIC 画像は Drive のサムネイル経由で JPEG として表示されます。アップロード直後はサムネイル生成が遅れることがあり、その場合は少し待ってから解析してください。

GAS の Web アプリは同時実行に上限があり、Gemini の無料枠にも回数制限があります。解析中に 429 エラーが出たら、少し待ってから「AIで解析する」を押し直してください（処理済みの写真は飛ばされます）。

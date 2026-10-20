# OUTPUT 公開 URL ＋ 外部デバイス・ライブカメラ入力 設計（2026-10-19）

状態: 設計のみ。コード変更・Funnel 有効化はまだ何もしていない（`tailscale funnel status` = "No serve config"）。

## 0. 調査結果（前提）

- ノード: `emergent-2.taila81ee8.ts.net`（HostName `emergent_2`、Tailscale 1.104.1）。Self の Capabilities に `https`、`funnel`、
  `funnel-ports?ports=443,8443,10000` がある → **HTTPS 証明書と Funnel は tailnet ポリシー上すでに許可済み**。公開ポートは 443/8443/10000 のみ。
- **最重要の発見**: Funnel 経由の要求は tailscaled がローカルから中継するため、Node から見た `remoteAddress` は `127.0.0.1` になる。
  既存の防御（`server/tdControl/node-proxy.mjs` の `privatePeer`、`server/browserOutputs.ts` の `browserOutputsAccess`、
  `server/mobile/access.ts` の CIDR ガード＝127.0.0.1/32 を許可）は**すべて「信頼できる相手」と判定してしまう**。
  → **:3000 を Funnel に直接つなぐことは絶対に禁止**。公開は専用リスナー経由のみ。
- 表示ページは **ポーリング（`fetch`、8 s タイムアウト）のみ**。WebSocket/EventSource は使っていない
  （`/api/displays/:id/events` の SSE はサーバーにあるがクライアント未使用）。→ 公開側は SSE/WS 不要。
- 認証・cookie・レート制限の既存コードはない（grep で該当なし）。依存は `express@5` のみで cookie/proxy ライブラリもない。
- 秘密情報は `server/loadEnv.ts` が `.env` → `.env.local` → … の順に読む（既存 `process.env` 優先）。`.env.local` は `.gitignore` の `*.local` で除外済み。

### 表示ページが取得する URL（全列挙）

| ページ | HTML | 静的アセット | API（GET） | 画像 |
|---|---|---|---|---|
| `/display/:screenId`（`current-now/a/b/c`、`td-1…` 等） | `tools/browser-display/index.html` | `/display-assets/screen.css`, `screen.mjs`, `timeline.mjs`, `face-blur.mjs`（相対 import） | `/api/displays/:screenId` | `content.imageUrl` |
| `/control/output/[1-4]`, `/control/screen/screen-N` | `server/tdControl/output.html` | `/control/player.css`, `output.mjs`, `timeline.mjs`, `face-blur.mjs` | `/api/td-control/outputs/[1-4]` または `/api/browser-outputs/screen-N` | `content.imageUrl` |

`content.imageUrl` は `timeline.mjs` の検証で `/captures/` 始まり・`.png/.jpg/.jpeg/.webp/.gif/.avif`・`?#%` なしに限定済み。実例は
`/captures/Gen_[abc]_<日時>.png`、`/captures/record_*.jpg` / `live_record_*.jpg`（NOW）、`/captures/browser-output-assets/<…>`（読み込み画像）。
サムネイル `/captures/browser-output-thumbnails/…` は Control の mapping 画面だけが使い、表示ページは使わない → 公開しない。
顔ぼかしはクライアント側 canvas（data URL）なので追加 URL なし。

## A. 公開 URL（Tailscale Funnel ＋ パスワード）

### A-1. 構成: 同一プロセス内の第 2 Express アプリ（`127.0.0.1:3443`）→ ループバック HTTP で :3000 へ転送

```
インターネット → Funnel(443, TLS終端) → http://127.0.0.1:3443 [公開ゲート] → http://127.0.0.1:3000 [既存サーバー, Host: localhost:3000]
```

- **同一プロセス案を推奨**。理由: (1) B のリモートフレームを nativeOperator に直接渡せる（別プロセスだと新たな内部 API が必要）、
  (2) サーバー再起動と一緒に起動・停止し、手順が増えない、(3) 依存追加なしで書ける。
- ただし**ハンドラを直接呼ばず、ループバック HTTP で :3000 に転送**する。既存の Host/peer/パス検証をそのまま二重の防壁として生かし、
  公開ゲートのバグが内部ルートの露出に直結しないようにするため。転送時は `Host: localhost:3000` に書き換え、
  `Cookie`/`Authorization`/`Origin`/`X-Forwarded-*` は落とし、レスポンスの `Set-Cookie` も落とす。
  （`TD_CONTROL_ALLOWED_HOSTS` を上書きしている場合は `localhost:3000` を含めること。）
- 別プロセス案（小さなプロキシ）の利点は「本体クラッシュと独立」だが、本作品では本体が落ちれば表示も無意味なので利点が薄い。
- リスナーは **`127.0.0.1` のみに bind**（tailnet 内の他端末からも直接は届かない）。`PUBLIC_OUTPUT_PASSWORD` 未設定なら起動しない。

### A-2. 許可リスト（これ以外はすべて 404。メソッドは GET/HEAD のみ、クエリ文字列付きは 400）

認証不要: `GET /login`（ログインページ）、`POST /login`、`POST /logout`、`GET /healthz`（"ok" のみ）。

認証必須（cookie 有効時のみ転送）:
1. `^/display/[A-Za-z0-9][A-Za-z0-9_-]{0,63}/?$`、`/display/face-blur.mjs`
2. `/display-assets/` は**静的マウントを素通しせず**ファイル名を固定: `screen.css` `screen.mjs` `timeline.mjs` `face-blur.mjs`
   （同ディレクトリの `screen.test.mjs` や `index.html` 直取得を防ぐ）
3. `^/control/output/[1-4]/?$`、`^/control/screen/screen-[1-9][0-9]{0,2}/?$`、`/control/player.css` `/control/output.mjs` `/control/timeline.mjs` `/control/face-blur.mjs`
4. `^/api/displays/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`（`/events` は除外）、`^/api/td-control/outputs/[1-4]$`、`^/api/browser-outputs/screen-[1-9][0-9]{0,2}$`
5. 画像: `^/captures/[A-Za-z0-9][A-Za-z0-9_.-]{0,239}\.(png|jpe?g|webp)$`（**直下のみ**。サブディレクトリ・`latest*.json`・`prediction_data.md`・`inspect-*.json` は不可）
   と `^/captures/browser-output-assets/[A-Za-z0-9/_.-]+\.(png|jpe?g|webp)$`。
   **追加の絞り込み（推奨）**: ゲートが転送した API 応答 JSON から `content.imageUrl` を拾い、直近 30 分に配信したものだけ許可する
   （約 1.4 万枚ある過去の撮影フレームを、日時の推測で取得されるのを防ぐ）。

明示的に拒否: POST/PUT/PATCH/DELETE（ログイン系と B の 1 本以外）、ディレクトリ一覧、`/control`・`/control/`・`/control/mapping`・`/control/history`、
`/api/td-control/state|input-preview|action|scenario-upload`、その他すべての `/api/*`（`/api/generate`、`/api/browser-outputs`（設定）、`/catalog`、`/assets`、
`/api/events*`、`/api/health`、`/api/mobile/*`、`/api/archive-image/*`）、`/m`、`/logs`、`/captures/browser-output-thumbnails/*`、Vite（`/@vite`、`/src` 等）。

### A-3. パスワードと cookie

- 生成: `scripts/public-output-secret.mjs`（新規）が `crypto.randomBytes(18).toString('base64url')`（24 文字）を `PUBLIC_OUTPUT_PASSWORD`、
  `randomBytes(32)` を `PUBLIC_OUTPUT_COOKIE_SECRET` として `.env.local` に追記する。**値は標準出力・ログ・git・チャットに一切出さない**
  （既に存在すれば上書きせず終了）。再発行は `--rotate`（全 cookie 失効）。
- ユーザーが読む方法: メイン PC で `.env.local` をメモ帳で開く、または `scripts/show-public-password.ps1`（新規）を**ユーザー自身の端末で**実行
  （値を表示するだけ。Claude は実行しない）。
- 照合: 起動時にランダム salt で `crypto.scrypt(password)` をメモリに保持し、入力も同じ salt で scrypt → `timingSafeEqual`。
  （平文は `.env.local` にあるので、scrypt の主目的は総当たりの減速と定数時間比較。）
- cookie: `sm_pub=<expiry>.<role>.<nonce>.<HMAC-SHA256>`、`HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=12h`。
  `role=view`（A）。署名鍵 `PUBLIC_OUTPUT_COOKIE_SECRET` の変更で全失効。ログイン成功後は元の URL へ 303（`next` は許可リストのパスのみ受け付け、オープンリダイレクト防止）。
- レート制限（メモリ）: クライアント IP は Funnel が付ける `X-Forwarded-For`（リスナーが 127.0.0.1 専用なので信頼可）。
  **IP ごと 5 回失敗 / 10 分 → 10 分ロック、全体 30 回失敗 / 10 分 → 10 分全体ロック**。失敗はログに IP と時刻のみ（入力値は記録しない）。
- ヘッダー: `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`X-Frame-Options: DENY`、
  ログインページに `Content-Security-Policy: default-src 'self'`。

### A-4. Tailscale Funnel 手順

管理者作業: 不要の見込み（Capabilities に `https`/`funnel` 済み）。もし `tailscale funnel` が「Funnel not enabled」と言えば、
admin console の DNS で HTTPS Certificates を有効化し、ポリシーファイルの `nodeAttrs` に `{"target":["autogroup:member"],"attr":["funnel"]}` を追加（ユーザー本人の操作）。

```
tailscale funnel --bg 3443          # 公開開始（https://emergent-2.taila81ee8.ts.net/ → 127.0.0.1:3443）
tailscale funnel status             # 確認
tailscale funnel --bg off           # 停止（うまくいかなければ tailscale funnel reset）
```

公開 URL 例: `https://emergent-2.taila81ee8.ts.net/display/current-now`、`…/control/output/1`、`…/capture/`。
初回は証明書発行で数十秒かかる。**`tailscale funnel` の実行（公開開始）はユーザー本人が行う**（「公開」は確認必須の操作）。

## B. 外部デバイスのライブカメラ入力

### B-1. 流れ

1. 公開 HTTPS 上の `GET /capture/`（getUserMedia は HTTPS 必須 → Funnel が満たす）。
2. 認証は A とは**別の秘密** `PUBLIC_CAPTURE_TOKEN`（randomBytes(24)）: Control 側で QR を表示 → `/capture/?t=<token>` を開くと
   ゲートが検証して `role=capture` の cookie（Path=/capture、12h）を発行し、**トークンを消した `/capture/` へ 303**（履歴・Referer に残さない）。
   理由: 閲覧パスワードを知る人が作品の入力を差し替えられるのは権限が強すぎる。
3. ページは「開始」ボタン（iOS はユーザー操作必須）→ `getUserMedia({video:{facingMode:'environment',width:1280,height:720}})` →
   N 秒ごと（既定 10 s、ページ上で 5–60 s 選択、Control 設定からも配布）に canvas で 1280x720 JPEG（quality 0.8）を作り、
   `POST /capture/frame`（`Content-Type: image/jpeg` の生バイナリ、上限 1 MB、`X-Capture-Request: 1` と Origin 一致を要求）。
4. ゲートは JPEG を検証（`operatorInput.ts` の `image()` と同じ SOI/EOI・寸法検査を共通化）し、**メモリに最新 1 枚＋受信時刻だけ保持**
   （ディスクに書くのは生成・記録に使われたときのみ）。応答 `{ok, receivedAt, selected:boolean}` でページに「使用中/待機中」を表示。

### B-2. サーバー側の統合

- 現状の入力経路: `nativeOperator.ts` は `createOperatorInputClient()`（laptop の入力ブリッジ `TD_CONTROL_BRIDGE_URL`:8767）から
  `readState/readFrame/readPreview` を取り、`input.select` は `TSC-001/002/003/cycle/camera` のみ。live は `sourceScope:'camera:main'`、
  フレーム年齢 ±2 s を検査し、`recordTimer` が 1 s ごとに `recordFrame` でライブ記録する。
- `server/remoteCamera.ts`（新規）: `setFrame(bytes)`、`latest(): {image, sha256, width, height, receivedAtMs}|null`、`status(): 'none'|'fresh'|'stale'`。
- 入力選択: `input.select` 許可値に `remote-device` を追加。選択状態は Node 側で保持し、`remote-device` 中は
  `readState`/`readFrame`/`readPreview` を laptop ブリッジではなく `remoteCamera` から返す合成クライアントで包む（laptop 側は無変更）。
- Control の INPUT セレクタ（`server/tdControl/index.html` / `control.mjs`）: 「Test replay（TSC-001/002/003/cycle）／Live camera（laptop）／Remote device」の 3 系統。
  `input-detail` に「Remote device · 最終受信 7 s 前」や「STALE」を表示。プレビューは既存 `/api/td-control/input-preview` が最新リモートフレームを返す。
- 生成時の NOW: `sourceParams={source:'live-camera',inputKind:'live-camera',sourceScope:'camera:remote',capturedAt:<受信時刻>}`、
  `suggestedCaptureId=remote-<ms>-<sha8>`。`operatorGeneration.ts`・`operatorInput.ts` の `camera:main` 固定検査、`captureEvents.ts` の
  `sourceScope` 判定、`browserOutputRecordings.ts` の `validRecordingScope` に `camera:remote` を追加。
- 鮮度: laptop の 2 s 制限とは別に **remote は 30 s（`REMOTE_CAMERA_STALE_SEC`）**。超えたら生成に使わず（timer/chain はスキップして理由を表示）、
  Control と `/api/health` に `remoteCamera: {state:'stale', ageSec}` を出す。同じフレームで 2 回生成しない（既存 `lastFrameKey` と同じ扱い）。
- 記録: ライブ扱い（`test` なし、`recordHistory:true`）→ 会場履歴・サマリーに書かれ、TD にも通知される。記録フレームは受信ごとに 1 枚（重複は除外）。
  **今日のテストループ問題との関係**: リモート選択のまま放置すると、スマホの映像（机の上・ポケットの中など）が本番履歴を汚す。
  そのため (a) stale 時は生成しない、(b) Control に「Remote device はライブ記録されます」と明示、(c) 実装中の動作確認は `/api/generate` に
  `test:true` を付けた別経路で行い、本番選択は人が Control で切り替えたときだけ、とする。人物ルール（直近に部屋にいた人のみ）の
  presence 判定にもリモート映像が入る点に注意（スマホが別の場所を映すと「最近いた人」がずれる）。

### B-3. スマホ側の注意

- 画面消灯でカメラが止まる → Screen Wake Lock API（`navigator.wakeLock.request('screen')`、iOS Safari 16.4+/Android Chrome 対応、`visibilitychange` で再取得）。
  非対応時は「自動ロックをオフに」と表示。充電しながら固定設置を推奨。
- バックグラウンドタブ・別アプリ切替でカメラ停止・タイマー間引き → ページに最終送信時刻を大きく表示、復帰時に自動再開、サーバー側は stale で検知。
- 帯域: 1 枚 約 100–200 KB × 6 枚/分 ＝ **約 0.6–1.2 MB/分（約 40–70 MB/時）**。モバイル回線なら 20–30 s 間隔も選べるように。
- カメラ許可: Android Chrome はオリジン単位で記憶。iOS Safari は毎回聞かれがち（設定 → Safari → カメラ →「許可」で軽減）。
- iOS の癖: `<video playsinline muted autoplay>` 必須、開始はタップ起点、`facingMode` 指定が効かない機種あり（切替ボタンを用意）、
  ImageCapture API は使わず canvas `drawImage` で取る、縦持ちだと 720x1280 になるので横向き固定を案内（または中央クロップで 16:9 にそろえる）。
- `/m` の「自分」タブの再利用: 現状は **getUserMedia ではなく `<input type=file capture=environment>` の単発撮影**、`shrink()`（長辺 1280・JPEG 0.9）、
  `POST /api/mobile/generate`（data URL、スマホ専用レーン・会場履歴なし・24 h で自動削除）。再利用できるのは `shrink()` の縮小処理と
  JPEG 検証の考え方程度。違い: 連続送信・毎回生成しない・会場ライブ入力になる・保存しない。`/m` 自体は公開しない（tailnet 専用のまま）。

## C. セキュリティ・チェックリストと実装計画

### C-1. チェックリスト

- [ ] :3000 は絶対に Funnel しない。公開リスナーは `127.0.0.1:3443` のみ bind。
- [ ] 許可リスト外は 404、GET/HEAD 以外は 405（ログインと `/capture/frame` のみ例外）、クエリ付きは 400、`..`/`%2e`/`\`/二重エンコードを拒否。
- [ ] cookie は HMAC 署名・期限付き・HttpOnly/Secure/SameSite=Strict、閲覧（view）と入力（capture）でロール分離。
- [ ] レート制限（IP 5 回/10 分＋全体 30 回/10 分）、`/capture/frame` は 1 cookie あたり 1 枚/3 s・1 MB 上限。
- [ ] 秘密は `.env.local` のみ（gitignore 済み）。ログ・応答・チャットに出さない。
- [ ] 転送時に Host 書き換え、Cookie/Authorization/X-Forwarded-* を落とす。応答の Set-Cookie も落とす。
- [ ] 公開しないもの: Control 本体・mapping・history、設定変更 API、生成 API、`/m` とスマホ API、`/logs` とイベント API、health、
  サムネイル、`latest*.json`・`prediction_data.md`・サブディレクトリ、Vite 開発資産、TouchDesigner stream/control API。

### C-2. 追加・変更ファイル

| ファイル | 内容 |
|---|---|
| `server/publicGate/index.ts`（新規） | 第 2 Express アプリ、許可リスト、転送、ヘッダー |
| `server/publicGate/auth.ts`（新規） | scrypt 照合、cookie 署名/検証、レート制限 |
| `server/publicGate/login.html`, `capture.html`, `capture.mjs`（新規） | ログイン画面、撮影ページ（Wake Lock・間隔設定・状態表示） |
| `server/remoteCamera.ts`（新規） | 最新フレーム保持・鮮度判定 |
| `server.ts` | `PUBLIC_OUTPUT_PASSWORD` があるときだけゲート起動、remoteCamera を nativeOperator に注入 |
| `server/nativeOperator.ts`, `operatorInput.ts`, `operatorGeneration.ts` | `remote-device` 選択、合成入力クライアント、`camera:remote` |
| `server/events/captureEvents.ts`, `browserOutputRecordings.ts`, `server/health/routes.ts` | スコープ追加、health 表示 |
| `server/tdControl/index.html`, `control.mjs` | INPUT 3 系統、STALE 表示、capture 用 QR 表示 |
| `scripts/public-output-secret.mjs`, `scripts/show-public-password.ps1`（新規） | 秘密生成（無出力）、ユーザー端末での表示 |

### C-3. テスト

- 許可リスト: 列挙した各 URL が 200、近い偽物（`/control/`、`/control/mapping`、`/display-assets/screen.test.mjs`、`/captures/latest.json`、
  `/captures/qa_flagged/x.png`、`/api/td-control/state`、`/api/generate`、`/m`、`%2e%2e`、クエリ付き、POST）がすべて拒否。
- 認証: cookie なし→ /login、改ざん・期限切れ・view で capture → 拒否、レート制限発動、ログに入力値が出ない。
- remoteCamera: 不正 JPEG/過大/頻度超過の拒否、30 s で stale、stale 時に生成しない、同一フレームで二重生成しない、`camera:remote` が記録に載る。
- 実ネットワーク不要（ゲートをテスト用ポートで起動し、下流は既存テストのモックサーバー）。

### C-4. 工数と順序

工数目安: ゲート＋認証 0.5–1 日、リモートカメラ（ページ＋入力統合＋Control）1–1.5 日、テスト込みで計 2–3 日。

1. 実装（ゲート → remoteCamera → Control）
2. テスト（`npm test` 全通過、上記ケース追加）
3. laptop へ通知（INPUT の選択肢追加と `camera:remote` スコープを TD/laptop 側に周知。laptop ブリッジ自体は無変更）
4. サーバー再起動（ゲートは 127.0.0.1:3443 で起動するが、まだ外部公開なし）
5. ユーザーが `.env.local`（または `show-public-password.ps1`）でパスワードを確認し、メイン PC のブラウザで `http://127.0.0.1:3443/login` から動作確認
   （Secure cookie は localhost では Chrome が許可する）
6. **ユーザーの確認後に、ユーザー本人が `tailscale funnel --bg 3443` を実行**。停止は `tailscale funnel --bg off`。

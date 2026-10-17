> 2026-10-12: この文書はTDとサーバーの接続手順。現在の全体方針は MULTI-PC-ARCHITECTURE.md を優先する。ノートはOllamaとTDを兼任でき、状況認識用の第三のPCは任意。スマホ出力は別途開発する。

# 2台構成のセットアップ（ノートPC = TouchDesigner、デスクトップ = サーバー + ComfyUI）

何もしなければ今まで通りの1台構成（全部 127.0.0.1）のまま動く。2台にするときだけ、下の設定を入れる。

```
ノートPC: TD + カメラ + 表示
   │  ① HTTP POST /api/generate （TCP 3000）
   ▼
デスクトップ: Node サーバー :3000 + ComfyUI
   │  ② UDP 9989 で TD に通知（capture.saved など。画像は URL つき）
   ▼
ノートPC: TD が ③ http://デスクトップ:3000/captures/… から画像を読む
```

## 1. デスクトップ（サーバー側）

`.env.local` に足す（IP はデスクトップの LAN の IP。`ipconfig` の IPv4。Tailscale なら 100.x.x.x）:

```
PUBLIC_BASE_URL=http://192.168.0.10:3000
```

- `PUBLIC_BASE_URL`: UDP で TD に送る画像 URL の土台。省略時は `http://127.0.0.1:3000`。
- `TOUCHDESIGNER_UDP_HOST` / `TOUCHDESIGNER_UDP_PORT`（既定 127.0.0.1 / 9989）: 通知の既定の送り先。
  **ノートPC側から「こちらへ返して」と頼むので、通常は設定不要。** ノートPC側が頼まないで常に別のPCに送りたいときだけ、ノートPCの IP を入れる。
- サーバーを再起動すると反映される（再起動は展示を止めてよいときに）。起動ログに `Public base URL for image links: …` が出る。
- 別PCのキャプチャ宛先は、キャプチャごとにログに出る: `TouchDesigner notify target for capture …: udp://<ノートPCのIP>:9989`。

仕組み: ノートPC の TD が `/api/generate` に `notifyToSender: true` を付けて呼ぶ → サーバーは「そのリクエストの送信元アドレス」へ、その撮影の UDP（started / saved / completed など）をすべて送る。
`Notifyhost` に IP を書くと、送信元ではなくその IP に送る（VPN や NAT で送信元が合わないとき用）。
`usage.updated`（料金表示）は、既定の送り先と、最近キャプチャを送ったノートPCの両方に送る。

## 2. ノートPC（TouchDesigner 側）

1. 一度だけ、パラメータのページを作る（TD の Textport）:
   `op('/project1/td_native_capture').module.install_network_parameters()`
   これで `/project1` に **Network** ページができる（何度実行してもよい）。
2. 値を入れる:

| パラメータ | 2台のとき | 1台のとき（既定） |
|---|---|---|
| `Serverurl` | `http://192.168.0.10:3000`（デスクトップの IP） | `http://127.0.0.1:3000` |
| `Imagesource` | `url` | `file` |
| `Notifyhost` | 空のまま（自動）。うまくいかなければノートPC自身の IP | 空 |

3. UDP In（`/project1` の `udpin1`）の受信ポートは 9989。**`Local Address` が空 or 0.0.0.0（全てのネットワーク）になっているか確認**。127.0.0.1 になっていると他のPCからの通知を受け取れない。
4. `td_capture_listener.py` / `td_native_capture.py` は DAT とファイル同期している。このリポジトリを更新したら、TD 側の DAT が最新になっているか確認（同期の仕方は HANDOVER.md）。

## 3. ファイアウォール（開けるポート）

- デスクトップ: **TCP 3000 の受信**（ノートPC からの API と画像取得）。
  管理者 PowerShell: `New-NetFirewallRule -DisplayName "SpecMem server 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private`
- ノートPC: **UDP 9989 の受信**（サーバーからの通知）。
  `New-NetFirewallRule -DisplayName "SpecMem TD udp 9989" -Direction Inbound -Protocol UDP -LocalPort 9989 -Action Allow -Profile Private`
- ネットワークの種類が「パブリック」だとブロックされやすい。「プライベート」にするか、上のルールの `-Profile` を合わせる。

## 4. ノートPC から試す（課金なし）

```
curl http://192.168.0.10:3000/api/usage
curl -I http://192.168.0.10:3000/captures/latest.json
```
どちらも 200 が返れば、ノートPC → デスクトップの経路は OK。
画像: `curl -I http://192.168.0.10:3000/captures/<最近のファイル名>.png` も 200 になること。
UDP（デスクトップ → ノートPC）の確認は、ノートPC で TD の Textport か DAT の受信ログを見ながら、**手動キャプチャ 1 回だけ**撮る（課金される。回数は必ず管理すること）。
`/api/generate` を curl で直接叩くと Gemini と ComfyUI が動いて課金されるので、テストではやらない。

## 5. Tailscale を使うとき

手順は同じ。IP を Tailscale の IP（100.x.x.x、`tailscale ip -4`）に置き換えるだけ:
`PUBLIC_BASE_URL=http://100.x.x.x:3000`、TD の `Serverurl=http://100.x.x.x:3000`。
Tailscale の経路は、Windows ファイアウォールでは「プライベート」ではなく別扱いになることがある。ブロックされるときはルールの `-Profile Any` にするか、`-RemoteAddress 100.64.0.0/10` で許可する。
`Notifyhost` は空（自動）のままでよい。送信元が Tailscale の IP として見える。

## 6. 1台構成に戻す

- ノートPC（またはこの1台）の TD: `Serverurl` = `http://127.0.0.1:3000`、`Imagesource` = `file`、`Notifyhost` 空。
- デスクトップの `.env.local` から `PUBLIC_BASE_URL` を消す（残しても、`file` のときは影響しない）。再起動は不要（URL は添えるだけで、1台のときは使われない）。

## 7. 注意と未確認

- Movie File In TOP は http の画像 URL を読める（`predownloadhttp` が既定オンで、ダウンロードしてから表示）。画像のファイル名は撮影ごとに時刻入りで変わるので、キャッシュ対策の `?v=` は付けていない。同じ URL を繰り返し読み直す使い方をするなら、クエリで URL を変えること。
- 回線が遅いと、画像が届く前に表示が切り替わる可能性がある。2台での実機確認はまだ（実機の手順は HANDOVER の改良ログ参照）。
- `latest.json` / `latest_scenes.json` / `prediction_data.md` は `Cache-Control: no-store` で配信する。

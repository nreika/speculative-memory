# ノートPCへの引き継ぎ（このファイルだけでも開始できる）

更新: 2026-10-12。

## いま分かっていること

- このノートには Tailscale と Ollama が導入済み（ユーザー申告）。再インストールから始めない。
- ノートは状況認識・シナリオ作成を担当する。TD・カメラ・外部4画面の役割と同居可能。外部4画面への独立出力はユーザー確認済み。
- 画像生成、ComfyUI、Nodeサーバー、保存・配信の共通基盤はメインのデスクトップに置く。
- 出力は4画面に固定しない。スマホ用表示を今後追加する。
- ユーザー実行結果: RTX 4060 Laptop GPU、8188 MiB。Qwen3-VL 4Bが導入済みとの申告（正確なタグは担当が照合）。Tailscale IPは受領済みで、公開資料には記載しない。
- OllamaとTDの同時実行が重ければ、状況認識を別ノートに分離する。

## ノート側の作業担当へ渡す文

```text
Speculative Memory のノート側の準備を引き継いでください。
このノートには Tailscale と Ollama が既に入っています。GPUはRTX 4060 Laptop、
8188 MiB、モデルはQwen3-VL 4Bとの申告です。導入済みの正確なタグと接続を担当自身で確認してください。
このノートは Ollama + Qwen3-VL の状況認識・シナリオ作成を担当し、
TouchDesigner・カメラ・外部4画面出力も同居させる想定です。
外部4画面への独立出力は確認済みです。重ければ状況認識を別ノートに分けます。
画像生成・ComfyUI・Nodeサーバー・保存配信はメインのデスクトップが担当します。
出力先には今後スマホ版も加えます。
GitHubの最新資料がまだ届いていなくても、環境確認と必要なローカルモデルの準備は進められます。
リポジトリがあればAGENTS.md、docs/HANDOVER.md、docs/MULTI-PC-ARCHITECTURE.md、
docs/LAPTOP-OLLAMA.mdを読んでください。古い二台/三台の説明より、この役割分担が優先です。
モデル本体・APIキー・写真・ログはGitHubに入れないでください。
撮影や推論テストは実行前に確認し、停止中のタイマーは再開しないでください。
料金を毎回報告する必要はありません。日本語で簡潔に、PowerShellを優先してください。
一項目ずつコマンドの手入力や結果のコピーをユーザーに求めず、まとめて調査・設定し、結果を報告してください。
```

## 作業担当がまとめて確認する

以下は作業担当用。ユーザーへ一つずつ実行を依頼しない。表示のみで推論は実行しない。

```powershell
ollama list
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
tailscale ip -4
```

コマンドが見つからない場合の代替パスも含めて確認するには、同梱スクリプトを使う。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\inspect-laptop.ps1
```

GitHubから取得した場合は `scripts\inspect-laptop.ps1` にある。
結果の共有は作業チャットで行い、公開リポジトリに端末情報を記録しない。

## GitHubから取得する段階

メインPC側で対象ブランチがプッシュされたあと、新しい保存先で実行する。

```powershell
git clone --branch feat/capture-modes-gguf --single-branch https://github.com/nreika/speculative-memory.git
Set-Location .\speculative-memory
git log -1 --oneline
```

同名フォルダが既にある場合は上書きせず、そこで `git status --short` とブランチを確認してから更新方法を判断する。
Ollamaの実行だけならNode依存関係のインストールは不要。リポジトリは手順・コード確認のために取得する。

## 準備の完了条件

1. GPU/VRAM、モデル名、ノートのTailscale IPv4が分かる。
2. Ollamaの `/api/tags` をノート自身とメインPCから取得できる。
3. 承認後の画像1枚の認識テストで回答・所要時間・GPU使用を確認する。
4. TDと同時使用した際の表示を確認する（TD未導入なら後段）。

推論前の設定・疎通は `LAPTOP-OLLAMA.md`。メインPCのサーバー設定と生成再開はメインPC側で行う。

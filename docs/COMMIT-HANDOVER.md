# メインPCからGitHubへ引き継ぐ

更新: 2026-10-12。実行するのはユーザー。エージェントはコミット・プッシュしていない。
対象: `feat/capture-modes-gguf`、origin は `https://github.com/nreika/speculative-memory.git`。

## 今回の範囲

`HANDOVER-COMMIT-FILES.txt` の明示したファイルだけを対象にする。既存の未コミットのサーバー・プロンプト・TD Python変更を含む。今回新たに作ったものは引き継ぎ資料と読み取り専用のノート確認スクリプト。

含めない: `.env.local`、写真、ログ、モデル、node_modules、TDの`.toe`とそのバックアップ、9月版起動スクリプト。TDバイナリの変更・削除は作業ツリーに残す。`.toe`に保存された最新の画面配置はこのコミットだけではノートへ移らないため、TD側の移行時に別途確認する。

古いGit履歴全体の公開可否を今回のチェックだけで保証しない。特に別ブランチ・stashの録画データを公開しない。`--all` や `--mirror` は使わない。

## 1. ステージする前の確認

PowerShellでリポジトリへ移動し、このブロックを実行する。想定外のブランチや既存のステージ済み変更があれば止まる。

```powershell
Set-Location 'C:\Users\nmrei\GitHub\speculative-memory_0905'
$ErrorActionPreference = 'Stop'
$gitOptions = @('-c', 'maintenance.auto=false', '-c', 'gc.auto=0')
$branch = git @gitOptions branch --show-current
if ($LASTEXITCODE -ne 0 -or $branch -ne 'feat/capture-modes-gguf') { throw '対象ブランチが違います。' }
$alreadyStaged = @(git @gitOptions diff --cached --name-only)
if ($LASTEXITCODE -ne 0 -or $alreadyStaged.Count -gt 0) { throw '先に既存のステージ済み変更を確認してください。' }
$handoverFiles = @(Get-Content -LiteralPath 'docs\HANDOVER-COMMIT-FILES.txt' | Where-Object { $_.Trim() })
foreach ($itemPath in $handoverFiles) {
    if (-not (Test-Path -LiteralPath $itemPath -PathType Leaf)) { throw "対象ファイルがありません: $itemPath" }
}
git @gitOptions status --short
git @gitOptions add -- @handoverFiles
if ($LASTEXITCODE -ne 0) { throw 'git add に失敗しました。' }
git @gitOptions diff --cached --check
if ($LASTEXITCODE -ne 0) { throw '差分を確認してください。' }
git @gitOptions diff --cached --stat
git @gitOptions diff --cached --name-only
```

表示された対象ファイルと内容を確認してから、次へ進む。差分は `git diff --cached` で読める。

## 2. コミット（ユーザー実行）

```powershell
git -c maintenance.auto=false -c gc.auto=0 commit -F docs/HANDOVER-COMMIT-MSG.txt
git -c maintenance.auto=false -c gc.auto=0 log -1 --stat
git -c maintenance.auto=false -c gc.auto=0 status --short
```

`.toe`やバックアップ等が未コミットとして残るのは意図した状態。

## 3. 対象ブランチだけプッシュ（ユーザー実行）

```powershell
git -c maintenance.auto=false -c gc.auto=0 push -u origin feat/capture-modes-gguf
```

拒否された場合はforce pushせず理由を確認する。成功後にノートで `LAPTOP-HANDOFF.md` のclone手順を使う。

## 検証結果と再確認コマンド

2026-10-13: think=false の回帰テストを含め単体テスト54件と型チェックを確認。生成APIや本番サービスは動かしていない。
コードが変わっていなければ繰り返す必要はない。

```powershell
& .\node_modules\.bin\tsc.cmd --noEmit -p .
if ($LASTEXITCODE -ne 0) { throw '型チェック失敗' }
$testFiles = @(Get-ChildItem -Path 'services\*.test.ts','server\network\*.test.ts','server\generation\*.test.ts','server\usage\*.test.ts' -File | ForEach-Object { $_.FullName })
& .\node_modules\.bin\tsx.cmd --test @testFiles
if ($LASTEXITCODE -ne 0) { throw 'テスト失敗' }
```

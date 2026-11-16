# 引継ぎメモ②: josiahsound (下麻 / ひらがじゃん)

GitHub: https://github.com/NoctepKates/josiahsound (main)

最初の引継ぎメモ(卓の3D化・`.tile-wrap`・ヘッドレス描画の話)の続きです。
**このメモ → 最初のメモ → GitHubの実物のコード** の順に読んでください。

---

## 0. 最初に読むこと(作業のしかた・事故の履歴)

### 0-1. 成果物の渡し方
- ユーザーの希望: **変更したファイルだけ**を渡す(リポジトリ全体のzipは渡さない)。
- 私(AI)にGitHubへの書き込み権限は無い。`/mnt/user-data/outputs/` に、リポジトリと同じパス構成
  (`public/css/game.css` など)で変更ファイルだけ置き、`present_files` で渡す。

### 0-2. 毎回やること
1. 作業の最初に `curl -sL https://codeload.github.com/NoctepKates/josiahsound/tar.gz/refs/heads/main | tar xz` で最新を取り直す。
2. CSSを触ったら `{` と `}` の数を数える。JSは `node --check`。TSは `npm install` → `npx tsc --noEmit`。
3. 見た目は必ずヘッドレスブラウザで描画して目で確認する(§6)。

### 0-3. 起きた事故(同じことを繰り返さないこと)
- **ユーザーは手元で編集し、コミット/プッシュしていないことがある。** GitHubの版を土台に作ったファイルを
  渡すと、手元の未コミット変更を上書きして消してしまう。実際に起きたこと:
  - `.action-bar`(リーチ/ツモのボタン)の位置指定CSS、`.dev-wall-*`(山を見る)のCSS、手牌の左揃え
    などが、いつのまにか無くなった。(どの版のCSSにも定義が残っていなかった。)
  - 逆に、**私が前回渡したCSSがGitHubにまだ入っていない状態で、別のファイルだけ渡したため、
    前回分が抜けたCSSを渡してしまい**、「ボタンが押せない」不具合を作った。
- 対策: ①渡す前に「前回までの未反映の変更が、今回の土台に入っているか」を確認する(特定の
  セレクタ名を grep)。入っていなければ入れ直す。②渡すときに「手元の未コミット変更を確認してから
  上書きしてください」と一言添える。③大きな変更のあとは、変更ファイルを全部まとめて渡す。
- 今も **CSSが定義されていないクラス** が残っている(元から無い。必要なら作る):
  `dealer-mark` `dev-badge` `dev-bar` `result-overlay` `result-card` `word-list` `word-chip` `han-fu`
  (和了結果の画面などで使われている。見た目が崩れていると言われたら、まずここを疑う。)

---

## 1. これまでの変更の一覧(時系列ではなく領域別)

### 1-1. 牌の見た目(3D・色・厚み) — `public/css/game.css`, `public/js/table.js`(`tileHtml`)

**色**
- 卓の緑: 中央から外へ `#1f7a5e → #17614a → #0f4636`(明るくした)。
- 牌の裏・側面の「緑」は紺色系に。裏面は `--tile-back`(ユーザーが手元で `#5077b9` に変更済み)、
  側面は `--tile-side-green` / `--tile-side-white`(`#fff`)。
- 表向きの牌(`.tile`)は面本体を `#ffffff`、縁は薄い灰色(ユーザー側で一時 `#ffffff` にしている版あり)。
  文字色は変えていない。2D牌の影も無彩色にした。

**厚み・角丸・側面**
- 厚みは `:root` の `--tile-depth`(ユーザー手元で値が変わりうる。一時 24px → その後 16px を確認)。
  河の牌だけ `.river .tile3d` で 12px。鳴き牌は `:root` の値を継承。
- **側面は「平らな4枚」をやめ、表面・裏面と同じ形(同じ幅・高さ・角丸)の板を厚みの間に14枚重ねる方式**。
  `tileHtml` が `<div class="tile-face tile-s tile-sb|tile-sf" style="--i:N">` を14個出す
  (`--i` は1..14、`translateZ(depth*(i/15-0.5))`、奥側7枚=紺、表側7枚=白)。
  理由: 平らな側面+角の折れ線近似では、角丸と側面が合わず隙間・はみ出しが出た。
- `--tile-r: 5px`(`:root`)で、表面・裏面・側面の角丸半径を統一。
- 牌が卓に「沈む」問題の根本原因2つ:
  1. 寝かせた牌の `translateZ` は **厚みの半分** にしないと下側が卓にめり込む。
  2. **`.tile.small` は `--tile-depth: 6px` を持つため、表面だけ厚みを6pxと解釈して奥に3pxずれた。**
     `.tile3d > .tile-front.tile { --tile-depth: inherit; }` で解消。

**卓の遠近法**
- `.table-wrap` に `perspective` **プロパティ**を使うと卓自身が台形にならない。
  `transform: perspective(1200px) rotateX(26deg) translateY(-60px)` にして、卓・牌・河・コンパスを
  同じ射影に乗せた(左右・奥の席の並びが斜めに見える)。

**自分の手牌(平面表示)**
- 手牌は卓の射影から切り離して、卓の外の `.self-hand-layer`(`position: fixed`)に置く。
  位置は `table.js` の `positionSelfHand()` が、卓の手前中央の目印 `#selfHandAnchor` の画面座標から決める
  (resize / scroll / 描画のたびに呼ぶ)。
- 表面は歪ませず、**見える側面は「上側の帯」(`.tile-top`)だけ**。下・左右・裏・重ね板は
  `.self-hand-layer ... { display: none !important }`。選択時は `:has()` でタイル全体を `translateY(-11px)`。
- `.self-hand-layer` は `pointer-events: none` だが、中の手牌・手牌行・ボタンは
  `pointer-events: auto` にする必要がある(忘れると、牌を選んだ状態での再クリックで捨てられなくなる)。
- 手牌は**左揃え**: `.hand-row { justify-content: flex-start; min-width: 14牌ぶん+ツモ牌の間隔14px }`。
  (中央揃えだと、ツモ・打牌のたびに全部の牌が半枚動く。)
- ツモ牌は常に一番右に置く(`moveDrawnTileToEnd`)。再読み込み直後に牌種順で並んだ中にツモ牌が
  入ると、間隔14pxのぶん後ろの牌がずれて見えた。自分でドラッグして途中に入れた場合は戻さない
  (`drawnTileManuallyPlaced`)。
- リーチ/ツモのボタン(`#actionBar`)は `table.html` で `.self-hand-layer` の中、手牌行の上に置く。
  CSSは手牌の右端にそろえ(`align-self: flex-end`)、手牌の64px上(`margin-bottom: 64px`)、
  `position: relative; z-index: 60`。

### 1-2. 鳴いた単語(`.meld-layer-*` / `.meld-row`) — `table.html`, `table.js`, `game.css`
- 各プレイヤーの鳴き牌は、卓と同じ大きさの透明な層 `.meld-layer-{self,r1,r2,r3}` を卓の中心で
  回転(0/-90/180/90度)させ、その中の右下に置く(4人とも同じCSSで済む)。
- 並びは横一列。**新しく鳴いた単語ほど既存の単語の左**(`flex-direction: row-reverse`)。右端固定。
- サイズは4人とも同じ 40x56(`.meld-row` に `--tile-w`/`--river-tile-h`)。
- 単語は文字順に並べ直す(`meldDisplayTiles`)。サーバーの `m.tiles` は「鳴いた牌, 手牌から出した牌…」の順。
  鳴いた牌は単語中で最初に同じ文字の牌を `called` にして**時計回りに90度**(`.meld-called`)。
  箱の縦横を入れ替えて、他の牌がずれる。
- 四隅の名前タグ(アバター付き)と重ならないよう、`.meld-row { right: 64px; bottom: 64px; }`。
- 各単語を包む `div` に `transform-style: preserve-3d` が必要(無いと3Dが潰れて平らになる)。

### 1-3. 判定ロジック(和了・テンパイ・リーチ) — `src/mahjong/*`, `src/GameRoom.ts`, `src/index.ts`, `public/debug/hand.html`
- 判定の定義は **`src/mahjong/analysis.ts` の冒頭コメントに集約**:
  - 和了 = 14枚が辞書の単語だけで過不足なく分解できる
  - テンパイ = 13枚に1種類足すと和了(待ち牌が1つ以上)
  - リーチ可能 = 14枚のうち1枚切るとテンパイ
- `words.ts` に `findWaits(hand13)` / `findRiichiDiscards(hand14)` を追加。`isTenpai` と
  `canDeclareRiichiHand` はこれに寄せた。`analysis.ts`(`analyzeHand`)が和了の全分解・役・点数・待ち牌ごとの
  分析を返す。
- `GameRoom.ts`: `computeRiichiDiscards(seat)` / `computeCanRiichi` / `computeCanTsumo` に一本化。
  `state` に `riichiDiscards` を載せる。**リーチ宣言は、切ればテンパイになる牌だけ**(サーバーで検証し、
  違えば `{type:'notice'}` を返す。クライアントも `riichiDiscards` で事前に弾く)。
- 辞書の更新: 以前は部屋の最初の1回しかD1から読まず、失敗すると空のままだった。
  `refreshDict()` を追加し、`ensureLoaded` で空なら必ず読み直し、`startHand` のたびに読み直す。
- `yaku.ts` のバグ修正: **成立した役が全部2回数えられていた**(filter結果にさらにpush)。上位役が
  下位役を消す処理の取りこぼしも直した。→ 以前より点数が下がる手がある。
- `score.ts`: `baseHanBreakdown` の型が役満 `'y'` を許さずtscエラーだったので修正。
- `/debug/hand`(`public/debug/hand.html` + `src/index.ts` の `/api/debug/hand-check`): 13枚・14枚とも
  「和了/テンパイ/リーチ可能」を同じ定義で表示。役の分析(リーチ・一発・親・ツモ/ロン・ドラ枚数を
  条件欄で変更)、和了分解ごとの単語・飜・符・点数、13枚なら待ち牌ごとの分析、14枚なら
  切る牌ごとの待ち牌。
- 手元で `seed_words.sql` の辞書を使って検証した結果、判定関数・`GameRoom` の判定は正しかった
  (辞書の単語から作った手400通りで漏れ0件)。**「実戦でリーチ/ツモできない」の本当の原因は、ボタンが
  画面外に出ていたこと**だった(§1-1 のボタン位置を参照)。

### 1-4. 対局画面の表示(局・本場・供託・コンパス・アバター) — `table.html`, `table.js`, `game.css`
- **局の表示**: 左上の「第n局(n本場)」は削除。コンパス中央の残り枚数の上に「東n局」
  (`roundLabel(s)`: 通算の `round` と `rules.playerCount` から場風と局数を計算。4人なら東1〜東4の次が南1)。
  残り枚数の数字は小さく(`scale(0.62)`)。
- **供託・本場**: 左上のドラ枠の下に「[1000点棒] x 供託本数」「[100点棒] x 本場数」
  (`renderStickCounts`)。点棒アイコンはCSS(`.stick-1000` は赤い丸、`.stick-100` は黒い点4つ)。
- **コンパス**: 各プレイヤーの帯(`.cell-*`)をコンパスの辺いっぱいに広げ、中身 `.cc-inner`(横長の箱)を
  帯の中心で回転(自分0 / 左の席 +90 / 向かい 180 / 右の席 -90)。箱の中で、風は左端、点数は中央のまま
  少し中心寄り(16px)、リーチ棒置き場 `.riichi-slot` はその外側。
- **リーチ棒のアニメーション**: `prevRiichi` で false→true の瞬間だけ `flyRiichiStick(divKey)`。
  画面外から回転しながら飛んできて、置き場に収まる(`element.animate`、約750ms)。
  画面を開いた直後にリーチ済みの人は飛ばさない。
- **プロフィール画像**: 名前タグの上に丸い画像(`avatarHtml`)。未設定なら名前の頭文字の丸。

### 1-5. プロフィール画像・ログアウト・供託(サーバー) — `src/index.ts`, `src/GameRoom.ts`, `src/db/schema.sql`, `public/js/home.js`, `public/xiama/home.html`
- 画像は `users.avatar`(data URL)と `users.avatar_updated`。列が無ければ `ensureUserColumns()` が
  ALTER TABLE で自動追加(手動マイグレーション不要。`schema.sql` にも列を追加)。
- API: `POST /api/profile/avatar`(`{avatar: dataURL | null}`、PNG/JPEG/WebP、200,000文字まで)、
  `GET /api/avatar/:userId`(画像本体、`?v=更新時刻` 付きで長期キャッシュ)、`/api/me` に `avatarUrl`。
- `GameRoom`: `Player.avatarV`、`loadAvatarFor()`(接続時にDBから更新時刻を読み、席に記録して
  `broadcastState`)。`publicPlayerView` に `avatarUrl`。開発者モードの席(`ID#席番号`)も元ユーザーの画像。
- ホーム: プロフィール画面で画像の選択・削除(中央で正方形に切り出して128pxに縮小)。
  ログアウトは右上とプロフィール画面のボタン(`POST /api/logout` → `/login.html`)。
- **供託リーチ棒**(今まで未実装だった): リーチ宣言で持ち点から1000点を引き `riichiSticks += 1`。
  和了(ツモ/ロン)で和了者が総取り(ダブロンは先頭)、流局は持ち越し。新しい対局の開始で0。
  `state.riichiSticks` を送る。

### 1-6. 山を見る(開発者モード) — `game.css`
- `.dev-wall-*`(モーダル・牌の並び・消費済み半透明・境目の点線)のCSSを新規に作り直した。
  元のCSSは手元の未コミットだった可能性が高く、見た目は昔と違うかもしれない。

---

## 2. 主なファイルと関数(地図)

| 場所 | 内容 |
|---|---|
| `public/css/game.css` | 牌・卓・コンパス・手牌・鳴き・点棒・アバター・山の確認などのCSS(長い) |
| `public/js/table.js` | `render` `tileHtml` `renderDeadWall` `renderStickCounts` `roundLabel` `avatarHtml` `flyRiichiStick` `positionSelfHand` `meldDisplayTiles` `attachHandHandlers` `renderActionBar` `renderDevWall` |
| `public/xiama/table.html` | 卓の骨組み。`.meld-layer-*` / `#selfHandAnchor` / `.self-hand-layer`(中に `#actionBar` と自分の座席) |
| `src/GameRoom.ts` | 対局進行(Durable Object)。`computeRiichiDiscards` `computeCanTsumo` `refreshDict` `loadAvatarFor` `handleDiscard` |
| `src/mahjong/words.ts` | 単語辞書による分解・`findWaits` `findRiichiDiscards` `canWin` |
| `src/mahjong/analysis.ts` | 手牌の分析(新規) |
| `src/mahjong/yaku.ts` `score.ts` | 役・点数 |
| `src/index.ts` | 認証・フレンド・アバター・デバッグAPI・静的配信 |

---

## 3. 見た目を確認する方法(ヘッドレス描画ハーネス)
最初のメモの§4と同じ。追加でわかったこと:
- `serve_shot.mjs` は `public/` を配信し、`/api/me` `/api/room/check/*` をダミーで返す。`window.WebSocket` を
  差し替えて、偽の `state`(`type:'state'`, `rules:{playerCount}`, `round`, `honba`, `riichiSticks`, `players[]`
  (`seat username handCount discards melds riichi score avatarUrl…`), `yourHand:[{id,kind}]`,
  `yourSeat`, `currentTurnSeat`, `canTsumo`, `canRiichi`, `doraIndicators`, `wallRemaining` …)を流す。
- 拡大確認は `deviceScaleFactor` を上げ、`page.$(selector).boundingBox()` で要素を切り出す
  (`CLIP` の座標指定は表示倍率とずれやすい)。
- ヘッドレスでは `requestAnimationFrame` が描画されるまで進まないので、アニメ検証は
  `await page.evaluate("new Promise(r=>requestAnimationFrame(r))")` を挟む。
- `/debug/hand` の確認は、`/api/debug/hand-check` をテスト側で `analyzeHand` に差し替えて、
  ページ内で `hand=[...'きたざわ…']; renderHand(); renderTiles(); check();` を実行する。
- サーバーロジックは `tsx` で `GameRoom` を直接動かして検証できる(`env.DB.prepare().all()` を
  ダミー化、`room.sockets = new Map([[0, fakeWs]])` など)。

---

## 4. 未解決・未確認・今後の課題
- **実戦での通し確認がまだ**: 描画は偽のstate、判定はダミーDBでの確認。実際のD1・WebSocketでの動作は未確認。
  リーチ/ツモが出ない・再読み込みで状態が戻る現象が再発したら、ブラウザのコンソールのエラーを
  聞くこと(クリックが届かない問題とは別の原因が残っている可能性)。
- **本場の加算点(本場ぶんの点数移動)は未実装**(表示だけ)。持ち時間のカウントダウン、流局時の
  テンパイ料なども最初のメモのとおり未実装。
- リーチ後に「ツモ切りしかできない」制限は未実装。リーチ宣言の打牌がテンパイを保つかの検証はした。
- リーチ棒のアニメの着地点は、`getBoundingClientRect()`(射影後の外接矩形)から決めているので、
  遠近法の角度によっては置き場から数px外れる。着地後に本物の棒が `active` で出る。
- 牌1枚あたりのDOMが増えた(面6 + 重ね板14)。牌が多いと重い場合は、重ね板の枚数(14)を減らす
  (`tileHtml` と `.tile-s` の `/ 15`)か、河の牌だけ減らす。
- 名前の呼び方: コード上の `r1`(自分の次の席=下家)は画面の**右**、`r3` は画面の**左**。
  ユーザーは「下家(左のプレイヤー)」と呼ぶことがあるので、**画面上の位置**で依頼を解釈すること。
- CSS未定義のクラス(§0-3)。見た目の崩れの報告があれば、定義を作る。

---

## 5. ユーザーの好み・やりとりの注意
- 日本語で、結論と変更点を短くまとめる。変更ファイルだけを渡す。
- 見た目の指摘は具体的(「隙間がある」「表面が沈んでいる」など)。**原因を数値で調べて直す**と一番早い
  (computed style / `getBoundingClientRect` / 拡大スクリーンショット)。
- 「前は動いていた/こうだった」と言われたら、**自分の変更が原因とは限らず、手元の未コミットの変更が
  上書きで消えた可能性**を最初に疑い、そう伝えて確認する。

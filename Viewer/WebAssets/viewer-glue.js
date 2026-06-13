// イメージウィンドウのグルー（仕様 §4）。
// 当面は normal レイアウトのみ移設。ただし将来レイアウトを足しやすいよう
// 「レイアウト名 → 描画関数」のディスパッチ構造（layouts）を温存する（仕様 §4.2）。
(function () {
  'use strict';

  const invoke = window.invoke;
  const stage = document.getElementById('stage');
  const hintEl = document.getElementById('hint');

  // ---- 状態 ----
  const state = {
    images: [],        // [{ path, name }]
    index: 0,
    count: 1,          // 同時表示枚数（normal で 1..16, 仕様 §4.1）。当面は 1。
    readingRTL: true,  // 右→左（漫画風, 既定）
    trim: false,       // トリミング有無（layout1/2 用の派生フラグ＝trimMode!=='none'）
    trimMode: 'short', // レイアウト3のトリミング方式: none/both/vertical/horizontal/short/long
    cropPenalty: 0.6,  // トリミング抑制度（列数決定で切り取り面積をどれだけ嫌うか・大=切り取り回避）
    zoom: 1,
    panX: 0,
    panY: 0,
    rotation: 0,       // 表示の回転角（0/90/180/270・時計回り）
    endMarker: true,   // 末尾ラベル「フォルダ末尾」を表示＆サイクルに含めるか（設定で切替）
    loop: true,        // 末尾→先頭へ循環するか（設定で切替。OFF なら端で止まる）
    preload: 3,        // 表示範囲の前後を何枚先読みするか（設定で変更・0で無効）
    fullscreen: false,
  };

  // 回転を考慮した実効ウィンドウ寸法（90/270 のときは縦横を入れ替えてレイアウト→回転で画面に収まる）。
  function effDims() {
    const W = stage.clientWidth, H = stage.clientHeight;
    return (state.rotation % 180 !== 0) ? { W: H, H: W } : { W, H };
  }

  // ---- レイアウト・レジストリ（仕様 §4.2：レイアウト方式を切替可能にする） ----
  // 「レイアウト名 → 描画関数」。メニュー/設定の layout 値（layout1/layout2…）で切り替える。
  const layouts = {
    layout1: renderLayout1, // 等サイズグリッド（縦を常に充填）
    layout2: renderLayout2, // 均一高さの justified 行
    layout3: renderLayout3, // 等サイズグリッド（各画像の長尺方向を充填）
  };
  let currentLayout = 'layout3'; // レイアウトは layout3 で固定（選択 UI は排除・他レイアウトのソースは残置）

  function render() {
    const fn = layouts[currentLayout] || layouts.layout1;
    fn();
    updateTitle();
    refreshOverlayIfVisible();
    preloadAround();
  }

  // 表示範囲の前後 state.preload 枚を先読み（Image を生成して保持＝メモリに載せておく）。
  // 表示時に同じ URL の <img> が即描画できる。preload=0 で無効。
  const preloadCache = new Map(); // url -> Image（参照を保持してキャッシュさせる）
  function preloadAround() {
    const len = state.images.length;
    if (len === 0 || state.preload <= 0) return;
    const total = len + (state.endMarker ? 1 : 0);
    const wanted = new Set();
    for (let k = 1; k <= state.preload; k++) {
      const after = (((state.index + state.count - 1 + k) % total) + total) % total;
      const before = (((state.index - k) % total) + total) % total;
      for (const pos of [after, before]) {
        if (pos >= len) continue;            // 末尾ラベル位置は画像なし
        const url = srcUrl(state.images[pos]);
        wanted.add(url);
        if (!preloadCache.has(url)) {
          const img = new Image();
          img.decoding = 'async';
          img.src = url;
          preloadCache.set(url, img);
        }
      }
    }
    // キャッシュが膨らみ過ぎないよう、必要外の古いものから削除。
    const limit = Math.max(8, state.preload * 4);
    if (preloadCache.size > limit) {
      for (const key of [...preloadCache.keys()]) {
        if (preloadCache.size <= limit) break;
        if (!wanted.has(key)) preloadCache.delete(key);
      }
    }
  }

  // 通常 / 書庫内（archive_path・inner_path）両対応（仕様 §5）。
  function srcUrl(im) {
    if (im.archive_path)
      return 'https://file.viewer/raw?a=' + encodeURIComponent(im.archive_path) +
             '&i=' + encodeURIComponent(im.inner_path);
    return 'https://file.viewer/raw?p=' + encodeURIComponent(im.path);
  }

  // ---- アスペクト比キャッシュ（グリッド列数の決定に使う・仕様 §4.1） ----
  const COL_GAP = 2; // セル間(px)
  const ROW_GAP = 2; // 行間(px)
  // トリミングON（レイアウト1・3）の改行判断で「クロップ（はみ出して隠れる）面積」に掛ける罰則。
  // 大きいほど早く改行（クロップを嫌う）、小さいほど1行に詰める（クロップ許容）。0でクロップ無視。
  // ※レイアウト3は state.cropPenalty（メニューの「トリミング抑制度」）を使う。これは layout1/2 用の既定。
  const TRIM_CROP_PENALTY = 0.6;
  const aspectCache = new Map(); // key -> 幅/高さ

  // ---- レイアウト3：トリミング方式（メニューで選択）→ 各画像のセルへの収め方 ----
  // 戻り値: 'contain' | 'cover' | 'fill-width' | 'fill-height'
  //   contain     = 全体表示（切り取らない・余白可）
  //   cover       = 縦横トリミング（セルを完全に埋める）
  //   fill-width  = 幅をセルに合わせる（上下＝縦をクロップ）
  //   fill-height = 高さをセルに合わせる（左右＝横をクロップ）
  function trimTarget(mode, aspect) {
    switch (mode) {
      case 'none': return 'contain';
      case 'both': return 'cover';
      case 'vertical': return 'fill-width';    // 縦だけトリミング＝上下を切る
      case 'horizontal': return 'fill-height'; // 横だけトリミング＝左右を切る
      case 'short': return aspect <= 1 ? 'fill-height' : 'fill-width'; // 短尺を切る＝長尺を充填
      case 'long':  return aspect <= 1 ? 'fill-width' : 'fill-height'; // 長尺を切る＝短尺を充填
      default: return 'contain';
    }
  }

  // 列数決定スコア：セル(cw×ch)に平均アスペクト avgA の画像を収め方 target で入れたときの
  // 「表示面積 − 抑制度×クロップ面積」。contain は黒最小化＝表示面積最大。
  function trimCellScore(cw, ch, avgA, mode, penalty) {
    const target = trimTarget(mode, avgA);
    if (target === 'contain') {
      const dispW = Math.min(cw, ch * avgA);
      const dispH = Math.min(ch, cw / avgA);
      return dispW * dispH;
    }
    let shown, hidden;
    if (target === 'cover') {
      shown = cw * ch;
      const hAtFullW = cw / avgA;          // 幅=cw のときの高さ
      if (hAtFullW >= ch) hidden = cw * (hAtFullW - ch);       // 幅基準で覆う→上下はみ出し
      else hidden = ch * (ch * avgA - cw);                     // 高さ基準→左右はみ出し
    } else if (target === 'fill-width') {
      const dispH = cw / avgA;
      if (dispH >= ch) { shown = cw * ch; hidden = cw * (dispH - ch); } // 上下クロップ
      else { shown = cw * dispH; hidden = 0; }                          // 収まる（余白）
    } else { // fill-height
      const dispW = ch * avgA;
      if (dispW >= cw) { shown = ch * cw; hidden = ch * (dispW - cw); } // 左右クロップ
      else { shown = ch * dispW; hidden = 0; }
    }
    return shown - penalty * hidden;
  }

  // 収め方 target を実際の cell/img スタイルへ適用（セルは overflow:hidden 前提）。
  function applyTrimTarget(cell, img, target) {
    if (target === 'contain') {
      cell.style.display = '';
      img.style.width = '100%'; img.style.height = '100%';
      img.style.maxWidth = ''; img.style.maxHeight = '';
      img.style.flexShrink = ''; img.style.objectFit = 'contain';
      return;
    }
    cell.style.display = 'flex';
    cell.style.alignItems = 'center';
    cell.style.justifyContent = 'center';
    img.style.maxWidth = 'none'; img.style.maxHeight = 'none';
    img.style.flexShrink = '0';
    if (target === 'cover') {
      img.style.width = '100%'; img.style.height = '100%'; img.style.objectFit = 'cover';
    } else if (target === 'fill-width') {
      img.style.width = '100%'; img.style.height = 'auto'; img.style.objectFit = 'fill';
    } else { // fill-height
      img.style.height = '100%'; img.style.width = 'auto'; img.style.objectFit = 'fill';
    }
  }
  function aspectKey(im) { return im.archive_path ? (im.archive_path + '::' + im.inner_path) : im.path; }
  function getAspect(im) { const a = im && aspectCache.get(aspectKey(im)); return (a && a > 0) ? a : 1; }
  function setAspect(im, a) { if (im && a > 0) aspectCache.set(aspectKey(im), a); }

  // 現在表示中のセル群（img は一度だけ生成し、レイアウト時に行へ再配置する。
  // 再生成しないので img の再読込が起きない）。
  let currentCells = []; // [{ cell, img, im }]

  // ===== レイアウト1：index から count 枚を「等サイズのグリッド」で表示 =====
  // 全セルが同一サイズ（=平等）。枚数に応じて改行（複数行）し、全枚数を画面内に収める。
  // トリミング ON はセルを埋める(cover・黒を最小化)、OFF は全体表示(contain)。1枚は常に全体表示。
  function renderLayout1() {
    stage.className = 'stage' + (state.readingRTL ? ' rtl' : '') + (state.trim ? ' trim' : '');
    stage.innerHTML = '';
    currentCells = [];

    if (state.images.length === 0) { appendMarker('画像がありません'); return; }

    const layer = document.createElement('div');
    layer.id = 'zoomLayer';
    layer.style.display = 'flex';
    layer.style.flexDirection = 'column';
    layer.style.alignItems = 'center';
    layer.style.justifyContent = 'center';
    layer.style.gap = ROW_GAP + 'px';
    applyTransform(layer);
    stage.appendChild(layer);

    buildCells(layout);
    layout();
  }

  // index から count 個のセルを「画像…→末尾マーカー→最初の画像…」と循環して作る。
  // 末尾マーカー（state.endMarker 有効時）も1つのセルとして含める。重複表示は避ける（総数で打切）。
  function buildCells(relayout) {
    currentCells = [];
    const len = state.images.length;
    const total = len + (state.endMarker ? 1 : 0);
    if (total === 0) return;
    // count ぶんだけ循環生成（画像・マーカーが総数より多ければ重複して表示する）。
    for (let i = 0; i < state.count; i++) {
      const pos = (((state.index + i) % total) + total) % total;
      const cell = document.createElement('div');
      cell.className = 'cell';
      if (state.endMarker && pos === len) {
        // 末尾マーカーのセル
        const m = document.createElement('div');
        m.className = 'end-marker';
        m.textContent = 'フォルダ末尾';
        cell.appendChild(m);
        currentCells.push({ cell, img: null, im: null, marker: true });
      } else {
        const im = state.images[pos];
        const img = document.createElement('img');
        img.draggable = false;
        img.addEventListener('load', () => {
          if (img.naturalWidth > 0 && img.naturalHeight > 0) {
            setAspect(im, img.naturalWidth / img.naturalHeight);
            relayout();
          }
        });
        img.src = srcUrl(im);
        cell.appendChild(img);
        currentCells.push({ cell, img, im, marker: false });
      }
    }
  }

  function appendMarker(text) {
    const m = document.createElement('div');
    m.className = 'end-marker';
    m.textContent = text;
    stage.appendChild(m);
  }

  // マーカーセル（画像なし）の見出しを中央寄せにする。
  function markerCellStyle(cell) {
    cell.style.display = 'flex';
    cell.style.alignItems = 'center';
    cell.style.justifyContent = 'center';
  }

  function styleRow(row) {
    row.className = 'image-row';
    row.style.display = 'flex';
    row.style.flexDirection = state.readingRTL ? 'row-reverse' : 'row'; // 漫画=右→左
    row.style.alignItems = 'center';
    row.style.justifyContent = 'center';
    row.style.gap = COL_GAP + 'px';
    row.style.flexShrink = '0';
  }

  // 等サイズグリッド・レイアウト本体。
  //   - 全セルを同一サイズ（cellW×cellH）にして R 行 × C 列に並べる（=平等なサイズ）。
  //   - 列数 C は「セルのアスペクト比が画像の平均アスペクト比に近づく」よう決める
  //     （C ≒ √(枚数 × ウィンドウ縦横比 / 平均アスペクト比)）。これで漫画見開きは横2枚、
  //     枚数が増えると自動で改行してグリッドになる。
  //   - トリミング ON : object-fit cover（セルを埋める＝黒を最小化。セルは平均アスペクトに
  //     近いので切り取りは小さい）。OFF : contain（全体表示・アスペクト差は黒）。
  //   - 1 枚は常に contain（全体表示）。
  function layout() {
    const layer = document.getElementById('zoomLayer');
    if (!layer || currentCells.length === 0) return;
    const { W, H } = effDims();
    const n = currentCells.length;

    layer.innerHTML = '';

    if (n === 1) {
      const row = document.createElement('div');
      styleRow(row);
      const { cell, img, marker } = currentCells[0];
      cell.style.flex = '0 0 auto';
      cell.style.width = W + 'px';
      cell.style.height = H + 'px';
      if (marker) {
        markerCellStyle(cell);
      } else {
        // セルいっぱいに contain（ウィンドウにフィット。小さい画像も拡大、全画面で更に拡大）。
        img.style.maxWidth = ''; img.style.maxHeight = '';
        img.style.width = '100%'; img.style.height = '100%';
        img.style.flexShrink = ''; img.style.objectFit = 'contain';
      }
      row.appendChild(cell);
      layer.appendChild(row);
      return;
    }

    // 画像2枚以下はトリミングON でも切らない。
    const aspects = currentCells.map((c) => getAspect(c.im));
    const avgA = aspects.reduce((s, a) => s + a, 0) / n || 1;
    const imageCount = currentCells.reduce((s, c) => s + (c.marker ? 0 : 1), 0);
    const doTrim = state.trim && imageCount > 2;

    // 列数 C を決定。
    //  ・トリミングON：縦クロップ無しで「埋まる表示面積」を最大化（縦長は横一列に並ぶ）。
    //  ・OFF：セルのアスペクトが平均画像アスペクトに最も近い C（黒/切り取り最小）。
    let bestC = 1, bestScore = -Infinity;
    for (let C = 1; C <= n; C++) {
      const R = Math.ceil(n / C);
      const cw = (W - COL_GAP * (C - 1)) / C;
      const ch = (H - ROW_GAP * (R - 1)) / R;
      if (cw <= 0 || ch <= 0) continue;
      let score;
      if (doTrim) {
        // トリミングON（高さ充填）：表示面積−クロップで隠れる面積（λ=1）を最大化。
        // 「可視面積の最大化」だと1行に詰めて過剰クロップになるため、隠れ面積を等価に罰して
        // 適切に改行させる。
        const shown = ch * Math.min(cw, ch * avgA);
        const hidden = ch * Math.max(0, ch * avgA - cw);
        score = shown - TRIM_CROP_PENALTY * hidden;
      } else {
        // トリミングなし(contain)：全画像が同サイズ(平均アスペクト avgA)と仮定し、1枚あたりに
        // 表示される面積を最大化＝ウィンドウの非表示（黒）領域を最小化する列数を選ぶ。
        const dispW = Math.min(cw, ch * avgA);
        const dispH = Math.min(ch, cw / avgA);
        score = dispW * dispH;
      }
      if (score > bestScore) { bestScore = score; bestC = C; }
    }
    const C = bestC;
    const R = Math.ceil(n / C);
    const cellW = (W - COL_GAP * (C - 1)) / C;
    const cellH = (H - ROW_GAP * (R - 1)) / R;

    for (let r = 0; r < R; r++) {
      const row = document.createElement('div');
      styleRow(row);
      for (let cI = 0; cI < C; cI++) {
        const idx = r * C + cI;
        if (idx >= n) break;
        const { cell, img, marker } = currentCells[idx];
        cell.style.flex = '0 0 auto';
        cell.style.width = cellW + 'px';
        cell.style.height = cellH + 'px';
        cell.style.overflow = 'hidden';
        if (marker) {
          markerCellStyle(cell);
        } else if (doTrim) {
          // 縦フル：高さを満たし幅は自動。上下端まで表示し、横がセルを超えたら左右クロップ。
          // ※ .stage img の CSS（max-width/height:100%・object-fit:contain）と flex 縮小を
          //   無効化しないと contain（黒帯）に戻ってしまうため、none / flex-shrink:0 を明示。
          cell.style.display = 'flex';
          cell.style.alignItems = 'center';
          cell.style.justifyContent = 'center';
          img.style.height = '100%'; img.style.width = 'auto';
          img.style.maxWidth = 'none'; img.style.maxHeight = 'none';
          img.style.flexShrink = '0'; img.style.objectFit = 'fill';
        } else {
          // 全体表示（切り取らない）。
          cell.style.display = '';
          img.style.width = '100%'; img.style.height = '100%';
          img.style.maxWidth = ''; img.style.maxHeight = '';
          img.style.flexShrink = ''; img.style.objectFit = 'contain';
        }
        row.appendChild(cell);
      }
      layer.appendChild(row);
    }
  }

  // ===== レイアウト3：レイアウト1の派生 =====
  // 違いはトリミングON時の充填/クロップの向き。レイアウト1は「常に縦（高さ）を充填」だが、
  // レイアウト3は「その画像の長尺方向を充填・長尺方向はトリミングしない」：
  //   ・縦長画像 → 高さ充填（上下フル・左右クロップ）。
  //   ・横長画像 → 幅充填（左右フル・上下クロップ）。
  // OFF / 2枚以下 / 1枚は contain（全体表示）でレイアウト1と同じ。列数選択もレイアウト1と同じ。
  function renderLayout3() {
    stage.className = 'stage' + (state.readingRTL ? ' rtl' : '') + (state.trim ? ' trim' : '');
    stage.innerHTML = '';
    currentCells = [];

    if (state.images.length === 0) { appendMarker('画像がありません'); return; }

    const layer = document.createElement('div');
    layer.id = 'zoomLayer';
    layer.style.display = 'flex';
    layer.style.flexDirection = 'column';
    layer.style.alignItems = 'center';
    layer.style.justifyContent = 'center';
    layer.style.gap = ROW_GAP + 'px';
    applyTransform(layer);
    stage.appendChild(layer);

    buildCells(layout3);
    layout3();
  }

  function layout3() {
    const layer = document.getElementById('zoomLayer');
    if (!layer || currentCells.length === 0) return;
    const { W, H } = effDims();
    const n = currentCells.length;

    layer.innerHTML = '';

    if (n === 1) {
      const row = document.createElement('div');
      styleRow(row);
      const { cell, img, marker } = currentCells[0];
      cell.style.flex = '0 0 auto';
      cell.style.width = W + 'px';
      cell.style.height = H + 'px';
      if (marker) {
        markerCellStyle(cell);
      } else {
        img.style.maxWidth = ''; img.style.maxHeight = '';
        img.style.width = '100%'; img.style.height = '100%';
        img.style.flexShrink = ''; img.style.objectFit = 'contain';
      }
      row.appendChild(cell);
      layer.appendChild(row);
      return;
    }

    const aspects = currentCells.map((c) => getAspect(c.im));
    const avgA = aspects.reduce((s, a) => s + a, 0) / n || 1;
    const imageCount = currentCells.reduce((s, c) => s + (c.marker ? 0 : 1), 0);
    // 2枚以下はトリミングしない（従来仕様）。それ以外はメニューで選んだ方式。
    const effMode = imageCount > 2 ? state.trimMode : 'none';

    let bestC = 1, bestScore = -Infinity;
    for (let C = 1; C <= n; C++) {
      const R = Math.ceil(n / C);
      const cw = (W - COL_GAP * (C - 1)) / C;
      const ch = (H - ROW_GAP * (R - 1)) / R;
      if (cw <= 0 || ch <= 0) continue;
      // 選択中のトリミング方式での「表示面積−抑制度×クロップ面積」を最大化する列数を選ぶ。
      const score = trimCellScore(cw, ch, avgA, effMode, state.cropPenalty);
      if (score > bestScore) { bestScore = score; bestC = C; }
    }
    const C = bestC;
    const R = Math.ceil(n / C);
    const cellW = (W - COL_GAP * (C - 1)) / C;
    const cellH = (H - ROW_GAP * (R - 1)) / R;

    for (let r = 0; r < R; r++) {
      const row = document.createElement('div');
      styleRow(row);
      for (let cI = 0; cI < C; cI++) {
        const idx = r * C + cI;
        if (idx >= n) break;
        const { cell, img, im, marker } = currentCells[idx];
        cell.style.flex = '0 0 auto';
        cell.style.width = cellW + 'px';
        cell.style.height = cellH + 'px';
        cell.style.overflow = 'hidden';
        if (marker) {
          markerCellStyle(cell);
        } else {
          // 選択中のトリミング方式に従って各画像をセルへ収める。
          applyTrimTarget(cell, img, trimTarget(effMode, getAspect(im)));
        }
        row.appendChild(cell);
      }
      layer.appendChild(row);
    }
  }

  // ===== レイアウト2：均一高さの justified 行 =====
  // ルール（ユーザー定義）：
  //   ・全画像を「同じ高さ」で行に詰める（＝サイズを揃える）。行ごとに高さは変えない。
  //   ・上下はトリミングしない（画像は常に全高表示）。トリミングONのときは行を画面高
  //     いっぱい(H/R)にして、横にはみ出した分だけ左右をクロップ（全領域表示）。OFFは
  //     切り取らず画面内に収める（黒可）。
  //   ・改行は「改行すると各画像が大きくなるなら」する＝R(行数)を 1..n で試し、切り取らない
  //     共通高さが最大になる R を選ぶ。
  function renderLayout2() {
    stage.className = 'stage' + (state.readingRTL ? ' rtl' : '') + (state.trim ? ' trim' : '');
    stage.innerHTML = '';
    currentCells = [];

    if (state.images.length === 0) { appendMarker('画像がありません'); return; }

    const layer = document.createElement('div');
    layer.id = 'zoomLayer';
    layer.style.display = 'flex';
    layer.style.flexDirection = 'column';
    layer.style.alignItems = 'center';
    layer.style.justifyContent = 'center';
    layer.style.gap = ROW_GAP + 'px';
    applyTransform(layer);
    stage.appendChild(layer);

    buildCells(layout2);
    layout2();
  }

  // 等サイズグリッド＋画像ごとの左右トリミング判断。
  //   ・全ブロック同一サイズ（cellW×cellH）＝全画像できるだけ同じ大きさ。
  //   ・列数 C は「各画像の表示面積が最大になる」よう選ぶ＝縦長/横長の比率で改行可否が決まる
  //     （縦長が多い→列を増やして1行寄り、横長が多い→行が増えやすい）。
  //   ・1ブロック内の表示はトリミングON時、画像ごとに自動判断：高さを満たし(上下クロップ無し)、
  //     横がブロックを超える画像は左右クロップ／足りない画像は左右に黒（=都度判断）。OFFは全体表示。
  function layout2() {
    const layer = document.getElementById('zoomLayer');
    if (!layer || currentCells.length === 0) return;
    const { W, H } = effDims();
    const n = currentCells.length;
    layer.innerHTML = '';

    const aspects = currentCells.map((c) => getAspect(c.im));
    const avgA = aspects.reduce((s, a) => s + a, 0) / n || 1;

    // 列数 C を「各画像の表示面積が最大」になるよう選ぶ（=改行で大きくなるなら改行）。
    // 表示面積（上下クロップ無し）= cellH × min(cellW, cellH×平均アスペクト)。
    let bestC = 1, bestScore = -Infinity;
    for (let C = 1; C <= n; C++) {
      const R = Math.ceil(n / C);
      const cw = (W - COL_GAP * (C - 1)) / C;
      const ch = (H - ROW_GAP * (R - 1)) / R;
      if (cw <= 0 || ch <= 0) continue;
      const score = ch * Math.min(cw, ch * avgA);
      if (score > bestScore) { bestScore = score; bestC = C; }
    }
    const C = bestC;
    const R = Math.ceil(n / C);
    const cellW = (W - COL_GAP * (C - 1)) / C;
    const cellH = (H - ROW_GAP * (R - 1)) / R;
    // 画像が2枚以下のときはトリミングON でも切らない。
    const imageCount = currentCells.reduce((s, c) => s + (c.marker ? 0 : 1), 0);
    const doTrim = state.trim && imageCount > 2;

    for (let r = 0; r < R; r++) {
      const row = document.createElement('div');
      styleRow(row);
      for (let cI = 0; cI < C; cI++) {
        const idx = r * C + cI;
        if (idx >= n) break;
        const { cell, img, marker } = currentCells[idx];
        cell.style.flex = '0 0 auto';
        cell.style.width = cellW + 'px';
        cell.style.height = cellH + 'px';
        cell.style.overflow = 'hidden';
        cell.style.display = 'flex';
        cell.style.alignItems = 'center';
        cell.style.justifyContent = 'center';
        if (marker) {
          // 末尾マーカーのセル（画像なし・中央のテキスト）。
        } else if (doTrim) {
          // 上下は切らない：高さを満たし幅は自動。はみ出せば左右クロップ、足りなければ左右に黒。
          // CSS の max-width/height と flex 縮小を無効化しないと contain に戻るため none/0 を明示。
          img.style.height = '100%'; img.style.width = 'auto';
          img.style.maxWidth = 'none'; img.style.maxHeight = 'none';
          img.style.flexShrink = '0'; img.style.objectFit = 'fill';
        } else {
          // 全体表示（切り取らない）。
          img.style.width = ''; img.style.height = '';
          img.style.maxWidth = '100%'; img.style.maxHeight = '100%';
          img.style.flexShrink = ''; img.style.objectFit = 'contain';
        }
        row.appendChild(cell);
      }
      layer.appendChild(row);
    }
  }

  function applyTransform(layer) {
    layer.style.transformOrigin = 'center center';
    layer.style.transform =
      `translate(${state.panX}px, ${state.panY}px) rotate(${state.rotation}deg) scale(${state.zoom})`;
  }

  function refreshTransform() {
    const layer = document.getElementById('zoomLayer');
    if (layer) applyTransform(layer);
  }

  let _lastNotifiedImage = null;
  function updateTitle() {
    const cur = state.images[state.index];
    if (cur) {
      document.title = cur.path;
      invoke('set_viewer_title', { title: cur.path }).catch(() => {});
      // 表示中画像をホストへ通知（一覧での選択同期用。画像が変わったときだけ）。
      const key = (cur.archive_path ? cur.archive_path + '::' + cur.inner_path : cur.path);
      if (key !== _lastNotifiedImage) {
        _lastNotifiedImage = key;
        invoke('viewer_current_image', {
          path: cur.path || '',
          archivePath: cur.archive_path || '',
          innerPath: cur.inner_path || '',
        }).catch(() => {});
      }
    }
  }

  // ---- ナビゲーション ----
  function resetZoom() { state.zoom = 1; state.panX = 0; state.panY = 0; state.rotation = 0; }

  // 画像を 90 度回転（時計回り deg=90 / 反時計回り deg=-90）。回転後の実効寸法で再レイアウトして収める。
  function rotateBy(deg) {
    state.rotation = (((state.rotation + deg) % 360) + 360) % 360;
    reflow();           // effDims（縦横入替）で再レイアウト
    refreshTransform(); // rotate を反映
  }

  function go(delta) {
    const len = state.images.length;
    if (len === 0) return;
    // 末尾ラベル有効時は末尾ラベル(index===len)も1つの位置として扱う。
    const total = len + (state.endMarker ? 1 : 0);
    let next;
    if (state.loop) {
      // …→最後の画像→末尾ラベル→最初の画像→… と循環（先頭からの戻りも末尾ラベルへ）。
      next = (((state.index + delta) % total) + total) % total;
    } else {
      // 循環しない：端（先頭/末尾ラベル）で止まる。
      next = Math.max(0, Math.min(state.index + delta, total - 1));
    }
    if (next === state.index) return;
    state.index = next;
    resetZoom();
    render();
  }

  function setImages(images, index) {
    state.images = Array.isArray(images) ? images : [];
    state.index = Math.max(0, Math.min(index || 0, state.images.length));
    resetZoom();
    render();
  }

  // メニューバーの表示設定（レイアウト方式／表示枚数／読み方向／トリミング）を反映（仕様 §4.1/§4.2）。
  function applyViewSettings(vs) {
    if (!vs) return;
    // レイアウトは layout3 固定のため、保存値（vs.layout）では切り替えない。
    if (typeof vs.view_count === 'number') state.count = Math.max(1, Math.min(vs.view_count, 16));
    if (typeof vs.reading_rtl === 'boolean') state.readingRTL = vs.reading_rtl;
    if (typeof vs.trim_mode === 'string') state.trimMode = vs.trim_mode;
    if (typeof vs.trim === 'boolean') state.trimMode = vs.trim ? state.trimMode : 'none'; // 旧bool互換
    if (typeof vs.crop_penalty === 'number') state.cropPenalty = Math.max(0, Math.min(vs.crop_penalty, 5));
    state.trim = state.trimMode !== 'none'; // layout1/2 用の派生フラグ
    if (typeof vs.end_marker === 'boolean') state.endMarker = vs.end_marker;
    if (typeof vs.loop === 'boolean') state.loop = vs.loop;                 // 末尾→先頭の循環
    if (typeof vs.preload === 'number') state.preload = Math.max(0, Math.min(vs.preload | 0, 50)); // 前後先読み枚数
    render();
  }

  // ---- ズーム / パン ----
  // 現在表示中の画像が画面に表示される実寸（contain フィット・回転考慮）。複数枚はウィンドウ全体。
  function contentDispSize() {
    const W = stage.clientWidth, H = stage.clientHeight;
    if (currentCells.length === 1 && !currentCells[0].marker) {
      let a = getAspect(currentCells[0].im);          // 画像の幅/高さ
      if (state.rotation % 180 !== 0) a = 1 / a;      // 90/270 は見た目のアスペクト反転
      if (a <= 0) return { w: W, h: H };
      return (W / H > a) ? { w: H * a, h: H } : { w: W, h: W / a };
    }
    return { w: W, h: H };
  }

  // パンを画像の範囲内に制限する。画像（ズーム後）がウィンドウより小さい軸は中央固定（パン 0）。
  function clampPan() {
    const W = stage.clientWidth, H = stage.clientHeight;
    const { w, h } = contentDispSize();
    const maxX = Math.max(0, (w * state.zoom - W) / 2);
    const maxY = Math.max(0, (h * state.zoom - H) / 2);
    state.panX = Math.min(maxX, Math.max(-maxX, state.panX));
    state.panY = Math.min(maxY, Math.max(-maxY, state.panY));
  }

  function zoomBy(factor) {
    state.zoom = Math.max(0.1, Math.min(state.zoom * factor, 20));
    clampPan();
    refreshTransform();
  }

  let dragging = false, lastX = 0, lastY = 0;
  stage.addEventListener('mousedown', (e) => {
    const D = window.ShortcutDispatch;
    if (D && D.dispatchMouse(CAT, e, 'down')) { e.preventDefault(); return; } // Shift+左=閉じる, Ctrl+中=リセット 等
    if (e.button !== 0) return;
    dragging = true; lastX = e.clientX; lastY = e.clientY;
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    state.panX += e.clientX - lastX;
    state.panY += e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    clampPan(); // 画像外（黒地）が見える位置まではドラッグさせない／小さい時は中央固定
    refreshTransform();
  });
  window.addEventListener('mouseup', () => { dragging = false; });

  // ウィンドウ/フルスクリーンでサイズが変わったらレイアウトを再計算（画像は再読込しない）。
  function reflow() {
    if (currentLayout === 'layout2') layout2();
    else if (currentLayout === 'layout3') layout3();
    else layout();
    clampPan();        // サイズ変化に合わせてパンを制限し直す
    refreshTransform();
  }
  window.addEventListener('resize', reflow);

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const D = window.ShortcutDispatch;
    if (D && D.dispatchMouse(CAT, e, 'wheel')) return; // ホイール=前後, Ctrl+ホイール=ズーム
  }, { passive: false });

  // ダブルクリック（例：全画面切替）。mousedown の単発とは別に dblclick を拾う。
  stage.addEventListener('dblclick', (e) => {
    const D = window.ShortcutDispatch;
    if (D && D.dispatchMouse(CAT, e, 'dblclick')) e.preventDefault();
  });

  // ---- マウスジェスチャー（右ボタンドラッグ・元viewer互換。仕様 §8） ----
  // 右ドラッグを4方向に量子化（連続重複は畳む）して "→←" 等の文字列を作り、カタログへ
  // dispatchGesture する。設定ウィンドウの「マウスジェスチャー」列の割り当てを反映。
  let gDrawing = false, gLast = null, gDirs = [], gJustPerformed = false;
  const GESTURE_SAMPLE = 18;
  stage.addEventListener('mousedown', (e) => {
    if (e.button !== 2) return; // 右ボタンのみ
    gDrawing = true; gDirs = []; gJustPerformed = false;
    gLast = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener('mousemove', (e) => {
    if (!gDrawing) return;
    const dx = e.clientX - gLast.x, dy = e.clientY - gLast.y;
    if (Math.hypot(dx, dy) < GESTURE_SAMPLE) return;
    const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? '→' : '←') : (dy > 0 ? '↓' : '↑');
    if (gDirs.length === 0 || gDirs[gDirs.length - 1] !== dir) gDirs.push(dir);
    gLast = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button !== 2 || !gDrawing) return;
    gDrawing = false;
    const str = gDirs.join(''); gDirs = [];
    if (!str) return; // ただの右クリックはジェスチャーにしない
    const D = window.ShortcutDispatch;
    if (D && D.isLoaded() && D.dispatchGesture('画像ウィンドウ', str)) gJustPerformed = true;
  });
  // ジェスチャー直後のコンテキストメニューを抑止。
  window.addEventListener('contextmenu', (e) => { if (gJustPerformed) { e.preventDefault(); gJustPerformed = false; } });

  // ---- フルスクリーン ----
  function toggleFullscreen() {
    state.fullscreen = !state.fullscreen;
    invoke('toggle_fullscreen', { fullscreen: state.fullscreen }).catch(() => {});
  }

  // ---- 現在画像・削除/コピー・表示枚数 ----
  function currentImage() { return state.images[state.index]; }
  function detailsArgs() {
    const im = currentImage();
    if (!im) return null;
    return im.archive_path ? { archivePath: im.archive_path, innerPath: im.inner_path } : { path: im.path };
  }
  function changeCount(d) {
    const next = Math.max(1, Math.min(state.count + d, 16));
    if (next === state.count) return;
    state.count = next;
    invoke('set_view_count', { count: state.count }).catch(() => {}); // 永続化
    render();
  }

  // ---- オーバーレイ操作（右上＝表示枚数± / 左上＝表示メニュー）。マウス移動時のみ表示 ----
  const countControls = document.getElementById('countControls');
  const layoutBtn = document.getElementById('layoutBtn');
  const layoutMenu = document.getElementById('layoutMenu');
  let controlsHideTimer = null;
  function revealControls() {
    if (countControls) countControls.classList.add('show');
    if (layoutBtn) layoutBtn.classList.add('show');
    clearTimeout(controlsHideTimer);
    controlsHideTimer = setTimeout(() => {
      if (layoutMenu && !layoutMenu.classList.contains('hidden')) return; // メニュー展開中は隠さない
      if (countControls) countControls.classList.remove('show');
      if (layoutBtn) layoutBtn.classList.remove('show');
    }, 2200);
  }
  window.addEventListener('mousemove', revealControls);

  // 表示枚数 ±
  if (countControls) {
    document.getElementById('countInc').addEventListener('click', (e) => { e.stopPropagation(); changeCount(1); revealControls(); });
    document.getElementById('countDec').addEventListener('click', (e) => { e.stopPropagation(); changeCount(-1); revealControls(); });
  }

  // 表示メニュー（読み方向 / トリミング方式 / トリミング抑制度）
  const cropPenaltyRange = document.getElementById('cropPenaltyRange');
  const cropPenaltyVal = document.getElementById('cropPenaltyVal');
  function updateLayoutMenu() {
    if (!layoutMenu) return;
    layoutMenu.querySelectorAll('.lm-item').forEach((el) => {
      const act = el.dataset.act;
      let on = false;
      if (act === 'layout') on = el.dataset.val === currentLayout;
      else if (act === 'rtl') on = (el.dataset.val === 'rtl') === state.readingRTL;
      else if (act === 'trimmode') on = el.dataset.val === state.trimMode;
      el.classList.toggle('active', on);
    });
    if (cropPenaltyRange) cropPenaltyRange.value = state.cropPenalty;
    if (cropPenaltyVal) cropPenaltyVal.textContent = Number(state.cropPenalty).toFixed(1);
  }
  if (layoutBtn && layoutMenu) {
    layoutBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willShow = layoutMenu.classList.contains('hidden');
      layoutMenu.classList.toggle('hidden');
      if (willShow) updateLayoutMenu();
      revealControls();
    });
    layoutMenu.addEventListener('click', (e) => {
      const it = e.target.closest('.lm-item');
      if (!it) return;
      const act = it.dataset.act;
      if (act === 'layout') {
        currentLayout = it.dataset.val;
        invoke('set_layout', { mode: currentLayout }).catch(() => {});
        render();
      } else if (act === 'rtl') {
        state.readingRTL = it.dataset.val === 'rtl';
        invoke('set_reading_rtl', { rtl: state.readingRTL }).catch(() => {});
        render();
      } else if (act === 'trimmode') {
        state.trimMode = it.dataset.val;
        state.trim = state.trimMode !== 'none'; // layout1/2 用の派生フラグ
        invoke('set_trim_mode', { mode: state.trimMode }).catch(() => {});
        render();
      }
      updateLayoutMenu(); // 続けて調整できるようメニューは開いたまま
    });
    // トリミング抑制度スライダー（live 反映・保存）。
    if (cropPenaltyRange) {
      cropPenaltyRange.addEventListener('input', () => {
        state.cropPenalty = parseFloat(cropPenaltyRange.value) || 0;
        if (cropPenaltyVal) cropPenaltyVal.textContent = state.cropPenalty.toFixed(1);
        invoke('set_crop_penalty', { value: state.cropPenalty }).catch(() => {});
        reflow(); // 列数の再計算（軽量）。レイアウトのみ更新。
      });
      // スライダー操作でメニューが閉じないように。
      cropPenaltyRange.addEventListener('mousedown', (e) => e.stopPropagation());
    }
    // 外側クリックでメニューを閉じる。
    window.addEventListener('mousedown', (e) => {
      const t = e.target;
      if (!t.closest || (!t.closest('#layoutMenu') && !t.closest('#layoutBtn')))
        layoutMenu.classList.add('hidden');
    });
  }
  function deleteCurrent() {
    const im = currentImage();
    if (!im || im.archive_path) return; // 書庫内は削除しない
    invoke('move_to_trash', { paths: [im.path] }).then(() => {
      state.images.splice(state.index, 1);
      if (state.index > state.images.length) state.index = state.images.length;
      resetZoom(); render();
    }).catch(() => {});
  }
  function copyCurrent() {
    const im = currentImage();
    if (!im || im.archive_path) return;
    invoke('copy_files_to_clipboard', { paths: [im.path], cut: false }).catch(() => {});
  }

  // ---- ショートカット（流用・仕様 §8。カテゴリ「画像ウィンドウ」） ----
  const CAT = '画像ウィンドウ';
  if (window.ShortcutDispatch) {
    ShortcutDispatch.registerAll({
      'viewer.prev_image': () => go(-1),
      'viewer.next_image': () => go(1),
      'viewer.slide_forward': () => go(1),
      'viewer.slide_backward': () => go(-1),
      'viewer.increase_count': () => changeCount(1),
      'viewer.decrease_count': () => changeCount(-1),
      'viewer.toggle_fullscreen': () => toggleFullscreen(),
      'viewer.exit_fullscreen': () => { if (state.fullscreen) toggleFullscreen(); else invoke('close_viewer').catch(() => {}); },
      'viewer.close': () => invoke('close_viewer').catch(() => {}),
      'viewer.delete': () => deleteCurrent(),
      'viewer.copy': () => copyCurrent(),
      'viewer.zoom_in': () => zoomBy(1.1),
      'viewer.zoom_out': () => zoomBy(1 / 1.1),
      'viewer.zoom_reset': () => { resetZoom(); refreshTransform(); },
      'viewer.toggle_overlay': () => toggleOverlay(),
      'viewer.rotate_right': () => rotateBy(90),
      'viewer.rotate_left': () => rotateBy(-90),
    });
    ShortcutDispatch.load().catch(() => {});
  }

  window.addEventListener('keydown', (e) => {
    const D = window.ShortcutDispatch;
    if (D && D.dispatchKey(CAT, e)) { e.preventDefault(); return; }
    // カタログ外の補助キー（詳細ペイン開閉はカタログ viewer.toggle_overlay で扱う）
    switch (e.key) {
      case 'Home': e.preventDefault(); state.index = 0; resetZoom(); render(); break;
      case 'End': e.preventDefault(); state.index = Math.max(0, state.images.length - 1); resetZoom(); render(); break;
      case 'PageDown': e.preventDefault(); go(state.count); break;
      case 'PageUp': e.preventDefault(); go(-state.count); break;
      case '0': e.preventDefault(); resetZoom(); refreshTransform(); break;
    }
  });

  // ---- 詳細オーバーレイ（仕様 §4.3。D キーでトグル） ----
  const overlayEl = document.getElementById('overlay');
  let overlayVisible = false;
  function toggleOverlay() {
    overlayVisible = !overlayVisible;
    overlayEl.classList.toggle('hidden', !overlayVisible);
    if (overlayVisible) updateOverlay();
  }
  function refreshOverlayIfVisible() { if (overlayVisible) updateOverlay(); }
  async function updateOverlay() {
    const im = currentImage();
    if (!im) { overlayEl.innerHTML = '<div class="row">画像なし</div>'; return; }
    const name = im.name || (im.path || '').split(/[\\/]/).pop();
    let md = null;
    try { md = await invoke('get_image_details', detailsArgs()); } catch {}
    overlayEl.innerHTML = renderDetails(name, md);
  }
  function ovRow(k, v) { return '<div class="row"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + '</span></div>'; }
  function renderDetails(name, md) {
    const parts = ['<div class="name">' + esc(name) + '</div>'];
    if (md) {
      if (md.has_ai_data) {
        if (md.generator) parts.push(ovRow('生成元', md.generator));
        if (md.model) parts.push(ovRow('モデル', md.model));
      }
      parts.push(ovRow('形式', md.format));
      if (md.width && md.height) parts.push(ovRow('画像サイズ', md.width + ' × ' + md.height));
      if (md.has_ai_data) {
        if (md.positive) parts.push('<div class="section">プロンプト</div><div class="prompt">' + esc(md.positive) + '</div>');
        if (md.negative) parts.push('<div class="section">ネガティブ</div><div class="prompt neg">' + esc(md.negative) + '</div>');
        const ps = md.parameters || {};
        const keys = Object.keys(ps).filter((k) => k !== 'Model' && k !== 'Generator');
        if (keys.length) {
          parts.push('<div class="section">生成パラメータ</div><div class="grid">');
          for (const k of keys) parts.push('<div class="pk">' + esc(k) + '</div><div class="pv">' + esc(ps[k]) + '</div>');
          parts.push('</div>');
        }
      }
    }
    return parts.join('');
  }
  function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  // ---- ホストからの通知 ----
  const ev = window.__TAURI__ && window.__TAURI__.event;
  if (ev) {
    ev.listen('load_images', (e) => {
      const p = e && e.payload;
      if (p) { applyViewSettings(p); setImages(p.images, p.index); }
    });
    // 一覧で別画像を選択した等（将来）。
    ev.listen('navigate-to-image', (e) => {
      const p = e && e.payload;
      if (p && typeof p.index === 'number') { state.index = p.index; resetZoom(); render(); }
    });
    // メニューバーで表示設定が変わったら反映。
    ev.listen('view_settings_changed', (e) => applyViewSettings(e && e.payload));

    // 全画面切替などウィンドウサイズ変更後の明示的な再レイアウト（resize イベントが
    // 確実に発火しないケースの保険）。直後＋次フレームの2回、新しいサイズで再フィットする。
    ev.listen('relayout', () => { reflow(); requestAnimationFrame(reflow); });

    // 一覧の画像集合に追従する（タグフィルター変更／フォルダー更新で画像が増減した等・
    // 仕様 §4.5/§7）。ファイル一覧が画像リストの真実源。書庫表示中は無視。**同じフォルダーの
    // 更新のみ受け入れ**、一覧が別フォルダーへ移動した通知では現在の表示を維持する。
    // 現在画像が残っていればその位置を維持、消えた場合のみインデックスをクランプ。
    ev.listen('filter_images_changed', (e) => {
      const p = e && e.payload;
      if (!p || !Array.isArray(p.paths)) return;
      const cur = currentImage();
      if (cur && cur.archive_path) return;          // 書庫表示中は無関係
      const curDir = cur ? dirOf(cur.path) : null;
      const newDir = p.paths.length ? dirOf(p.paths[0]) : curDir;
      if (curDir && newDir && curDir.toLowerCase() !== newDir.toLowerCase()) return; // 別フォルダーは無視
      const curPath = cur ? cur.path : null;
      const images = p.paths.map((path) => ({ path, name: (path.split(/[\\/]/).pop() || '') }));
      let idx = curPath ? images.findIndex((im) => im.path === curPath) : -1;
      if (idx < 0) idx = Math.min(state.index, Math.max(0, images.length - 1));
      setImages(images, idx);
    });
  }

  function dirOf(p) {
    const i = Math.max((p || '').lastIndexOf('\\'), (p || '').lastIndexOf('/'));
    return i < 0 ? '' : p.slice(0, i);
  }

  // ---- 起動：ホストへ初期データを要求 ----
  invoke('viewer_ready')
    .then((data) => { if (data) { applyViewSettings(data); setImages(data.images, data.index); } })
    .catch(() => {});
})();

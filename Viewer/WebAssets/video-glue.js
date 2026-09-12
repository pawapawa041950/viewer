// 動画ウィンドウ（video.html）のグルー（仕様 §4 の画像ウィンドウを踏襲した簡易版）。
// 中央に <video>（アスペクト比維持でフィット・自前コントロール）、右側に詳細ペイン。
// ズーム/回転/複数表示/送りは無し。メタデータ表示は画像と同じ get_image_details。
(() => {
  'use strict';
  const invoke = window.invoke;
  const vid = document.getElementById('vid');
  const errBox = document.getElementById('errBox');
  const openExternal = document.getElementById('openExternal');
  const overlayEl = document.getElementById('overlay');
  const overlayResizer = document.getElementById('overlayResizer');
  const sideBtns = document.getElementById('sideBtns');
  const detailBtn = document.getElementById('detailBtn');
  const loopBtn = document.getElementById('loopBtn');
  const contBtn = document.getElementById('contBtn');
  const abBtn = document.getElementById('abBtn');
  const hintEl = document.getElementById('hint');
  const stage = document.getElementById('stage');
  // 自前コントロール
  const controls = document.getElementById('controls');
  const seekEl = document.getElementById('seek');
  const seekPlayed = document.getElementById('seekPlayed');
  const seekBuffered = document.getElementById('seekBuffered');
  const seekThumb = document.getElementById('seekThumb');
  const seekTip = document.getElementById('seekTip');
  const abRange = document.getElementById('abRange');
  const abMarkA = document.getElementById('abMarkA');
  const abMarkB = document.getElementById('abMarkB');
  const playBtn = document.getElementById('playBtn');
  const playIcon = document.getElementById('playIcon');
  const timeLabel = document.getElementById('timeLabel');
  const muteBtn = document.getElementById('muteBtn');
  const volIcon = document.getElementById('volIcon');
  const volRange = document.getElementById('volRange');
  const rateBtn = document.getElementById('rateBtn');
  const rateMenu = document.getElementById('rateMenu');
  const fsBtn = document.getElementById('fsBtn');
  const fsIcon = document.getElementById('fsIcon');

  let current = null;    // { path }
  let seekSeconds = 5;   // 矢印キーのシーク秒数（設定・仕様 §9）
  // 連続再生用プレイリスト（ファイル一覧ペインの表示順＝ソート・タグフィルター適用後）。
  // 一覧側の更新（ソート変更・フォルダー更新）に video_list_changed で追従する。
  let playlist = [];
  // 再生モード（独立した 2 つの On/Off。組み合わせで挙動が決まる。詳細は setPlayMode 付近）
  let loopOn = true;
  let contOn = false;

  // ホストからの設定を反映（video_ready の初期値 / video_settings_changed のライブ変更）。
  function applySettings(s, initial) {
    if (!s) return;
    if (typeof s.seek_seconds === 'number' && s.seek_seconds > 0) seekSeconds = s.seek_seconds;
    vid.autoplay = s.autoplay !== false;
    if (initial) {
      setPlayMode(!!s.loop_default, false);
      if (typeof s.volume === 'number') vid.volume = Math.max(0, Math.min(1, s.volume));
      vid.muted = !!s.muted;
    }
  }

  // 一時表示ヒント（音量・再生速度などのフィードバック）。
  let hintTimer = null;
  function showHint(text) {
    hintEl.textContent = text;
    hintEl.classList.add('show');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => hintEl.classList.remove('show'), 1200);
  }

  function baseName(p) { return (p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop(); }
  // 動画本体の配信 URL（t 無し＝ホストが Range 対応でストリーミング配信する）。
  function srcUrl(p) { return 'https://file.viewer/raw?p=' + encodeURIComponent(p); }

  function load(path, paths) {
    if (Array.isArray(paths)) playlist = paths;
    current = { path };
    errBox.classList.add('hidden');
    vid.classList.remove('hidden');
    clearAb(); // A-B 区間は動画ごとの情報なので切替時に解除（ループ設定は維持）
    vid.src = srcUrl(path);
    setPreviewSrc(srcUrl(path));
    seekBuffered.style.width = '0%';
    updateProgress();
    revealUi();
    invoke('set_video_title', { title: baseName(path) }).catch(() => {});
    refreshOverlayIfVisible();
  }

  // 再生できない形式（MKV 等）は既定アプリへのフォールバックを出す。
  vid.addEventListener('error', () => {
    if (!current) return;
    errBox.classList.remove('hidden');
  });
  openExternal.addEventListener('click', () => {
    if (current) invoke('open_with_default_app', { path: current.path }).catch(() => {});
  });

  // ---- 詳細ペイン（画像ウィンドウ §4.3 踏襲。D キー / ⓘ ボタンで開閉） ----
  let overlayVisible = false;
  function toggleOverlay() {
    overlayVisible = !overlayVisible;
    overlayEl.classList.toggle('hidden', !overlayVisible);
    overlayResizer.classList.toggle('hidden', !overlayVisible);
    detailBtn.classList.toggle('active', overlayVisible);
    if (overlayVisible) updateOverlay();
  }
  function refreshOverlayIfVisible() { if (overlayVisible) updateOverlay(); }
  async function updateOverlay() {
    if (!current) { overlayEl.innerHTML = '<div class="row">動画なし</div>'; return; }
    let md = null;
    try { md = await invoke('get_image_details', { path: current.path }); } catch {}
    overlayEl.innerHTML = window.DetailsRender.render(baseName(current.path), md);
  }

  // 詳細ペインの幅をドラッグで変更（viewer-glue.js と同じ挙動）。
  (() => {
    let resizing = false;
    overlayResizer.addEventListener('mousedown', (e) => {
      resizing = true; e.preventDefault();
      document.body.style.cursor = 'ew-resize';
    });
    window.addEventListener('mousemove', (e) => {
      if (!resizing) return;
      const w = Math.max(180, Math.min(window.innerWidth * 0.7, window.innerWidth - e.clientX));
      overlayEl.style.width = w + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (!resizing) return;
      resizing = false; document.body.style.cursor = '';
    });
  })();

  // 左上ボタン群とコントロールバー：マウス移動で表示し、止まると隠す。
  // ただし「一時停止中」「コントロール上にマウスがある」「ドラッグ中」は隠さない。
  let revealTimer = null;
  let overControls = false;
  function revealUi() {
    sideBtns.classList.add('show');
    controls.classList.add('show');
    stage.classList.remove('idle');
    clearTimeout(revealTimer);
    revealTimer = setTimeout(hideUiIfIdle, 2000);
  }
  function hideUiIfIdle() {
    if (vid.paused || overControls || scrubbing || abDrag || !rateMenu.classList.contains('hidden')) { revealTimer = setTimeout(hideUiIfIdle, 1000); return; }
    sideBtns.classList.remove('show');
    controls.classList.remove('show');
    stage.classList.add('idle');
  }
  window.addEventListener('mousemove', revealUi);
  controls.addEventListener('mouseenter', () => { overControls = true; });
  controls.addEventListener('mouseleave', () => { overControls = false; });
  vid.addEventListener('pause', revealUi);
  detailBtn.addEventListener('click', toggleOverlay);

  // ---- 再生モード（ループ / 連続再生 の独立した 2 つの On/Off トグル）----
  // ループ On  / 連続 Off : 同じ動画を繰り返す（<video> の loop でギャップ最小）
  // ループ Off / 連続 On  : 再生し終わったら一覧の並び順で次の動画へ。最後の動画で停止
  // ループ On  / 連続 On  : 次の動画へ進み、最後の動画が終わったら最初の動画へ戻る
  // 両方 Off             : 単発（終端で停止）
  function setPlayMode(loop, cont) {
    loopOn = !!loop;
    contOn = !!cont;
    vid.loop = loopOn && !contOn;
    loopBtn.classList.toggle('active', loopOn);
    contBtn.classList.toggle('active', contOn);
  }
  function toggleLoop() {
    setPlayMode(!loopOn, contOn);
    showHint(loopOn ? 'ループ再生: On' : 'ループ再生: Off');
  }
  function toggleContinuous() {
    setPlayMode(loopOn, !contOn);
    showHint(contOn ? '連続再生: On' : '連続再生: Off');
  }
  loopBtn.addEventListener('click', toggleLoop);
  contBtn.addEventListener('click', toggleContinuous);

  // 連続再生：一覧の並び順で次の動画を再生する。
  // wrap=true なら末尾の次は先頭へ戻る（ループ On）。false なら末尾で終わり（何もしない）。
  function playNextInList(wrap) {
    if (playlist.length === 0) return false;
    const cur = current ? current.path : null;
    let idx = cur ? playlist.findIndex((p) => p.toLowerCase() === cur.toLowerCase()) : -1;
    let nextIdx = idx + 1; // 見つからない場合(-1)は先頭から
    if (nextIdx >= playlist.length) {
      if (!wrap) return false;
      nextIdx = 0;
    }
    const next = playlist[nextIdx];
    if (!next) return false;
    if (cur && next.toLowerCase() === cur.toLowerCase()) {
      // 一覧に 1 本しかない場合：ループ On なら頭出しして再生、Off なら停止
      if (!wrap) return false;
      vid.currentTime = 0;
      vid.play().catch(() => {});
      return true;
    }
    load(next);
    vid.play().catch(() => {});
    return true;
  }

  // ---- A-B リピート（シークバー上の ▼ マーカーで区間指定） ----
  // A-B ボタン / A キーで ON/OFF。ON にすると A=現在位置・B=末尾 でマーカーを出し、
  // ▼ をドラッグして区間を調整する。区間内は帯で表示。B 点到達で A 点へ戻る（rAF 監視）。
  let abA = null, abB = null;
  const AB_MIN_GAP = 0.2; // A と B の最小間隔（秒）
  function fmtTime(t) {
    t = Math.max(0, t || 0);
    const m = Math.floor(t / 60);
    return m + ':' + (t - m * 60).toFixed(1).padStart(4, '0');
  }
  function abActive() { return abA !== null && abB !== null; }
  function updateAbUi() {
    const on = abActive();
    abBtn.classList.toggle('active', on);
    abBtn.title = on
      ? 'A-B リピート中 ' + fmtTime(abA) + ' – ' + fmtTime(abB) + '（クリックで解除・▼ をドラッグで調整）'
      : 'A-B リピート (A)：クリックでシークバーに ▼ を出し、ドラッグで区間を設定';
    abMarkA.classList.toggle('hidden', !on);
    abMarkB.classList.toggle('hidden', !on);
    abRange.classList.toggle('hidden', !on);
    if (on) {
      const d = duration();
      const pa = d > 0 ? (abA / d) * 100 : 0;
      const pb = d > 0 ? (abB / d) * 100 : 0;
      abMarkA.style.left = pa + '%';
      abMarkB.style.left = pb + '%';
      abRange.style.left = pa + '%';
      abRange.style.width = Math.max(0, pb - pa) + '%';
    }
  }
  function clearAb() { abA = abB = null; updateAbUi(); }
  function cycleAb() {
    if (abActive()) { clearAb(); showHint('A-B 解除'); return; }
    const d = duration();
    if (!(d > 0)) return; // メタデータ未読込
    let a = vid.currentTime, b = d;
    if (b - a < 1) { a = 0; } // 末尾付近なら全体を区間にしてから調整してもらう
    abA = Math.max(0, Math.min(a, d - AB_MIN_GAP));
    abB = Math.max(abA + AB_MIN_GAP, Math.min(b, d));
    updateAbUi();
    showHint('A-B リピート：▼ をドラッグして区間を調整');
    revealUi();
  }
  abBtn.addEventListener('click', cycleAb);
  (function abTick() {
    if (abActive() && vid.currentTime >= abB) vid.currentTime = abA;
    requestAnimationFrame(abTick);
  })();
  // 終端到達時の挙動。A-B リピート中はそれを最優先（B 点が末尾付近で ended が先に来るケース）、
  // それ以外は再生モードに従う（連続再生なら一覧の次の動画へ。ループ On なら末尾から先頭へ戻る）。
  // ループ On / 連続 Off は <video>.loop が効くので ended は発生しない。
  vid.addEventListener('ended', () => {
    if (abActive()) { vid.currentTime = abA; vid.play().catch(() => {}); return; }
    if (contOn) playNextInList(loopOn);
  });

  // ▼ マーカーのドラッグ。A/B は互いを追い越せない（最小間隔を保つ）。
  let abDrag = null; // 'a' | 'b' | null
  function startAbDrag(which, e) {
    e.preventDefault(); e.stopPropagation();
    abDrag = which;
    (which === 'a' ? abMarkA : abMarkB).classList.add('dragging');
    moveAbDrag(e);
  }
  function moveAbDrag(e) {
    const d = duration();
    if (!abDrag || !(d > 0)) return;
    const t = timeAtClientX(e.clientX);
    if (abDrag === 'a') abA = Math.max(0, Math.min(t, abB - AB_MIN_GAP));
    else abB = Math.min(d, Math.max(t, abA + AB_MIN_GAP));
    updateAbUi();
    const v = abDrag === 'a' ? abA : abB;
    showSeekTip(v, (abDrag === 'a' ? 'A ' : 'B ') + fmtTime(v));
  }
  function endAbDrag() {
    if (!abDrag) return;
    (abDrag === 'a' ? abMarkA : abMarkB).classList.remove('dragging');
    abDrag = null;
    hideSeekTip();
    // 区間外にいれば A 点へ（区間再生をすぐ体感できるように）。
    if (abActive() && (vid.currentTime < abA || vid.currentTime > abB)) vid.currentTime = abA;
  }
  abMarkA.addEventListener('mousedown', (e) => startAbDrag('a', e));
  abMarkB.addEventListener('mousedown', (e) => startAbDrag('b', e));

  // ---- 自前コントロール：シークバー / 再生 / 音量 / 速度 / 全画面 ----
  function duration() { return isFinite(vid.duration) ? vid.duration : 0; }
  function fmtClock(t) {
    t = Math.max(0, Math.floor(t || 0));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
    return (h > 0 ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
  }
  function timeAtClientX(x) {
    const r = seekEl.getBoundingClientRect();
    const ratio = r.width > 0 ? (x - r.left) / r.width : 0;
    return Math.max(0, Math.min(1, ratio)) * duration();
  }
  // ---- シークバーのサムネイルプレビュー（YouTube 風） ----
  // 非表示の 2 本目の <video> を対象時刻へシークし、フレームを canvas に描いてポップアップ表示。
  // ページ(app.viewer)と動画(file.viewer)は別オリジンだが、canvas は「表示のみ」で
  // ピクセルを読み出さない（toDataURL 等をしない）ため tainted でも描画・表示できる。
  const previewVid = document.createElement('video');
  previewVid.muted = true;
  previewVid.preload = 'auto';
  previewVid.playsInline = true;
  const pvBox = document.getElementById('seekPreview');
  const pvCanvas = document.getElementById('seekPreviewCanvas');
  const pvLabel = document.getElementById('seekPreviewLabel');
  const pvCtx = pvCanvas.getContext('2d');
  const PV_W = 168; // 表示幅(px)。高さは動画のアスペクト比から算出。
  let pvReady = false, pvSeeking = false, pvWantTime = null;

  function setPreviewSrc(url) {
    pvReady = false; pvSeeking = false; pvWantTime = null;
    previewVid.src = url;
  }
  previewVid.addEventListener('loadeddata', () => { pvReady = true; });
  previewVid.addEventListener('seeked', () => {
    drawPreviewFrame();
    pvSeeking = false;
    if (pvWantTime !== null) pumpPreview();
  });
  function drawPreviewFrame() {
    const vw = previewVid.videoWidth, vh = previewVid.videoHeight;
    if (!vw || !vh) return;
    const h = Math.max(1, Math.round(PV_W * vh / vw));
    if (pvCanvas.width !== PV_W || pvCanvas.height !== h) { pvCanvas.width = PV_W; pvCanvas.height = h; }
    try { pvCtx.drawImage(previewVid, 0, 0, PV_W, h); } catch (e) { /* 一部フレームで失敗しても無視 */ }
  }
  function pumpPreview() {
    if (pvWantTime === null || !pvReady) return;
    pvSeeking = true;
    const t = pvWantTime; pvWantTime = null;
    try { previewVid.currentTime = t; } catch (e) { pvSeeking = false; }
  }
  // 対象時刻のフレームを要求（連続要求は最新だけ処理＝ドラッグ中も軽い）。preview 不可なら false。
  function requestPreview(t) {
    if (!pvReady) return false;
    pvWantTime = t;
    if (!pvSeeking) pumpPreview();
    return true;
  }
  // ポップアップの水平位置。画面外へはみ出さないよう seek バー幅でクランプする。
  function positionPreview(pct) {
    const seekW = seekEl.clientWidth || 1;
    const halfW = (pvBox.offsetWidth || PV_W + 10) / 2;
    let px = (pct / 100) * seekW;
    px = Math.max(halfW, Math.min(seekW - halfW, px));
    pvBox.style.left = px + 'px';
  }

  function showSeekTip(t, text) {
    const d = duration();
    const pct = d > 0 ? (t / d) * 100 : 0;
    const label = text || fmtClock(t);
    // サムネイルが出せるならサムネ＋ラベルを表示し、素の時刻チップは隠す。
    // 出せない（メタデータ未読込等）ときは従来の時刻チップにフォールバック。
    if (requestPreview(t)) {
      pvLabel.textContent = label;
      pvBox.classList.add('show');
      positionPreview(pct);
      seekTip.classList.remove('show');
    } else {
      seekTip.textContent = label;
      seekTip.style.left = pct + '%';
      seekTip.classList.add('show');
    }
  }
  function hideSeekTip() { seekTip.classList.remove('show'); pvBox.classList.remove('show'); }

  function updateProgress() {
    const d = duration();
    const pct = d > 0 ? (vid.currentTime / d) * 100 : 0;
    seekPlayed.style.width = pct + '%';
    seekThumb.style.left = pct + '%';
    timeLabel.textContent = fmtClock(vid.currentTime) + ' / ' + fmtClock(d);
  }
  function updateBuffered() {
    const d = duration();
    if (!(d > 0) || vid.buffered.length === 0) { seekBuffered.style.width = '0%'; return; }
    // 現在位置を含む範囲の終端（無ければ最大の終端）
    let end = 0;
    for (let i = 0; i < vid.buffered.length; i++) {
      const s0 = vid.buffered.start(i), e0 = vid.buffered.end(i);
      if (s0 <= vid.currentTime && vid.currentTime <= e0) { end = e0; break; }
      end = Math.max(end, e0);
    }
    seekBuffered.style.width = (end / d) * 100 + '%';
  }
  vid.addEventListener('timeupdate', updateProgress);
  vid.addEventListener('loadedmetadata', () => { updateProgress(); updateBuffered(); updateAbUi(); });
  vid.addEventListener('durationchange', () => { updateProgress(); updateAbUi(); });
  vid.addEventListener('progress', updateBuffered);
  vid.addEventListener('seeking', updateProgress);

  // シーク（クリック / ドラッグでスクラブ）。ホバー中は時刻ツールチップ。
  let scrubbing = false;
  let wasPlayingBeforeScrub = false;
  seekEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    scrubbing = true;
    wasPlayingBeforeScrub = !vid.paused;
    seekEl.classList.add('scrubbing');
    vid.currentTime = timeAtClientX(e.clientX);
    updateProgress();
    showSeekTip(vid.currentTime);
  });
  seekEl.addEventListener('mousemove', (e) => {
    if (scrubbing || abDrag) return;
    showSeekTip(timeAtClientX(e.clientX));
  });
  seekEl.addEventListener('mouseleave', () => { if (!scrubbing && !abDrag) hideSeekTip(); });
  window.addEventListener('mousemove', (e) => {
    if (abDrag) { moveAbDrag(e); return; }
    if (!scrubbing) return;
    vid.currentTime = timeAtClientX(e.clientX);
    updateProgress();
    showSeekTip(vid.currentTime);
  });
  window.addEventListener('mouseup', () => {
    if (abDrag) { endAbDrag(); return; }
    if (!scrubbing) return;
    scrubbing = false;
    seekEl.classList.remove('scrubbing');
    hideSeekTip();
    if (wasPlayingBeforeScrub) vid.play().catch(() => {});
  });

  // 再生 / 一時停止ボタンとアイコン同期。
  const ICON_PLAY = 'M8 5v14l11-7z';
  const ICON_PAUSE = 'M6 5h4v14H6zM14 5h4v14h-4z';
  function syncPlayIcon() { playIcon.setAttribute('d', vid.paused ? ICON_PLAY : ICON_PAUSE); }
  vid.addEventListener('play', syncPlayIcon);
  vid.addEventListener('pause', syncPlayIcon);
  playBtn.addEventListener('click', () => playPause());

  // 動画面クリック=再生/一時停止、ダブルクリック=全画面（標準コントロールの慣習を踏襲）。
  // ダブルクリック時に単クリックが 2 回走らないよう、単クリックは少し遅らせて確定する。
  let clickTimer = null;
  vid.addEventListener('click', () => {
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => playPause(), 220);
  });
  vid.addEventListener('dblclick', () => {
    clearTimeout(clickTimer);
    toggleFullscreen();
  });

  // 音量：スライダー / ミュートボタン / アイコン。
  const ICON_VOL = 'M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z';
  const ICON_VOL_LOW = 'M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4z';
  const ICON_MUTE = 'M3 9v6h4l5 5V4L7 9H3zm13.6 3l2.9-2.9-1.4-1.4-2.9 2.9-2.9-2.9-1.4 1.4 2.9 2.9-2.9 2.9 1.4 1.4 2.9-2.9 2.9 2.9 1.4-1.4z';
  function syncVolumeUi() {
    const muted = vid.muted || vid.volume === 0;
    volIcon.setAttribute('d', muted ? ICON_MUTE : vid.volume < 0.5 ? ICON_VOL_LOW : ICON_VOL);
    volRange.value = vid.muted ? 0 : vid.volume;
    muteBtn.title = (vid.muted ? 'ミュート解除' : 'ミュート') + ' (M)';
  }
  vid.addEventListener('volumechange', syncVolumeUi);
  muteBtn.addEventListener('click', () => toggleMute());
  volRange.addEventListener('input', () => {
    vid.muted = false;
    vid.volume = parseFloat(volRange.value);
  });
  // スライダーにフォーカスが残ると矢印キーがショートカットと二重に効くため、操作後に外す。
  volRange.addEventListener('mouseup', () => volRange.blur());
  volRange.addEventListener('keyup', () => volRange.blur());

  // 再生速度：ボタンクリックでドロップダウン表示（+/-/0 キーは従来どおり）。
  const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  // メニュー項目を一度だけ生成。
  RATES.forEach((r) => {
    const item = document.createElement('div');
    item.className = 'rate-item';
    item.dataset.rate = String(r);
    item.textContent = r + 'x';
    item.addEventListener('click', () => { setRate(r); closeRateMenu(); });
    rateMenu.appendChild(item);
  });
  function syncRateUi() {
    rateBtn.textContent = vid.playbackRate + 'x';
    rateMenu.querySelectorAll('.rate-item').forEach((el) => {
      el.classList.toggle('active', Math.abs(parseFloat(el.dataset.rate) - vid.playbackRate) < 1e-6);
    });
  }
  vid.addEventListener('ratechange', syncRateUi);
  function openRateMenu() { syncRateUi(); rateMenu.classList.remove('hidden'); }
  function closeRateMenu() { rateMenu.classList.add('hidden'); }
  function toggleRateMenu() { rateMenu.classList.contains('hidden') ? openRateMenu() : closeRateMenu(); }
  rateBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleRateMenu(); });
  // メニュー外クリックで閉じる（メニュー内クリックは項目側で処理）。
  document.addEventListener('mousedown', (e) => {
    if (!rateMenu.classList.contains('hidden') && !e.target.closest('.rate-wrap')) closeRateMenu();
  });

  // 全画面：stage ごと全画面にして自前コントロールも一緒に出す。
  const ICON_FS = 'M7 14H5v5h5v-2H7zm-2-4h2V7h3V5H5zm12 7h-3v2h5v-5h-2zm-3-12v2h3v3h2V5z';
  const ICON_FS_EXIT = 'M5 16h3v3h2v-5H5zm3-8H5v2h5V5H8zm6 11h2v-3h3v-2h-5zm2-11V5h-2v5h5V8z';
  document.addEventListener('fullscreenchange', () => {
    fsIcon.setAttribute('d', document.fullscreenElement ? ICON_FS_EXIT : ICON_FS);
    fsBtn.title = (document.fullscreenElement ? '全画面解除' : '全画面') + ' (F)';
  });
  fsBtn.addEventListener('click', () => toggleFullscreen());

  // ボタン類はクリックでフォーカスを奪わない（Space 等のショートカットがボタンに食われないように）。
  controls.querySelectorAll('button').forEach((b) => b.addEventListener('mousedown', (e) => e.preventDefault()));

  // ---- 再生操作（ショートカットから呼ばれるアクション群） ----
  function playPause() {
    if (vid.paused) vid.play().catch(() => {}); else vid.pause();
  }
  function seekBy(sec) {
    const max = isFinite(vid.duration) ? vid.duration : Infinity;
    vid.currentTime = Math.max(0, Math.min(max, vid.currentTime + sec));
  }
  function setVolume(v) {
    vid.muted = false;
    vid.volume = Math.max(0, Math.min(1, v));
    showHint('音量 ' + Math.round(vid.volume * 100) + '%');
  }
  function toggleMute() {
    vid.muted = !vid.muted;
    showHint(vid.muted ? 'ミュート' : 'ミュート解除');
  }
  function setRate(r) {
    vid.playbackRate = Math.max(0.25, Math.min(4, r));
    showHint('再生速度 ' + vid.playbackRate + 'x');
    syncRateUi(); // ratechange イベントに依存せず即時反映（syncRateUi は後段で定義・呼び出し時には存在）
  }
  function toggleFullscreen() {
    // stage（動画＋自前コントロール）を全画面にする。ホストがウィンドウを追随
    // （ContainsFullScreenElementChanged）。<video> 単体だとコントロールが出ない。
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else stage.requestFullscreen().catch(() => {});
  }

  // 音量・ミュートの記憶（設定 UI 無しの自動保存。連続変更はデバウンス）。
  let volSaveTimer = null;
  vid.addEventListener('volumechange', () => {
    clearTimeout(volSaveTimer);
    volSaveTimer = setTimeout(() => {
      invoke('set_video_state', { volume: vid.volume, muted: vid.muted }).catch(() => {});
    }, 500);
  });

  // ---- ショートカット（カタログ「動画ウィンドウ」・設定ウィンドウで変更可能・仕様 §8） ----
  const CAT = '動画ウィンドウ';
  if (window.ShortcutDispatch) {
    ShortcutDispatch.registerAll({
      'video.play_pause': () => playPause(),
      'video.seek_forward': () => seekBy(seekSeconds),
      'video.seek_back': () => seekBy(-seekSeconds),
      'video.volume_up': () => setVolume(vid.volume + 0.05),
      'video.volume_down': () => setVolume(vid.volume - 0.05),
      'video.toggle_mute': () => toggleMute(),
      'video.toggle_loop': () => toggleLoop(),
      'video.toggle_continuous': () => toggleContinuous(),
      'video.ab_repeat': () => cycleAb(),
      'video.speed_up': () => setRate(vid.playbackRate + 0.25),
      'video.speed_down': () => setRate(vid.playbackRate - 0.25),
      'video.speed_reset': () => setRate(1),
      'video.toggle_fullscreen': () => toggleFullscreen(),
      'video.toggle_overlay': () => toggleOverlay(),
      'video.close': () => {
        // 全画面中は閉じずに全画面解除（画像ウィンドウの exit_fullscreen と同じ流儀）。
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else invoke('close_video').catch(() => {});
      },
    });
    ShortcutDispatch.load().catch(() => {});
  }
  window.addEventListener('keydown', (e) => {
    const D = window.ShortcutDispatch;
    if (D && D.dispatchKey(CAT, e)) { e.preventDefault(); return; }
  });
  // マウス割り当て（既定はホイール=音量）。クリック/ダブルクリックは自前コントロールの
  // 動画面操作（再生トグル・全画面）と重複するため既定では割り当てない。
  stage.addEventListener('wheel', (e) => {
    const D = window.ShortcutDispatch;
    if (D && D.dispatchMouse(CAT, e, 'wheel')) e.preventDefault();
  }, { passive: false });

  // ---- ホストからの通知 ----
  const ev = window.__TAURI__ && window.__TAURI__.event;
  if (ev) {
    ev.listen('load_video', (e) => { const p = e && e.payload; if (p && p.path) load(p.path, p.paths); });
    ev.listen('video_settings_changed', (e) => applySettings(e && e.payload, false));
    // 一覧のソート変更・フォルダー更新に連続再生のプレイリストを追従させる。
    ev.listen('video_list_changed', (e) => {
      const p = e && e.payload;
      if (p && Array.isArray(p.paths)) playlist = p.paths;
    });
  }

  // 初期表示の同期（アイコン・音量・速度・コントロール表示）。
  syncPlayIcon(); syncVolumeUi(); syncRateUi(); updateProgress(); revealUi();

  // ---- 起動：ホストへ初期データ（パス＋設定）を要求 ----
  invoke('video_ready')
    .then((data) => {
      if (!data) return;
      applySettings(data, true);
      if (data.path) load(data.path, data.paths);
    })
    .catch(() => {});
})();

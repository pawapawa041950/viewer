// 動画ウィンドウ（video.html）のグルー（仕様 §4 の画像ウィンドウを踏襲した簡易版）。
// 中央に <video>（アスペクト比維持でフィット・標準コントロール）、右側に詳細ペイン。
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
  const abBtn = document.getElementById('abBtn');
  const hintEl = document.getElementById('hint');

  let current = null;    // { path }
  let seekSeconds = 5;   // 矢印キーのシーク秒数（設定・仕様 §9）
  // 連続再生用プレイリスト（ファイル一覧ペインの表示順＝ソート・タグフィルター適用後）。
  // 一覧側の更新（ソート変更・フォルダー更新）に video_list_changed で追従する。
  let playlist = [];
  // 再生モード（ループボタンで循環）: 'loop'=同じ動画を繰り返し /
  // 'continuous'=一覧の次の動画へ / 'single'=1本で停止。
  let playMode = 'loop';

  // ホストからの設定を反映（video_ready の初期値 / video_settings_changed のライブ変更）。
  function applySettings(s, initial) {
    if (!s) return;
    if (typeof s.seek_seconds === 'number' && s.seek_seconds > 0) seekSeconds = s.seek_seconds;
    vid.autoplay = s.autoplay !== false;
    if (initial) {
      setPlayMode(s.loop_default ? 'loop' : 'single');
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

  // 左上ボタン群：マウス移動時のみフェード表示（viewer と同じ振る舞い）。
  let revealTimer = null;
  window.addEventListener('mousemove', () => {
    sideBtns.classList.add('show');
    clearTimeout(revealTimer);
    revealTimer = setTimeout(() => sideBtns.classList.remove('show'), 1500);
  });
  detailBtn.addEventListener('click', toggleOverlay);

  // ---- 再生モード（ループ → 連続 → 単発 の循環）----
  // ループ  : 同じ動画を繰り返す（<video> の loop でギャップ最小）
  // 連続    : 再生し終わったらファイル一覧の並び順で次の動画へ（末尾からは先頭へ戻る）
  // 単発    : 終端で停止（何もしない）
  const MODE_UI = {
    loop:       { icon: '⟳', title: '再生モード: ループ（クリックで連続再生へ）',   cls: 'active' },
    continuous: { icon: '⏭', title: '再生モード: 連続再生（クリックで単発再生へ）', cls: 'cont' },
    single:     { icon: '❶', title: '再生モード: 単発（クリックでループへ）',       cls: '' },
  };
  function setPlayMode(mode) {
    playMode = MODE_UI[mode] ? mode : 'single';
    vid.loop = playMode === 'loop';
    const ui = MODE_UI[playMode];
    loopBtn.textContent = ui.icon;
    loopBtn.title = ui.title;
    loopBtn.classList.toggle('active', ui.cls === 'active');
    loopBtn.classList.toggle('cont', ui.cls === 'cont');
  }
  function cyclePlayMode() {
    const next = playMode === 'loop' ? 'continuous' : playMode === 'continuous' ? 'single' : 'loop';
    setPlayMode(next);
    showHint(next === 'loop' ? 'ループ再生' : next === 'continuous' ? '連続再生' : '単発再生');
  }
  // 互換名（ショートカット登録で使用）
  const toggleLoop = cyclePlayMode;
  loopBtn.addEventListener('click', cyclePlayMode);

  // 連続再生：一覧の並び順で次の動画を再生する（末尾は先頭へ戻る）。
  function playNextInList() {
    if (playlist.length === 0) return false;
    const cur = current ? current.path : null;
    let idx = cur ? playlist.findIndex((p) => p.toLowerCase() === cur.toLowerCase()) : -1;
    const next = playlist[(idx + 1) % playlist.length]; // 見つからない場合(-1)は先頭から
    if (!next || (cur && next.toLowerCase() === cur.toLowerCase() && playlist.length === 1)) return false;
    load(next);
    vid.play().catch(() => {});
    return true;
  }

  // ---- A-B リピート ----
  // ボタン/Aキーのサイクル：A 点設定 → B 点設定（同時に区間再生開始） → 解除。
  // B 点到達の監視は timeupdate（〜250ms 間隔）より精度の高い rAF で行う。
  let abA = null, abB = null;
  function fmtTime(t) {
    t = Math.max(0, t || 0);
    const m = Math.floor(t / 60);
    return m + ':' + (t - m * 60).toFixed(1).padStart(4, '0');
  }
  function updateAbUi() {
    abBtn.classList.toggle('half', abA !== null && abB === null);
    abBtn.classList.toggle('active', abA !== null && abB !== null);
    abBtn.title = abA === null
      ? 'A-B リピート (A)：クリックで A 点を設定'
      : abB === null
        ? 'A 点 ' + fmtTime(abA) + '（クリックで B 点を設定）'
        : 'A-B リピート中 ' + fmtTime(abA) + ' – ' + fmtTime(abB) + '（クリックで解除）';
  }
  function clearAb() { abA = abB = null; updateAbUi(); }
  function cycleAb() {
    if (abA === null) {
      abA = vid.currentTime;
    } else if (abB === null) {
      const t = vid.currentTime;
      if (Math.abs(t - abA) < 0.1) { abA = null; } // ほぼ同一点は設定し直し（取り消し）
      else {
        if (t < abA) { abB = abA; abA = t; } else { abB = t; } // 逆順指定は入れ替え
        vid.currentTime = abA;
        vid.play().catch(() => {});
      }
    } else {
      abA = abB = null;
    }
    updateAbUi();
  }
  abBtn.addEventListener('click', cycleAb);
  (function abTick() {
    if (abA !== null && abB !== null && vid.currentTime >= abB) vid.currentTime = abA;
    requestAnimationFrame(abTick);
  })();
  // 終端到達時の挙動。A-B リピート中はそれを最優先（B 点が末尾付近で ended が先に来るケース）、
  // それ以外は再生モードに従う（連続再生なら一覧の次の動画へ）。
  vid.addEventListener('ended', () => {
    if (abA !== null && abB !== null) { vid.currentTime = abA; vid.play().catch(() => {}); return; }
    if (playMode === 'continuous') playNextInList();
  });

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
  }
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else vid.requestFullscreen().catch(() => {}); // ホストがウィンドウを追随（ContainsFullScreenElementChanged）
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
  // マウス割り当て（既定はホイール=音量）。クリック/ダブルクリックは <video> 標準コントロールの
  // ネイティブ動作（再生トグル・全画面）と重複するため既定では割り当てない。
  document.getElementById('stage').addEventListener('wheel', (e) => {
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

  // ---- 起動：ホストへ初期データ（パス＋設定）を要求 ----
  invoke('video_ready')
    .then((data) => {
      if (!data) return;
      applySettings(data, true);
      if (data.path) load(data.path, data.paths);
    })
    .catch(() => {});
})();

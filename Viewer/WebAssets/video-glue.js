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

  let current = null; // { path }

  function baseName(p) { return (p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop(); }
  // 動画本体の配信 URL（t 無し＝ホストが Range 対応でストリーミング配信する）。
  function srcUrl(p) { return 'https://file.viewer/raw?p=' + encodeURIComponent(p); }

  function load(path) {
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

  // ---- 繰り返し再生（全体ループ）----
  function toggleLoop() {
    vid.loop = !vid.loop;
    loopBtn.classList.toggle('active', vid.loop);
  }
  loopBtn.addEventListener('click', toggleLoop);

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
  // B 点が末尾付近で ended が先に来た場合も A 点へ戻して継続。
  vid.addEventListener('ended', () => {
    if (abA !== null && abB !== null) { vid.currentTime = abA; vid.play().catch(() => {}); }
  });

  // ---- キー操作（最小限）：D=詳細ペイン / R=ループ / A=A-B / Escape=閉じる ----
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === 'd' || e.key === 'D') { e.preventDefault(); toggleOverlay(); }
    else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); toggleLoop(); }
    else if (e.key === 'a' || e.key === 'A') { e.preventDefault(); cycleAb(); }
    else if (e.key === 'Escape') {
      // <video> の全画面中は既定動作（全画面解除）に任せる。
      if (document.fullscreenElement) return;
      e.preventDefault();
      invoke('close_video').catch(() => {});
    }
  });

  // ---- ホストからの通知（ウィンドウ再利用時） ----
  const ev = window.__TAURI__ && window.__TAURI__.event;
  if (ev) ev.listen('load_video', (e) => { const p = e && e.payload; if (p && p.path) load(p.path); });

  // ---- 起動：ホストへ初期データを要求 ----
  invoke('video_ready')
    .then((data) => { if (data && data.path) load(data.path); })
    .catch(() => {});
})();

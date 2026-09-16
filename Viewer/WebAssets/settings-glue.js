// 設定ウィンドウ（ツール → 設定）。左カテゴリで全般/画像を切替、各設定は変更で即保存。
(function () {
  'use strict';
  const invoke = window.invoke;

  // ---- カテゴリ切替 ----
  const cats = Array.from(document.querySelectorAll('.cat'));
  const pages = Array.from(document.querySelectorAll('.page'));
  cats.forEach((c) => c.addEventListener('click', () => {
    const id = c.dataset.cat;
    cats.forEach((x) => x.classList.toggle('active', x === c));
    pages.forEach((p) => p.classList.toggle('hidden', p.dataset.page !== id));
  }));

  // ---- 設定の読み込み・保存 ----
  const showHidden = document.getElementById('show_hidden');
  const endMarker = document.getElementById('end_marker');
  const folderThumbs = document.getElementById('folder_thumbnails');
  const archiveThumbs = document.getElementById('archive_thumbnails');
  const defaultSortMode = document.getElementById('default_sort_mode');
  const defaultIconSize = document.getElementById('default_icon_size');
  const defaultShowUnsupported = document.getElementById('default_show_unsupported');
  const syncListSel = document.getElementById('sync_list_selection');
  const syncTreeSel = document.getElementById('sync_tree_selection');
  const showArchivesInTree = document.getElementById('show_archives_in_tree');
  const startupRadios = Array.from(document.querySelectorAll('input[name="startup_mode"]'));
  const startupFolder = document.getElementById('startup_folder');
  const pickFolder = document.getElementById('pick_folder');
  const imgCountRadios = Array.from(document.querySelectorAll('input[name="image_count_mode"]'));
  const imgCountFixed = document.getElementById('image_count_fixed');
  const loopNav = document.getElementById('loop_navigation');
  const preloadCount = document.getElementById('preload_count');
  const imgAlwaysOnTop = document.getElementById('image_window_always_on_top');
  const imgPerTab = document.getElementById('image_window_per_tab');
  const videoAutoplay = document.getElementById('video_autoplay');
  const videoLoopDefault = document.getElementById('video_loop_default');
  const videoAlwaysOnTop = document.getElementById('video_window_always_on_top');
  const videoSeekSeconds = document.getElementById('video_seek_seconds');
  const videoSeekSecondsMedium = document.getElementById('video_seek_seconds_medium');
  const videoSeekSecondsLarge = document.getElementById('video_seek_seconds_large');

  // 「決まったフォルダ」選択時だけパス入力／参照ボタンを有効化。
  function syncStartupEnabled() {
    const fixed = startupRadios.some((r) => r.checked && r.value === 'fixed');
    startupFolder.disabled = !fixed;
    pickFolder.disabled = !fixed;
    document.querySelector('[data-page="overall"] .row.indent').style.opacity = fixed ? '1' : '0.5';
  }
  // 「決まった枚数」選択時だけ枚数入力を有効化。
  function syncImgCountEnabled() {
    const fixed = imgCountRadios.some((r) => r.checked && r.value === 'fixed');
    imgCountFixed.disabled = !fixed;
    document.querySelector('[data-page="imagewin"] .row.indent').style.opacity = fixed ? '1' : '0.5';
  }

  invoke('get_settings').then((s) => {
    if (!s) return;
    showHidden.checked = !!s.show_hidden;
    endMarker.checked = !!s.end_marker;
    folderThumbs.checked = !!s.folder_thumbnails;
    archiveThumbs.checked = !!s.archive_thumbnails;
    defaultSortMode.value = s.default_sort_mode || 'name_asc';
    defaultIconSize.value = (typeof s.default_icon_size === 'number') ? s.default_icon_size : 120;
    defaultShowUnsupported.checked = s.default_show_unsupported !== false;
    syncListSel.checked = !!s.sync_list_selection;
    syncTreeSel.checked = !!s.sync_tree_selection;
    showArchivesInTree.checked = !!s.show_archives_in_tree;
    const mode = s.startup_mode || 'last';
    startupRadios.forEach((r) => { r.checked = r.value === mode; });
    startupFolder.value = s.startup_folder || '';
    syncStartupEnabled();
    const imode = s.image_count_mode || 'last';
    imgCountRadios.forEach((r) => { r.checked = r.value === imode; });
    imgCountFixed.value = s.image_count_fixed || 1;
    syncImgCountEnabled();
    loopNav.checked = !!s.loop_navigation;
    preloadCount.value = (typeof s.preload_count === 'number') ? s.preload_count : 3;
    imgAlwaysOnTop.checked = s.image_window_always_on_top !== false;
    imgPerTab.checked = !!s.image_window_per_tab;
    videoAutoplay.checked = s.video_autoplay !== false;
    videoLoopDefault.checked = !!s.video_loop_default;
    videoAlwaysOnTop.checked = s.video_window_always_on_top !== false;
    videoSeekSeconds.value = (typeof s.video_seek_seconds === 'number') ? s.video_seek_seconds : 5;
    videoSeekSecondsMedium.value = (typeof s.video_seek_seconds_medium === 'number') ? s.video_seek_seconds_medium : 13;
    videoSeekSecondsLarge.value = (typeof s.video_seek_seconds_large === 'number') ? s.video_seek_seconds_large : 58;
  }).catch(() => {});

  function bindCheckbox(el, key) {
    el.addEventListener('change', () => {
      invoke('set_setting', { key, value: el.checked }).catch(() => {});
    });
  }
  bindCheckbox(showHidden, 'show_hidden');
  bindCheckbox(endMarker, 'end_marker');
  bindCheckbox(folderThumbs, 'folder_thumbnails');
  bindCheckbox(archiveThumbs, 'archive_thumbnails');
  bindCheckbox(defaultShowUnsupported, 'default_show_unsupported');
  // 新しいタブの初期設定（並び替え／アイコンサイズ）。既存タブには影響しない。
  defaultSortMode.addEventListener('change', () => {
    invoke('set_setting', { key: 'default_sort_mode', value: defaultSortMode.value }).catch(() => {});
  });
  defaultIconSize.addEventListener('change', () => {
    let v = parseInt(defaultIconSize.value, 10);
    if (!(v >= 40)) v = 40;
    if (v > 400) v = 400;
    defaultIconSize.value = v;
    invoke('set_setting', { key: 'default_icon_size', value: v }).catch(() => {});
  });
  bindCheckbox(syncListSel, 'sync_list_selection');
  bindCheckbox(syncTreeSel, 'sync_tree_selection');
  bindCheckbox(showArchivesInTree, 'show_archives_in_tree');
  bindCheckbox(loopNav, 'loop_navigation');
  bindCheckbox(imgAlwaysOnTop, 'image_window_always_on_top');
  bindCheckbox(imgPerTab, 'image_window_per_tab');
  bindCheckbox(videoAutoplay, 'video_autoplay');
  bindCheckbox(videoLoopDefault, 'video_loop_default');
  bindCheckbox(videoAlwaysOnTop, 'video_window_always_on_top');

  // 動画のシーク秒数（少し / 普通 / 大きく）。
  function bindSeekSeconds(el, key) {
    el.addEventListener('change', () => {
      let v = parseInt(el.value, 10);
      if (!(v >= 1)) v = 1;
      if (v > 999) v = 999;
      el.value = v;
      invoke('set_setting', { key, value: v }).catch(() => {});
    });
  }
  bindSeekSeconds(videoSeekSeconds, 'video_seek_seconds');
  bindSeekSeconds(videoSeekSecondsMedium, 'video_seek_seconds_medium');
  bindSeekSeconds(videoSeekSecondsLarge, 'video_seek_seconds_large');

  // 事前読み枚数。
  preloadCount.addEventListener('change', () => {
    let v = parseInt(preloadCount.value, 10);
    if (!(v >= 0)) v = 0;
    if (v > 50) v = 50;
    preloadCount.value = v;
    invoke('set_setting', { key: 'preload_count', value: v }).catch(() => {});
  });

  // 起動フォルダのモード（ラジオ）。
  startupRadios.forEach((r) => r.addEventListener('change', () => {
    if (!r.checked) return;
    invoke('set_setting', { key: 'startup_mode', value: r.value }).catch(() => {});
    syncStartupEnabled();
  }));

  // 新規表示枚数のモード（ラジオ）。
  imgCountRadios.forEach((r) => r.addEventListener('change', () => {
    if (!r.checked) return;
    invoke('set_setting', { key: 'image_count_mode', value: r.value }).catch(() => {});
    syncImgCountEnabled();
  }));
  // 決まった枚数の値。
  imgCountFixed.addEventListener('change', () => {
    let v = parseInt(imgCountFixed.value, 10);
    if (!(v >= 1)) v = 1;
    if (v > 16) v = 16;
    imgCountFixed.value = v;
    invoke('set_setting', { key: 'image_count_fixed', value: v }).catch(() => {});
  });

  // 「決まったフォルダ」の参照ボタン → ネイティブのフォルダ選択ダイアログ。
  pickFolder.addEventListener('click', () => {
    invoke('pick_folder').then((path) => {
      if (!path) return;
      startupFolder.value = path;
      invoke('set_setting', { key: 'startup_folder', value: path }).catch(() => {});
    }).catch(() => {});
  });

  // Esc で閉じる。
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.close(); });
})();

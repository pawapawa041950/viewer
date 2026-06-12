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
  const syncListSel = document.getElementById('sync_list_selection');
  const syncTreeSel = document.getElementById('sync_tree_selection');
  const startupRadios = Array.from(document.querySelectorAll('input[name="startup_mode"]'));
  const startupFolder = document.getElementById('startup_folder');
  const pickFolder = document.getElementById('pick_folder');
  const imgCountRadios = Array.from(document.querySelectorAll('input[name="image_count_mode"]'));
  const imgCountFixed = document.getElementById('image_count_fixed');
  const loopNav = document.getElementById('loop_navigation');
  const preloadCount = document.getElementById('preload_count');

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
    syncListSel.checked = !!s.sync_list_selection;
    syncTreeSel.checked = !!s.sync_tree_selection;
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
  bindCheckbox(syncListSel, 'sync_list_selection');
  bindCheckbox(syncTreeSel, 'sync_tree_selection');
  bindCheckbox(loopNav, 'loop_navigation');

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

// ファイル一覧ペインのグルー。
// 流用モジュール file-list.js（選択/キーボード/DnD）と shortcut-dispatch.js を
// 新ホスト（C#/WebView2）の IPC（window.invoke / __TAURI__）に接続する。
// 仕様 §1.3（操作）、§3（サムネイルはキャッシュなし・ビューポート優先）、§5（書庫閲覧）。
(function () {
  'use strict';

  const invoke = window.invoke;
  const grid = document.getElementById('iconGrid');
  const headerPath = document.getElementById('headerPath');
  const spinner = document.getElementById('spinner');

  // ---- ローディング表示（遅い列挙・読み込み中） ----
  // 1 秒以上かかるときだけ表示する（一瞬で終わるフォルダーでスピナーがちらつかないように）。
  let spinnerTimer = null;
  const SPINNER_DELAY = 1000;
  function showSpinner() {
    if (spinnerTimer !== null) return;                                   // 既に予約済み
    if (spinner && !spinner.classList.contains('hidden')) return;        // 既に表示中
    spinnerTimer = setTimeout(() => {
      spinnerTimer = null;
      if (spinner) spinner.classList.remove('hidden');
    }, SPINNER_DELAY);
  }
  function hideSpinner() {
    if (spinnerTimer !== null) { clearTimeout(spinnerTimer); spinnerTimer = null; }
    if (spinner) spinner.classList.add('hidden');
  }

  // ロケーション状態。書庫内のときは currentArchive が非 null（仕様 §5）。
  let currentFolder = null;   // ディスク上のカレントフォルダー（書庫内でも保持）
  let currentArchive = null;  // 開いている書庫のフルパス（null=通常フォルダー）
  let currentInner = '';      // 書庫内パス（'' = 書庫ルート）
  let loadSeq = 0;            // 世代ガード（切替で古いロードを破棄）
  let currentSort = 'name_asc'; // ソート順（メニューバー連動・仕様 §1.4）
  let tagFilter = null;        // タグフィルター：null=無効 / Set<path>=一致パス（仕様 §7）
  let showFolderThumbs = true;  // フォルダのサムネイル表示（設定・重い場合 OFF）
  let showArchiveThumbs = true; // 圧縮ファイルのサムネイル表示（設定・重い場合 OFF）

  // ---- トースト ----
  let toastEl = null, toastTimer = null;
  function showToast(msg) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.id = 'toast'; document.body.appendChild(toastEl); }
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2000);
  }

  // ---- サムネイルのデコード目標サイズ（最大辺px）。アイコンサイズ×DPR を基準に上限つき。 ----
  // ホストはこの値で縮小デコードして配信するため、フル解像度の大画像をレンダラ側で
  // デコード/再描画せずに済み、スクロールが固まらない（仕様 §3）。
  function thumbPx() {
    const cs = getComputedStyle(document.documentElement).getPropertyValue('--icon-size');
    let px = parseInt(cs, 10) || 120;
    px = Math.round(px * (window.devicePixelRatio || 1));
    return Math.max(96, Math.min(512, px));
  }

  // ---- 画像URL（通常 / 書庫内）。一覧はサムネイル（&t=）で要求。仕様 §3/§5。 ----
  function srcUrl(file) {
    const base = file.archivePath
      ? 'https://file.viewer/raw?a=' + encodeURIComponent(file.archivePath) +
        '&i=' + encodeURIComponent(file.innerPath || file.path)
      : 'https://file.viewer/raw?p=' + encodeURIComponent(file.path);
    return base + '&t=' + thumbPx();
  }

  // ---- file-list.js 初期化（選択・キーボード・DnD を委譲） ----
  FileList.init({
    grid,
    invoke,
    getDestinationFolder: () => (currentArchive ? null : currentFolder),
    getCurrentArchive: () => currentArchive,
    onOpenImage: (path) => openImageAt(path),
    onOpenFolder: (path) => {
      if (currentArchive) { currentInner = path; loadLocation(); }
      else { loadFolder(path); invoke('host_navigated', { path }); }
    },
    onOpenArchive: (path) => { enterArchive(path); },
    onSelectionChanged: () => { invoke('selection_changed', { paths: FileList.getSelectedPaths(), archivePath: currentArchive }); },
    showToast,
    onRenamed: async () => { await loadLocation(); },
    onDeleted: () => deleteSelected(),
    onGoBack: () => goBackHistory(), // 戻る（履歴）
    onGoUp: () => goUpParent(),      // 上のフォルダーへ（親）
    // ペイン内ドロップ：フォルダー上で離したらそこへ移動（Ctrlでコピー）。書庫内は不可。
    onInternalMove: async (paths, destPath, copy) => {
      if (currentArchive) { showToast('書庫内では移動できません'); return; }
      try {
        await invoke('drop_move_files', { paths, destination: destPath, copy: !!copy });
        await loadLocation();
      } catch (e) { showToast((copy ? 'コピー' : '移動') + 'に失敗しました: ' + e); }
    },
  });

  // クリップボード（切り取り/コピー/貼り付け）。file-list.js は copy/cut/paste を
  // ホスト側に委ねているので、ここで ShortcutDispatch に登録する（仕様 §2.1/§8）。
  if (window.ShortcutDispatch) {
    ShortcutDispatch.register('filelist.copy', () => clipboardCopy(false));
    ShortcutDispatch.register('filelist.cut', () => clipboardCopy(true));
    ShortcutDispatch.register('filelist.paste', () => clipboardPaste());
    ShortcutDispatch.load().catch(() => {});
  }

  // 表示設定（アイコンサイズ・ソート）を反映。ファイル名は常に折り返し固定。
  function applyViewSettings(vs, reloadOnSortChange) {
    if (!vs) return;
    document.body.classList.add('name-wrap'); // 常に折り返し
    if (typeof vs.folder_thumbnails === 'boolean') showFolderThumbs = vs.folder_thumbnails;
    if (typeof vs.archive_thumbnails === 'boolean') showArchiveThumbs = vs.archive_thumbnails;
    if (vs.icon_size) setIconSize(vs.icon_size, false);
    if (vs.sort_mode) {
      const changed = vs.sort_mode !== currentSort;
      currentSort = vs.sort_mode;
      markSortActive();
      if (changed && reloadOnSortChange && (currentFolder || currentArchive)) loadLocation();
    }
  }
  // 起動時に現在値を取得して適用。
  invoke('get_view_settings').then((vs) => applyViewSettings(vs, false)).catch(() => {});
  // 起動時に開くフォルダ（設定「全体 → 起動時に開くフォルダ」）。none/未存在なら何もしない。
  invoke('get_startup_folder').then((p) => { if (p) loadFolder(p); }).catch(() => {});

  // ---- アドレスバーのツール（ソート選択 / アイコンサイズ調整） ----
  const sortBtn = document.getElementById('sortBtn');
  const iconSizeBtn = document.getElementById('iconSizeBtn');
  const sortPopup = document.getElementById('sortPopup');
  const iconSizePopup = document.getElementById('iconSizePopup');
  const iconSizeRange = document.getElementById('iconSizeRange');
  const iconSizeNum = document.getElementById('iconSizeNum');
  let iconSizeSaveTimer = null;

  function markSortActive() {
    sortPopup.querySelectorAll('.popup-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.sort === currentSort);
    });
  }
  function setSort(mode) {
    currentSort = mode;
    markSortActive();
    invoke('set_sort', { mode }).catch(() => {});
    if (currentFolder || currentArchive) loadLocation();
  }
  // アイコンサイズを反映。persist=true のときホストへ保存（入力中は debounce）。
  function setIconSize(px, persist) {
    px = Math.max(40, Math.min(400, Math.round(px)));
    document.documentElement.style.setProperty('--icon-size', px + 'px');
    if (iconSizeRange && iconSizeRange.value != px) iconSizeRange.value = px;
    if (iconSizeNum && iconSizeNum.value != px) iconSizeNum.value = px;
    if (persist) {
      clearTimeout(iconSizeSaveTimer);
      iconSizeSaveTimer = setTimeout(() => invoke('set_icon_size', { size: px }).catch(() => {}), 250);
    }
  }
  function togglePopup(popup) {
    const show = popup.classList.contains('hidden');
    sortPopup.classList.add('hidden');
    iconSizePopup.classList.add('hidden');
    if (show) popup.classList.remove('hidden');
  }
  if (sortBtn) {
    sortBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePopup(sortPopup); });
    sortPopup.addEventListener('click', (e) => {
      const it = e.target.closest('.popup-item');
      if (it) { setSort(it.dataset.sort); sortPopup.classList.add('hidden'); }
    });
  }
  if (iconSizeBtn) {
    iconSizeBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePopup(iconSizePopup); });
    iconSizeRange.addEventListener('input', () => setIconSize(+iconSizeRange.value, true));
    iconSizeNum.addEventListener('input', () => setIconSize(+iconSizeNum.value, true));
  }
  // 外側クリックでポップアップを閉じる。
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#sortPopup, #sortBtn')) sortPopup.classList.add('hidden');
    if (!e.target.closest('#iconSizePopup, #iconSizeBtn')) iconSizePopup.classList.add('hidden');
  });

  async function clipboardCopy(cut) {
    if (currentArchive) { showToast('書庫内ではコピー/切り取りできません'); return; }
    const paths = FileList.getSelectedPaths();
    if (paths.length === 0) return;
    try {
      await invoke('copy_files_to_clipboard', { paths, cut });
      if (cut) FileList.setCutPaths(paths); else FileList.clearCutPaths();
    } catch (e) { showToast('クリップボード操作に失敗しました: ' + e); }
  }
  async function clipboardPaste() {
    if (currentArchive) { showToast('書庫内には貼り付けできません'); return; }
    if (!currentFolder) return;
    try {
      const r = await invoke('paste_from_clipboard', { destination: currentFolder });
      FileList.clearCutPaths();
      if (r && r.count > 0) {
        showToast((r.mode === 'move' ? '移動' : 'コピー') + 'しました: ' + r.count + ' 件');
        await loadLocation();
      }
    } catch (e) { showToast('貼り付けに失敗しました: ' + e); }
  }

  function parentOf(p) {
    const norm = p.replace(/[\\/]+$/, '');
    const idx = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
    if (idx <= 2) return idx >= 0 ? norm.slice(0, idx + 1) : null; // ドライブ直下
    return norm.slice(0, idx);
  }
  function parentInner(p) {
    const norm = (p || '').replace(/[\\/]+$/, '');
    const idx = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
    return idx < 0 ? '' : norm.slice(0, idx);
  }

  // ---- ナビゲーション ----
  let history = [];   // 訪問フォルダー履歴（末尾＝現在）。戻る（履歴）用。

  function loadFolder(path, pushHistory = true) {
    if (!path) return;
    currentFolder = path;
    currentArchive = null;
    currentInner = '';
    tagFilter = null; // フォルダー切替でタグフィルター解除（仕様 §7）
    if (pushHistory && history[history.length - 1] !== path) history.push(path);
    loadLocation();
  }
  function enterArchive(path) {
    currentArchive = path;   // currentFolder は書庫の親としてそのまま保持
    currentInner = '';
    tagFilter = null;
    loadLocation();
  }
  // 仮想フォルダーの子フォルダー（ドライブ等）を一覧に表示。実フォルダーではないので
  // currentFolder は持たない（ダブルクリックで各フォルダーへ通常ナビゲートする）。
  function showFolders(folders, title) {
    loadSeq++;                 // 進行中の get_files ロードを無効化
    hideSpinner();             // list_loading で出していたスピナーを消す
    currentFolder = null; currentArchive = null; currentInner = ''; tagFilter = null;
    invoke('watch_folder', { path: '' }); // 仮想なので監視停止
    headerPath.textContent = title || '';
    grid.innerHTML = '';
    for (const f of folders) {
      const file = { path: f.path, name: f.name, is_dir: true, is_image: false, is_archive: false };
      grid.appendChild(FileList.createItem(file, {}));
    }
    FileList.clearSelection();
    invoke('selection_changed', { paths: [], archivePath: null });
  }
  // 戻る（履歴）：直前に居たフォルダーへ。書庫内は1階層戻る／書庫から出る（元アプリ準拠）。
  function goBackHistory() {
    if (currentArchive) {
      if (currentInner) { currentInner = parentInner(currentInner); loadLocation(); }
      else { currentArchive = null; currentInner = ''; loadLocation(); }
      return;
    }
    if (history.length > 1) {
      history.pop();                              // 現在地を捨てる
      const prev = history[history.length - 1];
      loadFolder(prev, false);                    // 履歴に積まずに戻る
      invoke('host_navigated', { path: prev });
    }
  }

  // 上のフォルダーへ（親）。書庫内は1階層上／書庫から出る。
  function goUpParent() {
    if (currentArchive) {
      if (currentInner) { currentInner = parentInner(currentInner); loadLocation(); }
      else { currentArchive = null; currentInner = ''; loadLocation(); }
      return;
    }
    if (!currentFolder) return;
    const parent = parentOf(currentFolder);
    if (parent) { loadFolder(parent); invoke('host_navigated', { path: parent }); }
  }

  // ---- ロケーション読み込み（通常フォルダー / 書庫内） ----
  async function loadLocation() {
    const myLoad = ++loadSeq;
    const inArchive = !!currentArchive;
    const archiveAtLoad = currentArchive;

    headerPath.textContent = inArchive
      ? (currentArchive + (currentInner ? '::' + currentInner : '::'))
      : (currentFolder || '');

    // 表示中フォルダーの監視対象をホストへ通知（仕様 §1.5）。書庫内は監視停止。
    invoke('watch_folder', { path: inArchive ? '' : (currentFolder || '') });

    showSpinner(); // 読み込み中表示（遅いフォルダーでホストはバックグラウンド列挙）

    let entries;
    try {
      entries = inArchive
        ? await invoke('get_archive_files', { archivePath: currentArchive, innerPath: currentInner })
        : await invoke('get_files', { path: currentFolder, sort: currentSort });
    } catch (e) {
      if (myLoad === loadSeq) hideSpinner();
      showToast('読み込みに失敗しました: ' + e);
      return;
    }
    if (myLoad !== loadSeq) return; // 古い結果は破棄（新しいロードがスピナーを管理）
    hideSpinner();

    grid.innerHTML = '';
    const imageItems = [];
    const archiveItems = [];
    const folderItems = [];
    for (const entry of entries) {
      // 書庫内エントリには archive コンテキストを付与（URL生成・openに使う）。
      const file = inArchive
        ? { path: entry.path, name: entry.name, is_dir: entry.is_dir, is_image: entry.is_image,
            is_archive: false, archivePath: archiveAtLoad, innerPath: entry.path }
        : entry;
      const item = FileList.createItem(file, inArchive ? { archivePath: archiveAtLoad } : {});
      grid.appendChild(item);
      if (file.is_image) imageItems.push({ item, file });
      else if (file.is_archive && !inArchive && showArchiveThumbs) archiveItems.push({ item, file });
      else if (file.is_dir && !inArchive && showFolderThumbs) folderItems.push({ item, file });
    }
    FileList.clearSelection();
    invoke('selection_changed', { paths: [], archivePath: currentArchive });

    applyTagFilterDom(); // 再構築した DOM にタグフィルターを再適用（仕様 §7）
    notifyViewerImages(); // 開いているビューワの画像リストを最新の一覧に追従（増減を反映・仕様 §4.5）
    loadThumbnails(imageItems, myLoad);
    // 圧縮ファイル＝中の1枚目、フォルダー＝直下の1枚目をサムネイル化（取得は背景・NIO）。
    loadThumbHosts(archiveItems, myLoad, 'get_archive_first_image',
      (file, inner) => 'https://file.viewer/raw?a=' + encodeURIComponent(file.path) + '&i=' + encodeURIComponent(inner));
    loadThumbHosts(folderItems, myLoad, 'get_folder_first_image',
      (file, imgPath) => 'https://file.viewer/raw?p=' + encodeURIComponent(imgPath));
  }

  // フォルダー監視(fs_changed)/F5 での差分更新（reconcile）。全消去→全再生成だとちらつき＆
  // 選択解除が起きるため、新リストと現DOMを突き合わせ、追加/削除/並べ替えだけを行う。
  // 既存アイテム（＝読込済みサムネイル）は再利用するのでフラッシュせず、選択も維持される。
  async function reconcile() {
    if (currentArchive) { loadLocation(); return; } // 書庫内は通常読み込み
    if (!currentFolder) return;
    const myLoad = ++loadSeq;

    let entries;
    try {
      entries = await invoke('get_files', { path: currentFolder, sort: currentSort });
    } catch (e) {
      return; // 失敗時は現状維持（ちらつかせない）
    }
    if (myLoad !== loadSeq) return;

    const prevSel = FileList.getSelectedPaths();

    // 現在の DOM ノードを path で引けるように。
    const existing = new Map();
    grid.querySelectorAll('.file-item').forEach((el) => existing.set(el.dataset.path, el));
    const newByPath = new Map();
    for (const e of entries) newByPath.set(e.path, e);

    // 削除：新リストに無いノードを除去。
    for (const [p, el] of existing) {
      if (!newByPath.has(p)) el.remove();
    }

    // 追加＋並べ替え：新リスト順に append（既存ノードは移動＝再読込なし、無ければ生成）。
    const imageItems = [], archiveItems = [], folderItems = [];
    for (const file of entries) {
      let item = existing.get(file.path);
      if (!item) {
        item = FileList.createItem(file, {});
        if (file.is_image) imageItems.push({ item, file });
        else if (file.is_archive && showArchiveThumbs) archiveItems.push({ item, file });
        else if (file.is_dir && showFolderThumbs) folderItems.push({ item, file });
      }
      grid.appendChild(item);
    }

    // 選択の復元：削除された項目だけ選択から外す（残りは DOM/選択集合とも維持済み）。
    const survivors = prevSel.filter((p) => newByPath.has(p));
    if (survivors.length !== prevSel.length) FileList.setSelection(survivors);

    applyTagFilterDom();
    notifyViewerImages();
    loadThumbnails(imageItems, myLoad);
    loadThumbHosts(archiveItems, myLoad, 'get_archive_first_image',
      (f, inner) => 'https://file.viewer/raw?a=' + encodeURIComponent(f.path) + '&i=' + encodeURIComponent(inner));
    loadThumbHosts(folderItems, myLoad, 'get_folder_first_image',
      (f, imgPath) => 'https://file.viewer/raw?p=' + encodeURIComponent(imgPath));
  }

  // 📦圧縮ファイル / 📁フォルダーのサムネイル（中の1枚目）をビューポート優先で読み込む（仕様 §3/§5）。
  // command で1枚目を取得（ホスト側は背景実行＝ブロックしない）、urlFn で配信URLを作って .thumb-img に設定。
  function loadThumbHosts(items, myLoad, command, urlFn) {
    if (items.length === 0) return;
    const map = new Map(items.map((x) => [x.item, x.file]));
    const observer = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const item = en.target;
        observer.unobserve(item);
        const file = map.get(item);
        if (!file) continue;
        invoke(command, { path: file.path, archivePath: file.path }).then((res) => {
          if (myLoad !== loadSeq || !res || !document.body.contains(item)) return;
          const img = item.querySelector('.thumb-img');
          if (!img) return;
          img.decoding = 'async'; // デコードをメインスレッド外へ（スクロールを固めない）
          img.addEventListener('load', () => {
            const box = img.closest('.thumb-host');
            if (box) box.classList.add('has-thumb'); // アイコンを左上へずらし、サムネイル表示
          }, { once: true });
          img.src = urlFn(file, res) + '&t=' + thumbPx(); // 縮小デコードで配信させる
        }).catch(() => {});
      }
    }, { root: grid, rootMargin: '200px' });
    for (const { item } of items) observer.observe(item);
  }

  // 開いているビューワへ、現在表示中（タグフィルター適用後・ソート順）の画像集合を通知する。
  // ビューワ側は同じフォルダーの更新のみ受け入れる（別フォルダーへ移動した一覧は無視）。
  function notifyViewerImages() {
    invoke('update_viewer_images', { paths: visibleImagePaths() }).catch(() => {});
  }

  // ---- サムネイル：キャッシュなし・ビューポート優先・並列度制御（仕様 §3） ----
  const IMAGE_CONCURRENCY = 8;
  function loadThumbnails(items, myLoad) {
    if (items.length === 0) return;
    const pending = new Map(items.map((x) => [x.file.path, x]));
    const visible = new Set();
    let active = 0;

    function loadOne({ item, file }) {
      pending.delete(file.path);
      const placeholder = item.querySelector('.file-icon.placeholder');
      if (!placeholder) return Promise.resolve();
      return new Promise((resolve) => {
        const img = new Image();
        img.className = 'file-icon';
        img.draggable = false;
        img.decoding = 'async'; // デコードをメインスレッド外へ（スクロールを固めない）
        img.onload = () => {
          if (myLoad === loadSeq && document.body.contains(item)) placeholder.replaceWith(img);
          resolve();
        };
        img.onerror = () => resolve();
        img.src = srcUrl(file);
      });
    }
    function pump() {
      if (myLoad !== loadSeq) return;
      const queue = [];
      for (const path of visible) if (pending.has(path)) queue.push(pending.get(path));
      for (const [, x] of pending) if (!visible.has(x.file.path)) queue.push(x);
      while (active < IMAGE_CONCURRENCY && queue.length > 0) {
        const next = queue.shift();
        if (!pending.has(next.file.path)) continue;
        active++;
        loadOne(next).then(() => { active--; pump(); });
      }
    }
    const observer = new IntersectionObserver((entries) => {
      let changed = false;
      for (const en of entries) {
        const path = en.target.dataset.path;
        if (en.isIntersecting) { if (pending.has(path)) { visible.add(path); changed = true; } }
        else visible.delete(path);
      }
      if (changed) pump();
    }, { root: grid, rootMargin: '200px' });
    for (const { item } of items) observer.observe(item);
    pump();
  }

  // ---- 操作ヘルパ（コンテキストメニュー / キーボード共通） ----
  function cssEsc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/(["\\])/g, '\\$1'); }
  function itemEl(path) { return grid.querySelector('.file-item[data-path="' + cssEsc(path) + '"]'); }

  // 現在表示中（タグフィルター適用後・ソート順）の画像パスを DOM 順に返す（仕様 §7/§4.5）。
  // ビューワはこの集合だけを画像リストとして扱う＝切替・先読み・削除が絞り込みを尊重する。
  function visibleImagePaths() {
    const out = [];
    grid.querySelectorAll('.file-item').forEach((el) => {
      if (el.dataset.isImage !== 'true') return;
      if (el.style.display === 'none') return; // タグフィルターで非表示の画像は除外
      out.push(el.dataset.path);
    });
    return out;
  }

  // 画像をビューワで開く。表示中の画像集合のみをホストへ渡す（唯一の真実源・仕様 §4.5）。
  function openImageAt(path) {
    const paths = visibleImagePaths();
    if (currentArchive) invoke('open_image', { archivePath: currentArchive, innerPath: path, paths });
    else invoke('open_image', { path, paths });
  }

  function openPath(path) {
    const el = itemEl(path);
    if (!el) return;
    if (el.dataset.isImage === 'true') {
      openImageAt(path);
    } else if (el.dataset.type === 'folder') {
      if (currentArchive) { currentInner = path; loadLocation(); }
      else { loadFolder(path); invoke('host_navigated', { path }); }
    } else if (el.querySelector('.file-icon.archive')) {
      enterArchive(path);
    } else if (!currentArchive) {
      invoke('open_with_default_app', { path });
    }
  }

  async function deleteSelected() {
    const paths = FileList.getSelectedPaths();
    if (paths.length === 0) return;
    if (currentArchive) { showToast('書庫内のファイルは削除できません'); return; }
    try { await invoke('move_to_trash', { paths }); await loadLocation(); }
    catch (e) { showToast('削除に失敗しました: ' + e); }
  }

  async function newFolder() {
    if (currentArchive) { showToast('書庫内にはフォルダーを作成できません'); return; }
    if (!currentFolder) return;
    try {
      const p = await invoke('create_folder', { parentPath: currentFolder });
      await loadLocation();
      if (p) { FileList.setSelection([p]); FileList.setFocus(p); FileList.startInlineRename(); }
    } catch (e) { showToast('フォルダー作成に失敗しました: ' + e); }
  }

  function copyText(text) { invoke('copy_text_to_clipboard', { text }); }
  function baseName(p) { return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop(); }

  // タグフィルターの表示反映（仕様 §7）。フォルダーは常に表示、画像は一致パスのみ表示。
  function applyTagFilterDom() {
    grid.querySelectorAll('.file-item').forEach((el) => {
      if (el.dataset.type === 'folder') { el.style.display = ''; return; }
      if (!tagFilter) { el.style.display = ''; return; }
      el.style.display = tagFilter.has(el.dataset.path) ? '' : 'none';
    });
  }

  async function touchSelected() {
    if (currentArchive) return;
    const paths = FileList.getSelectedPaths();
    if (paths.length === 0) return;
    try {
      for (const p of paths) await invoke('touch_file', { path: p });
      showToast(paths.length + ' 個の更新日時を更新しました');
      // 監視(fs_changed)でも更新されるが即時反映のため明示再読込。
      await loadLocation();
    } catch (e) { showToast('更新に失敗しました: ' + e); }
  }

  // ---- コンテキストメニュー（仕様 §2.4） ----
  let menuEl = null;
  function hideMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
  function showMenu(x, y, items) {
    hideMenu();
    menuEl = document.createElement('div');
    menuEl.className = 'ctx-menu';
    for (const it of items) {
      if (it === 'sep') { const s = document.createElement('div'); s.className = 'sep'; menuEl.appendChild(s); continue; }
      const d = document.createElement('div');
      d.className = 'it' + (it.disabled ? ' disabled' : '');
      d.textContent = it.label;
      if (!it.disabled) d.addEventListener('click', () => { hideMenu(); it.action(); });
      menuEl.appendChild(d);
    }
    document.body.appendChild(menuEl);
    const r = menuEl.getBoundingClientRect();
    let nx = x, ny = y;
    if (x + r.width > window.innerWidth) nx = window.innerWidth - r.width - 4;
    if (y + r.height > window.innerHeight) ny = window.innerHeight - r.height - 4;
    menuEl.style.left = Math.max(0, nx) + 'px';
    menuEl.style.top = Math.max(0, ny) + 'px';
  }

  function itemMenu() {
    const sel = FileList.getSelectedPaths();
    const single = sel.length === 1;
    const inArc = !!currentArchive;
    return [
      { label: '開く', action: () => openPath(sel[0]), disabled: !single },
      'sep',
      { label: '切り取り', action: () => clipboardCopy(true), disabled: inArc },
      { label: 'コピー', action: () => clipboardCopy(false), disabled: inArc },
      { label: '貼り付け', action: () => clipboardPaste(), disabled: inArc },
      { label: '削除', action: () => deleteSelected(), disabled: inArc },
      { label: '名前の変更', action: () => FileList.startInlineRename(), disabled: !single || inArc },
      'sep',
      { label: 'エクスプローラーで表示', action: () => invoke('open_in_explorer', { path: sel[0] }), disabled: !single || inArc },
      { label: '既定のアプリで開く', action: () => invoke('open_with_default_app', { path: sel[0] }), disabled: !single || inArc },
      { label: 'フルパスをコピー', action: () => copyText(sel.join('\n').replace(/\//g, '\\')), disabled: inArc },
      { label: 'ファイル名をコピー', action: () => copyText(sel.map(baseName).join('\n')) },
      'sep',
      { label: '更新日時を現在に (Touch)', action: () => touchSelected(), disabled: inArc },
      { label: '新しいフォルダー', action: () => newFolder(), disabled: inArc },
      'sep',
      // 元 viewer の「一般メニュー」= Explorer のフルシェルメニュー（仕様 §2.3）。
      { label: '一般メニュー', action: () => invoke('show_context_menu', { paths: sel }), disabled: inArc },
    ];
  }
  function emptyMenu() {
    const inArc = !!currentArchive;
    return [
      { label: '貼り付け', action: () => clipboardPaste(), disabled: inArc },
      { label: '新しいフォルダー', action: () => newFolder(), disabled: inArc },
    ];
  }

  grid.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const item = e.target.closest('.file-item');
    if (item) {
      if (!FileList.isSelected(item.dataset.path)) FileList.setSelection([item.dataset.path]);
      showMenu(e.clientX, e.clientY, itemMenu());
    } else {
      FileList.clearSelection();
      showMenu(e.clientX, e.clientY, emptyMenu());
    }
  });
  window.addEventListener('click', hideMenu);
  window.addEventListener('blur', hideMenu);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenu(); });

  // ナビゲーションの補助ハンドラ（元アプリ準拠）。grid のキーダウン（file-list.js）が
  // 既に処理した場合は defaultPrevented で二重発火を防ぐ。grid が空 / 非フォーカスでも
  // 戻る・上が効くよう window で受ける。入力中は無視。
  //   Backspace / Alt+← : 戻る（履歴） ／ Alt+↑ : 上のフォルダーへ
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    if (e.target && e.target.tagName === 'INPUT') return;
    if (e.key === 'F5') { e.preventDefault(); if (currentArchive) loadLocation(); else if (currentFolder) reconcile(); return; } // 更新（差分）
    if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goBackHistory(); }
    else if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); goUpParent(); }
    else if (!e.altKey && !e.ctrlKey && !e.shiftKey && e.key === 'Backspace') { e.preventDefault(); goBackHistory(); }
  });
  grid.addEventListener('scroll', hideMenu, true);

  // ---- ホストからのナビゲーション / フォルダー変更通知 ----
  if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen('navigate', (e) => {
      const p = e && e.payload && e.payload.path;
      if (p) loadFolder(p);
    });
    // ツリーで圧縮ファイルを選択 → 一覧に中身を展開（親フォルダーを currentFolder として保持）。
    window.__TAURI__.event.listen('navigate_archive', (e) => {
      const p = e && e.payload && e.payload.path;
      if (!p) return;
      currentFolder = parentOf(p);
      if (history[history.length - 1] !== currentFolder) history.push(currentFolder);
      enterArchive(p);
    });
    // 仮想フォルダー（PC/ホーム/ネットワーク等）選択時：子フォルダー（ドライブ等）を一覧表示。
    window.__TAURI__.event.listen('show_folders', (e) => {
      const p = e && e.payload;
      showFolders((p && p.folders) || [], p && p.title);
    });
    // ホストが遅い列挙を開始した（ツリーの仮想フォルダー選択等）→ ローディング表示。
    window.__TAURI__.event.listen('list_loading', () => { loadSeq++; showSpinner(); });
    // 表示中フォルダーがディスク上で変化したら再読み込み（仕様 §1.5。ホスト側でデバウンス済み）。
    window.__TAURI__.event.listen('fs_changed', (e) => {
      const p = e && e.payload && e.payload.path;
      if (!currentArchive && p && p === currentFolder) reconcile(); // 差分更新（ちらつき/選択解除を防ぐ）
    });
    // 設定変更（隠しファイル表示の切替など）で一覧を再読込（差分・選択維持）。
    window.__TAURI__.event.listen('reload_list', () => reconcile());
    // サムネイル表示切替など、アイテムを作り直す必要がある場合は全再読込。
    window.__TAURI__.event.listen('reload_list_full', () => { if (currentFolder || currentArchive) loadLocation(); });
    // ビューワで表示中の画像を一覧で選択（設定「表示している画像をファイル一覧上で選択する」）。
    window.__TAURI__.event.listen('select_image', (e) => {
      const p = e && e.payload && e.payload.path;
      if (!p) return;
      let target = null;
      grid.querySelectorAll('.file-item').forEach((el) => { if (el.dataset.path === p) target = el; });
      if (target) { FileList.setSelection([p]); target.scrollIntoView({ block: 'nearest' }); }
    });
    // メニューバーで表示設定が変わったら反映（アイコンサイズ／ソート）。
    window.__TAURI__.event.listen('view_settings_changed', (e) => {
      applyViewSettings(e && e.payload, true);
    });
    // 詳細ペインのタグフィルター結果を反映（仕様 §7）。
    window.__TAURI__.event.listen('tag_filter', (e) => {
      const p = e && e.payload;
      tagFilter = (p && p.active) ? new Set(p.paths || []) : null;
      applyTagFilterDom();
      // 開いているビューワにも絞り込み後の画像集合を反映（切替/先読みを揃える・仕様 §4.5/§7）。
      notifyViewerImages();
    });
  }
})();

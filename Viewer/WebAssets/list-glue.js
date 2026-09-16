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
  let showUnsupported = true;   // 本アプリで表示できないファイルも一覧に出す（タブごとの状態）
  // 一覧に出す価値があるもの＝フォルダー／画像／動画／圧縮ファイル。それ以外が「非対応ファイル」。
  function isSupportedEntry(e) { return !!(e.is_dir || e.is_image || e.is_video || e.is_archive); }

  // 詳細ペイン向けの集計：現在の一覧のファイル数／対応ファイル数と、パス→エントリ（サイズ参照用）。
  // 非対応ファイルを隠していても件数は隠す前の一覧で数える。
  let folderCounts = null;        // { total, supported } / 仮想表示や空タブは null
  let entryByPath = new Map();    // path → entry（size / is_dir）
  function updateFolderStats(entries) {
    entryByPath = new Map(entries.map((e) => [e.path, e]));
    const files = entries.filter((e) => !e.is_dir);
    folderCounts = { total: files.length, supported: files.filter(isSupportedEntry).length };
  }
  // 選択の通知（ホスト経由で詳細ペインへ）。フォルダーの件数と、選択中ファイルの合計サイズ／
  // フォルダー数を添える（フォルダーのサイズは数えない）。
  function notifySelectionToHost(paths, archivePath) {
    let size = 0, dirs = 0;
    for (const p of paths || []) {
      const e = entryByPath.get(p);
      if (!e) continue;
      if (e.is_dir) dirs++;
      else if (typeof e.size === 'number') size += e.size;
    }
    invoke('selection_changed', {
      paths, archivePath,
      total_files: folderCounts ? folderCounts.total : null,
      supported_files: folderCounts ? folderCounts.supported : null,
      sel_size: size, sel_dirs: dirs,
    }).catch(() => {});
  }

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
    // v=更新日時：同名で内容が変わったファイルを Chromium が同じ URL として使い回さないようにする
    return base + '&t=' + thumbPx() + '&v=' + (file.modified_at ?? '');
  }

  // ---- file-list.js 初期化（選択・キーボード・DnD を委譲） ----
  FileList.init({
    grid,
    invoke,
    getDestinationFolder: () => (currentArchive ? null : currentFolder),
    getCurrentArchive: () => currentArchive,
    onOpenImage: (path) => openImageAt(path),
    onOpenVideo: (path) => openVideoAt(path),
    onOpenFolder: (path) => {
      if (currentArchive) enterArchiveInner(path);
      else loadFolder(path);
    },
    onOpenArchive: (path) => { enterArchive(path); },
    onOpenFolderNewTab: (path) => { invoke('new_tab_with_folder', { path }).catch(() => {}); },
    onSelectionChanged: () => { notifySelectionToHost(FileList.getSelectedPaths(), currentArchive); },
    showToast,
    onRenamed: async () => { await loadLocation(); },
    onDeleted: () => deleteSelected(),
    onGoBack: () => goBack(),        // 戻る（履歴）
    onGoForward: () => goForward(),  // 進む（履歴）
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
    // タブ操作（host 側で実処理。既定 Ctrl+T/W/Tab）。
    ShortcutDispatch.register('filelist.new_tab', () => invoke('new_tab').catch(() => {}));
    ShortcutDispatch.register('filelist.close_tab', () => invoke('close_tab').catch(() => {}));
    ShortcutDispatch.register('filelist.next_tab', () => invoke('switch_tab', { delta: 1 }).catch(() => {}));
    ShortcutDispatch.register('filelist.prev_tab', () => invoke('switch_tab', { delta: -1 }).catch(() => {}));
    ShortcutDispatch.load().catch(() => {});
  }

  // タブ切替やアプリ復帰でこのペインがフォーカスを得たら、グリッドへフォーカスを移す。
  // コピー/切り取り/貼り付け等のショートカットは grid の keydown 経由で発火するため、
  // これが無いとタブ切替直後にキー操作（特にタブ間の貼り付け）が効かない。
  // 入力欄（アドレスバー等）にフォーカス中は奪わない。
  window.addEventListener('focus', () => {
    const ae = document.activeElement;
    if (!ae || ae === document.body) grid.focus();
  });
  // ホストがタブをアクティブ化したときの明示通知でもグリッドにフォーカスする（確実化）。
  if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen('focus_list', () => {
      const ae = document.activeElement;
      if (!ae || ae === document.body) grid.focus();
    });
  }

  // 表示設定（アイコンサイズ・ソート）を反映。ファイル名は常に折り返し固定。
  function applyViewSettings(vs, reloadOnSortChange) {
    if (!vs) return;
    document.body.classList.add('name-wrap'); // 常に折り返し
    if (typeof vs.folder_thumbnails === 'boolean') showFolderThumbs = vs.folder_thumbnails;
    if (typeof vs.archive_thumbnails === 'boolean') showArchiveThumbs = vs.archive_thumbnails;
    if (vs.icon_size) setIconSize(vs.icon_size, false);
    let needReload = false;
    if (vs.sort_mode) {
      if (vs.sort_mode !== currentSort) needReload = true;
      currentSort = vs.sort_mode;
      markSortActive();
    }
    if (typeof vs.show_unsupported === 'boolean') {
      if (vs.show_unsupported !== showUnsupported) needReload = true;
      showUnsupported = vs.show_unsupported;
      markUnsupportedActive();
    }
    if (needReload && reloadOnSortChange && (currentFolder || currentArchive)) loadLocation();
  }
  // 起動時に現在値（タブごとの並び替え／アイコンサイズ／非対応表示を含む）を取得して適用し、
  // その後で最初のパスを開く。順序を固定しないと、初期値のまま一覧が描画されてから
  // 設定が届く競合が起き、復元したタブの表示が保存時と食い違う。
  invoke('get_view_settings').then((vs) => applyViewSettings(vs, false)).catch(() => {}).then(() => {
    // このタブが最初に開くパス（host がタブ生成時に決定）。空なら空タブのまま。
    // フォルダー／圧縮ファイルのどちらでも開けるよう resolve_path で判定して分岐する。
    invoke('get_initial_folder').then((p) => {
      if (!p) return;
      invoke('resolve_path', { path: p }).then((r) => {
        if (!r || r.kind === 'none') { loadFolder(p); return; } // 後方互換: 判定不可ならフォルダー扱い
        if (r.kind === 'archive') enterArchive(r.path);
        else loadFolder(r.path);
      }).catch(() => loadFolder(p));
    }).catch(() => {});
  });

  // ---- アドレスバーのツール（ソート選択 / アイコンサイズ調整） ----
  const sortBtn = document.getElementById('sortBtn');
  const iconSizeBtn = document.getElementById('iconSizeBtn');
  const sortPopup = document.getElementById('sortPopup');
  const iconSizePopup = document.getElementById('iconSizePopup');
  const iconSizeRange = document.getElementById('iconSizeRange');
  const iconSizeNum = document.getElementById('iconSizeNum');
  const unsupportedBtn = document.getElementById('unsupportedBtn');
  let iconSizeSaveTimer = null;

  // 非対応ファイル表示（ON/OFF トグル）。状態はタブごとにホストが保持・保存する。
  function markUnsupportedActive() {
    if (unsupportedBtn) unsupportedBtn.classList.toggle('active', showUnsupported);
  }
  if (unsupportedBtn) {
    unsupportedBtn.addEventListener('click', () => {
      showUnsupported = !showUnsupported;
      markUnsupportedActive();
      invoke('set_show_unsupported', { value: showUnsupported }).catch(() => {});
      if (currentFolder || currentArchive) loadLocation();
    });
    markUnsupportedActive();
  }

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
    if (/^[\\/]{2}[^\\/]+$/.test(norm)) return null;          // \\server（UNC のサーバー直下）に親は無い
    if (/^[\\/]{2}[^\\/]+[\\/][^\\/]+$/.test(norm)) {          // \\server\share → \\server（共有一覧）
      return norm.slice(0, Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/')));
    }
    const idx = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
    if (idx <= 2) return idx >= 0 ? norm.slice(0, idx + 1) : null; // ドライブ直下
    return norm.slice(0, idx);
  }
  function parentInner(p) {
    const norm = (p || '').replace(/[\\/]+$/, '');
    const idx = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
    return idx < 0 ? '' : norm.slice(0, idx);
  }

  // ---- ナビゲーション履歴（ブラウザ型：戻る／進む） ----
  // 各エントリは「ロケーション」＝ 通常フォルダー or 書庫(＋内部パス)。フォルダーだけでなく
  // 書庫も第一級の履歴地点として扱うため、戻る/進むが書庫を含む経路を正しくたどれる。
  // 「上のフォルダーへ」も新しい移動として履歴に積む（Explorer 同様、戻るで子へ戻れる）。
  // ロケーション形 = { folder: string|null, archive: string|null, inner: string }
  let navStack = [];   // ロケーションの並び（先頭→末尾＝古い→新しい）
  let navIdx = -1;     // 現在地のインデックス（-1＝未ナビゲート）

  function sameLoc(a, b) {
    return !!a && !!b && a.folder === b.folder && a.archive === b.archive && (a.inner || '') === (b.inner || '');
  }
  function resetNav() { navStack = []; navIdx = -1; }

  // ロケーションを実際に表示する（履歴は変更しない）。
  function applyLoc(loc) {
    currentFolder = loc.folder;
    currentArchive = loc.archive;
    currentInner = loc.inner || '';
    tagFilter = null; // ロケーション切替でタグフィルター解除（仕様 §7）
    if (!loc.archive && loc.folder) invoke('host_navigated', { path: loc.folder });
    loadLocation();
  }
  // 新しいロケーションへ移動し履歴に積む（前方履歴は破棄）。同じ場所への連続移動は積まない。
  function pushLoc(loc) {
    if (navIdx >= 0 && sameLoc(navStack[navIdx], loc)) { applyLoc(loc); return; }
    navStack = navStack.slice(0, navIdx + 1);
    navStack.push(loc);
    navIdx = navStack.length - 1;
    applyLoc(loc);
  }

  // 通常フォルダーへ移動（クリック／ツリー／アドレスバー等）。
  function loadFolder(path) {
    if (!path) return;
    pushLoc({ folder: path, archive: null, inner: '' });
  }
  // 書庫を開く（中の最上位を表示）。currentFolder は書庫の親フォルダーとして保持。
  function enterArchive(path) {
    if (!path) return;
    pushLoc({ folder: parentOf(path), archive: path, inner: '' });
  }
  // 書庫内のフォルダーへ移動。
  function enterArchiveInner(inner) {
    pushLoc({ folder: currentFolder, archive: currentArchive, inner: inner || '' });
  }

  // 仮想フォルダーの子フォルダー（ドライブ等）を一覧に表示。実フォルダーではないので
  // currentFolder は持たない（ダブルクリックで各フォルダーへ通常ナビゲートする）。履歴対象外。
  function showFolders(folders, title) {
    loadSeq++;                 // 進行中の get_files ロードを無効化
    hideSpinner();             // list_loading で出していたスピナーを消す
    currentFolder = null; currentArchive = null; currentInner = ''; tagFilter = null;
    invoke('watch_folder', { path: '' }); // 仮想なので監視停止
    headerPath.value = title || '';
    invoke('set_tab_title', { title: title || '' }).catch(() => {});
    grid.innerHTML = '';
    for (const f of folders) {
      const file = { path: f.path, name: f.name, is_dir: true, is_image: false, is_archive: false };
      grid.appendChild(FileList.createItem(file, {}));
    }
    FileList.clearSelection();
    folderCounts = null; entryByPath = new Map(); // 仮想表示／空タブ：件数なし
    notifySelectionToHost([], null);
  }

  // 戻る：履歴を1つ前へ。書庫の地点もそのままたどれる。
  function goBack() {
    if (navIdx <= 0) return;
    navIdx--;
    applyLoc(navStack[navIdx]);
  }
  // 進む：履歴を1つ先へ。
  function goForward() {
    if (navIdx >= navStack.length - 1) return;
    navIdx++;
    applyLoc(navStack[navIdx]);
  }

  // 上のフォルダーへ（親）。書庫内は1階層上／書庫から出る。いずれも新しい移動として履歴に積む。
  function goUpParent() {
    if (currentArchive) {
      if (currentInner) enterArchiveInner(parentInner(currentInner));
      else loadFolder(currentFolder); // 書庫を出て親フォルダーへ
      return;
    }
    if (!currentFolder) return;
    const parent = parentOf(currentFolder);
    if (parent) loadFolder(parent);
  }

  // ---- ロケーション読み込み（通常フォルダー / 書庫内） ----
  async function loadLocation() {
    const myLoad = ++loadSeq;
    const inArchive = !!currentArchive;
    const archiveAtLoad = currentArchive;

    headerPath.value = inArchive
      ? (currentArchive + (currentInner ? '::' + currentInner : '::'))
      : (currentFolder || '');

    // タブ見出しを更新（フォルダ名／書庫名）。
    invoke('set_tab_title', {
      title: inArchive
        ? (baseName(currentArchive) + (currentInner ? ' / ' + baseName(currentInner) : ''))
        : (currentFolder ? (baseName(currentFolder) || currentFolder) : ''),
    }).catch(() => {});

    // 表示中フォルダーの監視対象をホストへ通知（仕様 §1.5）。書庫内は監視停止。
    invoke('watch_folder', { path: inArchive ? '' : (currentFolder || '') });

    showSpinner(); // 読み込み中表示（遅いフォルダーでホストはバックグラウンド列挙）

    let entries;
    try {
      entries = inArchive
        ? await invoke('get_archive_files', { archivePath: currentArchive, innerPath: currentInner, sort: currentSort })
        : await invoke('get_files', { path: currentFolder, sort: currentSort });
    } catch (e) {
      if (myLoad === loadSeq) hideSpinner();
      showToast('読み込みに失敗しました: ' + e);
      return;
    }
    if (myLoad !== loadSeq) return; // 古い結果は破棄（新しいロードがスピナーを管理）
    hideSpinner();
    updateFolderStats(entries); // 件数は隠す前に数える
    if (!showUnsupported) entries = entries.filter(isSupportedEntry); // 非対応ファイルを隠す

    grid.innerHTML = '';
    const imageItems = [];
    const videoItems = [];
    const archiveItems = [];
    const folderItems = [];
    const innerFolderItems = []; // 書庫内のフォルダー（中の1枚目をサムネイル化）
    for (const entry of entries) {
      // 書庫内エントリには archive コンテキストを付与（URL生成・openに使う）。
      const file = inArchive
        ? { path: entry.path, name: entry.name, is_dir: entry.is_dir, is_image: entry.is_image,
            is_archive: false, archivePath: archiveAtLoad, innerPath: entry.path }
        : entry;
      const item = FileList.createItem(file, inArchive ? { archivePath: archiveAtLoad } : {});
      grid.appendChild(item);
      if (file.is_image) imageItems.push({ item, file });
      else if (file.is_video) videoItems.push({ item, file });
      else if (file.is_archive && !inArchive && showArchiveThumbs) archiveItems.push({ item, file });
      else if (file.is_dir && !inArchive && showFolderThumbs) folderItems.push({ item, file });
      else if (file.is_dir && inArchive && showFolderThumbs) innerFolderItems.push({ item, file });
    }
    FileList.clearSelection();
    notifySelectionToHost([], currentArchive);

    applyTagFilterDom(); // 再構築した DOM にタグフィルターを再適用（仕様 §7）
    notifyViewerLists(); // 開いているビューワの画像リストを最新の一覧に追従（増減を反映・仕様 §4.5）
    loadThumbnails(imageItems, myLoad);
    // 動画＝シェルサムネイル（配信側が生成）。バッジ＋右下サムネの thumb-host 方式。
    loadThumbHosts(videoItems, myLoad, null,
      (file) => 'https://file.viewer/raw?p=' + encodeURIComponent(file.path));
    // 圧縮ファイル＝中の1枚目、フォルダー＝直下の1枚目をサムネイル化（取得は背景・NIO）。
    loadThumbHosts(archiveItems, myLoad, 'get_archive_first_image',
      (file, inner) => 'https://file.viewer/raw?a=' + encodeURIComponent(file.path) + '&i=' + encodeURIComponent(inner));
    loadThumbHosts(folderItems, myLoad, 'get_folder_first_image',
      (file, imgPath) => 'https://file.viewer/raw?p=' + encodeURIComponent(imgPath));
    // 書庫内フォルダー：その内部フォルダー配下の1枚目を書庫から取得してサムネイル化。
    loadThumbHosts(innerFolderItems, myLoad, 'get_archive_first_image',
      (file, inner) => 'https://file.viewer/raw?a=' + encodeURIComponent(archiveAtLoad) + '&i=' + encodeURIComponent(inner),
      (file) => ({ archivePath: archiveAtLoad, innerPath: file.path }));
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
    updateFolderStats(entries); // 件数は隠す前に数える
    if (!showUnsupported) entries = entries.filter(isSupportedEntry); // 非対応ファイルを隠す

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
    const imageItems = [], videoItems = [], archiveItems = [], folderItems = [];
    let replaced = false;
    for (const file of entries) {
      let item = existing.get(file.path);
      // 同じパスでも更新日時が変わっていれば別物（削除→同名で再生成、または上書き保存）。
      // 既存ノードを使い回すと古いサムネイルが残るので、捨てて作り直す。
      if (item && file.modified_at != null && item.dataset.mtime !== String(file.modified_at)) {
        item.remove();
        item = null;
        replaced = true;
      }
      if (!item) {
        item = FileList.createItem(file, {});
        if (file.is_image) imageItems.push({ item, file });
        else if (file.is_video) videoItems.push({ item, file });
        else if (file.is_archive && showArchiveThumbs) archiveItems.push({ item, file });
        else if (file.is_dir && showFolderThumbs) folderItems.push({ item, file });
      } else {
        // 既存ノードでも、サムネイル未読込のものは loadSeq の更新で前世代のロードが
        // 打ち切られている。新世代で再キューしないと読み込みが止まったままになる。
        // （画像＝placeholder が残存 / 動画・圧縮・フォルダ＝thumb-host が has-thumb 未付与）
        if (file.is_image) {
          if (item.querySelector('.file-icon.placeholder')) imageItems.push({ item, file });
        } else if (file.is_video) {
          if (!item.querySelector('.thumb-host.has-thumb')) videoItems.push({ item, file });
        } else if (file.is_archive && showArchiveThumbs) {
          if (!item.querySelector('.thumb-host.has-thumb')) archiveItems.push({ item, file });
        } else if (file.is_dir && showFolderThumbs) {
          if (!item.querySelector('.thumb-host.has-thumb')) folderItems.push({ item, file });
        }
      }
      grid.appendChild(item);
    }

    // 選択の復元：削除された項目だけ選択から外す（残りは DOM/選択集合とも維持済み）。
    const survivors = prevSel.filter((p) => newByPath.has(p));
    // 作り直したノードには選択クラスが付いていないので、その場合も選択を再適用する。
    if (survivors.length !== prevSel.length || replaced) FileList.setSelection(survivors);

    applyTagFilterDom();
    notifyViewerLists();
    loadThumbnails(imageItems, myLoad);
    loadThumbHosts(videoItems, myLoad, null,
      (f) => 'https://file.viewer/raw?p=' + encodeURIComponent(f.path));
    loadThumbHosts(archiveItems, myLoad, 'get_archive_first_image',
      (f, inner) => 'https://file.viewer/raw?a=' + encodeURIComponent(f.path) + '&i=' + encodeURIComponent(inner));
    loadThumbHosts(folderItems, myLoad, 'get_folder_first_image',
      (f, imgPath) => 'https://file.viewer/raw?p=' + encodeURIComponent(imgPath));
  }

  // 📦圧縮ファイル / 📁フォルダー / 🎞️動画のサムネイルをビューポート優先で読み込む（仕様 §3/§5）。
  // command で1枚目を取得（ホスト側は背景実行＝ブロックしない）、urlFn で配信URLを作って .thumb-img に設定。
  // command が null のときは invoke せずファイル自身を対象にする（動画＝シェルサムネイル）。
  // argsFn を渡すと invoke 引数を差し替えできる（書庫内フォルダー＝archivePath+innerPath を渡す）。
  function loadThumbHosts(items, myLoad, command, urlFn, argsFn) {
    if (items.length === 0) return;
    const map = new Map(items.map((x) => [x.item, x.file]));
    const observer = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const item = en.target;
        observer.unobserve(item);
        const file = map.get(item);
        if (!file) continue;
        const callArgs = argsFn ? argsFn(file) : { path: file.path, archivePath: file.path };
        (command ? invoke(command, callArgs) : Promise.resolve(file.path)).then((res) => {
          if (myLoad !== loadSeq || !res || !document.body.contains(item)) return;
          const img = item.querySelector('.thumb-img');
          if (!img) return;
          img.decoding = 'async'; // デコードをメインスレッド外へ（スクロールを固めない）
          img.addEventListener('load', () => {
            const box = img.closest('.thumb-host');
            if (box) box.classList.add('has-thumb'); // アイコンを左上へずらし、サムネイル表示
          }, { once: true });
          img.src = urlFn(file, res) + '&t=' + thumbPx() + '&v=' + (file.modified_at ?? ''); // 縮小デコード配信＋更新日時でキャッシュ回避
        }).catch(() => {});
      }
    }, { root: grid, rootMargin: '200px' });
    for (const { item } of items) observer.observe(item);
  }

  // 開いているビューワへ、現在表示中（タグフィルター適用後・ソート順）の画像／動画集合を通知する。
  // 画像ウィンドウ側は同じフォルダーの更新のみ受け入れる（別フォルダーへ移動した一覧は無視）。
  // 動画ウィンドウ側は連続再生のプレイリストとして使う。
  function notifyViewerLists() {
    invoke('update_viewer_images', { paths: visibleImagePaths() }).catch(() => {});
    invoke('update_viewer_videos', { paths: visibleVideoPaths() }).catch(() => {});
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

  // 現在表示中（タグフィルター適用後・ソート順）の動画パスを DOM 順に返す。
  // 動画ウィンドウの「連続再生」はこの順序で次のファイルへ進む（一覧が唯一の真実源）。
  // 書庫内はディスク上のファイルではなく再生できないため空にする。
  function visibleVideoPaths() {
    if (currentArchive) return [];
    const out = [];
    grid.querySelectorAll('.file-item').forEach((el) => {
      if (el.dataset.isVideo !== 'true') return;
      if (el.style.display === 'none') return;
      out.push(el.dataset.path);
    });
    return out;
  }

  // 動画を動画ウィンドウで開く。表示中の動画集合（連続再生用）も一緒に渡す。
  function openVideoAt(path) {
    invoke('open_video', { path, paths: visibleVideoPaths() });
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
    } else if (el.dataset.isVideo === 'true') {
      openVideoAt(path);
    } else if (el.dataset.type === 'folder') {
      if (currentArchive) enterArchiveInner(path);
      else loadFolder(path);
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

  // ---- コンテキストメニュー（仕様 §2.4。表示・項目定義とも ctx-menu.js と共用） ----
  function itemMenu() {
    const sel = FileList.getSelectedPaths();
    const single = sel.length === 1;
    const inArc = !!currentArchive;
    const isFolder = single && itemEl(sel[0])?.dataset.type === 'folder';
    const isArchive = single && !!(itemEl(sel[0])?.querySelector('.file-icon.archive') ||
      itemEl(sel[0])?.querySelector('.archive-thumbnail'));
    return CtxMenu.fileMenuItems({
      single, inArc, isFolder, isArchive,
      actions: {
        open: () => openPath(sel[0]),
        openNewTab: () => invoke('new_tab_with_folder', { path: sel[0] }),
        cut: () => clipboardCopy(true),
        copy: () => clipboardCopy(false),
        paste: () => clipboardPaste(),
        remove: () => deleteSelected(),
        rename: () => FileList.startInlineRename(),
        showInExplorer: () => invoke('open_in_explorer', { path: sel[0] }),
        openDefault: () => invoke('open_with_default_app', { path: sel[0] }),
        copyFullPath: () => copyText(sel.join('\n').replace(/\//g, '\\')),
        copyName: () => copyText(sel.map(baseName).join('\n')),
        touch: () => touchSelected(),
        newFolder: () => newFolder(),
        shellMenu: () => invoke('show_context_menu', { paths: sel }),
      },
    });
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
      CtxMenu.show(e.clientX, e.clientY, itemMenu());
    } else {
      FileList.clearSelection();
      CtxMenu.show(e.clientX, e.clientY, emptyMenu());
    }
  });

  // ナビゲーションの補助ハンドラ（元アプリ準拠）。grid のキーダウン（file-list.js）が
  // 既に処理した場合は defaultPrevented で二重発火を防ぐ。grid が空 / 非フォーカスでも
  // 戻る・進む・上が効くよう window で受ける。入力中は無視。
  //   Backspace / Alt+← : 戻る（履歴） ／ Alt+→ : 進む（履歴） ／ Alt+↑ : 上のフォルダーへ
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    if (e.target && e.target.tagName === 'INPUT') return;
    if (e.key === 'F5') { e.preventDefault(); if (currentArchive) loadLocation(); else if (currentFolder) reconcile(); return; } // 更新（差分）
    if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goBack(); }
    else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goForward(); }
    else if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); goUpParent(); }
    else if (!e.altKey && !e.ctrlKey && !e.shiftKey && e.key === 'Backspace') { e.preventDefault(); goBack(); }
  });

  // ---- アドレスバー手入力（パスを入力して Enter で開く） ----
  // 正しいフォルダー → そのフォルダーへ。正しい圧縮ファイル → 書庫として開く。
  // 不正なパスはトーストで通知し、入力を現在地に戻す。
  headerPath.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { restoreHeaderPath(); headerPath.blur(); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const p = headerPath.value.trim().replace(/^"(.*)"$/, '$1'); // 前後の "" を除去
    if (!p) { restoreHeaderPath(); return; }
    invoke('resolve_path', { path: p }).then((r) => {
      if (!r || r.kind === 'none') { showToast('パスが見つかりません: ' + p); restoreHeaderPath(); return; }
      if (r.kind === 'folder') loadFolder(r.path);
      else if (r.kind === 'archive') enterArchive(r.path);
    }).catch(() => { showToast('パスを開けませんでした'); restoreHeaderPath(); });
  });
  // フォーカス時に全選択（パスを差し替えやすく）。
  headerPath.addEventListener('focus', () => headerPath.select());
  // 現在のロケーションをアドレスバーに復元（入力キャンセル・失敗時）。
  function restoreHeaderPath() {
    headerPath.value = currentArchive
      ? (currentArchive + (currentInner ? '::' + currentInner : '::'))
      : (currentFolder || '');
  }

  // ---- ホストからのナビゲーション / フォルダー変更通知 ----
  if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen('navigate', (e) => {
      const p = e && e.payload && e.payload.path;
      if (p) loadFolder(p);
    });
    // ツリーで圧縮ファイルを選択 → 一覧に中身を展開（親フォルダーを currentFolder として保持）。
    window.__TAURI__.event.listen('navigate_archive', (e) => {
      const p = e && e.payload && e.payload.path;
      if (p) enterArchive(p);
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
    // 最後のタブを閉じる操作 → このタブを空（何も開いていない状態）にリセット。
    window.__TAURI__.event.listen('tab_make_empty', () => {
      loadSeq++;
      hideSpinner();
      currentFolder = null; currentArchive = null; currentInner = ''; tagFilter = null; resetNav();
      grid.innerHTML = '';
      headerPath.value = '';
      invoke('set_tab_title', { title: '' }).catch(() => {});
      FileList.clearSelection();
      folderCounts = null; entryByPath = new Map(); // 空タブ：件数なし
      notifySelectionToHost([], null);
    });
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
      notifyViewerLists();
    });
  }
})();

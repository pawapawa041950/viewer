// ファイル一覧ペインのグルー。
// 流用モジュール file-list.js（選択/キーボード/DnD）と shortcut-dispatch.js を
// 新ホスト（C#/WebView2）の IPC（window.invoke / __TAURI__）に接続する。
// 仕様 §1.3（操作）、§3（サムネイルはキャッシュなし・ビューポート優先）。
(function () {
  'use strict';

  const invoke = window.invoke;
  const grid = document.getElementById('iconGrid');
  const header = document.getElementById('header');

  let currentFolder = null;
  let loadSeq = 0; // 世代ガード（フォルダー切替で古いロードを破棄）

  // ---- トースト ----
  let toastEl = null;
  let toastTimer = null;
  function showToast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2000);
  }

  // ---- file-list.js 初期化（選択・キーボード・DnD を委譲） ----
  FileList.init({
    grid,
    invoke,
    getDestinationFolder: () => currentFolder,
    getCurrentArchive: () => null, // 書庫対応は後続（仕様 §5）
    onOpenImage: (path) => { invoke('open_image', { path }); },
    onOpenFolder: (path) => { loadFolder(path); invoke('host_navigated', { path }); },
    onOpenArchive: (path) => { showToast('書庫の閲覧は未実装です'); },
    onSelectionChanged: () => {
      invoke('selection_changed', { paths: FileList.getSelectedPaths() });
    },
    showToast,
    onRenamed: async () => { await loadFolder(currentFolder); },
    onDeleted: async (paths) => {
      try {
        await invoke('move_to_trash', { paths });
        await loadFolder(currentFolder);
      } catch (e) { showToast('削除に失敗しました: ' + e); }
    },
    onGoBack: () => {
      if (!currentFolder) return;
      const parent = parentOf(currentFolder);
      if (parent) { loadFolder(parent); invoke('host_navigated', { path: parent }); }
    },
  });

  // ショートカット（流用）。load_shortcuts は当面既定を返す。
  if (window.ShortcutDispatch) ShortcutDispatch.load().catch(() => {});

  function parentOf(p) {
    const norm = p.replace(/[\\/]+$/, '');
    const idx = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
    if (idx <= 2) return idx >= 0 ? norm.slice(0, idx + 1) : null; // ドライブ直下
    return norm.slice(0, idx);
  }

  // ---- フォルダー読み込み ----
  async function loadFolder(path) {
    if (!path) return;
    currentFolder = path;
    header.textContent = path;
    const myLoad = ++loadSeq;

    let files;
    try {
      files = await invoke('get_files', { path });
    } catch (e) {
      showToast('読み込みに失敗しました: ' + e);
      return;
    }
    if (myLoad !== loadSeq) return; // 古い結果は破棄

    grid.innerHTML = '';
    const imageItems = [];
    for (const file of files) {
      const item = FileList.createItem(file);
      grid.appendChild(item);
      if (file.is_image) imageItems.push({ item, file });
    }
    FileList.clearSelection();
    invoke('selection_changed', { paths: [] });

    loadThumbnails(imageItems, myLoad);
  }

  // ---- サムネイル：キャッシュなし・ビューポート優先・並列度制御（仕様 §3） ----
  const IMAGE_CONCURRENCY = 8;

  function loadThumbnails(items, myLoad) {
    if (items.length === 0) return;
    const pending = new Map(items.map((x) => [x.file.path, x]));
    const visible = new Set();
    let active = 0;

    function fileUrl(path) {
      return 'https://file.viewer/raw?p=' + encodeURIComponent(path);
    }

    function loadOne({ item, file }) {
      pending.delete(file.path);
      const placeholder = item.querySelector('.file-icon.placeholder');
      if (!placeholder) return Promise.resolve();
      return new Promise((resolve) => {
        const img = new Image();
        img.className = 'file-icon';
        img.draggable = false; // HTML5 ドラッグ干渉を防止（仕様 §3）
        img.onload = () => {
          if (myLoad === loadSeq && document.body.contains(item)) {
            placeholder.replaceWith(img);
          }
          resolve();
        };
        img.onerror = () => resolve();
        img.src = fileUrl(file.path);
      });
    }

    function pump() {
      if (myLoad !== loadSeq) return;
      // 可視を優先、その後に残りを充填
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
    pump(); // 初期描画分のキック
  }

  // ---- ホストからのナビゲーション ----
  if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen('navigate', (e) => {
      const p = e && e.payload && e.payload.path;
      if (p) loadFolder(p);
    });
  }
})();

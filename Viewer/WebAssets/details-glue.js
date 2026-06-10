// 詳細ペインのグルー（当面は最小表示）。
// 一覧ペイン→ホスト→このペインへ 'show_details' イベントで選択が届く（仕様 §0）。
// 生成AIメタデータの本格表示は file-details.js 流用で後続実装（仕様 §6）。
(function () {
  'use strict';
  const invoke = window.invoke;
  const preview = document.getElementById('preview');
  const info = document.getElementById('info');

  function isImage(path) {
    return /\.(jpe?g|png|gif|webp|bmp|tiff?)$/i.test(path);
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    const u = ['KB', 'MB', 'GB', 'TB'];
    let v = bytes / 1024, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(1) + ' ' + u[i];
  }

  function fmtDate(ms) {
    try { return new Date(ms).toLocaleString('ja-JP'); } catch { return ''; }
  }

  async function show(paths) {
    if (!paths || paths.length === 0) {
      preview.innerHTML = '';
      info.innerHTML = '<div class="muted">ファイルを選択してください</div>';
      return;
    }
    if (paths.length > 1) {
      preview.innerHTML = '';
      info.innerHTML = '<div class="muted">' + paths.length + ' 個を選択中</div>';
      return;
    }

    const path = paths[0];
    const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop();

    preview.innerHTML = '';
    if (isImage(path)) {
      const img = document.createElement('img');
      img.src = 'https://file.viewer/raw?p=' + encodeURIComponent(path);
      preview.appendChild(img);
    }

    let fi = null;
    try { fi = await invoke('get_file_info', { path }); } catch {}

    const rows = [];
    rows.push(row('名前', name));
    if (fi) {
      rows.push(row('種類', fi.is_dir ? 'フォルダー' : 'ファイル'));
      if (!fi.is_dir) rows.push(row('サイズ', fmtSize(fi.size)));
      rows.push(row('更新日時', fmtDate(fi.modified_at)));
    }
    info.innerHTML = '<div class="name">' + esc(name) + '</div>' + rows.join('');
  }

  function row(k, v) {
    return '<div class="row"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + '</span></div>';
  }
  function esc(s) {
    const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML;
  }

  if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen('show_details', (e) => {
      show(e && e.payload && e.payload.paths);
    });
  }
})();

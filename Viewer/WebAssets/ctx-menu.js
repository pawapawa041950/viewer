// 独自コンテキストメニュー（仕様 §2.4）。ファイル一覧ペイン（list-glue.js）と
// 画像ウィンドウ（viewer-glue.js）で共用する。
//   CtxMenu.show(x, y, items) : items = [{ label, action, disabled } | 'sep', ...]
//   CtxMenu.fileMenuItems(ctx): ファイル対象メニューの共通項目定義（両ペインで同一の並び・
//                               有効条件）。ctx.actions に無い操作は「そのペインでは成立
//                               しない」とみなして無効表示になる。
// 閉じる操作（外側クリック / Escape / ホイール / スクロール / フォーカス喪失）も
// ここで一括して面倒を見る。
window.CtxMenu = (() => {
  let menuEl = null;

  function hide() { if (menuEl) { menuEl.remove(); menuEl = null; } }
  function isOpen() { return !!menuEl; }

  function show(x, y, items) {
    hide();
    menuEl = document.createElement('div');
    menuEl.className = 'ctx-menu';
    for (const it of items) {
      if (it === 'sep') { const s = document.createElement('div'); s.className = 'sep'; menuEl.appendChild(s); continue; }
      const d = document.createElement('div');
      d.className = 'it' + (it.disabled ? ' disabled' : '');
      d.textContent = it.label;
      if (!it.disabled) d.addEventListener('click', () => { hide(); it.action(); });
      menuEl.appendChild(d);
    }
    document.body.appendChild(menuEl);
    // 画面外にはみ出す場合はカーソル位置から内側へ寄せる。
    const r = menuEl.getBoundingClientRect();
    let nx = x, ny = y;
    if (x + r.width > window.innerWidth) nx = window.innerWidth - r.width - 4;
    if (y + r.height > window.innerHeight) ny = window.innerHeight - r.height - 4;
    menuEl.style.left = Math.max(0, nx) + 'px';
    menuEl.style.top = Math.max(0, ny) + 'px';
  }

  // ---- ファイル対象メニューの共通項目定義 ----
  // ctx: { single, inArc, isFolder, isArchive, actions }
  //   single    : 単一選択か（一覧は複数選択あり。ビューワーは常に true）
  //   inArc     : 書庫内表示か（ファイル操作は不可）
  //   isFolder / isArchive : 選択対象の種別（「新しいタブで開く」の判定）
  //   actions   : 各操作の実装。省略した操作は無効表示（ペインごとの差はここに現れる）
  function fileMenuItems(ctx) {
    const a = ctx.actions || {};
    const single = ctx.single !== false;
    const inArc = !!ctx.inArc;
    const item = (label, fn, enabled) => ({ label, action: fn || (() => {}), disabled: !fn || !enabled });
    return [
      item('開く', a.open, single),
      item('新しいタブで開く', a.openNewTab, (ctx.isFolder || ctx.isArchive) && !inArc),
      'sep',
      item('切り取り', a.cut, !inArc),
      item('コピー', a.copy, !inArc),
      item('貼り付け', a.paste, !inArc),
      item('削除', a.remove, !inArc),
      item('名前の変更', a.rename, single && !inArc),
      'sep',
      item('エクスプローラーで表示', a.showInExplorer, single && !inArc),
      item('既定のアプリで開く', a.openDefault, single && !inArc),
      item('フルパスをコピー', a.copyFullPath, !inArc),
      item('ファイル名をコピー', a.copyName, true),
      'sep',
      item('更新日時を現在に (Touch)', a.touch, !inArc),
      item('新しいフォルダー', a.newFolder, !inArc),
      'sep',
      // 元 viewer の「一般メニュー」= Explorer のフルシェルメニュー（仕様 §2.3）。
      item('一般メニュー', a.shellMenu, !inArc),
    ];
  }

  // ---- 閉じる操作（両ペイン共通） ----
  // メニュー項目自体の mousedown では閉じない（click で action を発火させるため）。
  window.addEventListener('mousedown', (e) => {
    if (menuEl && !(e.target.closest && e.target.closest('.ctx-menu'))) hide();
  }, true);
  window.addEventListener('blur', hide);
  // Escape はメニューを閉じるだけ。ページ側のハンドラ（ビューワーのウィンドウを閉じる等）へ
  // 渡さないよう capture で先取りして止める。
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menuEl) { e.preventDefault(); e.stopPropagation(); hide(); }
  }, true);
  // スクロール／ホイール送りでメニューが古い対象を指したままにならないように閉じる。
  window.addEventListener('wheel', hide, { capture: true, passive: true });
  window.addEventListener('scroll', hide, true);

  return { show, hide, isOpen, fileMenuItems };
})();

/**
 * File List module — Explorer-equivalent selection / keyboard / drag-and-drop
 * for the icon grid. Owns:
 *
 *   - Selection state as a Set<string> of paths (single source of truth).
 *   - Anchor + focus tracked separately, matching Explorer semantics.
 *   - Click / Ctrl-click / Shift-click / Ctrl-Shift-click handlers.
 *   - Keyboard nav: arrows (grid-aware), Home/End, Ctrl+A, F2 inline rename,
 *     Delete (trash), Enter (open), Backspace (back), Space (toggle).
 *   - Marquee (rubber-band) selection on empty area.
 *   - Internal drag-target highlighting (drop into folder under cursor).
 *   - Native OS drag-out via Rust's `start_native_drag` command — this is
 *     what enables dragging files to Explorer / other apps.
 *
 * Used by index.html. The module is intentionally not aware of the rest of
 * the app's globals (selectedFolder, currentArchivePath, etc.) — it takes
 * callbacks at init time and only reaches outward through them.
 */
const FileList = (function () {
  'use strict';

  // ---- module state ----
  let grid = null;
  let opts = null;            // init options (callbacks, invoke fn)
  const selected = new Set();  // selected paths
  let anchor = null;            // path used as range-select anchor
  let focusPath = null;         // path with keyboard focus
  let inlineRenameInput = null; // active inline-rename <input> if any

  // ---- public API ----

  /**
   * Initialize the file list. Call once after DOM ready and `invoke` is bound.
   *
   * @param {object} options
   * @param {HTMLElement} options.grid
   *   The icon grid container (e.g. document.getElementById('iconGrid')).
   * @param {Function} options.invoke
   *   The Tauri invoke function.
   * @param {() => string|null} options.getDestinationFolder
   *   Returns the directory currently displayed in the grid (or null when
   *   showing archive contents). Used as the default drop / paste target.
   * @param {() => string|null} options.getCurrentArchive
   *   Returns archive path if the grid is showing archive contents.
   * @param {(path: string, name: string) => void} options.onOpenImage
   * @param {(path: string) => void} options.onOpenFolder
   * @param {(path: string) => void} options.onOpenArchive
   * @param {() => void} options.onSelectionChanged
   *   Called after every selection mutation (use to refresh details pane).
   * @param {(message: string) => void} options.showToast
   * @param {(path: string, oldName: string, newName: string) => Promise<void>} options.onRenamed
   *   Called after a successful inline rename so the caller can refresh state.
   * @param {(paths: string[]) => Promise<void>} options.onDeleted
   *   Called after items are sent to trash.
   * @param {() => void} options.onGoBack
   *   Backspace handler — navigate up.
   */
  function init(options) {
    opts = options;
    grid = options.grid;
    grid.tabIndex = 0;

    grid.addEventListener('mousedown', handleMouseDown);
    grid.addEventListener('click', handleEmptyClick);
    grid.addEventListener('keydown', handleKeyDown);
    grid.addEventListener('dblclick', handleDblClick);

    // Marquee + drag-out tracked on document so they survive dragging out of
    // the grid bounds.
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    registerShortcuts();
  }

  // Register the file-list actions with the runtime shortcut dispatcher. Each
  // handler describes WHAT to do; the key/mouse that triggers it comes from the
  // user's shortcuts.json (or the catalog defaults). Behavior is driven by the
  // action, not the physical key, so rebinding works. copy/cut/paste and the
  // context menu are owned by the document-level handlers in index.html.
  function registerShortcuts() {
    const D = (typeof window !== 'undefined') && window.ShortcutDispatch;
    if (!D) return;
    D.registerAll({
      'filelist.move_up':       (e) => navigateArrow(e, getAllItems(), 'up'),
      'filelist.move_down':     (e) => navigateArrow(e, getAllItems(), 'down'),
      'filelist.move_left':     (e) => navigateArrow(e, getAllItems(), 'left'),
      'filelist.move_right':    (e) => navigateArrow(e, getAllItems(), 'right'),
      'filelist.move_first':    (e) => rangeOrJump(e, getAllItems(), 0),
      'filelist.move_last':     (e) => { const all = getAllItems(); rangeOrJump(e, all, all.length - 1); },
      'filelist.select_all':    () => { for (const it of getAllItems()) selected.add(it.dataset.path); syncDom(); notifySelection(); },
      'filelist.toggle_select': (e) => toggleAtFocus(e, getAllItems()),
      'filelist.clear_selection': () => { clearSelection(); anchor = null; focusPath = null; },
      'filelist.rename':        () => startInlineRename(),
      'filelist.open':          () => {
        const items = Array.from(grid.querySelectorAll('.file-item.selected'));
        if (items.length === 1) openItem(items[0]);
      },
      'filelist.go_back_parent': () => { opts.onGoBack && opts.onGoBack(); },
      'filelist.delete':         () => {
        const items = Array.from(grid.querySelectorAll('.file-item.selected'));
        if (items.length > 0) opts.onDeleted && opts.onDeleted(items.map((it) => it.dataset.path));
      },
    });
  }

  /**
   * Build a file-item DOM element for `file` and wire selection handlers.
   * The caller appends the returned element to the grid.
   *
   * @param {object} file
   *   { path: string, name: string, is_dir: boolean, is_image: boolean,
   *     is_archive?: boolean, modified_at?: number, archivePath?: string,
   *     innerPath?: string }
   * @param {object} [extras]
   *   Optional dataset overrides applied to the element.
   */
  function createItem(file, extras = {}) {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.dataset.path = file.path;
    item.dataset.isImage = file.is_image ? 'true' : 'false';
    item.dataset.type = file.is_dir ? 'folder' : 'file';
    if (file.modified_at != null) {
      item.dataset.mtime = String(file.modified_at);
    }
    if (extras.archivePath) {
      item.dataset.archivePath = extras.archivePath;
    }

    let placeholderClass = 'file-icon placeholder';
    let iconEmoji = '📄';
    if (file.is_dir) {
      placeholderClass += ' folder';
      iconEmoji = '📁';
    } else if (file.is_archive) {
      placeholderClass += ' archive';
      iconEmoji = '📦';
    } else if (file.is_image) {
      iconEmoji = '🖼️';
    }

    item.innerHTML =
      '<div class="' + placeholderClass + '">' + iconEmoji + '</div>' +
      '<span class="file-name">' + escapeHtml(file.name) + '</span>';

    if (selected.has(file.path)) {
      item.classList.add('selected');
    }
    if (focusPath === file.path) {
      item.classList.add('focused');
    }

    return item;
  }

  /** Replace the entire selection with `paths` (Iterable<string>). */
  function setSelection(paths) {
    selected.clear();
    for (const p of paths) selected.add(p);
    syncDom();
    notifySelection();
  }

  /** Add a single path to the selection. */
  function addToSelection(path) {
    selected.add(path);
    syncDom();
    notifySelection();
  }

  /** Clear the selection. */
  function clearSelection() {
    selected.clear();
    syncDom();
    notifySelection();
  }

  /** Read the current selection as an array (paths in DOM order). */
  function getSelectedPaths() {
    const items = grid ? grid.querySelectorAll('.file-item.selected') : [];
    return Array.from(items).map((el) => el.dataset.path);
  }

  /** True if `path` is currently selected. */
  function isSelected(path) {
    return selected.has(path);
  }

  /**
   * Apply or remove the visual "cut" style across the grid. Called when
   * Ctrl+X writes paths to the clipboard.
   */
  function setCutPaths(paths) {
    grid.querySelectorAll('.file-item.cut').forEach((el) => el.classList.remove('cut'));
    if (!paths || paths.length === 0) return;
    const set = new Set(paths.map(normalizePath));
    grid.querySelectorAll('.file-item').forEach((el) => {
      if (set.has(normalizePath(el.dataset.path))) el.classList.add('cut');
    });
  }

  function clearCutPaths() {
    grid.querySelectorAll('.file-item.cut').forEach((el) => el.classList.remove('cut'));
  }

  /**
   * Begin inline rename on the focused (or sole-selected) item.
   * Replaces the .file-name span with an <input>; Enter commits, Esc cancels.
   */
  async function startInlineRename() {
    const items = Array.from(grid.querySelectorAll('.file-item.selected'));
    if (items.length === 0) {
      opts.showToast && opts.showToast('名前を変更するファイルを選択してください');
      return;
    }
    if (items.length > 1) {
      opts.showToast && opts.showToast('名前の変更は1つのファイルのみ選択してください');
      return;
    }
    inlineRename(items[0]);
  }

  // ---- internals ----

  function syncDom() {
    if (!grid) return;
    grid.querySelectorAll('.file-item').forEach((el) => {
      el.classList.toggle('selected', selected.has(el.dataset.path));
      el.classList.toggle('focused', focusPath === el.dataset.path);
    });
  }

  function notifySelection() {
    opts.onSelectionChanged && opts.onSelectionChanged();
  }

  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function normalizePath(p) {
    return (p || '').replace(/\//g, '\\').toLowerCase();
  }

  function getAllItems() {
    return Array.from(grid.querySelectorAll('.file-item'));
  }

  function setFocus(path) {
    focusPath = path;
    syncDom();
    const el = grid.querySelector(
      '.file-item[data-path="' + cssEscape(path) + '"]',
    );
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  function cssEscape(s) {
    return (window.CSS && window.CSS.escape) ? window.CSS.escape(s) : s.replace(/(["\\])/g, '\\$1');
  }

  // ---- click / selection ----

  function handleEmptyClick(e) {
    if (suppressEmptyClick) {
      suppressEmptyClick = false;
      return;
    }
    if (e.target === grid || e.target.classList.contains('icon-grid')) {
      clearSelection();
      anchor = null;
      focusPath = null;
    }
  }

  function applyClickSelection(item, e) {
    const all = getAllItems();
    const clickedIndex = all.indexOf(item);
    const path = item.dataset.path;

    if (e.shiftKey && anchor !== null) {
      const anchorIndex = all.findIndex((el) => el.dataset.path === anchor);
      if (anchorIndex !== -1) {
        const start = Math.min(anchorIndex, clickedIndex);
        const end = Math.max(anchorIndex, clickedIndex);
        if (!e.ctrlKey) selected.clear();
        for (let i = start; i <= end; i++) {
          selected.add(all[i].dataset.path);
        }
        focusPath = path;
      }
    } else if (e.ctrlKey) {
      if (selected.has(path)) selected.delete(path);
      else selected.add(path);
      anchor = path;
      focusPath = path;
    } else {
      selected.clear();
      selected.add(path);
      anchor = path;
      focusPath = path;
    }
    syncDom();
    notifySelection();
  }

  // ---- mouse: click vs drag vs marquee ----
  // mousedown on a file-item starts a potential drag. mousedown on empty area
  // starts a marquee selection. handleMouseMove decides which branch we're in.
  let pending = null;
  // pending shape (drag): { kind:'drag', paths:string[], startX, startY, started }
  // pending shape (marquee): { kind:'marquee', startX, startY, baseSelection:Set<string>, additive }
  let dragHighlightFolder = null;
  let marqueeEl = null;
  // A marquee drag fires a trailing `click` on the grid background; this flag
  // tells handleEmptyClick to ignore that one click so the just-made selection
  // is not immediately cleared.
  let suppressEmptyClick = false;

  function handleMouseDown(e) {
    if (e.button !== 0) return;
    suppressEmptyClick = false; // fresh interaction
    const item = e.target.closest('.file-item');
    if (item) {
      const wasSelected = selected.has(item.dataset.path);

      // We emit the selection on mousedown rather than click so a drag uses
      // the freshly-updated selection.
      //
      // Case A — clicking an unselected item without modifier:
      //   collapse to that single item immediately (so a follow-up drag
      //   carries only it).
      // Case B — with Ctrl or Shift:
      //   apply range/toggle now.
      // Case C — clicking an already-selected item without modifier:
      //   leave the multi-selection alone for now; if the user releases
      //   without dragging, mouseup collapses to the single clicked item
      //   (Explorer behavior).
      if (!wasSelected && !e.shiftKey && !e.ctrlKey) {
        selected.clear();
        selected.add(item.dataset.path);
        anchor = item.dataset.path;
        focusPath = item.dataset.path;
        syncDom();
        notifySelection();
      } else if (e.ctrlKey || e.shiftKey) {
        applyClickSelection(item, e);
      }

      pending = {
        kind: 'drag',
        paths: getSelectedPaths(),
        startX: e.clientX,
        startY: e.clientY,
        started: false,
        clickedPath: item.dataset.path,
        collapseOnRelease: wasSelected && !e.shiftKey && !e.ctrlKey,
      };
    } else if (e.target === grid || e.target.classList.contains('icon-grid')) {
      // Marquee selection start.
      pending = {
        kind: 'marquee',
        startX: e.clientX,
        startY: e.clientY,
        baseSelection: new Set(selected),
        additive: e.ctrlKey || e.shiftKey,
      };
    }
  }

  function handleMouseMove(e) {
    if (!pending) return;
    const dx = e.clientX - pending.startX;
    const dy = e.clientY - pending.startY;

    if (pending.kind === 'drag') {
      if (!pending.started && Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (!pending.started) {
        pending.started = true;
        startNativeDrag(pending.paths);
        // Native drag takes over via the OS — we don't need to track move/up.
        pending = null;
        return;
      }
    } else if (pending.kind === 'marquee') {
      if (!pending.started && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      if (!pending.started) {
        pending.started = true;
        marqueeEl = document.createElement('div');
        marqueeEl.id = 'fileListMarquee';
        marqueeEl.style.cssText =
          'position:fixed;border:1px solid rgba(59,130,246,0.9);' +
          'background:rgba(59,130,246,0.18);pointer-events:none;z-index:9999;';
        document.body.appendChild(marqueeEl);
      }
      updateMarquee(pending, e);
    }
  }

  function handleMouseUp(_e) {
    if (!pending) return;
    if (pending.kind === 'drag' && !pending.started && pending.collapseOnRelease) {
      // Click (no drag) on a previously-multi-selected item without modifier
      // → collapse to the single clicked item, matching Explorer.
      selected.clear();
      selected.add(pending.clickedPath);
      anchor = pending.clickedPath;
      focusPath = pending.clickedPath;
      syncDom();
      notifySelection();
    }
    if (pending.kind === 'marquee' && pending.started) {
      // Already-applied selection persists; just remove the rectangle.
      if (marqueeEl) {
        marqueeEl.remove();
        marqueeEl = null;
      }
      // Swallow the trailing click so handleEmptyClick doesn't clear it.
      suppressEmptyClick = true;
    }
    pending = null;
    if (dragHighlightFolder) {
      dragHighlightFolder.classList.remove('drag-over');
      dragHighlightFolder = null;
    }
  }

  function updateMarquee(state, e) {
    const left = Math.min(state.startX, e.clientX);
    const top = Math.min(state.startY, e.clientY);
    const w = Math.abs(e.clientX - state.startX);
    const h = Math.abs(e.clientY - state.startY);
    marqueeEl.style.left = left + 'px';
    marqueeEl.style.top = top + 'px';
    marqueeEl.style.width = w + 'px';
    marqueeEl.style.height = h + 'px';

    const next = new Set(state.additive ? state.baseSelection : []);
    for (const item of getAllItems()) {
      const r = item.getBoundingClientRect();
      const overlap =
        r.right >= left && r.left <= left + w && r.bottom >= top && r.top <= top + h;
      if (overlap) next.add(item.dataset.path);
    }
    if (!setEquals(next, selected)) {
      selected.clear();
      next.forEach((p) => selected.add(p));
      syncDom();
      notifySelection();
    }
  }

  function setEquals(a, b) {
    if (a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
  }

  // ---- native drag-out ----

  async function startNativeDrag(paths) {
    if (!paths || paths.length === 0) return;
    const winPaths = paths.map((p) => p.replace(/\//g, '\\'));
    try {
      // default_move: same-drive moves are Explorer's default (no modifier).
      // The OS drop target may override based on Ctrl/Shift held by the user
      // when releasing, so this is only the *suggested* default.
      const result = await opts.invoke('start_native_drag', {
        paths: winPaths,
        defaultMove: true,
      });
      // result is "copy" | "move" | "none". On move, files left our directory.
      if (result === 'move' && opts.onExternalMoveCompleted) {
        opts.onExternalMoveCompleted();
      }
    } catch (err) {
      console.error('start_native_drag failed:', err);
    }
  }

  // ---- double-click ----

  function handleDblClick(e) {
    const item = e.target.closest('.file-item');
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();
    openItem(item);
  }

  function openItem(item) {
    const path = item.dataset.path;
    const isDir = item.dataset.type === 'folder';
    const isImage = item.dataset.isImage === 'true';
    const isArchive = item.querySelector('.file-icon.archive') ||
      (item.querySelector('.archive-thumbnail'));

    if (isImage) {
      const name = item.querySelector('.file-name')?.textContent || '';
      opts.onOpenImage && opts.onOpenImage(path, name);
    } else if (isDir) {
      opts.onOpenFolder && opts.onOpenFolder(path);
    } else if (isArchive) {
      opts.onOpenArchive && opts.onOpenArchive(path);
    }
  }

  // ---- keyboard ----

  function handleKeyDown(e) {
    if (e.target.tagName === 'INPUT') return;

    // Preferred path: route through the runtime dispatcher so user rebindings
    // take effect. Falls back to the legacy hardcoded map when the dispatcher
    // is absent or has not finished loading shortcuts.json yet.
    const D = (typeof window !== 'undefined') && window.ShortcutDispatch;
    if (D && D.isLoaded()) {
      // Space on a focused button must still activate the button.
      if (e.target.tagName === 'BUTTON' && e.key === ' ') return;
      // Empty grid: nothing to navigate; let the event bubble (e.g. Ctrl+C/X/V
      // handled at the document level in index.html).
      if (getAllItems().length === 0) return;
      if (matchListKey(D, e)) e.preventDefault();
      return;
    }

    legacyKeyDown(e);
  }

  // Resolve a keydown to a file-list action via the dispatcher. Ctrl/Shift act
  // as Explorer-style selection modifiers on navigation keys, so if the exact
  // combo isn't bound we retry with those modifiers stripped and run the action
  // with the ORIGINAL event (so navigateArrow/rangeOrJump/toggleAtFocus can read
  // e.shiftKey/e.ctrlKey to extend/move-focus). Copy/cut/paste have no handler
  // here, so they return false and bubble to the document-level handler.
  function matchListKey(D, e) {
    const CAT = 'ファイル一覧ペイン';
    if (D.dispatchKey(CAT, e)) return true;
    if (!e.ctrlKey && !e.shiftKey) return false;
    const stripped = {
      key: e.key, ctrlKey: false, shiftKey: false,
      altKey: e.altKey, metaKey: e.metaKey,
    };
    const id = D.actionForKey(CAT, stripped);
    return id ? D.runAction(id, e) : false;
  }

  // Original hardcoded key handling, kept as a safety fallback (see above).
  function legacyKeyDown(e) {
    const all = getAllItems();
    if (all.length === 0 && !(e.ctrlKey && (e.key === 'c' || e.key === 'x' || e.key === 'v'))) {
      return;
    }

    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowDown':
      case 'ArrowLeft':
      case 'ArrowRight':
        e.preventDefault();
        navigateArrow(e, all);
        break;

      case 'Home':
        e.preventDefault();
        rangeOrJump(e, all, 0);
        break;

      case 'End':
        e.preventDefault();
        rangeOrJump(e, all, all.length - 1);
        break;

      case ' ':
        if (e.target.tagName !== 'BUTTON') {
          e.preventDefault();
          toggleAtFocus(e, all);
        }
        break;

      case 'a':
        if (e.ctrlKey) {
          e.preventDefault();
          for (const it of all) selected.add(it.dataset.path);
          syncDom();
          notifySelection();
        }
        break;

      case 'F2':
        e.preventDefault();
        startInlineRename();
        break;

      case 'Enter': {
        const items = Array.from(grid.querySelectorAll('.file-item.selected'));
        if (items.length === 1) {
          e.preventDefault();
          openItem(items[0]);
        }
        break;
      }

      case 'Backspace':
        e.preventDefault();
        opts.onGoBack && opts.onGoBack();
        break;

      case 'Delete': {
        const items = Array.from(grid.querySelectorAll('.file-item.selected'));
        if (items.length > 0) {
          e.preventDefault();
          opts.onDeleted && opts.onDeleted(items.map((it) => it.dataset.path));
        }
        break;
      }

      case 'Escape':
        clearSelection();
        anchor = null;
        focusPath = null;
        break;
    }
  }

  function focusedIndex(all) {
    if (focusPath) {
      const i = all.findIndex((el) => el.dataset.path === focusPath);
      if (i !== -1) return i;
    }
    const sel = grid.querySelector('.file-item.selected');
    return sel ? all.indexOf(sel) : 0;
  }

  function itemsPerRow() {
    const style = window.getComputedStyle(grid);
    const cols = style.getPropertyValue('grid-template-columns').trim();
    if (!cols) return 1;
    return cols.split(/\s+/).filter(Boolean).length || 1;
  }

  function navigateArrow(e, all, dir) {
    const cur = focusedIndex(all);
    const perRow = itemsPerRow();
    let next = cur;
    // `dir` is supplied by the dispatcher (rebind-safe); the legacy fallback
    // derives it from the physical arrow key.
    const d = dir || ({
      ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    })[e.key];
    switch (d) {
      case 'up':
        if (cur >= perRow) next = cur - perRow;
        break;
      case 'down':
        if (cur + perRow < all.length) next = cur + perRow;
        break;
      case 'left':
        if (cur > 0) next = cur - 1;
        break;
      case 'right':
        if (cur < all.length - 1) next = cur + 1;
        break;
    }
    if (next === cur && focusPath) return;

    if (e.ctrlKey && !e.shiftKey) {
      // Move focus only.
      focusPath = all[next].dataset.path;
    } else if (e.shiftKey) {
      if (anchor === null) anchor = focusPath || all[cur].dataset.path;
      const ai = all.findIndex((el) => el.dataset.path === anchor);
      const start = Math.min(ai, next);
      const end = Math.max(ai, next);
      if (!e.ctrlKey) selected.clear();
      for (let i = start; i <= end; i++) selected.add(all[i].dataset.path);
      focusPath = all[next].dataset.path;
    } else {
      selected.clear();
      selected.add(all[next].dataset.path);
      anchor = all[next].dataset.path;
      focusPath = all[next].dataset.path;
    }
    all[next].scrollIntoView({ block: 'nearest' });
    syncDom();
    notifySelection();
  }

  function rangeOrJump(e, all, target) {
    const cur = focusedIndex(all);
    if (e.shiftKey) {
      const ai = anchor
        ? all.findIndex((el) => el.dataset.path === anchor)
        : cur;
      const start = Math.min(ai, target);
      const end = Math.max(ai, target);
      if (!e.ctrlKey) selected.clear();
      for (let i = start; i <= end; i++) selected.add(all[i].dataset.path);
      focusPath = all[target].dataset.path;
    } else if (!e.ctrlKey) {
      selected.clear();
      selected.add(all[target].dataset.path);
      anchor = all[target].dataset.path;
      focusPath = all[target].dataset.path;
    } else {
      focusPath = all[target].dataset.path;
    }
    all[target].scrollIntoView({ block: 'nearest' });
    syncDom();
    notifySelection();
  }

  function toggleAtFocus(e, all) {
    const cur = focusedIndex(all);
    const path = all[cur].dataset.path;
    if (e.ctrlKey) {
      if (selected.has(path)) selected.delete(path);
      else selected.add(path);
      anchor = path;
    } else {
      selected.clear();
      selected.add(path);
      anchor = path;
    }
    focusPath = path;
    syncDom();
    notifySelection();
  }

  // ---- inline rename ----

  function inlineRename(item) {
    if (inlineRenameInput) return;
    const nameEl = item.querySelector('.file-name');
    if (!nameEl) return;

    const oldName = nameEl.textContent;
    const oldPath = item.dataset.path;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'file-name-input';
    input.value = oldName;
    input.style.cssText =
      'width:100%;box-sizing:border-box;font:inherit;text-align:center;' +
      'padding:1px 2px;border:1px solid #2563eb;background:#fff;color:#000;outline:none;';

    nameEl.style.display = 'none';
    nameEl.parentNode.insertBefore(input, nameEl);
    inlineRenameInput = input;

    // Select the basename without extension to mirror Explorer.
    const dot = oldName.lastIndexOf('.');
    if (dot > 0) {
      input.setSelectionRange(0, dot);
    } else {
      input.select();
    }
    input.focus();

    let finished = false;
    const finish = async (commit) => {
      if (finished) return;
      finished = true;
      const newName = input.value.trim();
      input.remove();
      nameEl.style.display = '';
      inlineRenameInput = null;

      if (!commit || !newName || newName === oldName) return;
      try {
        await opts.invoke('rename_file', {
          oldPath: oldPath.replace(/\//g, '\\'),
          newName: newName,
        });
        nameEl.textContent = newName;
        opts.showToast && opts.showToast('名前を変更しました: ' + newName);
        if (opts.onRenamed) await opts.onRenamed(oldPath, oldName, newName);
      } catch (err) {
        opts.showToast && opts.showToast('名前の変更に失敗しました: ' + err);
      }
    };

    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') {
        ev.preventDefault();
        finish(true);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  }

  // ---- public API ----

  return {
    init,
    createItem,
    setSelection,
    addToSelection,
    clearSelection,
    getSelectedPaths,
    isSelected,
    setCutPaths,
    clearCutPaths,
    startInlineRename,
    setFocus,
    // Expose internals the host page may want for compatibility:
    get selectedSet() { return selected; },
    get anchor() { return anchor; },
    set anchor(p) { anchor = p; },
    get focusPath() { return focusPath; },
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = FileList;
}

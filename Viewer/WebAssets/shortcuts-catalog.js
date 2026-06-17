// ─────────────────────────────────────────────────────────────────────────
//  Shared shortcut catalog + canonical binding-string normalizer.
//
//  Single source of truth for BOTH the settings UI (shortcuts.html) and the
//  runtime dispatcher (shortcut-dispatch.js). Plain script: attaches to
//  `window.ShortcutCatalog`; also exports under CommonJS for Node smoke tests.
//
//  Canonical formats
//  ─────────────────
//  Keyboard : modifiers in fixed order "Ctrl+Alt+Shift+Win+" followed by the
//             canonical key name. Letters are upper-cased, " " -> "Space",
//             "Add"/"Subtract" -> "+"/"-". e.g. "Ctrl+C", "Alt+ArrowLeft", "F11".
//  Mouse    : optional single/stacked modifier prefix (Ctrl/Alt/Shift order)
//             + Japanese base label matching MOUSE_OPTIONS.
//             e.g. "Shift+左クリック", "Ctrl+ホイールアップ", "ダブルクリック".
//  Gesture  : a string of quantized 4-direction arrows, e.g. "→←".
// ─────────────────────────────────────────────────────────────────────────
(function (root) {
  "use strict";

  const CATEGORIES = ["ファイル一覧ペイン", "画像ウィンドウ"];

  const ACTIONS = [
    // ファイル一覧ペイン (FileList が所有する操作)
    { id: "filelist.move_up",        category: "ファイル一覧ペイン", name: "選択を上へ",             defaultShortcut: "ArrowUp",     defaultMouse: "",            defaultGesture: "" },
    { id: "filelist.move_down",      category: "ファイル一覧ペイン", name: "選択を下へ",             defaultShortcut: "ArrowDown",   defaultMouse: "",            defaultGesture: "" },
    { id: "filelist.move_left",      category: "ファイル一覧ペイン", name: "選択を左へ",             defaultShortcut: "ArrowLeft",   defaultMouse: "",            defaultGesture: "" },
    { id: "filelist.move_right",     category: "ファイル一覧ペイン", name: "選択を右へ",             defaultShortcut: "ArrowRight",  defaultMouse: "",            defaultGesture: "" },
    { id: "filelist.move_first",     category: "ファイル一覧ペイン", name: "先頭へ",                 defaultShortcut: "Home",        defaultMouse: "",            defaultGesture: "" },
    { id: "filelist.move_last",      category: "ファイル一覧ペイン", name: "末尾へ",                 defaultShortcut: "End",         defaultMouse: "",            defaultGesture: "" },
    { id: "filelist.select_all",     category: "ファイル一覧ペイン", name: "すべて選択",             defaultShortcut: "Ctrl+A",      defaultMouse: "",            defaultGesture: "" },
    { id: "filelist.toggle_select",  category: "ファイル一覧ペイン", name: "フォーカスの選択をトグル", defaultShortcut: "Space",     defaultMouse: "",            defaultGesture: "" },
    { id: "filelist.clear_selection",category: "ファイル一覧ペイン", name: "選択を解除",             defaultShortcut: "Escape",      defaultMouse: "",            defaultGesture: "" },
    { id: "filelist.rename",         category: "ファイル一覧ペイン", name: "名前の変更",             defaultShortcut: "F2",          defaultMouse: "",            defaultGesture: "" },
    { id: "filelist.open",           category: "ファイル一覧ペイン", name: "開く",                   defaultShortcut: "Enter",       defaultMouse: "ダブルクリック", defaultGesture: "" },
    { id: "filelist.go_back",        category: "ファイル一覧ペイン", name: "戻る（履歴）",           defaultShortcut: "Backspace",      defaultMouse: "",            defaultGesture: "" },
    { id: "filelist.go_up",          category: "ファイル一覧ペイン", name: "上のフォルダーへ",       defaultShortcut: "Alt+ArrowUp",    defaultMouse: "",            defaultGesture: "" },
    { id: "filelist.delete",         category: "ファイル一覧ペイン", name: "ゴミ箱へ移動",           defaultShortcut: "Delete",      defaultMouse: "",            defaultGesture: "" },
    { id: "filelist.copy",           category: "ファイル一覧ペイン", name: "コピー",                 defaultShortcut: "Ctrl+C",      defaultMouse: "",            defaultGesture: "" },
    { id: "filelist.cut",            category: "ファイル一覧ペイン", name: "切り取り",               defaultShortcut: "Ctrl+X",      defaultMouse: "",            defaultGesture: "" },
    { id: "filelist.paste",          category: "ファイル一覧ペイン", name: "貼り付け",               defaultShortcut: "Ctrl+V",      defaultMouse: "",            defaultGesture: "" },
    { id: "filelist.context_menu",   category: "ファイル一覧ペイン", name: "コンテキストメニュー",   defaultShortcut: "",            defaultMouse: "右クリック",      defaultGesture: "" },

    // 画像ウィンドウ (viewer.html)
    { id: "viewer.toggle_fullscreen",category: "画像ウィンドウ", name: "フルスクリーン切替",        defaultShortcut: "F11",        defaultMouse: "",                     defaultGesture: "" },
    { id: "viewer.exit_fullscreen",  category: "画像ウィンドウ", name: "フルスクリーン解除",        defaultShortcut: "Escape",     defaultMouse: "",                     defaultGesture: "" },
    { id: "viewer.increase_count",   category: "画像ウィンドウ", name: "表示枚数を増やす",          defaultShortcut: "+",          defaultMouse: "",                     defaultGesture: "" },
    { id: "viewer.decrease_count",   category: "画像ウィンドウ", name: "表示枚数を減らす",          defaultShortcut: "-",          defaultMouse: "",                     defaultGesture: "" },
    { id: "viewer.prev_image",       category: "画像ウィンドウ", name: "表示枚数分 戻る",            defaultShortcut: "ArrowUp",    defaultMouse: "ホイールアップ",        defaultGesture: "" },
    { id: "viewer.next_image",       category: "画像ウィンドウ", name: "表示枚数分 進む",            defaultShortcut: "ArrowDown",  defaultMouse: "ホイールダウン",        defaultGesture: "" },
    { id: "viewer.slide_forward",    category: "画像ウィンドウ", name: "1枚進む (スライド)",        defaultShortcut: "ArrowLeft",  defaultMouse: "",                     defaultGesture: "" },
    { id: "viewer.slide_backward",   category: "画像ウィンドウ", name: "1枚戻る (スライド)",        defaultShortcut: "ArrowRight", defaultMouse: "",                     defaultGesture: "" },
    { id: "viewer.close",            category: "画像ウィンドウ", name: "ウィンドウを閉じる",        defaultShortcut: "Backspace",  defaultMouse: "Shift+左クリック",     defaultGesture: "→←" },
    { id: "viewer.delete",           category: "画像ウィンドウ", name: "現在の画像をゴミ箱へ",      defaultShortcut: "Delete",     defaultMouse: "",                     defaultGesture: "" },
    { id: "viewer.copy",             category: "画像ウィンドウ", name: "クリップボードへコピー",    defaultShortcut: "Ctrl+C",     defaultMouse: "",                     defaultGesture: "" },
    { id: "viewer.toggle_overlay",   category: "画像ウィンドウ", name: "詳細ペインの開閉",          defaultShortcut: "D",          defaultMouse: "",                     defaultGesture: "" },
    { id: "viewer.rotate_right",     category: "画像ウィンドウ", name: "右に90度回転",              defaultShortcut: "R",          defaultMouse: "",                     defaultGesture: "" },
    { id: "viewer.rotate_left",      category: "画像ウィンドウ", name: "左に90度回転",              defaultShortcut: "L",          defaultMouse: "",                     defaultGesture: "" },
    { id: "viewer.zoom_in",          category: "画像ウィンドウ", name: "拡大",                      defaultShortcut: "",           defaultMouse: "Ctrl+ホイールアップ",  defaultGesture: "" },
    { id: "viewer.zoom_out",         category: "画像ウィンドウ", name: "縮小",                      defaultShortcut: "",           defaultMouse: "Ctrl+ホイールダウン",  defaultGesture: "" },
    { id: "viewer.zoom_reset",       category: "画像ウィンドウ", name: "ズームをリセット",          defaultShortcut: "",           defaultMouse: "Ctrl+中クリック",      defaultGesture: "" },
  ];

  const MOUSE_OPTIONS = [
    "", "中クリック", "右クリック", "ダブルクリック", "ホイールアップ", "ホイールダウン",
    "Shift+左クリック", "Shift+右クリック", "Shift+中クリック",
    "Shift+ホイールアップ", "Shift+ホイールダウン",
    "Alt+左クリック", "Alt+右クリック", "Alt+中クリック",
    "Alt+ホイールアップ", "Alt+ホイールダウン",
    "Ctrl+左クリック", "Ctrl+右クリック", "Ctrl+中クリック",
    "Ctrl+ホイールアップ", "Ctrl+ホイールダウン",
  ];

  // Editability rules. Every remaining category (ファイル一覧ペイン / 画像ウィンドウ)
  // allows keyboard, mouse and gesture bindings, so these are always true. Kept
  // as functions so the settings UI can stay generic.
  function isMouseEditable(_category)   { return true; }
  function isGestureEditable(_category) { return true; }

  // ─── Keyboard normalization ──────────────────────────────────────────
  // Canonicalize a KeyboardEvent.key value to its catalog spelling.
  function canonicalizeKey(key) {
    if (key === " " || key === "Spacebar") return "Space";
    if (key === "Add") return "+";
    if (key === "Subtract") return "-";
    // Single printable letter -> upper-case (Ctrl+c and Ctrl+C must collapse).
    if (key.length === 1) {
      const up = key.toUpperCase();
      return up;
    }
    return key; // ArrowUp, Home, End, Delete, Backspace, Enter, Escape, F2.. etc.
  }

  // Build the canonical key combo string from a KeyboardEvent.
  // Returns "" for modifier-only key presses.
  function keyComboFromEvent(e) {
    const key = e.key;
    if (key === "Control" || key === "Alt" || key === "Shift" || key === "Meta") {
      return "";
    }
    const parts = [];
    if (e.ctrlKey)  parts.push("Ctrl");
    if (e.altKey)   parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    if (e.metaKey)  parts.push("Win");
    parts.push(canonicalizeKey(key));
    return parts.join("+");
  }

  // Re-normalize an already-saved/typed key string into canonical form
  // (used to migrate older overrides or to compare loosely).
  function normalizeKeyString(str) {
    if (!str) return "";
    const segs = str.split("+");
    const mods = { Ctrl: false, Alt: false, Shift: false, Win: false };
    let keyPart = "";
    for (const s of segs) {
      const t = s.trim();
      if (t === "Ctrl" || t === "Control") mods.Ctrl = true;
      else if (t === "Alt") mods.Alt = true;
      else if (t === "Shift") mods.Shift = true;
      else if (t === "Win" || t === "Meta") mods.Win = true;
      else keyPart = t;
    }
    const parts = [];
    if (mods.Ctrl) parts.push("Ctrl");
    if (mods.Alt) parts.push("Alt");
    if (mods.Shift) parts.push("Shift");
    if (mods.Win) parts.push("Win");
    if (keyPart) parts.push(canonicalizeKey(keyPart));
    return parts.join("+");
  }

  // ─── Mouse normalization ─────────────────────────────────────────────
  function mouseButtonLabel(button) {
    if (button === 0) return "左クリック";
    if (button === 1) return "中クリック";
    if (button === 2) return "右クリック";
    return "";
  }

  function mouseModPrefix(e) {
    const parts = [];
    if (e.ctrlKey)  parts.push("Ctrl");
    if (e.altKey)   parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    return parts.length ? parts.join("+") + "+" : "";
  }

  // Build a canonical mouse string from a DOM event.
  //   kind: "click" | "dblclick" | "wheel" | "down" | "up"
  // Returns "" when no meaningful base could be derived.
  function mouseStringFromEvent(e, kind) {
    let base = "";
    if (kind === "dblclick") {
      base = "ダブルクリック";
    } else if (kind === "wheel") {
      if (e.deltaY < 0) base = "ホイールアップ";
      else if (e.deltaY > 0) base = "ホイールダウン";
    } else {
      base = mouseButtonLabel(e.button);
    }
    if (!base) return "";
    return mouseModPrefix(e) + base;
  }

  // ─── Resolve overrides over defaults ─────────────────────────────────
  // saved: { version, bindings: [{id, shortcut, mouse, gesture}] }
  // Returns [{ id, category, name, shortcut, mouse, gesture }] in catalog order.
  function resolveItems(saved) {
    const bindings = (saved && Array.isArray(saved.bindings)) ? saved.bindings : [];
    return ACTIONS.map((a) => {
      const o = bindings.find((b) => b.id === a.id);
      return {
        id: a.id,
        category: a.category,
        name: a.name,
        shortcut: o ? (o.shortcut ?? a.defaultShortcut) : a.defaultShortcut,
        mouse:    o ? (o.mouse    ?? a.defaultMouse)    : a.defaultMouse,
        gesture:  o ? (o.gesture  ?? a.defaultGesture)  : a.defaultGesture,
      };
    });
  }

  const api = {
    CATEGORIES,
    ACTIONS,
    MOUSE_OPTIONS,
    isMouseEditable,
    isGestureEditable,
    canonicalizeKey,
    keyComboFromEvent,
    normalizeKeyString,
    mouseButtonLabel,
    mouseModPrefix,
    mouseStringFromEvent,
    resolveItems,
  };

  root.ShortcutCatalog = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof window !== "undefined" ? window : globalThis);

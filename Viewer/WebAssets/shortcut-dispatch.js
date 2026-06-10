// ─────────────────────────────────────────────────────────────────────────
//  Runtime shortcut dispatcher.
//
//  Loads the user's overrides (shortcuts.json via the `load_shortcuts` Tauri
//  command), merges them over the catalog defaults (shortcuts-catalog.js), and
//  resolves DOM input events to action IDs scoped per category. Panes register
//  a handler function per action ID; unregistered actions simply fall through
//  (return false) so callers can keep their legacy hardcoded behavior during
//  incremental migration.
//
//  Depends on: window.ShortcutCatalog (load shortcuts-catalog.js first).
//  Attaches to: window.ShortcutDispatch.
// ─────────────────────────────────────────────────────────────────────────
(function (root) {
  "use strict";

  const Catalog = root.ShortcutCatalog;
  if (!Catalog) {
    console.error("[shortcut-dispatch] ShortcutCatalog not loaded — include shortcuts-catalog.js first");
  }

  const handlers = new Map();      // actionId -> fn(event)
  let byCat = Object.create(null); // category -> { key:Map, mouse:Map, gesture:Map }
  let loaded = false;
  let listening = false;

  function emptyCat() {
    return { key: new Map(), mouse: new Map(), gesture: new Map() };
  }

  // Build the category-scoped lookup maps from resolved catalog items.
  function buildMaps(items) {
    const next = Object.create(null);
    for (const it of items) {
      const cat = next[it.category] || (next[it.category] = emptyCat());
      if (it.shortcut) cat.key.set(it.shortcut, it.id);
      if (it.mouse)    cat.mouse.set(it.mouse, it.id);
      if (it.gesture)  cat.gesture.set(it.gesture, it.id);
    }
    byCat = next;
  }

  async function fetchSaved() {
    try {
      if (!root.__TAURI__ || !root.__TAURI__.core) return { version: 1, bindings: [] };
      const s = await root.__TAURI__.core.invoke("load_shortcuts");
      return s || { version: 1, bindings: [] };
    } catch (e) {
      console.error("[shortcut-dispatch] load_shortcuts failed:", e);
      return { version: 1, bindings: [] };
    }
  }

  // Load (or reload) bindings. Safe to call repeatedly.
  async function load() {
    const saved = await fetchSaved();
    buildMaps(Catalog.resolveItems(saved));
    loaded = true;
    if (!listening && root.__TAURI__ && root.__TAURI__.event) {
      listening = true;
      try {
        root.__TAURI__.event.listen("shortcuts-updated", () => {
          load().catch((e) => console.error("[shortcut-dispatch] reload failed:", e));
        });
      } catch (e) {
        console.error("[shortcut-dispatch] could not subscribe to shortcuts-updated:", e);
      }
    }
    return byCat;
  }

  // ─── Registration ────────────────────────────────────────────────────
  function register(actionId, fn) {
    handlers.set(actionId, fn);
  }
  function registerAll(map) {
    for (const id of Object.keys(map)) handlers.set(id, map[id]);
  }

  // ─── Lookup ──────────────────────────────────────────────────────────
  function actionForKey(category, e) {
    const cat = byCat[category];
    if (!cat) return null;
    const combo = Catalog.keyComboFromEvent(e);
    if (!combo) return null;
    return cat.key.get(combo) || null;
  }
  function actionForMouse(category, e, kind) {
    const cat = byCat[category];
    if (!cat) return null;
    const str = Catalog.mouseStringFromEvent(e, kind);
    if (!str) return null;
    return cat.mouse.get(str) || null;
  }
  function actionForGesture(category, gestureStr) {
    const cat = byCat[category];
    if (!cat || !gestureStr) return null;
    return cat.gesture.get(gestureStr) || null;
  }

  // ─── Dispatch (returns true when an action handler ran) ───────────────
  function run(actionId, e) {
    if (!actionId) return false;
    const fn = handlers.get(actionId);
    if (!fn) return false;       // no handler yet -> let caller fall through
    fn(e, actionId);
    return true;
  }
  function dispatchKey(category, e)        { return run(actionForKey(category, e), e); }
  function dispatchMouse(category, e, kind){ return run(actionForMouse(category, e, kind), e); }
  function dispatchGesture(category, str)  { return run(actionForGesture(category, str), null); }

  // Run a specific action id with an event (used by panes that resolve the
  // action themselves, e.g. modifier-stripped selection navigation).
  function runAction(actionId, e) { return run(actionId, e); }

  root.ShortcutDispatch = {
    load,
    register,
    registerAll,
    actionForKey,
    actionForMouse,
    actionForGesture,
    dispatchKey,
    dispatchMouse,
    dispatchGesture,
    runAction,
    isLoaded: () => loaded,
    _maps: () => byCat,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.ShortcutDispatch;
  }
})(typeof window !== "undefined" ? window : globalThis);

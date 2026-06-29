// 詳細ペインのグルー（仕様 §6：生成AIメタデータ表示）。
// 一覧ペイン→ホスト→このペインへ 'show_details' イベントで選択が届く（仕様 §0）。
// 抽出は C# 側（AiImageMetadataService, ../chbrowser から移植）が担い、ここは整形表示のみ。
(function () {
  'use strict';
  const invoke = window.invoke;
  const preview = document.getElementById('preview');
  const info = document.getElementById('info');

  function isImage(path) { return /\.(jpe?g|png|gif|webp|bmp|tiff?)$/i.test(path); }
  function isArchive(path) { return /\.(zip|7z|rar)$/i.test(path); }

  // 一覧ペインと同じく、フォルダー/圧縮ファイルのサムネイル表示は設定で ON/OFF できる。
  // 「一覧でサムネイルが出ているフォルダー/書庫」だけ詳細ペインにも出す、という要件のため
  // ここでもフラグを尊重する（既定は ON。get_view_settings で初期化し、変更通知で追従）。
  let showFolderThumbs = true;
  let showArchiveThumbs = true;
  function applyThumbSettings(vs) {
    if (!vs) return;
    if (typeof vs.folder_thumbnails === 'boolean') showFolderThumbs = vs.folder_thumbnails;
    if (typeof vs.archive_thumbnails === 'boolean') showArchiveThumbs = vs.archive_thumbnails;
  }
  invoke('get_view_settings').then(applyThumbSettings).catch(() => {});

  // 選択が短時間で切り替わったとき、古い非同期サムネイル取得が新しい表示を上書きしないよう
  // 通し番号でガードする。
  let showSeq = 0;

  function fmtSize(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return bytes + ' B';
    const u = ['KB', 'MB', 'GB', 'TB'];
    let v = bytes / 1024, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(1) + ' ' + u[i];
  }
  function fmtDate(ms) { try { return new Date(ms).toLocaleString('ja-JP'); } catch { return ''; } }

  function srcUrl(path, archivePath) {
    if (archivePath)
      return 'https://file.viewer/raw?a=' + encodeURIComponent(archivePath) + '&i=' + encodeURIComponent(path);
    return 'https://file.viewer/raw?p=' + encodeURIComponent(path);
  }

  async function show(paths, archivePath) {
    const my = ++showSeq;
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
      img.src = srcUrl(path, archivePath);
      preview.appendChild(img);
    }

    if (isImage(path)) {
      let md = null;
      try {
        md = archivePath
          ? await invoke('get_image_details', { archivePath, innerPath: path })
          : await invoke('get_image_details', { path });
      } catch {}
      if (my !== showSeq) return;
      renderImage(name, md);
    } else {
      let fi = null;
      try { fi = await invoke('get_file_info', { path }); } catch {}
      if (my !== showSeq) return;
      renderBasic(name, fi);
      // フォルダー / 圧縮ファイル（書庫の外で選択されたもの）は、一覧と同じく中の1枚目を
      // サムネイルとしてプレビュー表示する。書庫の中にいるとき（archivePath あり）は対象外。
      if (!archivePath) showFolderOrArchiveThumb(my, path, fi);
    }
  }

  // フォルダー/圧縮ファイルの中の1枚目を取得してプレビューに表示する（一覧の loadThumbHosts 相当）。
  function showFolderOrArchiveThumb(my, path, fi) {
    const isDir = fi && fi.is_dir;
    const arc = !isDir && isArchive(path);
    if (isDir && !showFolderThumbs) return;
    if (arc && !showArchiveThumbs) return;
    if (!isDir && !arc) return;

    if (isDir) {
      invoke('get_folder_first_image', { path }).then((imgPath) => {
        if (my !== showSeq || !imgPath) return;
        setPreviewThumb('https://file.viewer/raw?p=' + encodeURIComponent(imgPath));
      }).catch(() => {});
    } else {
      invoke('get_archive_first_image', { archivePath: path }).then((inner) => {
        if (my !== showSeq || !inner) return;
        setPreviewThumb('https://file.viewer/raw?a=' + encodeURIComponent(path) +
          '&i=' + encodeURIComponent(inner));
      }).catch(() => {});
    }
  }

  function setPreviewThumb(url) {
    preview.innerHTML = '';
    const img = document.createElement('img');
    img.decoding = 'async';
    img.src = url;
    preview.appendChild(img);
  }

  function renderImage(name, md) {
    const parts = ['<div class="name">' + esc(name) + '</div>'];
    if (md) {
      if (md.has_ai_data) {
        if (md.generator) parts.push(row('生成元', md.generator));
        if (md.model) parts.push(row('モデル', md.model));
      }
      parts.push(row('形式', md.format));
      if (md.width && md.height) parts.push(row('画像サイズ', md.width + ' × ' + md.height));
      parts.push(row('サイズ', fmtSize(md.file_size)));

      if (md.has_ai_data) {
        if (md.positive) parts.push(promptBlock('プロンプト', md.positive));
        if (md.negative) parts.push(promptBlock('ネガティブ', md.negative, true));
        const ps = md.parameters || {};
        const keys = Object.keys(ps).filter((k) => k !== 'Model' && k !== 'Generator');
        if (keys.length) {
          parts.push('<div class="section">生成パラメータ</div><div class="grid">');
          for (const k of keys) parts.push(cell(k, ps[k]));
          parts.push('</div>');
        }
      }
    }
    info.innerHTML = parts.join('');
  }

  function renderBasic(name, fi) {
    const parts = ['<div class="name">' + esc(name) + '</div>'];
    if (fi) {
      parts.push(row('種類', fi.is_dir ? 'フォルダー' : 'ファイル'));
      if (!fi.is_dir) parts.push(row('サイズ', fmtSize(fi.size)));
      parts.push(row('更新日時', fmtDate(fi.modified_at)));
    }
    info.innerHTML = parts.join('');
  }

  function row(k, v) {
    return '<div class="row"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + '</span></div>';
  }
  function cell(k, v) {
    return '<div class="pk">' + esc(k) + '</div><div class="pv">' + esc(v) + '</div>';
  }
  function promptBlock(label, text, neg) {
    return '<div class="section">' + esc(label) + '</div>' +
      '<div class="prompt' + (neg ? ' neg' : '') + '">' + esc(text) + '</div>';
  }
  function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  function escapeHtml(text) { return esc(text); }

  // ========== タグフィルター（元 viewer 互換・仕様 §7） ==========
  // 元アプリ(index.html)の挙動をそのまま移植：
  //   - Positive / Negative / Model の3タブ
  //   - 各タグはクリックで none → AND → OR → none と循環（Model は none → OR の2状態）
  //   - チェックしたタグは上部サマリにカテゴリ別でリストアップされ × で除去
  //   - 「タグなし」マスター、検索ボックス、「全はずし」ボタン
  // 元アプリは1ドキュメント内で一覧DOMを直接 show/hide していたが、本アプリは
  // 一覧と詳細が別 WebView のため、ここで可視パス集合を算出して host 経由で
  // 一覧ペインへ配信する（apply_tag_filter → tag_filter イベント）。

  const TAG_CATEGORIES = ['positive', 'negative', 'model'];
  const TAG_LABELS = { positive: 'Positive', negative: 'Negative', model: 'Model' };
  // カテゴリ毎の状態循環。Model は1画像1値なので AND は常に空 → 2状態のみ。
  const STATE_CYCLE = {
    positive: ['none', 'and', 'or'],
    negative: ['none', 'and', 'or'],
    model: ['none', 'or'],
  };

  // path -> { positive:Set, negative:Set, model:Set, hasPrompt:bool }
  let tagDataByPath = new Map();
  // category -> Map<tag, count>
  let allTags = { positive: new Map(), negative: new Map(), model: new Map() };
  // 有効フィルタ。値は 'and' | 'or'。none のタグは入れない。
  let tagCheckedState = { positive: new Map(), negative: new Map(), model: new Map(), noTag: false };
  // サマリに表示中の項目。none に戻してもサマリ内なら残る（× で除去）。
  let summaryList = { positive: new Set(), negative: new Set(), model: new Set(), noTag: false };
  let activeTagTab = 'positive';
  let tagLoadingAbort = null;

  function getTagState(category, tag) { return tagCheckedState[category].get(tag) || 'none'; }

  function cycleTagState(category, tag, fromSummary) {
    const cycle = STATE_CYCLE[category] || ['none', 'and', 'or'];
    const current = getTagState(category, tag);
    const next = cycle[(cycle.indexOf(current) + 1) % cycle.length];
    if (next === 'none') {
      tagCheckedState[category].delete(tag);
      if (!fromSummary) summaryList[category].delete(tag);
    } else {
      tagCheckedState[category].set(tag, next);
      summaryList[category].add(tag);
    }
    updateToggleVisuals(category, tag);
    applyTagFilter();
    updateTabFilterIndicators();
    renderTagFilterSummary();
  }

  function toggleNoTag(fromSummary) {
    const next = !tagCheckedState.noTag;
    tagCheckedState.noTag = next;
    if (next) summaryList.noTag = true;
    else if (!fromSummary) summaryList.noTag = false;
    syncNoTagCheckboxes();
    applyTagFilter();
    updateTabFilterIndicators();
    renderTagFilterSummary();
  }

  function removeFromSummary(category, tag) {
    if (category === '__noTag__') {
      tagCheckedState.noTag = false;
      summaryList.noTag = false;
      syncNoTagCheckboxes();
    } else {
      tagCheckedState[category].delete(tag);
      summaryList[category].delete(tag);
      updateToggleVisuals(category, tag);
    }
    applyTagFilter();
    updateTabFilterIndicators();
    renderTagFilterSummary();
  }

  function updateToggleVisuals(category, tag) {
    const body = document.getElementById('tagFilterBody');
    if (!body) return;
    const state = getTagState(category, tag);
    const label = state === 'none' ? '' : state.toUpperCase();
    body.querySelectorAll('.tag-state-toggle[data-section="' + category + '"]').forEach((el) => {
      if (el.dataset.tag !== tag) return;
      el.dataset.state = state;
      el.className = 'tag-state-toggle state-' + state;
      el.textContent = label;
    });
  }

  function syncNoTagCheckboxes() {
    const body = document.getElementById('tagFilterBody');
    if (!body) return;
    body.querySelectorAll('#tagFilter_noTag').forEach((cb) => { cb.checked = tagCheckedState.noTag; });
    const summary = document.getElementById('tagFilterSummary');
    if (summary) summary.querySelectorAll('input[data-summary-notag="1"]').forEach((cb) => { cb.checked = tagCheckedState.noTag; });
  }

  // タグ正規化（元アプリと同一）。
  function normalizeTag(raw) {
    let tag = raw.trim().toLowerCase();
    if (!tag) return '';
    if (tag.startsWith('<') && tag.endsWith('>')) {
      const inner = tag.slice(1, -1);
      const parts = inner.split(':').map((p) => p.trim());
      if (parts.length >= 3 && parts[0] === 'lora') {
        const name = parts.slice(1, -1).join(':');
        return '<lora:' + name.replace(/[_\s]+/g, ' ').trim() + '>';
      }
    }
    while (tag.startsWith('(') && tag.endsWith(')')) tag = tag.slice(1, -1).trim();
    const weightMatch = tag.match(/^(.+?)\s*:\s*-?\d*\.?\d+\s*$/);
    if (weightMatch && weightMatch[1].trim()) tag = weightMatch[1].trim();
    tag = tag.replace(/[_\s]+/g, ' ').trim();
    return tag;
  }

  function splitTags(text) {
    if (!text) return [];
    return text.split(',').map((t) => normalizeTag(t)).filter((t) => t.length > 0);
  }

  // C# が抽出済みの {positive, negative, model} からカテゴリ別タグを作る。
  function tagsFromEntry(item) {
    const positive = splitTags(item.positive);
    const negative = splitTags(item.negative);
    // Model は元アプリ同様、丸ごと1タグ（カンマ分割・重み除去なし、trim のみ）。
    const modelRaw = (typeof item.model === 'string') ? item.model.trim() : '';
    const model = modelRaw ? [modelRaw] : [];
    return { positive, negative, model };
  }

  async function loadTagsForDirectory() {
    if (tagLoadingAbort) tagLoadingAbort.aborted = true;
    const abort = { aborted: false };
    tagLoadingAbort = abort;

    const body = document.getElementById('tagFilterBody');

    // 状態リセット
    tagDataByPath = new Map();
    allTags = { positive: new Map(), negative: new Map(), model: new Map() };
    tagCheckedState = { positive: new Map(), negative: new Map(), model: new Map(), noTag: false };
    summaryList = { positive: new Set(), negative: new Set(), model: new Set(), noTag: false };
    applyTagFilter(); // 既存の絞り込みを解除

    body.innerHTML = '<div class="tag-filter-loading">タグ読み込み中...</div>';

    let prompts = [];
    try { prompts = await invoke('get_all_image_prompts'); } catch { prompts = []; }
    if (abort.aborted) return;
    if (!Array.isArray(prompts)) prompts = [];

    for (const item of prompts) {
      const tags = tagsFromEntry(item);
      const hasAny = tags.positive.length > 0 || tags.negative.length > 0 || tags.model.length > 0;
      if (hasAny) {
        tagDataByPath.set(item.path, {
          positive: new Set(tags.positive), negative: new Set(tags.negative),
          model: new Set(tags.model), hasPrompt: true,
        });
        for (const cat of TAG_CATEGORIES)
          for (const t of tags[cat]) allTags[cat].set(t, (allTags[cat].get(t) || 0) + 1);
      } else {
        tagDataByPath.set(item.path, { positive: new Set(), negative: new Set(), model: new Set(), hasPrompt: false });
      }
    }
    if (abort.aborted) return;
    renderTagFilterUI();
  }

  function renderTagFilterUI() {
    const body = document.getElementById('tagFilterBody');
    if (!body) return;

    const sortByCount = (tagMap) => [...tagMap.entries()].sort((a, b) => b[1] - a[1]);
    const visibleCats = TAG_CATEGORIES.filter((cat) => allTags[cat] && allTags[cat].size > 0);
    if (!visibleCats.includes(activeTagTab)) activeTagTab = visibleCats[0] || 'positive';

    let html = '';

    const noTagCount = [...tagDataByPath.values()].filter((d) => !d.hasPrompt).length;
    if (noTagCount > 0) {
      html += '<div class="tag-filter-notag"><div class="tag-filter-item">' +
        '<input type="checkbox" id="tagFilter_noTag"' + (tagCheckedState.noTag ? ' checked' : '') + '>' +
        '<span class="tag-name">タグなし</span><span class="tag-count">' + noTagCount + '</span>' +
        '</div></div>';
    }

    // タブ列（カテゴリが空でも「フィルター」タイトルと全はずしは表示）
    html += '<div class="tag-filter-tabs">';
    html += '<span class="tag-filter-tabs-title">フィルター<span id="tagFilterStatus"></span></span>';
    for (const cat of visibleCats) {
      const isActive = activeTagTab === cat ? 'active' : '';
      const hasFilter = tagCheckedState[cat].size > 0 ? 'has-filter' : '';
      html += '<div class="tag-filter-tab ' + isActive + ' ' + hasFilter + '" data-tab="' + cat + '">' +
        '<span class="tag-filter-tab-indicator" title="フィルタ適用中">●</span>' +
        '<span>' + escapeHtml(TAG_LABELS[cat] || cat) + '</span></div>';
    }
    html += '<span class="tag-filter-tabs-spacer"></span>';
    html += '<button class="tag-filter-btn" id="tagUncheckAll">全はずし</button>';
    html += '</div>';

    if (visibleCats.length > 0) {
      html += '<div class="tag-filter-panes">';
      for (const cat of visibleCats) {
        const isActive = activeTagTab === cat ? 'active' : '';
        html += '<div class="tag-filter-tab-pane ' + isActive + '" data-tab="' + cat + '">';
        html += '<div class="tag-filter-search"><input type="text" data-search-cat="' + cat + '" placeholder="フィルタ..."></div>';
        html += '<div class="tag-filter-section-list" data-list-cat="' + cat + '">';
        for (const [tag, count] of sortByCount(allTags[cat])) {
          const state = getTagState(cat, tag);
          const label = state === 'none' ? '' : state.toUpperCase();
          html += '<div class="tag-filter-item">' +
            '<span class="tag-state-toggle state-' + state + '" data-section="' + cat + '" data-tag="' + escapeHtml(tag) + '" data-state="' + state + '">' + label + '</span>' +
            '<span class="tag-name" title="' + escapeHtml(tag) + '">' + escapeHtml(tag) + '</span>' +
            '<span class="tag-count">' + count + '</span></div>';
        }
        html += '</div></div>';
      }
      html += '</div>';
    }

    body.innerHTML = html;

    const noTagCb = document.getElementById('tagFilter_noTag');
    if (noTagCb) noTagCb.addEventListener('change', () => toggleNoTag(false));

    const uncheckAllBtn = document.getElementById('tagUncheckAll');
    if (uncheckAllBtn) {
      uncheckAllBtn.addEventListener('click', () => {
        for (const cat of TAG_CATEGORIES) { tagCheckedState[cat].clear(); summaryList[cat].clear(); }
        tagCheckedState.noTag = false;
        summaryList.noTag = false;
        renderTagFilterUI();
        applyTagFilter();
      });
    }

    body.querySelectorAll('.tag-filter-tab-pane .tag-state-toggle').forEach((el) => {
      el.addEventListener('click', () => cycleTagState(el.dataset.section, el.dataset.tag, false));
    });
    body.querySelectorAll('input[data-search-cat]').forEach((input) => {
      input.addEventListener('input', () => filterTagList(input.dataset.searchCat, input.value));
    });
    body.querySelectorAll('.tag-filter-tab').forEach((tabEl) => {
      tabEl.addEventListener('click', () => {
        const tab = tabEl.dataset.tab;
        if (activeTagTab === tab) return;
        activeTagTab = tab;
        body.querySelectorAll('.tag-filter-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
        body.querySelectorAll('.tag-filter-tab-pane').forEach((p) => p.classList.toggle('active', p.dataset.tab === tab));
      });
    });

    renderTagFilterSummary();
    updateTagFilterStatus();
  }

  function renderTagFilterSummary() {
    const summary = document.getElementById('tagFilterSummary');
    if (!summary) return;
    let html = '';
    let hasAny = false;

    for (const cat of TAG_CATEGORIES) {
      const tags = [...summaryList[cat]];
      if (tags.length === 0) continue;
      hasAny = true;
      html += '<div class="tag-filter-summary-group">';
      html += '<div class="tag-filter-summary-group-title">' + escapeHtml(TAG_LABELS[cat]) + '</div>';
      html += '<div class="tag-filter-summary-items">';
      for (const tag of tags) {
        const state = getTagState(cat, tag);
        const label = state === 'none' ? '' : state.toUpperCase();
        const count = allTags[cat].get(tag) || 0;
        html += '<div class="tag-filter-item">' +
          '<span class="tag-state-toggle state-' + state + '" data-section="' + cat + '" data-tag="' + escapeHtml(tag) + '" data-state="' + state + '" data-summary="1">' + label + '</span>' +
          '<span class="tag-name" title="' + escapeHtml(tag) + '">' + escapeHtml(tag) + '</span>' +
          '<span class="tag-count">' + count + '</span>' +
          '<span class="tag-summary-remove" data-section="' + cat + '" data-tag="' + escapeHtml(tag) + '" title="フィルタから外す">×</span>' +
          '</div>';
      }
      html += '</div></div>';
    }

    if (summaryList.noTag) {
      hasAny = true;
      const noTagCount = [...tagDataByPath.values()].filter((d) => !d.hasPrompt).length;
      html += '<div class="tag-filter-summary-group">';
      html += '<div class="tag-filter-summary-group-title">タグなし</div>';
      html += '<div class="tag-filter-summary-items"><div class="tag-filter-item">' +
        '<input type="checkbox" data-summary-notag="1"' + (tagCheckedState.noTag ? ' checked' : '') + '>' +
        '<span class="tag-name">タグなし</span><span class="tag-count">' + noTagCount + '</span>' +
        '<span class="tag-summary-remove" data-summary-notag="1" title="フィルタから外す">×</span>' +
        '</div></div></div>';
    }

    summary.innerHTML = html;
    summary.classList.toggle('empty', !hasAny);

    summary.querySelectorAll('.tag-state-toggle').forEach((el) => {
      el.addEventListener('click', () => cycleTagState(el.dataset.section, el.dataset.tag, true));
    });
    summary.querySelectorAll('input[data-summary-notag="1"]').forEach((cb) => {
      cb.addEventListener('change', () => toggleNoTag(true));
    });
    summary.querySelectorAll('.tag-summary-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.summaryNotag === '1') removeFromSummary('__noTag__', null);
        else removeFromSummary(btn.dataset.section, btn.dataset.tag);
      });
    });
  }

  function filterTagList(category, query) {
    const body = document.getElementById('tagFilterBody');
    if (!body) return;
    const list = body.querySelector('[data-list-cat="' + category + '"]');
    if (!list) return;
    const q = query.toLowerCase().trim();
    list.querySelectorAll('.tag-filter-item').forEach((item) => {
      const toggle = item.querySelector('[data-tag]');
      const tag = toggle ? toggle.dataset.tag : '';
      item.style.display = (!q || tag.includes(q)) ? '' : 'none';
    });
  }

  function updateTabFilterIndicators() {
    const body = document.getElementById('tagFilterBody');
    if (!body) return;
    body.querySelectorAll('.tag-filter-tab').forEach((tabEl) => {
      tabEl.classList.toggle('has-filter', tagCheckedState[tabEl.dataset.tab].size > 0);
    });
  }

  // 絞り込みを実行。可視パス集合を算出し、host 経由で一覧へ配信する。
  function applyTagFilter() {
    const filtersByCat = {};
    let totalActive = 0;
    for (const cat of TAG_CATEGORIES) {
      const andSet = new Set();
      const orSet = new Set();
      for (const [tag, state] of tagCheckedState[cat]) {
        if (state === 'and') andSet.add(tag);
        else if (state === 'or') orSet.add(tag);
      }
      filtersByCat[cat] = { andSet, orSet };
      totalActive += andSet.size + orSet.size;
    }
    const anyChecked = totalActive > 0 || tagCheckedState.noTag;

    if (!anyChecked) {
      invoke('apply_tag_filter', { active: false, paths: [] }).catch(() => {});
      updateTagFilterStatus(tagDataByPath.size, tagDataByPath.size);
      return;
    }

    const matched = [];
    for (const [path, data] of tagDataByPath) {
      let show;
      if (!data.hasPrompt) {
        show = tagCheckedState.noTag; // タグなし画像は noTag チェック時のみ
      } else if (totalActive === 0 && tagCheckedState.noTag) {
        show = false; // noTag のみ有効ならタグ付き画像は除外
      } else {
        show = true;
        for (const cat of TAG_CATEGORIES) {
          const { andSet, orSet } = filtersByCat[cat];
          for (const tag of andSet) { if (!data[cat].has(tag)) { show = false; break; } }
          if (!show) break;
          if (orSet.size > 0) {
            let matchAny = false;
            for (const tag of orSet) { if (data[cat].has(tag)) { matchAny = true; break; } }
            if (!matchAny) { show = false; break; }
          }
        }
      }
      if (show) matched.push(path);
    }

    invoke('apply_tag_filter', { active: true, paths: matched }).catch(() => {});
    updateTagFilterStatus(matched.length, tagDataByPath.size);
  }

  function updateTagFilterStatus(visible, total) {
    const status = document.getElementById('tagFilterStatus');
    if (!status) return;
    const anyActive = tagCheckedState.noTag || TAG_CATEGORIES.some((c) => tagCheckedState[c].size > 0);
    status.textContent = anyActive ? ('(' + visible + '/' + total + ')') : '';
  }

  // パネル高さのドラッグリサイズ（元アプリ互換）。
  function setupTagPanelResizer() {
    const resizer = document.getElementById('tagFilterPanelResizer');
    const panel = document.getElementById('tagFilterPanel');
    if (!resizer || !panel) return;
    let resizing = false, startY = 0, startH = 0;
    resizer.addEventListener('mousedown', (e) => {
      resizing = true; startY = e.clientY; startH = panel.offsetHeight;
      resizer.classList.add('dragging');
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!resizing) return;
      const delta = startY - e.clientY; // 上方向ドラッグで拡大
      const maxH = window.innerHeight - 80;
      panel.style.height = Math.max(36, Math.min(maxH, startH + delta)) + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!resizing) return;
      resizing = false;
      resizer.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  }

  // プレビュー画像領域の高さをドラッグで変更（元 viewer 互換）。
  function setupPreviewResizer() {
    const resizer = document.getElementById('previewResizer');
    const preview = document.getElementById('preview');
    if (!resizer || !preview) return;
    let resizing = false, startY = 0, startH = 0;
    resizer.addEventListener('mousedown', (e) => {
      resizing = true; startY = e.clientY; startH = preview.offsetHeight;
      resizer.classList.add('dragging');
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!resizing) return;
      const newH = Math.max(40, startH + (e.clientY - startY));
      preview.style.height = newH + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!resizing) return;
      resizing = false;
      resizer.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  }

  setupPreviewResizer();
  setupTagPanelResizer();
  renderTagFilterUI(); // 初期空タブ列を描画

  if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen('show_details', (e) => {
      const p = e && e.payload;
      show(p && p.paths, p && p.archive_path);
    });
    // フォルダーが変わったらタグ一覧を再構築（仕様 §7）。
    window.__TAURI__.event.listen('folder_changed', () => loadTagsForDirectory());
    // サムネイル表示設定の変更に追従（フォルダー/書庫のサムネイル ON/OFF）。
    window.__TAURI__.event.listen('view_settings_changed', (e) => applyThumbSettings(e && e.payload));
  }
  // 初期化直後にこのタブのフォルダのタグを取得（folder_changed をリスナー登録前に
  // 取り逃しても、ここで現在フォルダ分を読み込んで整合させる。タブごと詳細インスタンス用）。
  loadTagsForDirectory().catch(() => {});
})();

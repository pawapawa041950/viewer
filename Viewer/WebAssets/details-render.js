// 詳細ペインの HTML 生成（画像ウィンドウ viewer-glue.js / 動画ウィンドウ video-glue.js 共用）。
// md は get_image_details の戻り値（AiImageMetadata の snake_case JSON）。
window.DetailsRender = (() => {
  'use strict';
  function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function row(k, v) { return '<div class="row"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + '</span></div>'; }
  // Contex Loop 等の複数シーン構成でホストが挿入する区切り見出し行
  // （"── 共通プレフィックス ──" / "── シーン 1/6 [0:00.0–0:05.0]: id ──"）だけ色を変える。
  function promptHtml(text) {
    return String(text == null ? '' : text).split('\n')
      .map((line) => line.indexOf('──') === 0
        ? '<span class="prompt-scene-header">' + esc(line) + '</span>'
        : esc(line))
      .join('\n');
  }
  function render(name, md) {
    const parts = ['<div class="name">' + esc(name) + '</div>'];
    if (md) {
      if (md.has_ai_data) {
        if (md.generator) parts.push(row('生成元', md.generator));
        if (md.model) parts.push(row('モデル', md.model));
      }
      parts.push(row('形式', md.format));
      if (md.width && md.height) parts.push(row('画像サイズ', md.width + ' × ' + md.height));
      if (md.has_ai_data) {
        if (md.positive) parts.push('<div class="section">プロンプト</div><div class="prompt">' + promptHtml(md.positive) + '</div>');
        if (md.negative) parts.push('<div class="section">ネガティブ</div><div class="prompt neg">' + promptHtml(md.negative) + '</div>');
        const ps = md.parameters || {};
        const keys = Object.keys(ps).filter((k) => k !== 'Model' && k !== 'Generator');
        if (keys.length) {
          parts.push('<div class="section">生成パラメータ</div><div class="grid">');
          for (const k of keys) parts.push('<div class="pk">' + esc(k) + '</div><div class="pv">' + esc(ps[k]) + '</div>');
          parts.push('</div>');
        }
      }
    }
    return parts.join('');
  }
  return { render };
})();

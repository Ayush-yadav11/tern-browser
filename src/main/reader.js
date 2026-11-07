'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ISOLATED_WORLD = 1001;
const MIN_ARTICLE_LENGTH = 200;
const ALLOWED_TAGS = new Set([
  'a', 'article', 'b', 'blockquote', 'br', 'code', 'dd', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 'section', 'span', 'strong',
  'sub', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u', 'ul',
]);

// Runs in the page's process but out of reach of its scripts. Only a short list of tags
// and attributes survives, so nothing active from the page gets into the reader.
function extract(allowedTags, minLength) {
  const article = new Readability(document.cloneNode(true)).parse();
  if (!article || (article.textContent ?? '').trim().length < minLength) return null;
  const allowed = new Set(allowedTags);
  const parsed = new DOMParser().parseFromString(article.content, 'text/html');
  const isWeb = (value, base) => {
    try {
      return /^https?:$/.test(new URL(value, base).protocol);
    } catch {
      return false;
    }
  };
  for (const el of [...parsed.body.querySelectorAll('*')]) {
    const tag = el.tagName.toLowerCase();
    if (!allowed.has(tag)) {
      if (['script', 'style', 'iframe', 'object', 'embed', 'form', 'svg', 'math', 'link', 'meta', 'base', 'noscript', 'template'].includes(tag)) el.remove();
      else el.replaceWith(...el.childNodes);
      continue;
    }
    const href = el.getAttribute('href');
    const src = el.getAttribute('src');
    const alt = el.getAttribute('alt');
    const colspan = el.getAttribute('colspan');
    const rowspan = el.getAttribute('rowspan');
    for (const attribute of [...el.attributes]) el.removeAttribute(attribute.name);
    if (tag === 'a' && href && isWeb(href, document.baseURI)) el.setAttribute('href', new URL(href, document.baseURI).href);
    if (tag === 'img') {
      if (src && isWeb(src, document.baseURI)) el.setAttribute('src', new URL(src, document.baseURI).href);
      else el.remove();
      if (alt) el.setAttribute('alt', alt);
    }
    if (colspan) el.setAttribute('colspan', colspan);
    if (rowspan) el.setAttribute('rowspan', rowspan);
  }
  return {
    title: article.title ?? document.title,
    byline: article.byline ?? '',
    site: article.siteName ?? '',
    length: article.textContent.trim().length,
    content: parsed.body.innerHTML,
  };
}

let library = null;
function readabilitySource() {
  if (library === null) {
    library = fs.readFileSync(path.join(path.dirname(require.resolve('@mozilla/readability')), 'Readability.js'), 'utf8');
  }
  return library;
}

async function extractArticle(contents) {
  const call = `(${extract})(${JSON.stringify([...ALLOWED_TAGS])}, ${MIN_ARTICLE_LENGTH})`;
  // One script, because this call only returns the result of the first one it's given.
  return contents.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: `${readabilitySource()}\n;${call}` }]);
}

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const minutes = (length) => Math.max(1, Math.round(length / 1200));

// Scripts are also off in the view showing this, so this policy is a second lock, not the only one.
function readerPage(article, { pageUrl }) {
  const images = pageUrl.startsWith('https:') ? 'https: data:' : 'https: http: data:';
  const csp = `default-src 'none'; img-src ${images}; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'`;
  const meta = [article.byline, article.site, `${minutes(article.length)} min read`].filter(Boolean).map(escapeHtml).join(' &middot; ');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(article.title)}</title>
<style>
html { color-scheme: var(--reader-scheme, dark); background: var(--reader-bg, #14161a); color: var(--reader-text, #e6e8ec); font: 19px/1.65 var(--reader-font, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif); }
body { margin: 0 auto; padding: 48px 24px 96px; max-width: 42em; overflow-wrap: break-word; }
h1 { font-size: 1.9em; line-height: 1.2; margin: 0 0 .4em; }
h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.6em 0 .5em; }
.meta { color: var(--reader-muted, #979da8); font-size: .85em; margin: 0 0 2em; padding-bottom: 1.2em; border-bottom: 1px solid var(--reader-line, #2c3037); }
a { color: var(--reader-accent, #6ea8fe); }
img { max-width: 100%; height: auto; display: block; margin: 1.2em auto; border-radius: 6px; }
figure { margin: 1.4em 0; }
figcaption { color: var(--reader-muted, #979da8); font-size: .85em; text-align: center; }
blockquote { margin: 1.2em 0; padding: .1em 0 .1em 1em; border-left: 3px solid var(--reader-line, #2c3037); color: var(--reader-muted, #979da8); }
pre { overflow-x: auto; padding: 1em; border-radius: 6px; background: var(--reader-code, rgba(127, 127, 127, .15)); font-size: .85em; }
code { font-family: Consolas, monospace; font-size: .92em; }
table { border-collapse: collapse; width: 100%; font-size: .9em; }
td, th { border: 1px solid var(--reader-line, #2c3037); padding: .4em .6em; }
hr { border: 0; border-top: 1px solid var(--reader-line, #2c3037); margin: 2em 0; }
::selection { background: var(--reader-accent, #6ea8fe); color: var(--reader-bg, #14161a); }
</style>
</head>
<body>
<h1>${escapeHtml(article.title)}</h1>
<p class="meta">${meta}</p>
${article.content}
</body>
</html>`;
  return `data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf8').toString('base64')}`;
}

const SAFE_CSS_VALUE = /^[#\w\s(),.%-]+$/;

// The look follows the theme and text settings, so it's applied apart from the article.
function readerStyle({ theme = {}, fontSize, serif }) {
  const vars = Object.entries(theme)
    .filter(([name, value]) => /^--reader-[a-z]+$/.test(name) && SAFE_CSS_VALUE.test(String(value)))
    .map(([name, value]) => `${name}: ${value};`);
  if (serif) vars.push('--reader-font: Georgia, "Times New Roman", serif;');
  return `:root { ${vars.join(' ')} } html { font-size: ${Number(fontSize)}px !important; }`;
}

module.exports = { extractArticle, readerPage, readerStyle };

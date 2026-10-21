import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'
import { parse } from '@vue/compiler-dom'
import postcss from 'postcss'

// Capture only the rendered .slidev-layout.tr-canvas elements. Presenter notes,
// application state, the editor and the Slidev runtime never enter this file.
const deckDirectory = path.dirname(fileURLToPath(import.meta.url))
const distDirectory = path.join(deckDirectory, 'dist')
const publicDirectory = path.join(deckDirectory, 'public')
const args = process.argv.slice(2)
function option(name, fallback) {
  const index = args.indexOf(name)
  if (index === -1) return fallback
  assert(args[index + 1] && !args[index + 1].startsWith('--'), `缺少 ${name} 参数`)
  return path.resolve(args[index + 1])
}
const input = option('--input', path.join(deckDirectory, 'exports', 'dom-slides.json'))
const output = option('--output', path.join(deckDirectory, '..', 'outputs', '投资决策复盘与学习-即开版-20261022.html'))
const snapshot = JSON.parse(await readFile(input, 'utf8'))
assert(Array.isArray(snapshot.slides) && snapshot.slides.length === 18, '需要完整 18 页 DOM')
assert.deepEqual(snapshot.slides.map(slide => slide.number).sort((a, b) => a - b), Array.from({ length: 18 }, (_, index) => index + 1), '页码必须为 1 至 18，各一页')
const variantNames = ['5-fuyao', '5-ifind', '7-adopted']
for (const name of variantNames) assert(typeof snapshot.variants?.[name] === 'string', `缺少交互状态 ${name}`)

const assets = new Map()
const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff' }
async function readAsset(file) {
  if (assets.has(file)) return assets.get(file)
  const bytes = await readFile(file)
  const mime = mimeTypes[path.extname(file).toLowerCase()]
  assert(mime, `不支持的离线资源类型：${path.basename(file)}`)
  const info = { data: `data:${mime};base64,${bytes.toString('base64')}`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  if (mime === 'image/png') {
    assert(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), '截图 PNG 格式无效')
    info.width = bytes.readUInt32BE(16)
    info.height = bytes.readUInt32BE(20)
  }
  assets.set(file, info)
  return info
}

function rootedAsset(directory, pathname) {
  const resolved = path.resolve(directory, `.${pathname.startsWith('/') ? pathname : `/${pathname}`}`)
  assert(resolved.startsWith(`${path.resolve(directory)}${path.sep}`), '资源必须位于演示文件目录内')
  return resolved
}

async function inlineScreenshot(value) {
  assert(!value.startsWith('data:'), '请捕获原始截图 URL，以核对原图尺寸')
  const pathname = decodeURIComponent(new URL(value, 'https://offline.invalid/').pathname)
  const screenIndex = pathname.lastIndexOf('/screens/')
  assert(screenIndex !== -1, '页面图片必须来自演示 screens 目录')
  const file = rootedAsset(publicDirectory, pathname.slice(screenIndex))
  assert(path.extname(file).toLowerCase() === '.png', '截图必须沿用原始 PNG')
  const asset = await readAsset(file)
  assert(asset.width === 3840 && asset.height === 2160, `截图应保持原始 3840×2160 像素：${path.basename(file)}`)
  asset.key = `screens/${path.basename(file)}`
  return asset.key
}

function attribute(node, name) {
  return node.props?.find(property => property.type === 6 && property.name === name)
}

async function packSlide(html) {
  assert(typeof html === 'string' && html.length > 20, '页面 DOM 为空')
  const ast = parse(html, { comments: true })
  const roots = ast.children.filter(node => node.type === 1)
  assert(roots.length === 1 && /(?:^|\s)tr-canvas(?:\s|$)/.test(attribute(roots[0], 'class')?.value?.content || ''), '仅接受 tr-canvas 页面 DOM')
  const edits = []
  const replace = (location, content) => edits.push({ start: location.start.offset, end: location.end.offset, content })
  async function visit(node) {
    if (node.type === 3) { replace(node.loc, ''); return }
    if (node.type !== 1) return
    assert(!['script', 'iframe', 'object', 'embed', 'link', 'style', 'meta', 'base', 'form', 'input', 'textarea'].includes(node.tag.toLowerCase()), `演示 DOM 包含不需要的元素：${node.tag}`)
    const classes = attribute(node, 'class')?.value?.content || ''
    assert(!/slidev-editor|monaco-editor|presenter-notes/.test(classes), '不能打包编辑器或讲稿')
    if (node.tag === 'a' && /(?:^|\s)live-link(?:\s|$)/.test(classes)) {
      replace(node.loc, '<a class="live-link" href="#1">返回第一页 ↺</a>')
      return
    }
    for (const property of node.props) {
      assert(property.type === 6, '请提供渲染后的 DOM，不能包含 Vue 指令')
      const value = property.value?.content || ''
      if (/^on/i.test(property.name) || ['srcset', 'ping', 'nonce'].includes(property.name)) replace(property.loc, '')
      else if (property.name === 'src') {
        assert(node.tag === 'img', '仅允许截图图片资源')
        replace(property.loc, `data-asset="${await inlineScreenshot(value)}"`)
      } else if (property.name === 'href') {
        assert(/^#(?:\/?\d+)?$/.test(value), '离线版本不能保留外部页面入口')
      } else if (property.name === 'style') {
        assert(!/url\s*\(|@import|expression\s*\(/i.test(value), '内联样式不能引用外部资源')
      }
    }
    for (const child of node.children) await visit(child)
  }
  await visit(roots[0])
  let packed = html
  for (const edit of edits.sort((a, b) => b.start - a.start)) packed = packed.slice(0, edit.start) + edit.content + packed.slice(edit.end)
  return packed
}

async function packCss() {
  const index = await readFile(path.join(distDirectory, 'index.html'), 'utf8')
  const stylesheetNames = [...index.matchAll(/<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>/gi)].map(match => rootedAsset(distDirectory, decodeURIComponent(new URL(match[1], 'https://offline.invalid/').pathname)))
  assert(stylesheetNames.length, '未找到构建后的主样式表')
  // The source-picker is a lazily loaded slide component with scoped selectors.
  // Include its exact compiled selectors so captured data-v attributes retain style.
  for (const name of await readdir(path.join(distDirectory, 'assets'))) {
    if (!name.endsWith('.css')) continue
    const file = path.join(distDirectory, 'assets', name)
    if (stylesheetNames.includes(file)) continue
    const text = await readFile(file, 'utf8')
    if (/\.source-demo\[data-v-/.test(text)) stylesheetNames.push(file)
  }
  const stylesheets = []
  for (const file of stylesheetNames) {
    const css = postcss.parse(await readFile(file, 'utf8'), { from: file })
    css.walkAtRules('import', () => { throw new Error('样式含外部导入，需先完成本地构建') })
    const declarations = []
    css.walkDecls(declaration => declarations.push(declaration))
    for (const declaration of declarations) {
      const urls = [...declaration.value.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)]
      for (const match of urls.reverse()) {
        const value = (match[1] ?? match[2] ?? match[3]).trim()
        if (value.startsWith('data:') || value.startsWith('#')) continue
        assert(!/^(?:https?:)?\/\//i.test(value), '离线样式不能依赖网络资源')
        const assetPath = value.startsWith('/') ? rootedAsset(distDirectory, value) : path.resolve(path.dirname(file), value)
        assert(assetPath.startsWith(`${distDirectory}${path.sep}`), '样式资源必须位于构建目录内')
        const asset = await readAsset(assetPath)
        declaration.value = declaration.value.slice(0, match.index) + `url("${asset.data}")` + declaration.value.slice(match.index + match[0].length)
      }
    }
    stylesheets.push(css.toString().replace(/\/\*# sourceMappingURL=[\s\S]*?\*\//g, ''))
  }
  return stylesheets.join('\n')
}

const slides = []
for (const slide of [...snapshot.slides].sort((a, b) => a.number - b.number)) slides.push({ number: slide.number, html: await packSlide(slide.html) })
const variants = {}
for (const name of variantNames) variants[name] = await packSlide(snapshot.variants[name])
const css = await packCss()
const imageAssets = Object.fromEntries([...assets.values()].filter(asset => asset.key).map(asset => [asset.key, asset.data]))
assert(Object.keys(imageAssets).length === [...assets.values()].filter(asset => asset.key).length, '离线图片标识重复')
// Escape the complete JSON payload, including HTML text and attribute values.
const payload = JSON.stringify({ slides, variants, assets: imageAssets }).replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)

const offlineCss = `
html,body{margin:0!important;padding:0!important;width:100%;height:100%;overflow:hidden;background:#111!important;font-family:'Microsoft YaHei','PingFang SC',Arial,sans-serif;color:#111;color-scheme:light}
#offline-viewport{position:fixed;inset:0;overflow:hidden;display:grid;place-items:center}
#offline-stage{position:absolute;left:50%;top:50%;width:1280px;height:720px;transform-origin:center center;overflow:hidden;box-shadow:0 12px 80px #0004;--slidev-slide-scale:1;--slidev-slide-container-scale:1}
#offline-stage>.slidev-layout.tr-canvas{width:1280px!important;height:720px!important;max-width:none!important;max-height:none!important;overflow:hidden;font-family:'Microsoft YaHei','PingFang SC',Arial,sans-serif;user-select:text;-webkit-user-select:text}
#offline-stage .slidev-vclick-hidden{opacity:1!important;visibility:visible!important;transform:none!important;pointer-events:auto!important}
#offline-stage button,#offline-nav button,#offline-nav select{touch-action:manipulation}
#offline-nav{position:fixed;bottom:14px;left:50%;transform:translateX(-50%);z-index:3000;display:flex;align-items:center;gap:4px;padding:6px 8px;border:1px solid #ffffff38;border-radius:999px;background:#151515eb;backdrop-filter:blur(12px);box-shadow:0 5px 25px #0003;color:#fff;font:12px 'Microsoft YaHei',sans-serif;transition:opacity .3s,transform .3s}
body.controls-quiet #offline-nav:not(:hover):not(:focus-within){opacity:0;pointer-events:none;transform:translate(-50%,8px)}
#offline-nav button,#offline-nav select{appearance:none;border:0;border-radius:999px;background:transparent;color:#fff;font:inherit;cursor:pointer;min-width:34px;height:32px;padding:0 10px}
#offline-nav button:hover,#offline-nav select:hover{background:#ffffff1c}
#offline-nav button:focus-visible,#offline-nav select:focus-visible{outline:2px solid #bcff2f;outline-offset:1px}
#offline-nav button:disabled{opacity:.3;cursor:default}
#offline-nav select{text-align:center;padding:0 14px;font-variant-numeric:tabular-nums}
#offline-nav select option{background:#171717;color:#fff}
.offline-nav-separator{height:16px;width:1px;background:#ffffff30;margin:0 4px}
.offline-lightbox[hidden]{display:none!important}
.offline-lightbox{position:fixed;inset:0;z-index:10000;background:#080b10f5;color:#fff;display:flex;flex-direction:column;font-family:'Microsoft YaHei',sans-serif}
.offline-lightbox-tools{height:62px;flex:0 0 62px;display:flex;gap:10px;align-items:center;justify-content:flex-end;padding:0 24px}
.offline-lightbox-tools button{border:1px solid #ffffff48;border-radius:999px;background:#ffffff0c;color:#fff;font-family:inherit;font-size:13px;padding:7px 15px;cursor:pointer}
.offline-lightbox-tools button:focus-visible{outline:2px solid #bcff2f;outline-offset:3px}
.offline-image-scroll{margin:0 24px;min-height:0;flex:1;display:flex;align-items:center;justify-content:center;overflow:hidden}
.offline-image-scroll img{width:auto;height:auto;max-width:100%;max-height:100%;object-fit:contain;display:block;border-radius:14px;box-shadow:0 25px 80px #0007;cursor:zoom-in}
.offline-lightbox.is-native .offline-image-scroll{display:block;overflow:auto}
.offline-lightbox.is-native img{width:3840px;height:2160px;max-width:none;max-height:none;margin:auto;cursor:zoom-out}
.offline-lightbox-caption{text-align:center;flex:0 0 auto;min-height:44px;padding:13px 24px;font-size:12px;line-height:1.5;color:#aaa}
.offline-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(prefers-reduced-motion:reduce){#offline-nav{transition:none}}
@media print{html,body{overflow:visible;background:#fff!important}#offline-nav,.offline-lightbox{display:none!important}#offline-viewport{position:static;display:block}#offline-stage{position:static;transform:none!important;box-shadow:none}}
`

const runtime = String.raw`
(() => {
  'use strict';
  const data = JSON.parse(document.getElementById('offline-data').textContent);
  const stage = document.getElementById('offline-stage');
  const nav = document.getElementById('offline-nav');
  const picker = document.getElementById('offline-picker');
  const previous = document.getElementById('offline-previous');
  const next = document.getElementById('offline-next');
  const modal = document.getElementById('offline-lightbox');
  const image = document.getElementById('offline-full-image');
  const imageScroll = document.getElementById('offline-image-scroll');
  const closeButton = document.getElementById('offline-close');
  const zoomButton = document.getElementById('offline-zoom');
  const live = document.getElementById('offline-announcement');
  const selections = { 5: 'api', 7: 'gray' };
  let current = 1;
  let lastFocus = null;
  let fadeTimer;
  for (const slide of data.slides) {
    const option = document.createElement('option');
    option.value = slide.number;
    option.textContent = slide.number + ' / ' + data.slides.length;
    picker.append(option);
  }
  function showControls() {
    document.body.classList.remove('controls-quiet');
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => document.body.classList.add('controls-quiet'), 2600);
  }
  function fit() {
    stage.style.transform = 'translate(-50%, -50%) scale(' + Math.min(innerWidth / 1280, innerHeight / 720) + ')';
  }
  function pageFromHash() {
    const match = location.hash.match(/^#\/?(\d+)$/);
    return Math.max(1, Math.min(data.slides.length, match ? Number(match[1]) : 1));
  }
  function render(focusSelector) {
    const key = current + '-' + selections[current];
    stage.innerHTML = data.variants[key] || data.slides[current - 1].html;
    for (const picture of stage.querySelectorAll('img[data-asset]')) picture.src = data.assets[picture.dataset.asset];
    stage.setAttribute('aria-label', '第 ' + current + ' 页，共 ' + data.slides.length + ' 页');
    picker.value = String(current);
    previous.disabled = current === 1;
    next.disabled = current === data.slides.length;
    const title = stage.querySelector('h1')?.textContent?.trim() || '投资决策复盘与学习';
    document.title = current + ' / ' + data.slides.length + ' · ' + title;
    live.textContent = '第 ' + current + ' 页，' + title;
    if (focusSelector) stage.querySelector(focusSelector)?.focus({ preventScroll: true });
  }
  function go(page) {
    if (!modal.hidden) closeImage();
    current = Math.max(1, Math.min(data.slides.length, Number(page) || 1));
    if (location.hash !== '#' + current) location.hash = String(current);
    else render();
    showControls();
  }
  function selectSource(index, focus = false) {
    selections[5] = ['api', 'fuyao', 'ifind'][index];
    render(focus ? '.source-tabs button:nth-child(' + (index + 1) + ')' : undefined);
  }
  function selectSuggestion(index, focus = false) {
    selections[7] = index === 0 ? 'gray' : 'adopted';
    render(focus ? '.demo-switch button:nth-child(' + (index + 1) + ')' : undefined);
  }
  function openImage(button) {
    const source = button.querySelector('img');
    if (!source) return;
    lastFocus = button;
    image.src = source.src;
    image.alt = source.alt;
    document.getElementById('offline-caption').textContent = source.alt + ' · 原始 3840 × 2160 PNG';
    modal.setAttribute('aria-label', source.alt);
    modal.classList.remove('is-native');
    zoomButton.textContent = '原始尺寸';
    zoomButton.setAttribute('aria-pressed', 'false');
    modal.hidden = false;
    stage.inert = true;
    nav.inert = true;
    closeButton.focus();
  }
  function closeImage() {
    modal.hidden = true;
    stage.inert = false;
    nav.inert = false;
    image.removeAttribute('src');
    lastFocus?.focus({ preventScroll: true });
    showControls();
  }
  function toggleZoom() {
    const native = modal.classList.toggle('is-native');
    zoomButton.textContent = native ? '适应窗口' : '原始尺寸';
    zoomButton.setAttribute('aria-pressed', String(native));
    if (native) requestAnimationFrame(() => {
      imageScroll.scrollLeft = (imageScroll.scrollWidth - imageScroll.clientWidth) / 2;
      imageScroll.scrollTop = (imageScroll.scrollHeight - imageScroll.clientHeight) / 2;
    });
  }
  stage.addEventListener('click', event => {
    const source = event.target.closest('.source-tabs button');
    if (source && current === 5) {
      selectSource([...source.parentElement.querySelectorAll('button')].indexOf(source), true);
      return;
    }
    const suggestion = event.target.closest('.demo-switch button');
    if (suggestion && current === 7) {
      selectSuggestion([...suggestion.parentElement.querySelectorAll('button')].indexOf(suggestion), true);
      return;
    }
    const shot = event.target.closest('.product-shot');
    if (shot) openImage(shot);
  });
  document.addEventListener('keydown', event => {
    showControls();
    if (!modal.hidden) {
      if (event.key === 'Escape') { event.preventDefault(); closeImage(); }
      if (event.key === 'Tab') {
        const first = zoomButton;
        const last = closeButton;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const group = event.target.closest('.source-tabs, .demo-switch');
    if (group && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const buttons = [...group.querySelectorAll('button')];
      const index = buttons.indexOf(document.activeElement);
      const selected = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      if (current === 5) selectSource(selected, true);
      if (current === 7) selectSuggestion(selected, true);
      return;
    }
    if (event.target.closest('input, textarea, select, button, a, [contenteditable]')) return;
    const forward = ['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(event.key);
    const back = ['ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key);
    if (forward || back || ['Home', 'End'].includes(event.key)) {
      event.preventDefault();
      go(event.key === 'Home' ? 1 : event.key === 'End' ? data.slides.length : current + (forward ? 1 : -1));
    }
  });
  previous.addEventListener('click', () => go(current - 1));
  next.addEventListener('click', () => go(current + 1));
  picker.addEventListener('change', () => go(picker.value));
  closeButton.addEventListener('click', closeImage);
  zoomButton.addEventListener('click', toggleZoom);
  image.addEventListener('click', toggleZoom);
  modal.addEventListener('click', event => { if (event.target === imageScroll || event.target === modal) closeImage(); });
  document.getElementById('offline-fullscreen').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch { showControls(); }
  });
  document.addEventListener('fullscreenchange', () => {
    document.getElementById('offline-fullscreen').textContent = document.fullscreenElement ? '退出全屏' : '全屏';
    fit();
  });
  window.addEventListener('hashchange', () => { current = pageFromHash(); render(); });
  window.addEventListener('resize', fit);
  document.addEventListener('pointermove', showControls, { passive: true });
  document.addEventListener('pointerdown', showControls, { passive: true });
  current = pageFromHash();
  fit();
  render();
  showControls();
})();
`
new Script(runtime, { filename: 'standalone-runtime.js' })
assert(!/<\/script/i.test(payload), 'JSON 未完成安全转义')
assert(!/<\/style/i.test(css + offlineCss), '样式包含异常结束标签')

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><title>投资决策复盘与学习</title><style>${css}\n${offlineCss}</style></head>
<body><main id="offline-viewport"><div id="offline-stage" role="region" aria-label="演示页面"></div></main>
<nav id="offline-nav" aria-label="演示导航"><button id="offline-previous" title="上一页（←）" aria-label="上一页">←</button><select id="offline-picker" aria-label="跳转页码"></select><button id="offline-next" title="下一页（→）" aria-label="下一页">→</button><span class="offline-nav-separator" aria-hidden="true"></span><button id="offline-fullscreen" title="全屏观看">全屏</button></nav>
<section id="offline-lightbox" class="offline-lightbox" role="dialog" aria-modal="true" hidden><div class="offline-lightbox-tools"><button id="offline-zoom" aria-pressed="false">原始尺寸</button><button id="offline-close">关闭 · Esc</button></div><div id="offline-image-scroll" class="offline-image-scroll"><img id="offline-full-image" alt=""></div><p id="offline-caption" class="offline-lightbox-caption"></p></section>
<div id="offline-announcement" class="offline-sr-only" aria-live="polite"></div><noscript><p style="color:white;padding:30px">请在浏览器中允许 JavaScript，以使用翻页和截图放大。</p></noscript>
<script type="application/json" id="offline-data">${payload}</script><script>${runtime}</script></body></html>`

let embeddedImageInstances = 0
function checkOfflineMarkup(node) {
  if (node.type === 1) {
    for (const property of node.props) {
      if (property.type !== 6) continue
      const value = property.value?.content || ''
      if (property.name === 'src') assert(value.startsWith('data:image/png;base64,'), '图片资源未内嵌')
      if (property.name === 'data-asset') assert(imageAssets[value]?.startsWith('data:image/png;base64,'), '图片映射未内嵌')
      if (property.name === 'href') assert(value.startsWith('#'), '仍存在外部页面链接')
      if (node.tag === 'script' && property.name === 'type') assert(value !== 'module', '不能依赖模块服务')
    }
    if (node.tag === 'img' && attribute(node, 'data-asset')) embeddedImageInstances++
    assert(node.tag !== 'link', '不能依赖外部样式表')
  }
  for (const child of node.children || []) checkOfflineMarkup(child)
}
checkOfflineMarkup(parse(html))
for (const page of [...slides.map(slide => slide.html), ...Object.values(variants)]) checkOfflineMarkup(parse(page))
assert(!/localhost|127\.0\.0\.1/.test(html), '仍存在本地服务入口')

await mkdir(path.dirname(output), { recursive: true })
await writeFile(output, html, 'utf8')
console.log(JSON.stringify({ output, slides: slides.length, variants: Object.keys(variants), bytes: Buffer.byteLength(html), embeddedImageInstances, embeddedPngs: [...assets.values()].filter(asset => asset.width).length, sourcePngs: [...assets.entries()].filter(([, asset]) => asset.width).map(([file, asset]) => ({ file: path.basename(file), width: asset.width, height: asset.height, sha256: asset.sha256 })), networkDependencies: 0, externalScriptOrCssOrImages: 0, localhostLinks: 0, runtimeSyntaxValid: true }, null, 2))

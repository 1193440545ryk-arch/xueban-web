import katex from 'katex';
import 'katex/dist/katex.min.css';
import './styles.css';
import { runTask, cancelTask, deleteTask, clearTasks, getTasks, subscribe, downloadOutput, printOutput } from './task-manager.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const processingKinds = ['image', 'pdf', 'document', 'paper'];
const tabs = [...processingKinds, 'formula', 'tasks', 'download'];
const state = {
  tab: 'image', pdfMode: 'merge', paperMode: 'format', tasks: [],
  files: { image: [], pdf: [], document: [], paper: [] },
  appliedPreviews: new Set(), releaseLoaded: false, releaseLoading: false,
};
const documentModes = {
  pdf_txt: { label: 'PDF → TXT', source: 'PDF', accept: '.pdf', test: /\.pdf$/i, hint: '提取 PDF 中已有的文字，不包含扫描件文字识别；复杂排版的阅读顺序可能变化。' },
  pdf_png: { label: 'PDF → PNG', source: 'PDF', accept: '.pdf', test: /\.pdf$/i, hint: '按所选页面逐页生成 PNG 图片。建议先导出少量页面，避免占用过多内存。' },
  pdf_jpg: { label: 'PDF → JPG', source: 'PDF', accept: '.pdf', test: /\.pdf$/i, hint: '按所选页面逐页生成 JPG 图片，可调整画质和清晰度。' },
  txt_docx: { label: 'TXT → DOCX', source: 'TXT', accept: '.txt', test: /\.txt$/i, hint: '将纯文本整理为 Word 文档。建议使用 UTF-8 编码的文本文件。' },
  md_docx: { label: 'Markdown → DOCX', source: 'Markdown', accept: '.md,.markdown', test: /\.(md|markdown)$/i, hint: '将 Markdown 内容整理为 Word 文档，复杂语法与版式请在结果中核对。' },
  txt_html: { label: 'TXT → 打印为 PDF', source: 'TXT', accept: '.txt', test: /\.txt$/i, hint: '先生成可打印页面，再打开浏览器打印窗口，选择“另存为 PDF”。不会直接生成 PDF 文件。' },
  md_html: { label: 'Markdown → 打印为 PDF', source: 'Markdown', accept: '.md,.markdown', test: /\.(md|markdown)$/i, hint: '先生成可打印页面，再打开浏览器打印窗口，选择“另存为 PDF”。打印效果以浏览器预览为准。' },
};
const kindNames = { image: '图片处理', pdf: 'PDF 整理', document: '格式转换', paper: '论文基础' };
const statusNames = { queued: '排队中', running: '处理中', done: '已完成', failed: '处理失败', cancelled: '已取消' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#icon-${name}"/></svg>`;
const fileSize = bytes => Number(bytes) >= 1048576 ? `${(Number(bytes) / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(Number(bytes || 0) / 1024))} KB`;
const isActive = task => task.status === 'queued' || task.status === 'running';
let toastTimer;
let pendingConfirmation = null;

function showError(kind, message) {
  const element = $(`#${kind}-error`);
  element.textContent = message || '';
  element.hidden = !message;
}

function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = String(message);
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500);
}

function switchTab(name, updateHash = true) {
  if (!tabs.includes(name)) name = 'image';
  state.tab = name;
  $$('.panel').forEach(panel => { panel.hidden = panel.id !== `panel-${name}`; });
  $$('[data-tab]').forEach(button => {
    const active = button.dataset.tab === name;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  if (updateHash) history.replaceState(null, '', `#${name}`);
  if (name === 'download' && !state.releaseLoaded) loadRelease();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

$$('[data-tab]').forEach(button => button.addEventListener('click', () => switchTab(button.dataset.tab)));
$('.brand').addEventListener('click', event => { event.preventDefault(); switchTab('image'); });
$('#first-task').addEventListener('click', () => switchTab('image'));
$('#download-entry').addEventListener('click', () => switchTab('download'));
$('#formula-desktop').addEventListener('click', () => switchTab('download'));
window.addEventListener('hashchange', () => switchTab(location.hash.slice(1), false));

function validateFiles(kind, files) {
  if (!files.length) return '请先选择要处理的文件。';
  if (files.length > 20) return '每次最多选择 20 个文件。';
  if (files.some(file => file.size === 0)) return '不能处理空文件，请重新选择。';
  const sourceIsPDF = kind === 'pdf' || (kind === 'document' && $('#document-mode').value.startsWith('pdf_'));
  const maxSize = (sourceIsPDF ? 50 : 20) * 1048576;
  const largeFile = files.find(file => file.size > maxSize);
  if (largeFile) return `“${largeFile.name}”超过 ${sourceIsPDF ? 50 : 20} MB 限制。`;
  if (files.reduce((total, file) => total + file.size, 0) > 50 * 1048576) return '每次选择的文件总量不能超过 50 MB。';
  if (kind === 'image' && files.some(file => !/\.(jpe?g|png|webp|bmp)$/i.test(file.name))) return '请选择 JPG、PNG、WebP 或 BMP。HEIC 图片请先转为 JPG。';
  if (kind === 'pdf' && files.some(file => !/\.pdf$/i.test(file.name))) return '请选择 PDF 文件。';
  if (kind === 'paper' && files.some(file => !/\.docx$/i.test(file.name))) return '论文基础仅支持 DOCX，请先把旧版 DOC 另存为 DOCX。';
  if (kind === 'document') {
    const mode = documentModes[$('#document-mode').value];
    if (files.some(file => !mode.test.test(file.name))) return `当前转换方式需要 ${mode.source} 源文件。`;
  }
  return '';
}

function selectFiles(kind, incoming) {
  let files = [...incoming];
  if (!files.length) return;
  const multiple = kind === 'image' || (kind === 'pdf' && state.pdfMode === 'merge');
  if (multiple) files = [...state.files[kind], ...files];
  else {
    if (files.length > 1) toast('此操作每次处理一份文件，已选择第一份。');
    files = files.slice(0, 1);
  }
  const error = validateFiles(kind, files);
  showError(kind, error);
  if (error) return;
  state.files[kind] = files;
  renderSelection(kind);
}

function renderSelection(kind) {
  const reorder = (kind === 'pdf' && state.pdfMode === 'merge') || (kind === 'image' && $('#image-format').value === 'pdf');
  $(`#${kind}-selection`).innerHTML = state.files[kind].map((file, index) => `
    <li class="file-row"><span class="file-number">${String(index + 1).padStart(2, '0')}</span>
      <span class="file-name">${esc(file.name)}<small>${fileSize(file.size)}</small></span>
      <span class="file-actions">${reorder ? `<button type="button" data-file-action="up" data-index="${index}" aria-label="向前移动 ${esc(file.name)}" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" data-file-action="down" data-index="${index}" aria-label="向后移动 ${esc(file.name)}" ${index === state.files[kind].length - 1 ? 'disabled' : ''}>↓</button>` : ''}<button type="button" data-file-action="remove" data-index="${index}" aria-label="移除 ${esc(file.name)}">${icon('close')}</button></span>
    </li>`).join('');
}

processingKinds.forEach(kind => {
  $(`#${kind}-files`).addEventListener('change', event => { selectFiles(kind, event.target.files); event.target.value = ''; });
  const zone = $(`#${kind}-dropzone`);
  ['dragenter', 'dragover'].forEach(type => zone.addEventListener(type, event => { event.preventDefault(); zone.classList.add('dragging'); }));
  ['dragleave', 'drop'].forEach(type => zone.addEventListener(type, event => { event.preventDefault(); zone.classList.remove('dragging'); }));
  zone.addEventListener('drop', event => selectFiles(kind, event.dataTransfer.files));
  $(`#${kind}-selection`).addEventListener('click', event => {
    const button = event.target.closest('[data-file-action]');
    if (!button) return;
    const index = Number(button.dataset.index), files = state.files[kind];
    if (button.dataset.fileAction === 'remove') files.splice(index, 1);
    else {
      const next = index + (button.dataset.fileAction === 'up' ? -1 : 1);
      if (next >= 0 && next < files.length) [files[index], files[next]] = [files[next], files[index]];
    }
    renderSelection(kind);
  });
});

$('#image-format').addEventListener('change', () => {
  const format = $('#image-format').value;
  $('#image-format-hint').textContent = {
    jpg: '透明区域转为白色，适合分享和保存照片。',
    png: '保留透明背景，无损编码；画质设置不适用，限制目标大小时可能缩小尺寸。',
    webp: '支持透明背景，适合兼顾文件大小和画质。',
    pdf: '按文件列表顺序合为一份 PDF，可用上下箭头调整顺序。',
  }[format];
  $('#image-quality').disabled = format === 'png' || format === 'pdf';
  $('#image-target').disabled = format === 'pdf';
  renderSelection('image');
});
$('#image-quality').addEventListener('input', event => { $('#quality-value').value = `${event.target.value}%`; });

$$('[data-pdf-mode]').forEach(button => button.addEventListener('click', () => {
  const mode = button.dataset.pdfMode;
  state.pdfMode = mode;
  $$('[data-pdf-mode]').forEach(item => { item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', String(item === button)); });
  const labels = { merge: '合并', split: '拆分', extract: '提取', rotate: '旋转' };
  $('#pdf-files').multiple = mode === 'merge';
  $('#pdf-file-count').textContent = mode === 'merge' ? '至少 2 份' : '单个文件';
  $('#pdf-picker-title').textContent = `拖入要${labels[mode]}的 PDF，或点击选择`;
  $('#pdf-picker-hint').textContent = mode === 'merge' ? '添加后可调整合并顺序' : '生成副本，保留电脑里的原文件';
  $('#pdf-options').hidden = mode === 'merge';
  $('#pdf-groups-field').hidden = mode !== 'split';
  $('#pdf-pages-field').hidden = !['extract', 'rotate'].includes(mode);
  $('#pdf-angle-field').hidden = mode !== 'rotate';
  $('#pdf-pages').disabled = !['extract', 'rotate'].includes(mode);
  $('#pdf-pages').required = mode === 'extract';
  $('#pdf-pages-hint').textContent = mode === 'extract' ? '填写需要提取的页码，以逗号分隔；页码从 1 开始。' : '留空旋转所有页面；填写后仅旋转指定页，其余页面保留。';
  $('#pdf-submit').innerHTML = `开始${labels[mode]} ${icon('arrow')}`;
  if (mode !== 'merge' && state.files.pdf.length > 1) { state.files.pdf = state.files.pdf.slice(0, 1); toast('此操作每次处理一份 PDF，已保留第一份。'); }
  showError('pdf', '');
  renderSelection('pdf');
}));

function updateDocumentMode() {
  const modeName = $('#document-mode').value, mode = documentModes[modeName];
  $('#document-files').accept = mode.accept;
  $('#document-picker-title').textContent = `选择或拖入 ${mode.source}`;
  $('#document-mode-hint').textContent = mode.hint;
  $('#document-pages-field').hidden = !modeName.startsWith('pdf_');
  const images = ['pdf_png', 'pdf_jpg'].includes(modeName);
  $('#document-image-options').hidden = !images;
  $('#document-page-limit').hidden = !images;
  $('#document-dpi').disabled = !images;
  $('#document-quality-field').hidden = modeName !== 'pdf_jpg';
  $('#document-quality').disabled = modeName !== 'pdf_jpg';
  $('#document-limit').textContent = modeName.startsWith('pdf_') ? 'PDF ≤ 50 MB' : '文本文件 ≤ 20 MB';
  $('#document-submit-hint').textContent = modeName.endsWith('_html') ? '完成后点击“打印为 PDF”，在打印窗口保存' : '原文件不变，处理后下载结果';
  if (state.files.document.some(file => !mode.test.test(file.name))) { state.files.document = []; renderSelection('document'); toast(`请重新选择 ${mode.source} 源文件。`); }
  showError('document', '');
}
$('#document-mode').addEventListener('change', updateDocumentMode);
$$('[data-paper-mode]').forEach(button => button.addEventListener('click', () => {
  state.paperMode = button.dataset.paperMode;
  $$('[data-paper-mode]').forEach(item => { item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', String(item === button)); });
  $('#paper-format-options').hidden = state.paperMode === 'cleanup';
  $('#paper-cleanup-options').hidden = state.paperMode !== 'cleanup';
  $$('input, select', $('#paper-format-options')).forEach(input => { input.disabled = state.paperMode === 'cleanup'; });
}));

function taskOptions(kind) {
  if (kind === 'image') return { format: $('#image-format').value, quality: Number($('#image-quality').value), width: Number($('#image-width').value) || 0, height: Number($('#image-height').value) || 0, targetKB: $('#image-target').disabled ? 0 : Number($('#image-target').value) || 0 };
  if (kind === 'pdf') return { mode: state.pdfMode, pages: ['extract', 'rotate'].includes(state.pdfMode) ? $('#pdf-pages').value.trim() : '', groups: state.pdfMode === 'split' ? $('#pdf-groups').value.trim() : '', angle: Number($('#pdf-angle').value) };
  if (kind === 'document') return { mode: $('#document-mode').value, pages: $('#document-pages').value.trim(), dpi: Number($('#document-dpi').value), quality: Number($('#document-quality').value) };
  return { action: 'preview', mode: state.paperMode, font: $('#paper-font').value.trim() || '宋体', fontSize: Number($('#paper-font-size').value) || 12, lineSpacing: Number($('#paper-line-spacing').value) || 1.5, firstLineIndent: Number($('#paper-indent').value) || 0 };
}

processingKinds.forEach(kind => $(`#${kind}-form`).addEventListener('submit', event => {
  event.preventDefault();
  let error = validateFiles(kind, state.files[kind]);
  if (!error && kind === 'pdf' && state.pdfMode === 'merge' && state.files.pdf.length < 2) error = '合并 PDF 至少需要两份文件，请再添加一份。';
  showError(kind, error);
  if (error) return;
  try {
    runTask({ kind, files: [...state.files[kind]], options: taskOptions(kind) });
    switchTab('tasks');
    toast(kind === 'paper' ? '正在检查文档，预览后由你确认生成副本。' : '已开始在本机处理。');
  } catch (err) { showError(kind, err.message || String(err)); }
}));

function taskTitle(task) {
  if (task.kind === 'document') return documentModes[task.options?.mode]?.label || '格式转换';
  if (task.kind === 'pdf') return `PDF · ${{ merge: '合并', split: '拆分', extract: '提取页面', rotate: '旋转页面' }[task.options?.mode] || '整理'}`;
  if (task.kind === 'paper') return `${task.options?.mode === 'cleanup' ? '正文清理' : '基础排版'} · ${task.options?.action === 'apply' ? '生成副本' : '检查预览'}`;
  return kindNames[task.kind] || '文件处理';
}

function readableSummary(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(readableSummary).join('\n');
  return '';
}

function paperReport(task) {
  if (task.kind !== 'paper' || task.status !== 'done') return '';
  const preview = task.result?.preview;
  const summary = readableSummary(task.result?.summary);
  if (!preview) return summary ? `<div class="paper-report"><h3>处理报告</h3><p class="paper-summary">${esc(summary)}</p></div>` : '';
  const statsLabels = { paragraphs: '检查段落', totalParagraphs: '检查段落', headings: '保留标题', changed: '涉及修改', changedParagraphs: '修改段落', protected: '保留段落', skipped: '跳过段落', removedSpaces: '清理空格', spacesRemoved: '清理空格' };
  const stats = Object.entries(preview.stats || {}).filter(([key, value]) => statsLabels[key] && typeof value === 'number').map(([key, value]) => `<div><strong>${value}</strong><span>${statsLabels[key]}</span></div>`).join('');
  const changes = (Array.isArray(preview.changes) ? preview.changes : []).slice(0, 40).map(change => `<article class="change-row"><h4>${esc(change.label || '修改内容')}</h4><div class="change-comparison"><div><span>处理前</span><pre>${esc(String(change.before ?? '').slice(0, 1500))}</pre></div><div><span>处理后</span><pre>${esc(String(change.after ?? '').slice(0, 1500))}</pre></div></div></article>`).join('');
  const settings = task.options.mode === 'cleanup' ? '保守清理安全正文的段尾空格，段首、制表符与空段保留。' : `正文：${task.options.font}，${task.options.fontSize} pt，${task.options.lineSpacing} 倍行距，首行缩进 ${task.options.firstLineIndent} 字符。已有标题保持原样。`;
  const canApply = task.options.action === 'preview' && Boolean(preview.sourceHash) && !state.appliedPreviews.has(task.id);
  return `<div class="paper-report"><h3>检查结果</h3>${summary ? `<p class="paper-summary">${esc(summary)}</p>` : ''}${stats ? `<div class="stats-grid">${stats}</div>` : ''}<details><summary>查看本次实际设置</summary><p class="paper-settings">${esc(settings)}</p></details>${changes ? `<details><summary>查看修改示例（${Math.min(preview.changes.length, 40)} 项）</summary><p class="field-hint">页面仅显示前 40 项，每项前后各最多 1500 字符。请结合处理报告核对范围。</p>${changes}</details>` : '<p class="field-hint">此次检查未提供文本修改示例，请核对摘要和处理范围。</p>'}<p class="field-hint">预览用于核对修改范围，不是实际分页效果。请在生成的副本中检查版式。</p>${canApply ? `<div class="confirm-paper-row"><p>按本次预览的设置生成新副本，原件不会覆盖。</p><button class="primary" data-task-action="apply-paper">确认并生成副本 ${icon('arrow')}</button></div>` : state.appliedPreviews.has(task.id) ? '<p class="field-hint">已创建生成任务，请在任务记录中查看结果。</p>' : ''}</div>`;
}

function taskHTML(task) {
  const active = isActive(task);
  const progress = Math.min(100, Math.max(0, Number(task.progress) || 0));
  const waiting = task.kind === 'paper' && task.status === 'done' && task.options?.action === 'preview' && task.result?.preview && !state.appliedPreviews.has(task.id);
  const time = new Date(task.createdAt || Date.now()).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const files = (task.files || []).map(file => file.name).filter(Boolean);
  const source = files.length > 1 ? `${files[0]} 等 ${files.length} 份文件` : files[0] || '本地文件';
  const outputs = (task.result?.outputs || []).map((output, index) => {
    const printable = task.kind === 'document' && task.options?.mode?.endsWith('_html');
    return `<div class="output-row">${icon('download')}<span class="output-name">${esc(output.name || `结果 ${index + 1}`)}<small>${output.blob?.size ? fileSize(output.blob.size) : '结果文件'}</small></span>${printable ? `<button class="primary" data-task-action="print" data-output="${index}">打印为 PDF</button><button class="secondary" data-task-action="download" data-output="${index}">保存 HTML</button>` : `<button class="secondary" data-task-action="download" data-output="${index}">下载</button>`}</div>`;
  }).join('');
  const taskIcon = processingKinds.includes(task.kind) ? task.kind : 'document';
  const summary = task.kind !== 'paper' ? readableSummary(task.result?.summary) : '';
  return `<div class="task-heading"><span class="task-icon">${icon(taskIcon)}</span><div class="task-name"><h2>${esc(taskTitle(task))}</h2><p>${time} · ${esc(source)}</p></div><span class="status ${waiting ? 'preview' : esc(task.status)}">${waiting ? '待确认' : esc(statusNames[task.status] || task.status)}</span></div>${active ? `<div class="task-progress"><div class="progress-caption"><span>${esc(task.message || (task.status === 'queued' ? '等待本机处理' : '正在处理'))}</span><span>${Math.round(progress)}%</span></div><div class="progress-track" role="progressbar" aria-label="任务进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(progress)}"><span style="width:${progress}%"></span></div></div>` : ''}${task.error ? `<p class="task-message error">${esc(task.error.message || task.error)}</p>` : ''}${summary ? `<p class="task-message">${esc(summary)}</p>` : ''}${(task.result?.warnings || []).map(warning => `<p class="task-message">${esc(warning)}</p>`).join('')}${paperReport(task)}${outputs ? `<div class="outputs">${outputs}</div>` : ''}<div class="task-footer"><span>仅保留在当前页面</span><div>${active ? '<button data-task-action="cancel">取消处理</button>' : ''}<button data-task-action="delete">删除记录</button></div></div>`;
}

function renderTasks(tasks) {
  state.tasks = [...tasks];
  const list = $('#tasks-list');
  const ids = new Set(tasks.map(task => String(task.id)));
  $$('.task-card', list).forEach(card => { if (!ids.has(card.dataset.taskId)) card.remove(); });
  const ordered = [...tasks].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  ordered.forEach((task, index) => {
    const id = String(task.id);
    let card = $$('.task-card', list).find(item => item.dataset.taskId === id);
    if (!card) { card = document.createElement('article'); card.className = 'task-card'; card.dataset.taskId = id; }
    card.dataset.status = task.status;
    card.dataset.kind = task.kind;
    const signature = JSON.stringify([task.status, task.progress, task.message, task.error, task.result, state.appliedPreviews.has(task.id)]);
    if (card.dataset.signature !== signature) { card.innerHTML = taskHTML(task); card.dataset.signature = signature; }
    if (list.children[index] !== card) list.insertBefore(card, list.children[index] || null);
  });
  $('#tasks-empty').hidden = tasks.length > 0;
  $('#task-count').textContent = tasks.length ? `共 ${tasks.length} 条任务` : '暂无任务';
  $('#clear-tasks').disabled = tasks.length === 0;
  const activeCount = tasks.filter(isActive).length;
  $('#task-badge').hidden = activeCount === 0;
  $('#task-badge').textContent = activeCount;
}

function askConfirmation(title, description, action) {
  $('#confirm-title').textContent = title;
  $('#confirm-description').textContent = description;
  pendingConfirmation = action;
  $('#confirm-dialog').returnValue = 'cancel';
  $('#confirm-dialog').showModal();
}

$('#confirm-dialog').addEventListener('close', async () => {
  const action = pendingConfirmation;
  pendingConfirmation = null;
  if ($('#confirm-dialog').returnValue !== 'confirm' || !action) return;
  try { await action(); } catch (error) { toast(error.message || String(error)); }
});

$('#tasks-list').addEventListener('click', async event => {
  const button = event.target.closest('[data-task-action]');
  if (!button) return;
  const id = button.closest('.task-card').dataset.taskId;
  const task = state.tasks.find(item => String(item.id) === id);
  if (!task) return;
  const action = button.dataset.taskAction;
  if (action === 'delete') {
    askConfirmation('删除这条记录？', `${isActive(task) ? '正在进行的任务也将取消。' : ''}页面中的结果将被移除；电脑里的原件和已下载的文件不受影响。`, async () => { await deleteTask(task.id); toast('记录已删除，电脑文件不受影响。'); });
    return;
  }
  button.disabled = true;
  try {
    if (action === 'cancel') await cancelTask(task.id);
    if (action === 'download') await downloadOutput(task.id, Number(button.dataset.output));
    if (action === 'print') { await printOutput(task.id, Number(button.dataset.output)); toast('请在新窗口点击“打印 / 保存为 PDF”，再选择“另存为 PDF”。'); }
    if (action === 'apply-paper') {
      const sourceHash = task.result?.preview?.sourceHash;
      if (!sourceHash) throw new Error('预览校验信息缺失，请重新检查源文件。');
      runTask({ kind: 'paper', files: [...task.files], options: { ...task.options, action: 'apply', sourceHash } });
      state.appliedPreviews.add(task.id);
      renderTasks(getTasks());
      toast('已确认，正在按预览设置生成副本。');
    }
  } catch (error) { toast(error.message || String(error)); }
  finally { button.disabled = false; }
});

$('#clear-tasks').addEventListener('click', () => askConfirmation('清空当前页面的任务？', '正在进行的任务将取消，未下载的结果将从页面移除。电脑里的原件和已下载文件不会删除。', async () => { await clearTasks(); state.appliedPreviews.clear(); toast('当前页面的任务已清空。'); }));

function updateFormula() {
  const source = $('#formula-input').value.trim();
  $('#formula-copy').disabled = !source;
  $('#formula-save').disabled = !source;
  showError('formula', '');
  if (!source) { $('#formula-preview').innerHTML = '<p>在左侧输入公式，预览会显示在这里。</p>'; return; }
  try { katex.render(source, $('#formula-preview'), { displayMode: true, throwOnError: true, trust: false, strict: 'warn', maxExpand: 1000 }); }
  catch (error) { $('#formula-preview').textContent = '暂时无法渲染，请检查 LaTeX 语法。'; showError('formula', error.message || String(error)); }
}
$('#formula-input').addEventListener('input', updateFormula);
$('#formula-example').addEventListener('click', () => { $('#formula-input').value = 'x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}'; updateFormula(); });
$('#formula-copy').addEventListener('click', async () => {
  try {
    if (navigator.clipboard && isSecureContext) await navigator.clipboard.writeText($('#formula-input').value);
    else { $('#formula-input').focus(); $('#formula-input').select(); if (!document.execCommand('copy')) throw new Error('请按 Ctrl+C 复制选中的文本。'); }
    toast('LaTeX 已复制。');
  } catch { $('#formula-input').focus(); $('#formula-input').select(); toast('公式文本已选中，请按 Ctrl+C（Mac 用 ⌘C）复制。'); }
});
$('#formula-save').addEventListener('click', () => {
  const blob = new Blob([$('#formula-input').value + '\n'], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = '学伴公式.tex'; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
});

function allowedReleaseURL(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value, document.baseURI);
    const localPreview = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return url.protocol === 'https:' || (url.protocol === 'http:' && (url.origin === location.origin || localPreview)) ? url.href : '';
  } catch { return ''; }
}

async function loadRelease() {
  if (state.releaseLoading) return;
  state.releaseLoading = true;
  $('#release-loading').hidden = false;
  $('#release-content').hidden = true;
  $('#release-error').hidden = true;
  $('#release-retry').disabled = true;
  try {
    const response = await fetch(new URL('./releases.json', document.baseURI), { cache: 'no-store' });
    if (!response.ok) throw new Error('暂时无法读取发布信息，请稍后重试。');
    const release = await response.json();
    $('#release-version').textContent = release.version ? `版本 ${release.version}` : '版本待配置';
    $('#release-platform').textContent = release.platform || 'Windows 10/11 · 64 位';
    $('#release-filename').textContent = release.filename || 'Windows 安装包';
    $('#release-size').textContent = release.bytes ? `${(Number(release.bytes) / 1048576).toFixed(1)} MiB · ${Number(release.bytes).toLocaleString('zh-CN')} 字节` : '大小信息待配置';
    $('#release-notes').textContent = Array.isArray(release.notes) ? release.notes.join(' ') : release.notes || '';
    const url = allowedReleaseURL(release.url);
    $('#release-link').hidden = !url;
    $('#release-unconfigured').hidden = Boolean(url);
    if (url) { $('#release-link').href = url; $('#release-link').download = release.filename || ''; }
    else $('#release-link').removeAttribute('href');
    const checksum = typeof release.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(release.sha256) ? release.sha256 : '';
    $('#release-checksum-details').hidden = !checksum;
    $('#release-sha256').textContent = checksum;
    $('#release-content').hidden = false;
    state.releaseLoaded = true;
  } catch (error) { $('#release-error').textContent = error.message || String(error); $('#release-error').hidden = false; state.releaseLoaded = false; }
  finally { $('#release-loading').hidden = true; $('#release-retry').disabled = false; state.releaseLoading = false; }
}
$('#release-retry').addEventListener('click', loadRelease);

subscribe(renderTasks);
renderTasks(getTasks());
updateDocumentMode();
updateFormula();
switchTab(location.hash.slice(1) || 'image', false);

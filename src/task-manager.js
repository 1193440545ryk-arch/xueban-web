const MB = 1024 * 1024;
const tasks = [];
const listeners = new Set();
let active = null;
let timer = null;

const broadcast = () => listeners.forEach(fn => fn([...tasks]));
export const getTasks = () => [...tasks];
export function subscribe(fn) { listeners.add(fn); fn(getTasks()); return () => listeners.delete(fn); }

function usage() {
  return tasks.reduce((sum, task) => sum + task.files.reduce((n, f) => n + f.size, 0)
    + (task.result?.outputs || []).reduce((n, f) => n + f.blob.size, 0), 0);
}

export function runTask({kind, files, options = {}}) {
  if (!['image', 'pdf', 'document', 'paper'].includes(kind)) throw new Error('暂不支持此处理方式。');
  if (!Array.isArray(files) || !files.length || files.some(f => !(f instanceof File))) throw new Error('请先选择文件。');
  if (files.length > 20 || files.some(f => !f.size)) throw new Error('每次最多 20 个文件，不能选择空文件。');
  const inputSize = files.reduce((n, f) => n + f.size, 0);
  if (inputSize > 50 * MB) throw new Error('本次文件总大小不能超过 50 MB。');
  if (['image', 'paper'].includes(kind) && files.some(f => f.size > 20 * MB)) throw new Error('图片或 DOCX 单文件不能超过 20 MB。');
  if (tasks.length >= 20 || usage() + inputSize > 250 * MB) throw new Error('本页暂存的任务较多，请先下载结果并清空旧任务。');
  if (!globalThis.Worker || !globalThis.crypto?.subtle) throw new Error('请使用新版 Chrome / Edge，并通过 HTTPS 或 localhost 打开网站。');
  const task = {id: crypto.randomUUID(), kind, files: [...files], options: structuredClone(options),
    status: 'queued', progress: 0, message: '等待处理', result: null, error: '', createdAt: Date.now()};
  tasks.unshift(task);
  broadcast();
  queueMicrotask(pump);
  return task.id;
}

function finish(task, worker) {
  clearTimeout(timer);
  timer = null;
  worker.terminate();
  if (active?.task === task) active = null;
  broadcast();
  queueMicrotask(pump);
}

function pump() {
  if (active) return;
  const task = [...tasks].reverse().find(item => item.status === 'queued');
  if (!task) return;
  let worker;
  try { worker = new Worker(new URL('./workers/processor.worker.js', import.meta.url), {type: 'module'}); }
  catch {
    task.status = 'failed'; task.error = '浏览器无法启动处理组件，请使用新版 Chrome / Edge 并刷新页面。'; task.message = task.error;
    broadcast(); queueMicrotask(pump); return;
  }
  active = {task, worker};
  task.status = 'running'; task.message = '正在读取本地文件';
  const fail = message => {
    if (active?.task !== task) return;
    task.status = 'failed'; task.error = message; task.message = message;
    finish(task, worker);
  };
  worker.addEventListener('message', ({data}) => {
    if (active?.task !== task) return;
    if (data.type === 'progress') {
      task.progress = Math.max(0, Math.min(99, Number(data.percent) || 0));
      task.message = String(data.message || '处理中'); broadcast();
    } else if (data.type === 'result') {
      const result = data.result;
      if (!result || !Array.isArray(result.outputs) || result.outputs.some(output => !(output.blob instanceof Blob))) {
        fail('处理结果格式异常，请重新选择文件后重试。'); return;
      }
      const size = result.outputs.reduce((n, output) => n + output.blob.size, 0);
      if (size > 150 * MB || usage() + size > 300 * MB) { fail('生成结果过大，请减少页数或降低分辨率。'); return; }
      result.outputs = result.outputs.map(output => ({...output, name: safeName(output.name), url: URL.createObjectURL(output.blob), downloaded: false}));
      task.result = result; task.status = 'done'; task.progress = 100;
      task.message = result.summary || '处理完成';
      finish(task, worker);
    } else if (data.type === 'error') fail(String(data.message || '文件处理失败，请核对文件格式。'));
  });
  worker.addEventListener('error', event => { event.preventDefault(); fail('处理组件无法运行。请刷新页面后重试，或使用新版 Chrome / Edge。'); });
  worker.addEventListener('messageerror', () => fail('无法读取处理结果，请减少文件数量后重试。'));
  timer = setTimeout(() => fail('处理超过 3 分钟，已停止。请减少文件大小或页数后重试。'), 180000);
  try {
    const base = new URL(import.meta.env.BASE_URL, document.baseURI);
    worker.postMessage({kind: task.kind, files: task.files, options: {...task.options, assetBase: new URL('pdfjs/', base).href}});
  } catch (error) { fail(error.message || '无法启动处理任务。'); }
  broadcast();
}

function safeName(value) {
  const name = String(value || '处理结果').split(/[\\/]/).pop().replace(/[\x00-\x1f<>:"|?*]/g, '_');
  return name.slice(0, 180) || '处理结果';
}
export function cancelTask(id) {
  const task = tasks.find(item => item.id === id);
  if (!task || !['running', 'queued'].includes(task.status)) return;
  task.status = 'cancelled'; task.message = '已取消，可重新选择文件处理';
  if (active?.task === task) { clearTimeout(timer); active.worker.terminate(); active = null; }
  broadcast(); queueMicrotask(pump);
}
export function deleteTask(id) {
  cancelTask(id);
  const index = tasks.findIndex(item => item.id === id);
  if (index < 0) return;
  for (const output of tasks[index].result?.outputs || []) URL.revokeObjectURL(output.url);
  tasks.splice(index, 1); broadcast();
}
export function clearTasks() { for (const task of [...tasks]) deleteTask(task.id); }
function getOutput(id, index) {
  const output = tasks.find(item => item.id === id)?.result?.outputs?.[index];
  if (!output) throw new Error('结果已被清空，请重新处理。');
  return output;
}
export function downloadOutput(id, index) {
  const output = getOutput(id, index);
  const a = document.createElement('a'); a.href = output.url; a.download = output.name;
  document.body.append(a); a.click(); a.remove(); output.downloaded = true; broadcast();
}
export function printOutput(id, index) {
  const output = getOutput(id, index);
  if (!output.blob.type.startsWith('text/html')) throw new Error('此结果不支持打印预览。');
  const tab = window.open('', '_blank');
  if (!tab) throw new Error('打印预览被浏览器拦截，请允许本站打开弹窗后重试。');
  tab.opener = null;
  tab.document.title = '打印预览 · 学伴';
  const toolbar = tab.document.createElement('div');
  toolbar.style.cssText = 'padding:12px 20px;background:#eff5f1;display:flex;gap:16px;align-items:center;font:14px system-ui';
  const btn = tab.document.createElement('button'); btn.textContent = '打印 / 保存为 PDF';
  btn.style.cssText = 'padding:10px 18px;background:#176b58;color:white;border:0;border-radius:8px;cursor:pointer';
  const note = tab.document.createElement('span'); note.textContent = '在打印窗口选择“另存为 PDF”，请核对纸张、分页和字体。';
  const frame = tab.document.createElement('iframe');
  frame.title = '文档打印预览'; frame.sandbox = 'allow-same-origin allow-modals';
  frame.style.cssText = 'border:0;width:100%;height:calc(100vh - 74px)';
  const previewURL = URL.createObjectURL(output.blob);
  frame.src = previewURL;
  btn.onclick = () => { try { frame.contentWindow.focus(); frame.contentWindow.print(); output.downloaded = true; broadcast(); } catch { note.textContent = '浏览器限制了打印，请下载 HTML 后在本地浏览器打开打印。'; } };
  toolbar.append(btn, note); tab.document.body.style.margin = '0'; tab.document.body.append(toolbar, frame);
  tab.addEventListener('beforeunload', () => URL.revokeObjectURL(previewURL), {once: true});
}

window.addEventListener('beforeunload', event => {
  if (tasks.some(task => ['running', 'queued'].includes(task.status) || task.result?.outputs?.some(file => !file.downloaded))) {
    event.preventDefault(); event.returnValue = '';
  }
});

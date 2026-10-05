import MarkdownIt from 'markdown-it';
import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, HeadingLevel, WidthType } from 'docx';

const MAX_BYTES = 20 * 1024 * 1024;
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const parser = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: false });
// No fetchable image URL or clickable link survives into a print preview.
parser.renderer.rules.image = (tokens, i) => `<span class="image-placeholder">[图片：${escapeHtml(tokens[i].content || '已省略')}，未加载]</span>`;
parser.renderer.rules.link_open = () => '<span class="link-text">';
parser.renderer.rules.link_close = () => '</span>';

function inlineRuns(token) {
  const runs = [], format = { bold: false, italics: false, strike: false };
  for (const item of token?.children || []) {
    if (item.type === 'strong_open') format.bold = true;
    else if (item.type === 'strong_close') format.bold = false;
    else if (item.type === 'em_open') format.italics = true;
    else if (item.type === 'em_close') format.italics = false;
    else if (item.type === 's_open') format.strike = true;
    else if (item.type === 's_close') format.strike = false;
    else if (item.type === 'softbreak' || item.type === 'hardbreak') runs.push(new TextRun({ text: '', break: 1 }));
    else if (item.type === 'image') runs.push(new TextRun(`[图片：${item.content || '已省略'}，未加载]`));
    else if (item.type === 'code_inline') runs.push(new TextRun({ text: item.content, font: 'Consolas', shading: { fill: 'F1F3F5' }, ...format }));
    else if (item.type === 'text' || item.type === 'html_inline') runs.push(new TextRun({ text: item.content, ...format }));
  }
  return runs.length ? runs : [new TextRun('')];
}
function markdownChildren(tokens) {
  const children = [], lists = [];
  let quote = 0, emitted = 0;
  const add = block => { if (++emitted > 30000) throw new Error('文档段落或表格过多，请拆分后转换。'); children.push(block); };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'blockquote_open') quote++;
    else if (token.type === 'blockquote_close') quote--;
    else if (token.type === 'bullet_list_open' || token.type === 'ordered_list_open') lists.push({ ordered: token.type === 'ordered_list_open', index: Number(token.attrGet('start')) || 1, pending: false });
    else if (token.type === 'bullet_list_close' || token.type === 'ordered_list_close') lists.pop();
    else if (token.type === 'list_item_open' && lists.length) lists.at(-1).pending = true;
    else if (token.type === 'heading_open') {
      const level = Math.min(6, Number(token.tag.slice(1)));
      add(new Paragraph({ heading: HeadingLevel['HEADING_' + level], children: inlineRuns(tokens[i + 1]) }));
      i += 2;
    } else if (token.type === 'paragraph_open') {
      const runs = inlineRuns(tokens[i + 1]), list = lists.at(-1);
      if (list?.pending) { runs.unshift(new TextRun(list.ordered ? `${list.index++}. ` : '• ')); list.pending = false; }
      add(new Paragraph({ children: runs, spacing: { after: 120, line: 360 }, indent: { left: (lists.length + quote) * 360 } }));
      i += 2;
    } else if (token.type === 'fence' || token.type === 'code_block') {
      for (const line of token.content.replace(/\n$/, '').split('\n')) add(new Paragraph({ children: [new TextRun({ text: line, font: 'Consolas', size: 20 })], shading: { fill: 'F1F3F5' }, spacing: { after: 0, line: 260 } }));
    } else if (token.type === 'hr') add(new Paragraph({ children: [new TextRun('────────────────')] }));
    else if (token.type === 'table_open') {
      const rows = [];
      let cells = [], current = [], head = false, inCell = false;
      while (++i < tokens.length && tokens[i].type !== 'table_close') {
        const t = tokens[i];
        if (t.type === 'tr_open') cells = [];
        else if (t.type === 'th_open' || t.type === 'td_open') { current = []; head = t.type === 'th_open'; inCell = true; }
        else if (t.type === 'inline' && inCell) current.push(new Paragraph({ children: inlineRuns(t) }));
        else if (t.type === 'th_close' || t.type === 'td_close') {
          if (++emitted > 30000) throw new Error('表格过大，请拆分后转换。');
          cells.push(new TableCell({ children: current.length ? current : [new Paragraph('')], ...(head ? { shading: { fill: 'E8EDF3' } } : {}) })); inCell = false;
        } else if (t.type === 'tr_close') rows.push(new TableRow({ children: cells }));
      }
      if (rows.length) add(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
    }
  }
  return children.length ? children : [new Paragraph('')];
}
function htmlDocument(body, name) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'"><title>${escapeHtml(name)}</title><style>body{font:12pt/1.6 "宋体",SimSun,serif;max-width:190mm;margin:20mm auto;padding:0 8mm;color:#17202a;background:white;overflow-wrap:anywhere}h1,h2,h3,h4,h5,h6{font-family:Arial,"黑体",sans-serif;break-after:avoid}h1{font-size:24pt}h2{font-size:18pt}h3{font-size:15pt}table{border-collapse:collapse;width:100%;margin:1em 0}th,td{border:1px solid #999;padding:6px;text-align:left;vertical-align:top}thead{display:table-header-group}pre{white-space:pre-wrap;background:#f1f3f5;padding:10px;overflow-wrap:anywhere}code{font-family:Consolas,monospace}blockquote{border-left:3px solid #aab4c0;margin-left:0;padding-left:16px;color:#4d5762}.image-placeholder{color:#596778}.plain{white-space:pre-wrap}.link-text{text-decoration:underline}@page{size:A4;margin:20mm}@media print{body{max-width:none;margin:0;padding:0}pre{background:#f4f4f4}tr{break-inside:avoid}}</style></head><body>${body}</body></html>`;
}
export async function processDocument(files, options = {}, progress = () => {}) {
  const mode = options.mode;
  if (!['txt_docx', 'md_docx', 'txt_html', 'md_html'].includes(mode)) throw new Error('请选择支持的文本或 Markdown 转换方式。');
  const markdown = mode.startsWith('md_');
  if (!Array.isArray(files) || files.length !== 1 || !files[0] || !(markdown ? /\.(?:md|markdown)$/i : /\.txt$/i).test(files[0].name || '')) throw new Error(markdown ? '请选择一个 Markdown（.md）文件。' : '请选择一个 TXT 文件。');
  const file = files[0];
  if (file.size > MAX_BYTES) throw new Error('文本文件不能超过 20 MB。');
  progress(5, '正在本地读取 UTF-8 文本');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
  catch { throw new Error('文本不是有效的 UTF-8 编码，请用编辑器另存为 UTF-8 后重试。'); }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/.test(text)) throw new Error('文本含不支持的控制字符，请清理后重试。');
  text = text.replace(/\r\n?/g, '\n');
  if (text.split('\n').length > 20000) throw new Error('文本超过 20000 行，请拆分后转换。');
  const name = (file.name || '文档').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').replace(/[\x00-\x1f<>:"|?*]/g, '_').slice(0, 90) || '文档';
  const warnings = [];
  let tokens;
  if (markdown) {
    tokens = parser.parse(text, {});
    if (tokens.length > 100000 || tokens.reduce((sum, t) => sum + (t.children?.length || 0), 0) > 100000) throw new Error('Markdown 结构过于复杂，请拆分后转换。');
    warnings.push('图片保留为文字占位，不加载本地或远程图片；链接仅保留显示文字；原始 HTML 作为文字显示。');
    if (/\$[^\n]+\$|\\\(|\\\[/.test(text)) warnings.push('公式语法按可编辑文字保留；本模块不把 LaTeX 转为原生 Word 公式。');
  }
  progress(35, '正在转换段落、表格和代码块');
  if (mode.endsWith('_html')) {
    const body = markdown ? parser.renderer.render(tokens, parser.options, {}) : `<div class="plain">${escapeHtml(text)}</div>`;
    const blob = new Blob([htmlDocument(body, name)], { type: 'text/html;charset=utf-8' });
    warnings.push('这是打印预览 HTML，请使用浏览器打印并选择“另存为 PDF”；页面效果取决于本机字体与打印设置。');
    progress(100, '打印预览已准备好');
    return { outputs: [{ name: `${name}_打印预览.html`, blob }], warnings, summary: '已生成本地打印预览，可打印另存为 PDF。', preview: { type: 'html', name: `${name}_打印预览.html` } };
  }
  const children = markdown ? markdownChildren(tokens) : text.split('\n').map(line => new Paragraph({ children: [new TextRun(line)], spacing: { after: 100, line: 360 } }));
  const document = new Document({ creator: '学伴工作台', title: name, styles: { default: { document: { run: { font: '宋体', size: 24 }, paragraph: { spacing: { line: 360 } } } } }, sections: [{ properties: {}, children }] });
  progress(75, '正在打包可编辑的 Word 文档');
  const blob = await Packer.toBlob(document);
  progress(100, 'Word 文档已生成');
  return { outputs: [{ name: `${name}.docx`, blob }], warnings, summary: '已生成可编辑 DOCX；请用 Word/WPS 核对字体和分页。' };
}

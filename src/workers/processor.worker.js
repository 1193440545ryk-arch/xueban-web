self.onmessage = async ({data}) => {
  const progress = (percent, message) => self.postMessage({type: 'progress', percent, message});
  try {
    let result;
    if (data.kind === 'image') {
      const {processImage} = await import('../processors/image.js');
      result = await processImage(data.files, data.options, progress);
    } else if (data.kind === 'pdf' || (data.kind === 'document' && data.options.mode?.startsWith('pdf_'))) {
      const {processPdf, processPdfDocument} = await import('../processors/pdf.js');
      result = await (data.kind === 'pdf' ? processPdf : processPdfDocument)(data.files, data.options, progress);
    } else if (data.kind === 'document') {
      const {processDocument} = await import('../processors/document.js');
      result = await processDocument(data.files, data.options, progress);
    } else if (data.kind === 'paper') {
      const {processPaper} = await import('../processors/paper.js');
      result = await processPaper(data.files, data.options, progress);
    } else throw new Error('暂不支持此操作。');
    self.postMessage({type: 'result', result});
  } catch (error) {
    self.postMessage({type: 'error', message: error?.message || '处理失败，请检查文件。'});
  }
};

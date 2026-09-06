// 边界测试2：文本 + 单工具混合流（验证 index 顺序 text<tool、stop 顺序正确）
const { openaiSseToAnthropic } = require('./src/converter');

function makeStream(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}
function sseData(obj) { return `data: ${JSON.stringify(obj)}\n\n`; }

const chunks = [
  Buffer.from(sseData({ choices: [{ index: 0, delta: { role: 'assistant', content: '让我看看' }, finish_reason: null }] })),
  Buffer.from(sseData({ choices: [{ index: 0, delta: { content: '代码' }, finish_reason: null }] })),
  Buffer.from(sseData({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_x', type: 'function', function: { name: 'Bash', arguments: '{"cmd":"ls"}' } }] }, finish_reason: null }] })),
  Buffer.from(sseData({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })),
  Buffer.from('data: [DONE]\n\n'),
];

(async () => {
  const events = [];
  for await (const ev of openaiSseToAnthropic(makeStream(chunks), 'm')) events.push(ev);
  events.forEach((e) => {
    const line = e.split('\n')[1] || '';
    const m = line.match(/"type":"([^"]+)"/);
    const idx = line.match(/"index":(\d+)/);
    const nm = line.match(/"name":"([^"]*)"/);
    console.log(`${m ? m[1] : '?'} ${idx ? 'index=' + idx[1] : ''} ${nm ? 'name=' + nm[1] : ''}`);
  });
  const starts = events.filter((e) => e.includes('"content_block_start"')).length;
  const stops = events.filter((e) => e.includes('"content_block_stop"')).length;
  const textDelta = events.filter((e) => e.includes('text_delta')).length;
  const ok = starts === 2 && stops === 2 && textDelta === 2;
  console.log(ok ? '✓ 混合流通过' : '✗ 混合流异常');
})();

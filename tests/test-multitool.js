// 复现：多工具并行调用时转换层是否正确生成每个 tool_use 块
const { openaiSseToAnthropic } = require('./src/converter');

// 构造一个 OpenAI SSE 流（模拟上游返回两个并行 tool_calls，无 .done）
function makeStream(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

function sseData(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

// 模拟百炼/DeepSeek 类上游：两个并行工具调用，参数分片，finish_reason: tool_calls 收尾
const chunks = [
  Buffer.from(sseData({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })),
  Buffer.from(sseData({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'Read', arguments: '' } }] }, finish_reason: null }] })),
  Buffer.from(sseData({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'Grep', arguments: '' } }] }, finish_reason: null }] })),
  Buffer.from(sseData({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"file_path":' } }] }, finish_reason: null }] })),
  Buffer.from(sseData({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '{"pattern":' } }] }, finish_reason: null }] })),
  Buffer.from(sseData({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }, finish_reason: null }] })),
  Buffer.from(sseData({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '"foo"' } }] }, finish_reason: null }] })),
  Buffer.from(sseData({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })),
  Buffer.from('data: [DONE]\n\n'),
];

(async () => {
  const stream = makeStream(chunks);
  const events = [];
  for await (const ev of openaiSseToAnthropic(stream, 'test-model')) {
    events.push(ev);
  }
  // 统计
  const starts = events.filter((e) => e.includes('"content_block_start"')).length;
  const toolStarts = events.filter((e) => e.includes('content_block_start') && e.includes('tool_use')).length;
  const deltas = events.filter((e) => e.includes('input_json_delta')).length;
  const stops = events.filter((e) => e.includes('content_block_stop')).length;

  console.log('content_block_start 总数:', starts);
  console.log('tool_use start 数:', toolStarts, '(期望 2)');
  console.log('input_json_delta 数:', deltas, '(期望 4)');
  console.log('content_block_stop 数:', stops, '(期望 2)');
  console.log('');
  console.log('=== 事件序列 ===');
  events.forEach((e) => {
    const line = e.split('\n')[1] || '';
    const m = line.match(/"type":"([^"]+)"/);
    const idx = line.match(/"index":(\d+)/);
    const nm = line.match(/"name":"([^"]*)"/);
    console.log(`${m ? m[1] : '?'} ${idx ? 'index=' + idx[1] : ''} ${nm ? 'name=' + nm[1] : ''}`);
  });
})();

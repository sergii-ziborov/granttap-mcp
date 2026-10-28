const readline = require('node:readline');
process.stdout.write('{"ready":true}\n');
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const request = JSON.parse(line);
  const response = Buffer.from(JSON.stringify({ id: request.id,
    result: { operation: 'desktop.task_activity', entries: [{ id: 'fixture', kind: 'message', text: 'Привет 👋' }] } }) + '\n');
  const first = response.indexOf(Buffer.from('П')) + 1;
  const second = response.indexOf(Buffer.from('👋')) + 2;
  for (const chunk of [response.subarray(0, first), response.subarray(first, second), response.subarray(second)]) {
    process.stdout.write(chunk);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
});

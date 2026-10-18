const { createInterface } = require('node:readline');

/** Deterministic ACP provider fixture; never executes user commands. */
module.exports = function start(options = {}) {
  const args = process.argv.slice(2);
  if (!args.includes('acp') || !args.includes('--trust')) process.exit(2);
  if (args.some(arg => ['-p', '--force', '--yolo', '-f', '--approve-mcps'].includes(arg))) process.exit(3);
  const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  let sessionId = options.newId || 'cursor-new', loaded = false;
  createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line);
    if (message.method === 'initialize') return send({ id: message.id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    if (message.method === 'session/new') return send({ id: message.id, result: { sessionId } });
    if (message.method === 'session/load') {
      if (options.rejectLoadIds?.includes(message.params.sessionId)) {
        return send({ id: message.id, error: { code: -32602, message: 'Native execution not found' } });
      }
      loaded = true; sessionId = message.params.sessionId;
      return send({ id: message.id, result: {} });
    }
    if (message.method !== 'session/prompt') process.exit(4);
    const prompt = message.params.prompt[0].text;
    if (options.requireContext && !prompt.includes('Keep authentication unchanged.') && prompt !== 'Second') process.exit(5);
    const text = options.requireContext ? 'Context retained' : options.cwd ? process.cwd()
      : JSON.stringify({ args, sessionId, loaded, prompt });
    send({ method: 'session/update', params: { sessionId, update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
    send({ id: message.id, result: { stopReason: 'end_turn' } });
  });
};

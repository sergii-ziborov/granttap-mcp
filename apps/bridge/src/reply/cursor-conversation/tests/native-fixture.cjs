const { createInterface } = require('node:readline');
const { appendFileSync, writeFileSync } = require('node:fs');
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const args = process.argv.slice(2);
if (!args.includes('acp') || !args.includes('--trust') || args.some(x => ['--force', '--yolo', '-p'].includes(x))) process.exit(2);
let promptId;
const sessionId = 'fixture-task';
createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method) appendFileSync(process.env.CURSOR_FIXTURE_LOG, msg.method + '\n');
  if (msg.method === 'initialize') {
    if (typeof msg.params.clientInfo?.version !== 'string') return send({ id: msg.id, error: { code: -32602 } });
    return send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  }
  if (msg.method === 'session/new') return send({ id: msg.id, result: { sessionId } });
  if (msg.method === 'session/load') {
    if (process.env.CURSOR_FIXTURE_MODE === 'load-fail') return send({ id: msg.id, error: { code: -32000, message: 'Missing session' } });
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD HISTORY MUST NOT REPLAY' } } } });
    return send({ id: msg.id, result: {} });
  }
  if (msg.method === 'session/prompt') {
    promptId = msg.id;
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'PRIVATE THOUGHT MUST NOT LEAK' } } } });
    return send({ id: 'question', method: 'cursor/ask_question', params: { toolCallId: 'question-1', title: 'Next step', questions: [
      { id: 'q1', prompt: 'Which action?', options: [{ id: 'test', label: 'Run tests' }, { id: 'review', label: 'Review' }] },
    ] } });
  }
  if (msg.id === 'question') {
    if (process.env.CURSOR_FIXTURE_MODE === 'wait') return;
    if (msg.result?.outcome?.answers?.[0]?.selectedOptionIds?.[0] !== 'test') process.exit(3);
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'shell-1',
      title: 'Write fixture marker', kind: 'execute', rawInput: { command: 'printf safe > marker' } } } });
    return send({ id: 'permission', method: 'session/request_permission', params: { sessionId,
      toolCall: { toolCallId: 'shell-1', title: 'Write fixture marker', kind: 'execute' },
      options: [{ optionId: 'native-reject', kind: 'reject_once', name: 'Reject' },
        { optionId: 'native-allow', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'never-global-allow', kind: 'allow_always', name: 'Allow always' }] } });
  }
  if (msg.id === 'permission') {
    if (msg.result?.outcome?.optionId !== 'native-allow') process.exit(4);
    writeFileSync(process.env.CURSOR_FIXTURE_MARKER, 'approved exactly once');
    return send({ id: 'plan', method: 'cursor/create_plan', params: {
      toolCallId: 'plan-1', name: 'Fixture plan', plan: 'Inspect the marker and finish.', todos: [] } });
  }
  if (msg.id === 'plan') {
    if (msg.result?.outcome?.outcome !== 'accepted') process.exit(5);
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Question answered; fixture completed.' } } } });
    return send({ id: promptId, result: { stopReason: 'end_turn' } });
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { T3Client, T3Delivery } from '../src/t3-delivery.js';
import { storedJobSchema } from '../src/contracts.js';

const requestSchema = z.object({ id: z.string().optional(), method: z.string(), params: z.unknown() });
const callSchema = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) });

test('thread delivery pins workspace and original; explicit queue send reconciles a lost reply without duplicate messages', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'footage-delivery-'));
  await Promise.all([mkdir(join(dir, 'originals'), { mode: 0o700 }), mkdir(join(dir, 'workspace'), { mode: 0o700 })]);
  const token = randomUUID(); await writeFile(join(dir, 'credential'), token, { mode: 0o600 });
  let archived = false, wrongEnvironment = false, loseReply = true;
  const sends: { threadId: string; clientRequestId: string; mode: string; message: string }[] = [];
  const messages = new Map<string, string>();
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
    if (!body.id) { res.writeHead(202).end(); return; }
    let result: unknown = { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'owned-contract-fixture', version: '1' } };
    if (body.method === 'tools/call') {
      const call = callSchema.parse(body.params);
      let value: unknown;
      switch (call.name) {
        case 't3_environment_read': value = { environmentId: wrongEnvironment ? 'wrong' : 'env' }; break;
        case 't3_project_read': value = { id: 'project', workspaceRoot: join(dir, 'workspace') }; break;
        case 't3_thread_read': value = { thread: { threadId: 'thread', projectId: 'project', title: 'Real selected target', archived, worktreePath: null } }; break;
        case 't3_thread_send': {
          const input = z.object({ threadId: z.string(), clientRequestId: z.string(), mode: z.string(), message: z.string() }).parse(call.arguments);
          sends.push(input); if (!messages.has(input.clientRequestId)) messages.set(input.clientRequestId, randomUUID());
          if (loseReply) { loseReply = false; req.socket.destroy(); return; }
          value = { threadId: input.threadId, messageId: messages.get(input.clientRequestId) }; break;
        }
        default: throw new Error('Unexpected tool');
      }
      result = { structuredContent: value, content: [] };
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  let delivery: T3Delivery | null = null;
  try {
    const client = await T3Client.fromFile(`http://127.0.0.1:${address.port}/mcp`, join(dir, 'credential'));
    const target = await client.target('env', 'project', 'thread', randomUUID());
    delivery = new T3Delivery(dir, client);
    const bytes = Buffer.from('generated original; not personal media'), jobId = randomUUID();
    const job = storedJobSchema.parse({ id: jobId, name: 'generated.mp4', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), tokenHash: 'a'.repeat(64), status: 'received', transport: 'tus', contentReference: 'original', receipt: { id: randomUUID(), jobId, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), verifiedAt: new Date().toISOString() } });
    await writeFile(join(dir, 'originals', job.id), bytes, { mode: 0o600 });
    await assert.rejects(delivery.materialize({ ...job, receipt: job.receipt && { ...job.receipt, bytes: job.bytes + 1 } }, target));
    const saved = await delivery.materialize(job, target);
    assert.deepEqual(await readFile(saved.path), bytes); assert.equal(sends.length, 0);
    await assert.rejects(delivery.materialize(job, { ...target, thread: 'different' }));
    archived = true; await assert.rejects(delivery.dispatch(job, target)); assert.equal(sends.length, 0); archived = false;
    wrongEnvironment = true; await assert.rejects(delivery.dispatch(job, target)); wrongEnvironment = false;
    await assert.rejects(delivery.dispatch(job, target));
    const [sent, replayed] = await Promise.all([delivery.dispatch(job, target), delivery.dispatch(job, target)]);
    assert.equal(sent, replayed);
    assert.equal(await delivery.dispatch(job, target), sent);
    assert.equal(messages.size, 1); assert.equal(sends.length, 2); assert.equal(sends[0]?.clientRequestId, sends[1]?.clientRequestId);
    assert.equal(sends[0]?.mode, 'queue'); assert.equal(sends[0]?.threadId, 'thread');
    assert(sends[0]?.message.includes(job.sha256)); assert(sends[0]?.message.includes('$cardboard'));
  } finally { delivery?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});

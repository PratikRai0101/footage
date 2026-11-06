import { resolve } from 'node:path';
import { z } from 'zod';
import { createReceiver } from './server.js';

const port = z.coerce.number().int().min(1).max(65535).parse(process.env.FOOTAGE_PORT ?? '1080');
const host = process.env.FOOTAGE_HOST ?? '127.0.0.1';
const receiver = await createReceiver(resolve(process.env.FOOTAGE_DATA_DIR ?? 'data'));
const address = await receiver.listen(port, host);
process.stdout.write(`Footage receiver listening at ${address}\nPrivate-network development only. Do not expose this spike to the internet.\n`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void receiver.close().then(() => process.exit(0)); });

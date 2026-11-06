import { openFixture } from './fixture.js';

const directory = process.argv[2], boundary = process.argv[3];
if (!directory || !boundary) throw new Error('Test worker arguments missing.');
const fixture = await openFixture(directory, {
  boundary(point) {
    if (point === boundary) process.kill(process.pid, 'SIGKILL');
  },
});
process.stdout.write(`${JSON.stringify({ base: fixture.base })}\n`);

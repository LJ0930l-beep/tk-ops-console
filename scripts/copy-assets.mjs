import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(import.meta.url), '../..');
const jobs = [
  ['apps/server/src/db/schema.sqlite.sql', 'apps/server/dist/db/schema.sqlite.sql'],
];
for (const [from, to] of jobs) {
  const src = path.join(root, from);
  const dst = path.join(root, to);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  console.log(`[assets] ${from} → ${to}`);
}

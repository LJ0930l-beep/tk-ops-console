import fs from 'node:fs';
import path from 'node:path';

const jobs = [
  ['apps/server/src/db/schema.sqlite.sql', 'apps/server/dist/db/schema.sqlite.sql'],
];
for (const [from, to] of jobs) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log(`[assets] ${from} → ${to}`);
}

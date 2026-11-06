// Copies the Sentinel Ember fire data and detector model from ../web/public so the
// Agent-Native app serves the same files as the Meta build without a second copy in git.
import {cpSync, existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../../web/public');
const dst = path.resolve(here, '../public');
for (const dir of ['data', 'models']) {
  const from = path.join(src, dir);
  if (!existsSync(from)) throw new Error(`missing ${from}: run from the metahacks repo`);
  cpSync(from, path.join(dst, dir), {recursive: true, force: true});
}
console.log('fire data synced into public/data and public/models');

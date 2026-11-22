import path from 'node:path';
import fs from 'node:fs/promises';
import { git, inventory } from './snapshot.js';
import { check, atomic, saveJson } from '../core.js';

// Populate a private Git index from raw bytes. Source attributes, filters, hooks
// and working-tree encodings never participate in object creation.
async function tree(p, files, signal) {
  const repo = path.join(p.input, 'baseline.git');
  const run = (args, input) => git(['--git-dir=' + repo, ...args], { cwd: p.code, input, signal });
  await run(['read-tree', '--empty']);
  if (files.length) {
    const names = files.map(f => f.path).join('\n') + '\n';
    const hashes = (await run(['hash-object', '-w', '--no-filters', '--stdin-paths'], names)).stdout
      .toString()
      .trim()
      .split('\n');
    check(
      hashes.length === files.length && hashes.every(h => /^[a-f0-9]{40}$/.test(h)),
      'Git returned invalid object IDs',
      1
    );
    const index = files.map((f, i) => f.mode + ' ' + hashes[i] + '\t' + f.path + '\0').join('');
    await run(['update-index', '-z', '--index-info'], index);
  }
  return (await run(['write-tree'])).stdout.toString().trim();
}
export async function baseline(p, snapshot, signal) {
  await git(['init', '--bare', '--object-format=sha1', '--template=', path.join(p.input, 'baseline.git')], {
    signal,
  });
  return tree(p, snapshot.code.files, signal);
}
export async function collectPatch(p, initial, baseTree, limits, signal) {
  const before = new Map(initial.code.files.map(f => [f.path, f]));
  const final = await inventory(p.code, limits, {
    readOnlySubtree: initial.code.readOnlySubtree,
    priorModes: Object.fromEntries([...before].map(([n, f]) => [n, f.mode])),
    signal,
  });
  const after = new Map(final.files.map(f => [f.path, f]));
  const changes = [];
  for (const name of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const a = before.get(name),
      b = after.get(name);
    if (a?.sha256 !== b?.sha256 || a?.mode !== b?.mode)
      changes.push({
        path: name,
        kind: !a ? 'added' : !b ? 'deleted' : 'modified',
        before: a ?? null,
        after: b ?? null,
      });
  }
  const target = await tree(p, final.files, signal);
  const { stdout } = await git(
    [
      '--git-dir=' + path.join(p.input, 'baseline.git'),
      'diff',
      '--binary',
      '--full-index',
      '--no-ext-diff',
      '--no-textconv',
      '--find-renames',
      baseTree,
      target,
      '--',
    ],
    { cwd: p.input, signal, max: Math.min(512 * 1024 ** 2, limits.totalBytes * 3 + 1048576) }
  );
  await atomic(p.patch, stdout);
  await saveJson(path.join(p.output, 'manifest.json'), {
    schemaVersion: 1,
    baseRevision: initial.code.revision,
    baseTree,
    finalTree: target,
    changes,
    excluded: final.excluded,
  });
  return changes.map(c => c.path);
}
export async function emptyPatch(p) {
  await fs.writeFile(p.patch, '', { mode: 0o600 });
  await saveJson(path.join(p.output, 'manifest.json'), { schemaVersion: 1, changes: [], complete: false });
}

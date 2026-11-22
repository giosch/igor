import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { check, command, inside, safeRelative, mkdir, systemEnv, saveJson, IgorError } from '../core.js';

const omitted = new Set(
  '.git .hg .svn .pi .claude .codex .ssh .aws .gnupg .azure .kube .docker .config .terraform .netrc _netrc .npmrc .pypirc .git-credentials credentials.json application_default_credentials.json node_modules .igor-dev .venv venv __pycache__ .cache .next .turbo .parcel-cache dist build target coverage .ds_store'.split(
    ' '
  )
);
export function excluded(name) {
  return name
    .split('/')
    .some(
      part =>
        omitted.has(part.toLowerCase()) ||
        /^\.env($|\.)|^id_(rsa|ed25519|ecdsa|dsa)($|\.)|\.(pem|p12|pfx|key|keystore)$/i.test(part)
    );
}
export function git(args, options = {}) {
  return command(
    'git',
    ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', ...args],
    {
      ...options,
      env: {
        ...systemEnv(),
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_ATTR_NOSYSTEM: '1',
        ...options.env,
      },
    }
  );
}
export async function canonicalFuture(dir) {
  try {
    return await fs.realpath(dir);
  } catch (err) {
    if (err.code !== 'ENOENT' || path.dirname(dir) === dir) throw err;
    return path.join(await canonicalFuture(path.dirname(dir)), path.basename(dir));
  }
}
export async function sourceRoot(input, home) {
  check(typeof input === 'string' && input.length && !input.includes('\0'), 'Missing source directory');
  const resolved = path.resolve(input);
  let root;
  try {
    root = await fs.realpath(resolved);
    check((await fs.stat(root)).isDirectory(), 'Expected a directory: ' + input);
  } catch (err) {
    throw new IgorError('Invalid source directory ' + input + ': ' + err.message, 2);
  }
  const data = await canonicalFuture(home);
  check(!inside(root, data) && !inside(data, root), 'Source and Igor data directories overlap');
  return root;
}
function omit(name, readOnlySubtree) {
  return (
    excluded(name) ||
    (readOnlySubtree && (name === readOnlySubtree || name.startsWith(readOnlySubtree + '/')))
  );
}
async function walk(root, limits, signal, excludedPaths, readOnlySubtree) {
  const names = [];
  let visited = 0;
  async function descend(rel) {
    const folder = await fs.opendir(path.join(root, rel));
    for await (const item of folder) {
      signal?.throwIfAborted();
      check(++visited <= limits.files * 4 + 1000, 'Directory enumeration limit exceeded');
      const name = rel ? rel + '/' + item.name : item.name;
      if (omit(name, readOnlySubtree)) {
        excludedPaths.push(name);
        continue;
      }
      safeRelative(name);
      if (item.isDirectory() && !item.isSymbolicLink()) await descend(name);
      else names.push(name);
    }
  }
  await descend('');
  return names.sort();
}
async function sourceFiles(root, limits, signal, omittedPaths, readOnlySubtree) {
  const opt = { cwd: root, signal };
  const probe = await git(['rev-parse', '--is-inside-work-tree'], { ...opt, allow: [0, 128] });
  if (probe.code !== 0) {
    if (!probe.stderr.includes('not a git repository (or any')) throw new IgorError(probe.stderr);
    return {
      names: await walk(root, limits, signal, omittedPaths, readOnlySubtree),
      modes: {},
      revision: null,
      git: false,
    };
  }
  check(probe.stdout.toString().trim() === 'true', 'Select a Git working tree or a plain directory');
  const split = buffer => buffer.toString('utf8').split('\0').filter(Boolean);
  const staged = split((await git(['ls-files', '--stage', '-z', '--', '.'], opt)).stdout);
  const modes = Object.create(null);
  for (const line of staged) {
    const tab = line.indexOf('\t'),
      [mode, , stage] = line.slice(0, tab).split(' '),
      name = line.slice(tab + 1);
    if (omit(name, readOnlySubtree)) continue;
    check(stage === '0', 'Resolve Git conflicts before snapshotting: ' + name);
    check(mode !== '160000', 'Select the submodule separately: ' + name);
    modes[name] = mode;
  }
  const names = split(
    (await git(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'], opt)).stdout
  );
  const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD'], { ...opt, allow: [0, 1] });
  return {
    names: [...new Set(names)].sort(),
    modes,
    revision: head.stdout.toString().trim() || null,
    git: true,
  };
}
// Check every ancestor. Git can list a tracked child underneath a replaced directory.
async function ordinaryFile(root, name, checked) {
  let parent = root;
  const parts = safeRelative(name).split('/');
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part);
    if (checked.has(parent)) continue;
    const stat = await fs.lstat(parent);
    check(!stat.isSymbolicLink() && stat.isDirectory(), 'Linked or invalid directory: ' + name);
    checked.add(parent);
  }
  const file = path.join(root, name),
    stat = await fs.lstat(file);
  check(stat.isFile() && !stat.isSymbolicLink(), 'Links and special files are unsupported: ' + name);
  const real = await fs.realpath(file);
  check(inside(root, real), 'Path escapes source: ' + name);
  check(
    !excluded(path.relative(root, real).split(path.sep).join('/')),
    'Path resolves to excluded data: ' + name
  );
  return { file, stat };
}
async function readStable(entry, name, signal) {
  const handle = await fs.open(entry.file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat();
    check(
      before.isFile() &&
        before.ino === entry.stat.ino &&
        before.dev === entry.stat.dev &&
        before.size === entry.stat.size,
      'File changed before copying: ' + name
    );
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted();
      const read = await handle.read(bytes, offset, Math.min(1024 ** 2, bytes.length - offset), offset);
      check(read.bytesRead > 0, 'File truncated during snapshot: ' + name);
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    check(
      after.size === before.size && after.mtimeMs === before.mtimeMs,
      'File changed during snapshot: ' + name
    );
    return bytes;
  } finally {
    await handle.close();
  }
}
export async function inventory(
  root,
  limits,
  { dest, signal, priorModes = {}, source = false, readOnlySubtree = null } = {}
) {
  const omittedPaths = [],
    deleted = [],
    files = [],
    checked = new Set();
  const info = source
    ? await sourceFiles(root, limits, signal, omittedPaths, readOnlySubtree)
    : {
        names: await walk(root, limits, signal, omittedPaths, readOnlySubtree),
        modes: priorModes,
        revision: null,
        git: false,
      };
  let bytes = 0;
  for (const name of info.names) {
    signal?.throwIfAborted();
    if (omit(name, readOnlySubtree)) {
      omittedPaths.push(name);
      continue;
    }
    let entry;
    try {
      entry = await ordinaryFile(root, name, checked);
    } catch (err) {
      if (err.code === 'ENOENT' && Object.hasOwn(info.modes, name)) {
        deleted.push(name);
        continue;
      }
      throw err;
    }
    check(
      files.length < limits.files && entry.stat.size <= limits.fileBytes,
      'Snapshot limit exceeded at ' + name
    );
    bytes += entry.stat.size;
    check(bytes <= limits.totalBytes, 'Total snapshot size exceeded at ' + name);
    if (!source) check(entry.stat.nlink === 1, 'Hard-linked worker output is unsupported: ' + name);
    const data = await readStable(entry, name, signal);
    const executable =
      process.platform === 'win32' ? info.modes[name] === '100755' : Boolean(entry.stat.mode & 0o111);
    const mode = executable ? '100755' : '100644';
    if (dest) {
      const file = path.join(dest, name);
      await mkdir(path.dirname(file));
      await fs.writeFile(file, data, { flag: 'wx', mode: executable ? 0o700 : 0o600 });
    }
    files.push({
      path: name,
      mode,
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    });
  }
  return { revision: info.revision, git: info.git, files, deleted, excluded: omittedPaths, bytes };
}
export async function snapshot(spec, p, limits, signal) {
  const readOnlySubtree =
    spec.docs && inside(spec.code, spec.docs)
      ? path.relative(spec.code, spec.docs).split(path.sep).join('/')
      : null;
  check(readOnlySubtree !== '', 'Code and documentation must have distinct roots');
  const code = await inventory(spec.code, limits, { dest: p.code, source: true, signal, readOnlySubtree });
  code.readOnlySubtree = readOnlySubtree;
  const docs = spec.docs ? await inventory(spec.docs, limits, { dest: p.docs, source: true, signal }) : null;
  const manifest = { schemaVersion: 1, code, docs };
  await saveJson(path.join(p.input, 'snapshot.json'), manifest);
  return manifest;
}

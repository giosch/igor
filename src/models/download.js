import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { check, IgorError, mkdir, jsonFile, saveJson, safeId, safeRelative } from '../core.js';
import { exclusive } from '../jobs/store.js';

const allowedMlx =
  /^(?:[\w.-]+\.safetensors|model\.safetensors\.index\.json|(?:config|generation_config|processor_config|preprocessor_config|tokenizer_config|tokenizer|special_tokens_map|added_tokens|vocab)\.json|merges\.txt|tokenizer\.model|chat_template\.jinja)$/;
export function selectFiles(model, metadata) {
  check(/^[0-9a-f]{40}$/.test(metadata.sha) && Array.isArray(metadata.siblings), 'Invalid Hub metadata', 4);
  check(!model.source.revision || metadata.sha === model.source.revision, 'Hub revision mismatch', 4);
  const files = [];
  for (const s of metadata.siblings) {
    if (!(model.runtime === 'llamacpp' ? s.rfilename === model.source.file : allowedMlx.test(s.rfilename)))
      continue;
    const name = safeRelative(s.rfilename);
    const hash = s.lfs?.sha256 || s.blobId;
    check(
      Number.isSafeInteger(s.size) && s.size >= 0 && (s.lfs ? /^[0-9a-f]{64}$/ : /^[0-9a-f]{40}$/).test(hash),
      'Missing checksum for ' + name,
      4
    );
    files.push({ name, size: s.size, hash, algorithm: s.lfs ? 'sha256' : 'git-sha1' });
  }
  check(
    files.length > 0 && new Set(files.map(f => f.name)).size === files.length,
    'Invalid model file list',
    4
  );
  if (model.runtime === 'omlx') {
    for (const name of ['config.json', ...(model.options.mtp ? ['mtp.safetensors'] : [])])
      check(
        files.some(f => f.name === name),
        'Missing ' + name,
        4
      );
    check(
      files.some(f => f.name.endsWith('.safetensors') && f.name !== 'mtp.safetensors'),
      'Missing weights',
      4
    );
  }
  return files;
}
async function valid(file, meta, full = true) {
  const stat = await fs.lstat(file).catch(err => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (!stat?.isFile() || stat.size !== meta.size) return false;
  if (!full) return true;
  const hash = createHash(meta.algorithm === 'git-sha1' ? 'sha1' : 'sha256');
  if (meta.algorithm === 'git-sha1') hash.update('blob ' + meta.size + '\0');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex') === meta.hash;
}
export async function fetchFile(url, dir, meta, request = fetch) {
  const file = path.join(dir, safeRelative(meta.name));
  if (await valid(file, meta)) return;
  const partial = file + '.part';
  let start = (
    await fs.stat(partial).catch(err => {
      if (err.code === 'ENOENT') return { size: 0 };
      throw err;
    })
  ).size;
  if (start === meta.size && (await valid(partial, meta))) {
    await fs.rename(partial, file);
    return;
  }
  if (start >= meta.size) start = 0;
  const response = await request(url, { headers: start ? { Range: 'bytes=' + start + '-' } : {} });
  check(response.ok, 'Download failed for ' + meta.name + ' (HTTP ' + response.status + ')', 4);
  const append = response.status === 206 && start > 0;
  if (response.status === 206)
    check(
      response.headers.get('content-range') === 'bytes ' + start + '-' + (meta.size - 1) + '/' + meta.size,
      'Invalid resumed range',
      4
    );
  let size = append ? start : 0;
  const bound = new Transform({
    transform(chunk, _, done) {
      size += chunk.length;
      done(size > meta.size ? new IgorError('Download exceeds published size', 4) : null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body),
    bound,
    createWriteStream(partial, { flags: append ? 'a' : 'w', mode: 0o600 })
  );
  if (!(await valid(partial, meta))) {
    await fs.rm(partial);
    throw new IgorError('Checksum mismatch for ' + meta.name + '. Retry the download.', 4);
  }
  await fs.rename(partial, file);
}
function cachePaths(home, id, revision, model) {
  check(/^(?:[a-f0-9]{40}|mock-v1)$/.test(revision), 'Invalid cached revision', 4);
  const root = path.join(home, 'cache', safeId(id), revision);
  const models = path.join(root, 'models');
  return {
    root,
    models,
    dir: path.join(models, model.runtime === 'omlx' ? safeRelative(model.options.modelId) : 'weights'),
  };
}
export async function download(home, id, model, { request = fetch, progress = () => {} } = {}) {
  check(model.runtime !== 'external', 'External endpoints manage their own model files');
  const lock = exclusive(path.join(home, 'runtime', 'download-' + safeId(id) + '.lock'));
  check(lock, 'Another download is active for ' + id, 4);
  try {
    let revision = 'mock-v1',
      files;
    const mockData = Buffer.from('Igor mock model v1\n');
    if (model.runtime === 'mock')
      files = [
        {
          name: 'mock.txt',
          size: mockData.length,
          algorithm: 'sha256',
          hash: createHash('sha256').update(mockData).digest('hex'),
        },
      ];
    else {
      const url =
        'https://huggingface.co/api/models/' +
        model.source.repository +
        '/revision/' +
        (model.source.revision || 'main') +
        '?blobs=true';
      const response = await request(url, { signal: AbortSignal.timeout(30000) });
      check(response.ok, 'Hub metadata HTTP ' + response.status, 4);
      const metadata = await response.json();
      files = selectFiles(model, metadata);
      revision = metadata.sha;
    }
    const p = cachePaths(home, id, revision, model);
    await mkdir(p.dir);
    for (const file of files) {
      progress(file.name);
      if (model.runtime === 'mock')
        await fs.writeFile(path.join(p.dir, file.name), mockData, { mode: 0o600 });
      else
        await fetchFile(
          'https://huggingface.co/' + model.source.repository + '/resolve/' + revision + '/' + file.name,
          p.dir,
          file,
          request
        );
    }
    const meta = { schemaVersion: 1, model: id, source: model.source, revision, files };
    await saveJson(path.join(p.root, 'manifest.json'), meta);
    await saveJson(path.join(home, 'cache', id, 'current.json'), { revision });
    return { model: id, revision, files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) };
  } catch (err) {
    throw new IgorError(err.message, 4);
  } finally {
    lock.close();
  }
}
export async function verify(home, id, model, full = true) {
  try {
    const current =
      model.source.revision ||
      (await jsonFile(path.join(home, 'cache', safeId(id), 'current.json'))).revision;
    const p = cachePaths(home, id, current, model),
      meta = await jsonFile(path.join(p.root, 'manifest.json'));
    check(
      meta.model === id &&
        meta.revision === current &&
        meta.source.type === model.source.type &&
        meta.source.repository === model.source.repository &&
        meta.files.length,
      'Cache identity mismatch',
      4
    );
    const names = new Set(meta.files.map(f => safeRelative(f.name)));
    const actual = await fs.readdir(p.dir);
    check(
      actual.length === names.size && actual.every(n => names.has(n)),
      'Unexpected cached model files',
      4
    );
    for (const f of meta.files)
      check(
        await valid(path.join(p.dir, safeRelative(f.name)), f, full),
        'Missing or damaged model file ' + f.name,
        4
      );
    if (model.runtime === 'omlx') {
      const config = await jsonFile(path.join(p.dir, 'config.json'));
      check(!config.model_file && !config.auto_map, 'Model requires custom repository code', 4);
      if (names.has('model.safetensors.index.json')) {
        const index = await jsonFile(path.join(p.dir, 'model.safetensors.index.json'));
        for (const file of new Set(Object.values(index.weight_map || {})))
          check(names.has(file) && file.endsWith('.safetensors'), 'Unexpected weight index target', 4);
      }
    }
    return {
      ...p,
      revision: current,
      files: meta.files.length,
      bytes: meta.files.reduce((n, f) => n + f.size, 0),
    };
  } catch (err) {
    throw new IgorError('Model verification failed. Run igor model download ' + id + '. ' + err.message, 4);
  }
}

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ArtifactStore, MemoryBrokerRuntime } from '../dist/services.js';

const workspaceA = 'workspace:alpha';
const workspaceB = 'workspace:beta';

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'browser-pilot-artifacts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'store');
  const store = new ArtifactStore({ directory, ...options });
  await store.initialize();
  return { root, directory, store };
}

function screenshot(workspaceId, bytes = Uint8Array.from([1, 2, 3])) {
  return {
    workspaceId,
    kind: 'screenshot',
    mimeType: 'image/png',
    bytes,
    width: 1,
    height: 1,
  };
}

test('Artifact Store protects directories and files and does not derive paths from IDs', async t => {
  const { directory, store } = await fixture(t, {
    idFactory: () => 'artifact:safe:id',
  });
  const record = await store.create(screenshot(workspaceA));

  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(record.path)).mode & 0o777, 0o600);
  assert.equal(record.path.includes('safe:id'), false);
  assert.deepEqual(await readFile(record.path), Buffer.from([1, 2, 3]));
});

test('Artifact Store imports an authorized local file as a protected upload input', async t => {
  const { root, directory, store } = await fixture(t);
  const source = join(root, 'resume.pdf');
  await writeFile(source, 'resume contents');

  const record = await store.importFile(workspaceA, source);
  assert.equal(record.descriptor.kind, 'upload_input');
  assert.equal(record.descriptor.sensitivity, 'user_file');
  assert.equal(record.descriptor.fileName, 'resume.pdf');
  assert.equal(record.descriptor.mimeType, 'application/pdf');
  assert.equal(record.path.startsWith(`${directory}/`), true);
  assert.equal(record.path.endsWith('/resume.pdf'), true);
  assert.equal((await stat(record.path)).mode & 0o777, 0o600);
  assert.deepEqual(await readFile(record.path), Buffer.from('resume contents'));
  assert.deepEqual(await readFile(source), Buffer.from('resume contents'));

  await store.release(workspaceA, record.descriptor.id);
  await assert.rejects(() => stat(record.path), error => error.code === 'ENOENT');
});

test('Artifact Store copies a completed user download and never removes the source', async t => {
  const { root, directory, store } = await fixture(t);
  const staging = join(root, 'private-download-guid');
  await writeFile(staging, 'download contents');

  const record = await store.ingestDownloadCopy(workspaceA, staging, 'quarterly-report.csv');
  assert.equal(record.descriptor.kind, 'download');
  assert.equal(record.descriptor.sensitivity, 'user_file');
  assert.equal(record.descriptor.fileName, 'quarterly-report.csv');
  assert.equal(record.descriptor.mimeType, 'text/csv');
  assert.equal(record.path.startsWith(`${directory}/`), true);
  assert.deepEqual(await readFile(record.path), Buffer.from('download contents'));
  assert.deepEqual(await readFile(staging), Buffer.from('download contents'));

  const listed = await store.list(workspaceA, ['download']);
  assert.deepEqual(listed.map(artifact => artifact.id), [record.descriptor.id]);
  assert.deepEqual(await store.list(workspaceB, ['download']), []);

  await store.release(workspaceA, record.descriptor.id);
  assert.deepEqual(await readFile(staging), Buffer.from('download contents'));
  await store.releaseWorkspace(workspaceA);
  assert.deepEqual(await readFile(staging), Buffer.from('download contents'));
});

test('download copying rejects unsafe sources and quota failures preserve user files', async t => {
  const { root, store } = await fixture(t, {
    maxArtifactBytes: 4,
    maxWorkspaceBytes: 8,
    maxTotalBytes: 16,
  });
  const source = join(root, 'large-download.bin');
  const sourceLink = join(root, 'download-link.bin');
  await writeFile(source, '12345');
  await symlink(source, sourceLink);

  await assert.rejects(
    () => store.ingestDownloadCopy(workspaceA, 'relative.bin', 'relative.bin'),
    error => error.code === 'invalid_argument',
  );
  await assert.rejects(
    () => store.ingestDownloadCopy(workspaceA, sourceLink, 'linked.bin'),
    error => error.code === 'invalid_argument',
  );
  await assert.rejects(
    () => store.ingestDownloadCopy(workspaceA, source, 'large.bin'),
    error => error.code === 'result_too_large',
  );
  assert.deepEqual(await readFile(source), Buffer.from('12345'));
});

test('Artifact import and export reject symbolic-link paths into Broker storage', async t => {
  const { root, directory, store } = await fixture(t);
  const record = await store.create(screenshot(workspaceA));
  const fileLink = join(root, 'broker-file-link');
  const directoryLink = join(root, 'broker-directory-link');
  await symlink(record.path, fileLink);
  await symlink(directory, directoryLink);

  await assert.rejects(
    () => store.importFile(workspaceA, fileLink),
    error => error.code === 'invalid_argument',
  );
  await assert.rejects(
    () => store.export(workspaceA, record.descriptor.id, join(directoryLink, 'export.png')),
    error => error.code === 'invalid_argument',
  );
});

test('Artifact Store enforces atomic quotas under concurrent creation', async t => {
  const { store } = await fixture(t, {
    maxArtifactBytes: 6,
    maxWorkspaceBytes: 10,
    maxTotalBytes: 20,
  });
  const results = await Promise.allSettled([
    store.create(screenshot(workspaceA, new Uint8Array(6))),
    store.create(screenshot(workspaceA, new Uint8Array(6))),
  ]);

  assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'result_too_large');
  assert.equal(store.size(), 1);
});

test('Artifact TTL, retain, and bounded expiry errors are deterministic', async t => {
  let now = 1_000;
  let nextId = 1;
  const { store } = await fixture(t, {
    now: () => now,
    ttlMs: 100,
    retainedTtlMs: 500,
    expiredTombstoneTtlMs: 1_000,
    maxExpiredTombstones: 1,
    idFactory: () => `artifact:item-${nextId++}`,
  });
  const retained = await store.create(screenshot(workspaceA));
  const ordinary = await store.create(screenshot(workspaceB));
  await store.retain(workspaceA, retained.descriptor.id);

  now = 1_100;
  assert.equal((await store.get(workspaceA, retained.descriptor.id)).descriptor.retained, true);
  await assert.rejects(
    () => store.get(workspaceB, ordinary.descriptor.id),
    error => error.code === 'artifact_expired',
  );

  now = 1_500;
  await assert.rejects(
    () => store.get(workspaceA, retained.descriptor.id),
    error => error.code === 'artifact_expired',
  );
  await assert.rejects(
    () => store.get(workspaceB, ordinary.descriptor.id),
    error => error.code === 'artifact_not_found',
  );
});

test('Artifact access is Workspace-scoped and release removes bytes', async t => {
  const { store } = await fixture(t);
  const record = await store.create(screenshot(workspaceA));

  await assert.rejects(
    () => store.get(workspaceB, record.descriptor.id),
    error => error.code === 'artifact_not_found',
  );
  await store.release(workspaceB, record.descriptor.id);
  assert.equal(store.size(), 1);
  await store.releaseWorkspace(workspaceA);
  assert.equal(store.size(), 0);
  await assert.rejects(() => stat(record.path), error => error.code === 'ENOENT');
});

test('Artifact export requires an absolute external path and does not overwrite by default', async t => {
  const { root, directory, store } = await fixture(t);
  const record = await store.create(screenshot(workspaceA));
  const destination = join(root, 'capture.png');

  await assert.rejects(
    () => store.export(workspaceA, record.descriptor.id, 'capture.png'),
    error => error.code === 'invalid_argument',
  );
  await assert.rejects(
    () => store.export(workspaceA, record.descriptor.id, join(directory, 'export.png')),
    error => error.code === 'invalid_argument',
  );
  const exported = await store.export(workspaceA, record.descriptor.id, destination);
  assert.equal(exported.path, destination);
  assert.equal((await stat(destination)).mode & 0o777, 0o600);
  await writeFile(destination, 'existing');
  await assert.rejects(
    () => store.export(workspaceA, record.descriptor.id, destination),
    error => error.code === 'invalid_argument',
  );
  await store.export(workspaceA, record.descriptor.id, destination, true);
  assert.deepEqual(await readFile(destination), Buffer.from([1, 2, 3]));
});

test('Artifact IDs are validated independently from filesystem paths', async t => {
  const { store } = await fixture(t, {
    idFactory: () => 'artifact:../../outside',
  });
  await assert.rejects(
    () => store.create(screenshot(workspaceA)),
    error => error.code === 'internal_error',
  );
  assert.equal(store.size(), 0);
});

test('Broker Artifact methods require an owning Workspace and active Lease', async t => {
  const { root, store } = await fixture(t);
  const runtime = new MemoryBrokerRuntime({
    serviceVersion: '1.0.0',
    brokerProcessIdentity: 'broker:artifact-test',
    browsers: [{
      candidate: { id: 'browser:test', product: 'Chrome', state: 'ready' },
      instance: {
        id: 'browser-instance:test',
        product: 'Chrome',
        userDataRoot: '/profiles/test',
        processIdentity: 'process:test',
        connectionGeneration: 1,
        state: 'connected',
      },
    }],
    artifactStore: store,
  });
  const initialize = (bridge, clientId) => runtime.call(bridge, 'initialize', {
    client: { id: clientId, name: clientId, version: '1.0.0', instanceId: 'instance:test' },
    protocol: { min: { major: 1, minor: 0 }, max: { major: 1, minor: 0 } },
    requestedCapabilities: ['workspace.manage', 'artifact.read'],
  });
  await initialize('bridge:owner', 'com.example.owner');
  const { workspace } = await runtime.call('bridge:owner', 'workspaces/create', {});
  const { lease } = await runtime.call('bridge:owner', 'leases/create', { workspaceId: workspace.id });
  const record = await store.create(screenshot(workspace.id));
  const uploadSource = join(root, 'attachment.txt');
  await writeFile(uploadSource, 'attachment');
  const imported = await runtime.call('bridge:owner', 'artifacts/import', {
    workspaceId: workspace.id,
    leaseId: lease.id,
    path: uploadSource,
  });
  assert.equal(imported.artifact.kind, 'upload_input');
  assert.equal(imported.artifact.fileName, 'attachment.txt');
  assert.equal(imported.artifact.sensitivity, 'user_file');

  const accessed = await runtime.call('bridge:owner', 'artifacts/get', {
    workspaceId: workspace.id,
    leaseId: lease.id,
    artifactId: record.descriptor.id,
  });
  assert.equal(accessed.path, record.path);
  const listed = await runtime.call('bridge:owner', 'artifacts/list', {
    workspaceId: workspace.id,
    leaseId: lease.id,
    kinds: ['screenshot'],
  });
  assert.deepEqual(listed.artifacts.map(artifact => artifact.id), [record.descriptor.id]);

  await initialize('bridge:other', 'com.example.other');
  const { workspace: otherWorkspace } = await runtime.call('bridge:other', 'workspaces/create', {});
  const { lease: otherLease } = await runtime.call('bridge:other', 'leases/create', {
    workspaceId: otherWorkspace.id,
  });
  await assert.rejects(
    () => runtime.call('bridge:other', 'artifacts/get', {
      workspaceId: workspace.id,
      leaseId: otherLease.id,
      artifactId: record.descriptor.id,
    }),
    error => error.code === 'workspace_not_found',
  );

  await runtime.call('bridge:owner', 'workspaces/release', { workspaceId: workspace.id });
  await assert.rejects(
    () => runtime.call('bridge:owner', 'artifacts/get', {
      workspaceId: workspace.id,
      leaseId: lease.id,
      artifactId: record.descriptor.id,
    }),
    error => error.code === 'workspace_not_found',
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.size(), 0);
});

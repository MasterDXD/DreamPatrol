'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const ServiceFSModule = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'service-fs'));
const ServiceFS = ServiceFSModule.ServiceFS || ServiceFSModule;
const MemoryAdapter = ServiceFSModule.MemoryAdapter || ServiceFS.MemoryAdapter;

function createFullAdapter(store) {
  return {
    list: (p) => {
      const prefix = p ? p + '/' : '';
      const entries = [];
      const seen = new Set();
      for (const key of store.keys()) {
        if (prefix && !key.startsWith(prefix)) continue;
        const remaining = prefix ? key.slice(prefix.length) : key;
        if (remaining.length === 0) continue;
        const name = remaining.includes('/') ? remaining.split('/')[0] : remaining;
        if (seen.has(name)) continue;
        seen.add(name);
        entries.push({ name, type: remaining.includes('/') ? 'dir' : 'file' });
      }
      return entries;
    },
    read: (p) => store.get(p),
    write: (p, c) => { store.set(p, String(c)); return true; },
    remove: (p) => { store.delete(p); return true; },
    exists: (p) => store.has(p),
  };
}

describe('ServiceFS - Constructor', () => {
  it('should create instance with default config', () => {
    const sfs = new ServiceFS();
    assert.ok(sfs);
    assert.strictEqual(sfs._config.mountPrefix, '/services/');
    assert.strictEqual(sfs._config.maxMounts, 20);
    assert.strictEqual(sfs._config.pathMaxLength, 512);
  });

  it('should merge custom config with defaults', () => {
    const sfs = new ServiceFS({ maxMounts: 5 });
    assert.strictEqual(sfs._config.maxMounts, 5);
    assert.strictEqual(sfs._config.mountPrefix, '/services/');
  });

  it('should expose DEFAULT_CONFIG and MemoryAdapter', () => {
    assert.ok(ServiceFSModule.DEFAULT_CONFIG);
    assert.ok(MemoryAdapter);
  });
});

describe('ServiceFS - mount / unmount', () => {
  it('should mount a service with valid adapter', () => {
    const sfs = new ServiceFS();
    const store = new Map();
    const result = sfs.mount('test-svc', createFullAdapter(store));
    assert.strictEqual(result, sfs);
    assert.strictEqual(sfs._mounts.size, 1);
  });

  it('should throw for empty serviceName', () => {
    const sfs = new ServiceFS();
    assert.throws(() => sfs.mount('', createFullAdapter(new Map())), /non-empty string/);
  });

  it('should throw for invalid adapter', () => {
    const sfs = new ServiceFS();
    assert.throws(() => sfs.mount('svc', {}), /missing required method/);
    assert.throws(() => sfs.mount('svc', null), /must be an object/);
  });

  it('should throw for duplicate mount', () => {
    const sfs = new ServiceFS();
    const store = new Map();
    sfs.mount('svc', createFullAdapter(store));
    assert.throws(() => sfs.mount('svc', createFullAdapter(store)), /already mounted/);
  });

  it('should throw when maxMounts reached', () => {
    const sfs = new ServiceFS({ maxMounts: 1 });
    sfs.mount('svc1', createFullAdapter(new Map()));
    assert.throws(() => sfs.mount('svc2', createFullAdapter(new Map())), /Max mounts/);
  });

  it('should emit mounted event', () => {
    const sfs = new ServiceFS();
    let emitted = false;
    sfs.on('mounted', () => { emitted = true; });
    sfs.mount('svc', createFullAdapter(new Map()));
    assert.strictEqual(emitted, true);
  });

  it('should unmount a service', () => {
    const sfs = new ServiceFS();
    sfs.mount('svc', createFullAdapter(new Map()));
    const result = sfs.unmount('svc');
    assert.strictEqual(result, true);
    assert.strictEqual(sfs._mounts.size, 0);
  });

  it('should return false for unmounting non-existent service', () => {
    const sfs = new ServiceFS();
    assert.strictEqual(sfs.unmount('nonexistent'), false);
  });

  it('should emit unmounted event', () => {
    const sfs = new ServiceFS();
    sfs.mount('svc', createFullAdapter(new Map()));
    let emitted = false;
    sfs.on('unmounted', () => { emitted = true; });
    sfs.unmount('svc');
    assert.strictEqual(emitted, true);
  });
});

describe('ServiceFS - resolve', () => {
  it('should resolve a valid path', () => {
    const sfs = new ServiceFS();
    const result = sfs.resolve('/services/my-svc/path/to/file');
    assert.strictEqual(result.serviceName, 'my-svc');
    assert.strictEqual(result.adapterPath, 'path/to/file');
  });

  it('should resolve path without subpath', () => {
    const sfs = new ServiceFS();
    const result = sfs.resolve('/services/my-svc');
    assert.strictEqual(result.serviceName, 'my-svc');
    assert.strictEqual(result.adapterPath, '');
  });

  it('should throw for empty path', () => {
    const sfs = new ServiceFS();
    assert.throws(() => sfs.resolve(''), /non-empty string/);
  });

  it('should throw for path not starting with mountPrefix', () => {
    const sfs = new ServiceFS();
    assert.throws(() => sfs.resolve('/other/path'), /must start with/);
  });

  it('should throw for path exceeding max length', () => {
    const sfs = new ServiceFS({ pathMaxLength: 10 });
    assert.throws(() => sfs.resolve('/services/very-long-path'), /max length/);
  });

  it('should throw for path with only prefix', () => {
    const sfs = new ServiceFS();
    assert.throws(() => sfs.resolve('/services/'), /service name/);
  });
});

describe('ServiceFS - ls / cat / write / rm / exists', () => {
  it('should list files in a service', () => {
    const sfs = new ServiceFS();
    const store = new Map();
    store.set('file1.txt', 'hello');
    store.set('file2.txt', 'world');
    sfs.mount('svc', createFullAdapter(store));
    const entries = sfs.ls('/services/svc');
    assert.ok(Array.isArray(entries));
  });

  it('should read a file from a service', () => {
    const sfs = new ServiceFS();
    const store = new Map();
    store.set('data.txt', 'hello world');
    sfs.mount('svc', createFullAdapter(store));
    const content = sfs.cat('/services/svc/data.txt');
    assert.strictEqual(content, 'hello world');
  });

  it('should throw for cat without file path', () => {
    const sfs = new ServiceFS();
    sfs.mount('svc', createFullAdapter(new Map()));
    assert.throws(() => sfs.cat('/services/svc'), /file path/);
  });

  it('should write a file to a service', () => {
    const sfs = new ServiceFS();
    const store = new Map();
    sfs.mount('svc', createFullAdapter(store));
    const result = sfs.write('/services/svc/newfile.txt', 'content');
    assert.strictEqual(result, true);
  });

  it('should throw for write without file path', () => {
    const sfs = new ServiceFS();
    sfs.mount('svc', createFullAdapter(new Map()));
    assert.throws(() => sfs.write('/services/svc', 'content'), /file path/);
  });

  it('should remove a file from a service', () => {
    const sfs = new ServiceFS();
    const store = new Map();
    store.set('data.txt', 'hello');
    sfs.mount('svc', createFullAdapter(store));
    const result = sfs.rm('/services/svc/data.txt');
    assert.strictEqual(result, true);
  });

  it('should throw for rm without path', () => {
    const sfs = new ServiceFS();
    sfs.mount('svc', createFullAdapter(new Map()));
    assert.throws(() => sfs.rm('/services/svc'), /path/);
  });

  it('should check existence of a file', () => {
    const sfs = new ServiceFS();
    const store = new Map();
    store.set('data.txt', 'hello');
    sfs.mount('svc', createFullAdapter(store));
    assert.strictEqual(sfs.exists('/services/svc/data.txt'), true);
    assert.strictEqual(sfs.exists('/services/svc/missing.txt'), false);
  });

  it('should return true for service root exists', () => {
    const sfs = new ServiceFS();
    sfs.mount('svc', createFullAdapter(new Map()));
    assert.strictEqual(sfs.exists('/services/svc'), true);
  });

  it('should return false for unmounted service exists', () => {
    const sfs = new ServiceFS();
    assert.strictEqual(sfs.exists('/services/unknown'), false);
  });

  it('should throw for ls on unmounted service', () => {
    const sfs = new ServiceFS();
    assert.throws(() => sfs.ls('/services/unknown'), /not mounted/);
  });
});

describe('ServiceFS - tree', () => {
  it('should return tree for all services', () => {
    const sfs = new ServiceFS();
    const store = new Map();
    store.set('file1.txt', 'a');
    sfs.mount('svc', createFullAdapter(store));
    const tree = sfs.tree();
    assert.ok(typeof tree === 'string');
    assert.ok(tree.includes('/services/'));
  });

  it('should return tree for specific service path', () => {
    const sfs = new ServiceFS();
    const store = new Map();
    store.set('file1.txt', 'a');
    sfs.mount('svc', createFullAdapter(store));
    const tree = sfs.tree('/services/svc');
    assert.ok(typeof tree === 'string');
  });

  it('should throw for unmounted service tree', () => {
    const sfs = new ServiceFS();
    assert.throws(() => sfs.tree('/services/unknown'), /not mounted/);
  });
});

describe('ServiceFS - MemoryAdapter', () => {
  it('should support basic CRUD operations', () => {
    const adapter = new MemoryAdapter();
    adapter.write('test.txt', 'hello');
    assert.strictEqual(adapter.read('test.txt'), 'hello');
    assert.strictEqual(adapter.exists('test.txt'), true);
    adapter.remove('test.txt');
    assert.strictEqual(adapter.exists('test.txt'), false);
  });

  it('should throw on read for non-existent path', () => {
    const adapter = new MemoryAdapter();
    assert.throws(() => adapter.read('missing.txt'), /Not found/);
  });

  it('should list entries', () => {
    const adapter = new MemoryAdapter();
    adapter.write('a.txt', 'a');
    adapter.write('b.txt', 'b');
    const entries = adapter.list('');
    assert.strictEqual(entries.length, 2);
  });

  it('should remove with prefix', () => {
    const adapter = new MemoryAdapter();
    adapter.write('dir/a.txt', 'a');
    adapter.write('dir/b.txt', 'b');
    adapter.write('c.txt', 'c');
    adapter.remove('dir');
    assert.strictEqual(adapter.exists('dir/a.txt'), false);
    assert.strictEqual(adapter.exists('c.txt'), true);
  });
});

describe('ServiceFS - getStats', () => {
  it('should return stats object', () => {
    const sfs = new ServiceFS();
    const stats = sfs.getStats();
    assert.strictEqual(stats.mountCount, 0);
    assert.strictEqual(stats.maxMounts, 20);
    assert.ok(stats.services);
    assert.ok(stats.operations);
  });

  it('should reflect mount operations', () => {
    const sfs = new ServiceFS();
    sfs.mount('svc', createFullAdapter(new Map()));
    const stats = sfs.getStats();
    assert.strictEqual(stats.mountCount, 1);
    assert.strictEqual(stats.operations.mounts, 1);
  });
});

describe('ServiceFS - shutdown', () => {
  it('should clear all data on shutdown', () => {
    const sfs = new ServiceFS();
    sfs.mount('svc', createFullAdapter(new Map()));
    sfs.shutdown();
    assert.strictEqual(sfs._mounts.size, 0);
    assert.strictEqual(sfs._shutDown, true);
  });

  it('should prevent operations after shutdown', () => {
    const sfs = new ServiceFS();
    sfs.shutdown();
    assert.throws(() => sfs.mount('svc', createFullAdapter(new Map())), /shut down/i);
  });
});

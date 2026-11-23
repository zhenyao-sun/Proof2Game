// The progress record and its manual/recovery snapshots change in one transaction.
// Keep snapshots separate so reading the map only loads the current conversation.
export function stripLegacyMessageImages(message) {
  if (!message || typeof message !== 'object' ||
      !['images', 'image', 'image_retry'].some(key => Object.hasOwn(message, key))) return false;
  if (message.role === 'assistant' && typeof message.content === 'string' && !message.content.trim()) {
    const captions = [message.image, ...(Array.isArray(message.images) ? message.images : [])]
      .map(item => item?.alt).filter(alt => typeof alt === 'string' && alt.trim());
    if (captions.length) message.content = captions.join('\n\n');
  }
  delete message.image;
  delete message.images;
  delete message.image_retry;
  return true;
}
const changed = () => Object.assign(new Error('Progress changed in another tab. Refresh and retry.'), {
  status:409, publicCode:'progressChanged'
});
export function saveSummary(id, record) {
  return {id, label:record.label, created_at:record.created_at, completed_count:record.progress.completed.length, sequence:record.progress.revision};
}
export function createSaveStore(key, storage, blankProgress, validate, database = globalThis.indexedDB) {
  const empty = () => ({progress:blankProgress(), generation:0, saves:{}, recovery:{}});
  function migrate(raw) {
    if (!raw) return {state:empty(), files:{}};
    const old = JSON.parse(raw);
    if (old.storage_version === 2) return old;
    validate(structuredClone(old.progress));
    if (!old.saves || Array.isArray(old.saves) || !Array.isArray(old.recovery) || !Number.isSafeInteger(old.generation)) {
      throw new Error('Invalid browser save. Existing data was preserved.');
    }
    const state = {...empty(), progress:old.progress, generation:old.generation};
    const files = {};
    for (const [id, record] of Object.entries(old.saves)) {
      files[id] = record;
      state.saves[id] = saveSummary(id, record);
    }
    for (const record of old.recovery) {
      const id = crypto.randomUUID();
      state.recovery[id] = {action:'legacy'};
      files[id] = record;
    }
    return {state, files};
  }
  if (!database) {
    const read = () => migrate(storage.getItem(key));
    return {
      async read() { return read().state; },
      async snapshot(id) { return read().files[id]; },
      async write(state, expected, updates = {}, removed = []) {
        const old = read();
        if (old.state.generation !== expected) throw changed();
        Object.assign(old.files, updates);
        for (const id of removed) delete old.files[id];
        storage.setItem(key, JSON.stringify({storage_version:2, state, files:old.files}));
      }
    };
  }
  const opened = new Promise((resolve, reject) => {
    const request = database.open('Proof2Game saves', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('games');
      request.result.createObjectStore('snapshots');
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  function transaction(db, mode, operation) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['games','snapshots'], mode);
      const games = tx.objectStore('games'), snapshots = tx.objectStore('snapshots');
      let result, error;
      const guard = fn => event => {
        try { fn(event.target.result); } catch (cause) { error = cause; tx.abort(); }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(error || tx.error || new Error('Could not save progress on this device.'));
      operation(games, snapshots, guard, value => {result=value;});
    });
  }
  const ready = opened.then(async db => {
    let migrated = false;
    await transaction(db, 'readwrite', (games, snapshots, guard) => {
      games.get(key).onsuccess = guard(current => {
        if (current) return;
        const raw = storage.getItem(key);
        const legacy = migrate(raw);
        validate(structuredClone(legacy.state.progress));
        games.put(legacy.state, key);
        for (const [id, value] of Object.entries(legacy.files)) snapshots.put(value, [key, id]);
        migrated = Boolean(raw);
      });
    });
    if (migrated) storage.removeItem(key);
    db.onversionchange = () => db.close();
    return db;
  });
  return {
    async read() {
      return transaction(await ready, 'readonly', (games, _, guard, done) => { games.get(key).onsuccess = guard(done); });
    },
    async snapshot(id) {
      return transaction(await ready, 'readonly', (_, snapshots, guard, done) => { snapshots.get([key,id]).onsuccess = guard(done); });
    },
    async write(state, expected, updates = {}, removed = []) {
      return transaction(await ready, 'readwrite', (games, snapshots, guard) => {
        games.get(key).onsuccess = guard(current => {
          if (current.generation !== expected) throw changed();
          games.put(state, key);
          for (const [id, value] of Object.entries(updates)) snapshots.put(value, [key,id]);
          for (const id of removed) snapshots.delete([key,id]);
        });
      });
    }
  };
}

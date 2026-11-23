const connectionKey = 'proof2game:ai:deepseek';
const legacyKey = 'proof2game:deepseek-key';

export function createConnections({storage, models, checks, onChange = () => {}, onRequired = () => {}}) {
  storage.removeItem('proof2game:ai:bailian');
  let attempt;
  const waiters = new Set();

  function checkProvider(provider) {
    if (provider !== 'deepseek') throw new Error('Unknown AI service.');
  }
  function stored() {
    const raw = storage.getItem(connectionKey);
    if (!raw) return {key: storage.getItem(legacyKey) || '', models: []};
    const record = JSON.parse(raw);
    if (typeof record.key !== 'string' || !Array.isArray(record.models)) throw new Error('Invalid AI connection configuration.');
    return record;
  }
  function state() {
    const record = stored();
    if (!record.key) return 'missing';
    if (attempt?.key === record.key) return 'verifying';
    if (record.models.includes(models.deepseek)) return 'verified';
    return record.error || 'unverified';
  }
  const verified = () => state() === 'verified';
  const snapshot = () => ({
    available: true, authenticated: verified(), providers: {deepseek: {state: state()}}
  });
  function notify() {
    const connection = snapshot();
    onChange(connection);
    if (connection.authenticated) for (const wake of [...waiters]) wake();
  }
  function setKey(provider, value) {
    checkProvider(provider);
    const previous = stored();
    if (typeof value !== 'string' || value.length > 1024 || /[\s\x00-\x1f]/.test(value)) throw new Error('Enter an API key without spaces.');
    if (value === previous.key) return;
    attempt?.controller.abort();
    attempt = undefined;
    if (value) storage.setItem(connectionKey, JSON.stringify({key: value, models: []}));
    else storage.removeItem(connectionKey);
    storage.removeItem(legacyKey);
    notify();
  }
  async function verify(provider, {force = false} = {}) {
    checkProvider(provider);
    const record = stored();
    if (!record.key) throw new Error('Enter an API key first.');
    if (attempt?.key === record.key) return attempt.promise;
    if (!force && verified()) return snapshot();
    const controller = new AbortController();
    const active = {controller, key: record.key};
    const timer = setTimeout(() => controller.abort(), 120000);
    attempt = active;
    active.promise = (async () => {
      try {
        await checks.deepseek(record.key, controller.signal);
        const current = stored();
        if (attempt === active && current.key === record.key) {
          storage.setItem(connectionKey, JSON.stringify({key: current.key, models: [...new Set([...current.models, models.deepseek])]}));
          storage.removeItem(legacyKey);
        }
      } catch (error) {
        const current = stored();
        if (attempt === active && current.key === record.key) {
          const reason = error.reason === 'invalid_key' || error.reason === 'balance' ? error.reason : 'failed';
          const retained = reason === 'failed' ? current.models.filter(model => model !== models.deepseek) : [];
          storage.setItem(connectionKey, JSON.stringify({...current, models: retained, error: reason}));
        }
        throw error;
      } finally {
        clearTimeout(timer);
        if (attempt === active) attempt = undefined;
        notify();
      }
      return snapshot();
    })();
    notify();
    return active.promise;
  }
  function waitUntilVerified(signal) {
    if (verified()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {waiters.delete(wake); signal?.removeEventListener('abort', abort);};
      const wake = () => {cleanup(); resolve();};
      const abort = () => {cleanup(); reject(signal.reason || new DOMException('Cancelled', 'AbortError'));};
      if (signal?.aborted) return abort();
      waiters.add(wake);
      signal?.addEventListener('abort', abort, {once: true});
    });
  }
  function requireVerified() {
    if (verified()) return;
    onRequired({connection: snapshot()});
    throw Object.assign(new Error('Verify your DeepSeek API key in AI Connection to enter a level.'), {status: 401, code: 'missingKey'});
  }
  async function withVerifiedService(provider, operation, signal, background = false, onPause = () => {}) {
    checkProvider(provider);
    for (;;) {
      signal?.throwIfAborted();
      if (!verified()) {
        if (background) throw new Error('Waiting for the DeepSeek connection.');
        onPause(true);
        try {
          onRequired({connection: snapshot(), paused: true});
          await waitUntilVerified(signal);
        } finally {onPause(false);}
      }
      const attemptedKey = stored().key;
      try {return await operation(attemptedKey);}
      catch (error) {
        const invalid = error.reason === 'invalid_key' || error.status === 401;
        if (!invalid) throw error;
        const current = stored();
        if (current.key === attemptedKey) {
          storage.setItem(connectionKey, JSON.stringify({...current, models: [], error: 'invalid_key'}));
          notify();
        }
        if (background) throw error;
      }
    }
  }
  function syncStorage(eventKey) {
    if (eventKey && eventKey !== legacyKey && eventKey !== connectionKey) return false;
    notify();
    return true;
  }
  return {snapshot, verified, setKey, verify, requireVerified, withVerifiedService, syncStorage};
}

const providers = ['deepseek', 'bailian'];
const prefix = 'proof2game:ai:';
const legacy = 'proof2game:deepseek-key';

export function createConnections({storage, models, checks, onChange = () => {}, onRequired = () => {}}) {
  const attempts = new Map();
  const waiters = new Set();
  const stored = provider => {
    if (!providers.includes(provider)) throw new Error('Unknown AI service.');
    const raw = storage.getItem(prefix + provider);
    if (raw) {
      const record = JSON.parse(raw);
      if (typeof record.key === 'string' && Array.isArray(record.models)) return record;
      throw new Error('Invalid AI connection configuration.');
    }
    return {key: provider === 'deepseek' ? storage.getItem(legacy) || '' : '', models: []};
  };
  function state(provider) {
    const record = stored(provider);
    if (!record.key) return 'missing';
    if (attempts.get(provider)?.key === record.key) return 'verifying';
    if (record.models.includes(models[provider])) return 'verified';
    return record.error || 'unverified';
  }
  const verified = () => providers.every(provider => state(provider) === 'verified');
  const snapshot = () => ({
    available: true, authenticated: verified(),
    providers: Object.fromEntries(providers.map(provider => [provider, {state: state(provider)}]))
  });
  function notify() {
    onChange(snapshot());
    if (verified()) for (const wake of [...waiters]) wake();
  }
  function setKey(provider, value) {
    const previous = stored(provider);
    if (typeof value !== 'string' || value.length > 1024 || /[\s\x00-\x1f]/.test(value)) throw new Error('Enter an API key without spaces.');
    if (value === previous.key) return;
    attempts.get(provider)?.controller.abort();
    attempts.delete(provider);
    if (value) storage.setItem(prefix + provider, JSON.stringify({key: value, models: []}));
    else storage.removeItem(prefix + provider);
    if (provider === 'deepseek') storage.removeItem(legacy);
    notify();
  }
  async function verify(provider, {force = false} = {}) {
    const record = stored(provider);
    if (!record.key) throw new Error('Enter an API key first.');
    const existing = attempts.get(provider);
    if (existing?.key === record.key) return existing.promise;
    if (!force && state(provider) === 'verified') return snapshot();
    const controller = new AbortController();
    const attempt = {controller, key: record.key};
    const timer = setTimeout(() => controller.abort(), 120000);
    attempts.set(provider, attempt);
    attempt.promise = (async () => {
      try {
        await checks[provider](record.key, controller.signal);
        const current = stored(provider);
        if (attempts.get(provider) === attempt && current.key === record.key) {
          storage.setItem(prefix + provider, JSON.stringify({key: current.key, models: [...new Set([...current.models, models[provider]])]}));
          if (provider === 'deepseek') storage.removeItem(legacy);
        }
      } catch (error) {
        const current = stored(provider);
        if (attempts.get(provider) === attempt && current.key === record.key) {
          const reason = error.reason === 'invalid_key' || error.reason === 'balance' ? error.reason : 'failed';
          const retained = reason === 'failed' ? current.models.filter(model => model !== models[provider]) : [];
          storage.setItem(prefix + provider, JSON.stringify({...current, models: retained, error: reason}));
        }
        throw error;
      } finally {
        clearTimeout(timer);
        if (attempts.get(provider) === attempt) attempts.delete(provider);
        notify();
      }
      return snapshot();
    })();
    notify();
    return attempt.promise;
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
    throw Object.assign(new Error('Verify both API keys in AI Connection to enter a level.'), {status: 401, code: 'missingKey'});
  }
  async function withVerifiedService(provider, operation, signal, background = false, onPause = () => {}) {
    for (;;) {
      signal?.throwIfAborted();
      if (!verified()) {
        if (background) throw new Error('Waiting for verified API connections.');
        onPause(true);
        try {
          onRequired({connection: snapshot(), paused: true});
          await waitUntilVerified(signal);
        } finally {onPause(false);}
      }
      const attemptedKey = stored(provider).key;
      try {return await operation(attemptedKey);}
      catch (error) {
        const invalid = error.reason === 'invalid_key' || error.status === 401;
        const billing = provider === 'bailian' && error.reason === 'balance';
        if (!invalid && !billing) throw error;
        const current = stored(provider);
        if (current.key === attemptedKey) {
          storage.setItem(prefix + provider, JSON.stringify({...current, models: [], error: billing ? 'balance' : 'invalid_key'}));
          notify();
        }
        if (background) throw error;
      }
    }
  }
  function syncStorage(eventKey) {
    if (eventKey && eventKey !== legacy && !eventKey.startsWith(prefix)) return false;
    notify();
    return true;
  }
  return {snapshot, verified, setKey, verify, requireVerified, withVerifiedService, syncStorage};
}

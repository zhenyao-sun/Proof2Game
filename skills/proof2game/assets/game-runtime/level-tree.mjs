// Map edges describe proof structure. Only manuscript positions authorize entering a level.
export function createLevelTree(levels, fail) {
  const byId = new Map();
  const position = new Map();
  for (const [index, level] of levels.entries()) {
    if (!level.id || byId.has(level.id) || !['statement', 'proof', 'convention'].includes(level.type) || typeof level.text !== 'string') {
      fail('Invalid game level.');
    }
    byId.set(level.id, level);
    position.set(level.id, index);
  }
  for (const level of levels) {
    if (level.type === 'convention') {
      if ((level.owner && !byId.has(level.owner)) || level.paired) fail('Invalid section convention.');
    } else {
      const pair = byId.get(level.paired);
      if (!pair || pair.paired !== level.id || pair.type === level.type) fail('Invalid statement/proof pairing.');
    }
  }
  function validateParents() {
    const checked = new Set();
    for (const level of byId.values()) {
      const path = new Set();
      let id = level.id;
      while (id && !checked.has(id)) {
        if (!byId.has(id) || path.has(id)) fail('Invalid level hierarchy.');
        path.add(id);
        id = byId.get(id).parent;
      }
      for (const id of path) checked.add(id);
    }
  }
  validateParents();

  const section = level => (level.structural_path || level.location || '').toString().split('.')[0];
  function statementOwner(convention) {
    const owner = byId.get(convention.owner);
    return owner?.type === 'proof' ? byId.get(owner.paired) : owner;
  }
  const settingOf = new Map();
  const settingParent = new Map();
  for (const level of levels) {
    if (level.type !== 'convention') continue;
    const owner = statementOwner(level);
    if (owner?.type !== 'statement') continue;
    // Older packages placed a proof's local setting immediately above its own statement.
    const legacySetting = !section(level) && position.get(level.id) > position.get(owner.id) &&
      (owner.parent === level.id || level.parent === owner.id);
    if (section(level) === '2' || legacySetting) {
      settingParent.set(level.id, settingOf.get(owner.id) || owner.id);
      settingOf.set(owner.id, level.id);
    }
  }
  function mapParent(level) {
    if (level.type === 'proof') return settingOf.get(level.paired) || level.paired;
    if (settingParent.has(level.id)) return settingParent.get(level.id);
    if (section(level) === '1' && Array.isArray(level.context)) {
      const entrance = level.context.findLast(item => {
        const setting = byId.get(item.id);
        return setting?.type === 'convention' && section(setting) === '1';
      });
      return entrance?.id || null;
    }
    let parent = byId.get(level.parent);
    if (level.type === 'statement') {
      // Unwrap the legacy entrance before attaching a child to its enclosing proof.
      while (parent && settingParent.has(parent.id) && statementOwner(parent)?.id === level.id) {
        parent = byId.get(parent.parent);
      }
      if (parent?.type === 'statement') return parent.paired;
    }
    return parent?.id || null;
  }
  const mapLevels = levels.map(level => ({...level, parent: mapParent(level)}));
  for (const level of mapLevels) byId.set(level.id, level);
  validateParents();

  // Preview only the existing entrances, paired proofs, and ancestors needed to connect them.
  const visibleFrom = new Map();
  for (const level of mapLevels) {
    let from = position.get(level.id);
    if (level.type === 'proof') from = Math.min(from, position.get(level.paired));
    if (level.type === 'convention') {
      const owner = statementOwner(level);
      if (owner) from = Math.min(from, position.get(owner.id));
    }
    if (level.type === 'statement') {
      const entrance = byId.get(level.parent);
      if (entrance?.type === 'convention' && entrance.owner === level.id) {
        from = Math.min(from, position.get(entrance.id));
      }
    }
    let id = level.id;
    while (id && from < (visibleFrom.get(id) ?? Infinity)) {
      visibleFrom.set(id, from);
      id = byId.get(id).parent;
    }
  }
  function levelStatus(progress, id) {
    if (!position.has(id)) fail('Unknown level.', 404);
    const index = position.get(id);
    const completed = progress.completed.length; // Both engines validate the saved prefix.
    if (index < completed) return 'complete';
    if (index === completed) return 'open';
    return visibleFrom.get(id) <= completed ? 'locked' : 'hidden';
  }
  return {levels: mapLevels, byId, levelStatus};
}

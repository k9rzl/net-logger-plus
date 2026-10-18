/** Minimal stand-in for the parts of the MongoDB driver that MongoStore uses. */
export function fakeDb() {
  const cols = {};
  const stats = { ops: 0, indexes: [], failNext: false };
  const col = (name) => (cols[name] ??= {
    docs: new Map(),
    find: () => ({ toArray: async () => [...cols[name].docs.values()] }),
    createIndex: async (spec, opts) => { stats.indexes.push([name, spec, opts]); },
    bulkWrite: async (ops) => {
      if (stats.failNext) { stats.failNext = false; throw new Error('network down'); }
      for (const op of ops) {
        stats.ops += 1;
        if (op.replaceOne) cols[name].docs.set(op.replaceOne.filter._id, { _id: op.replaceOne.filter._id, ...op.replaceOne.replacement });
        if (op.deleteOne) cols[name].docs.delete(op.deleteOne.filter._id);
      }
    },
  });
  return { collection: col, cols, stats };
}

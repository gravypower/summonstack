// A stand-in for the mysql2 pool.
//
// The tests here are about logic the database cannot check for us — which
// realm a command is addressed to, which database a write lands in, which
// realm's settings priced a payout. A stub makes those assertable by recording
// the statements, and lets the suite run with no MySQL to start.
//
// Handlers match on normalised SQL and return mysql2's [rows, fields] shape.

/** Collapse whitespace so tests can match on readable fragments. */
function flatten(sql) {
  return sql.replace(/\s+/g, " ").trim();
}

/**
 * @param handlers array of [predicate(flatSql, params), respond(flatSql, params)]
 *   The first matching predicate wins; unmatched queries return no rows, which
 *   is usually what "this table is empty" means.
 */
function makePool(handlers, log = []) {
  async function query(sql, params) {
    const flat = flatten(sql);
    log.push({ sql: flat, params });
    for (const [matches, respond] of handlers) {
      if (matches(flat, params)) return respond(flat, params);
    }
    return [[]];
  }

  const connection = {
    query,
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
  };

  return {
    query,
    getConnection: async () => connection,
    /** Every statement issued, in order. */
    log,
  };
}

/** Convenience: match when the flattened SQL contains all the fragments. */
function contains(...fragments) {
  return (flat) => fragments.every((f) => flat.includes(f));
}

/** mysql2 returns a ResultSetHeader for writes. */
function affected(rows = 1) {
  return [{ affectedRows: rows }];
}

module.exports = { makePool, contains, affected, flatten };

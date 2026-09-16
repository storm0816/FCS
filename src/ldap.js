const ldap = require('ldapjs');

function escapeFilter(value) {
  return String(value).replace(/[\\*()\0]/g, (ch) => ({ '\\': '\\5c', '*': '\\2a', '(': '\\28', ')': '\\29', '\0': '\\00' }[ch]));
}

function bind(client, dn, password) {
  return new Promise((resolve, reject) => client.bind(dn, password, (err) => err ? reject(err) : resolve()));
}

function startTls(client, verify) {
  return new Promise((resolve, reject) => client.starttls({ rejectUnauthorized: verify !== 'off' }, [], (err) => err ? reject(err) : resolve()));
}

function findUser(client, base, filter, attributes) {
  return new Promise((resolve, reject) => {
    client.search(base, { scope: 'sub', filter, attributes }, (err, result) => {
      if (err) return reject(err);
      let found = null;
      result.on('searchEntry', (entry) => {
        if (found) return;
        const value = {};
        for (const attr of (entry.attributes || [])) value[attr.type] = Array.isArray(attr.values) ? attr.values[0] : attr.values;
        value.dn = (entry.objectName && entry.objectName.toString()) || (entry.dn && entry.dn.toString()) || '';
        found = { ...value, objectGUID: value.objectGUID };
      });
      result.on('error', reject);
      result.on('end', () => resolve(found));
    });
  });
}

async function authenticateLdap(username, password, cfg = {}) {
  if (cfg.state !== 'on' || !username || !password) return null;
  if (!/^[A-Za-z0-9._@-]{1,128}$/.test(String(username))) return null;
  const servers = Array.isArray(cfg.servers) ? cfg.servers : [];
  for (const url of servers) {
    let client;
    try {
      client = ldap.createClient({ url, timeout: Number(cfg.timeout || 5000), connectTimeout: Number(cfg.timeout || 5000), tlsOptions: { rejectUnauthorized: cfg.tls_verify !== 'off' } });
      if (cfg.start_tls === 'on' && String(url).toLowerCase().startsWith('ldap://')) await startTls(client, cfg.tls_verify);
      const hasServiceAccount = cfg.bind_user && cfg.bind_password && cfg.search_base;
      let userDn = String(cfg.bind_template || '%s').replace('%s', username);
      let userEntry = null;
      if (hasServiceAccount) {
        await bind(client, cfg.bind_user, cfg.bind_password);
        userEntry = await findUser(client, cfg.search_base, `(${cfg.user_attribute || 'uid'}=${escapeFilter(username)})`, [cfg.user_attribute || 'uid', 'displayName', 'cn', 'uid', 'userPrincipalName', 'entryUUID', 'objectGUID']);
        if (!userEntry || !userEntry.dn) throw new Error('LDAP user not found');
        userDn = userEntry.dn;
        try { await bind(client, userDn, password); }
        catch (bindError) { if (!userEntry.userPrincipalName) throw bindError; await bind(client, userEntry.userPrincipalName, password); }
      } else {
        await bind(client, userDn, password);
      }
      const displayName = userEntry?.displayName || userEntry?.cn || userEntry?.uid || username;
      const externalId = userEntry?.entryUUID || userEntry?.objectGUID || userDn;
      return { username, displayName, externalId };
    } catch (_) {
      // Try the next configured LDAP server without exposing connection details.
    } finally {
      if (client) try { client.unbind(); } catch (_) {}
    }
  }
  return null;
}

module.exports = { authenticateLdap };

// SPDX-License-Identifier: GPL-3.0-or-later
// Database schema as an ordered list of migrations. Never edit a released migration:
// add a new one. Each `up` runs inside a transaction together with the version bump.
//
// The messages/messages_fts design is derived from an earlier internal tool by the same
// author: FTS5 with `unicode61 remove_diacritics 2` and 2/3-character prefix indexes.

import { cleanName } from './people.js'

export const MIGRATIONS = [
  {
    version: 1,
    name: 'initial schema',
    up(db) {
      db.exec(`
        CREATE TABLE accounts (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT NOT NULL,
          display_name TEXT,
          type TEXT NOT NULL CHECK (type IN ('imap', 'pop3')),
          in_host TEXT NOT NULL,
          in_port INTEGER NOT NULL,
          in_security TEXT NOT NULL CHECK (in_security IN ('tls', 'starttls', 'none')),
          in_user TEXT NOT NULL,
          smtp_host TEXT,
          smtp_port INTEGER,
          smtp_security TEXT CHECK (smtp_security IN ('tls', 'starttls', 'none')),
          smtp_user TEXT,
          smtp_same_password INTEGER NOT NULL DEFAULT 1,
          tls_verify INTEGER NOT NULL DEFAULT 1,
          body_index_days INTEGER NOT NULL DEFAULT 1095,  -- 0 = no limit
          sync_interval_min INTEGER NOT NULL DEFAULT 5,
          save_sent_to_server INTEGER NOT NULL DEFAULT 1,
          pop3_delete_after_days INTEGER,                -- NULL = never
          signature TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE account_secrets (
          account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('incoming', 'smtp')),
          nonce BLOB NOT NULL,
          ciphertext BLOB NOT NULL,
          tag BLOB NOT NULL,
          PRIMARY KEY (account_id, kind)
        );

        CREATE TABLE vault (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          kdf TEXT NOT NULL,
          kdf_params TEXT NOT NULL,
          salt BLOB NOT NULL,
          dek_nonce BLOB NOT NULL,
          dek_ciphertext BLOB NOT NULL,
          dek_tag BLOB NOT NULL,
          created_at INTEGER NOT NULL,
          changed_at INTEGER
        );

        CREATE TABLE folders (
          account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
          path TEXT NOT NULL,
          delimiter TEXT,
          special_use TEXT,
          is_local INTEGER NOT NULL DEFAULT 0,
          uidvalidity TEXT,
          last_uid INTEGER NOT NULL DEFAULT 0,
          highest_modseq TEXT,
          synced_at INTEGER,
          PRIMARY KEY (account_id, path)
        );

        CREATE TABLE messages (
          id INTEGER PRIMARY KEY,
          account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
          folder TEXT NOT NULL,
          uid INTEGER,                       -- IMAP UID; NULL for POP3
          pop3_uidl TEXT,                    -- POP3 UIDL; NULL for IMAP
          message_id TEXT,
          in_reply_to TEXT,
          refs TEXT,
          from_addr TEXT,
          from_name TEXT,
          to_addrs TEXT,
          cc_addrs TEXT,
          subject TEXT,
          date INTEGER,                      -- Date header (ms)
          idate INTEGER,                     -- arrival on the server (ms); the body limit uses this
          flags TEXT NOT NULL DEFAULT '',
          size INTEGER,
          has_attachments INTEGER NOT NULL DEFAULT 0,
          attachments TEXT,                  -- JSON: [{part, filename, type, size, inline}]
          store_path TEXT,                   -- downloaded full message (.eml) under data/store
          preview TEXT,                      -- first 200 characters of the text, for the list
          -- 0: text not fetched yet, 1: indexed, 2: failed, 3: beyond the account's body limit (headers only)
          body_state INTEGER NOT NULL DEFAULT 0 CHECK (body_state IN (0, 1, 2, 3)),
          -- 1 = opened by the user: the text stays indexed whatever the account's limit
          body_pinned INTEGER NOT NULL DEFAULT 0 CHECK (body_pinned IN (0, 1)),
          UNIQUE (account_id, folder, uid)
        );
        CREATE UNIQUE INDEX idx_messages_pop3 ON messages (account_id, pop3_uidl) WHERE pop3_uidl IS NOT NULL;
        CREATE INDEX idx_messages_folder_date ON messages (account_id, folder, date DESC);
        CREATE INDEX idx_messages_date ON messages (date DESC);
        CREATE INDEX idx_messages_idate ON messages (account_id, idate);
        CREATE INDEX idx_messages_msgid ON messages (message_id);
        CREATE INDEX idx_messages_inreply ON messages (in_reply_to);
        CREATE INDEX idx_messages_pending ON messages (account_id, body_state, folder);

        -- rowid = messages.id. remove_diacritics 2: "szamla" finds "számla".
        CREATE VIRTUAL TABLE messages_fts USING fts5 (
          subject, sender, recipients, body,
          tokenize = 'unicode61 remove_diacritics 2',
          prefix = '2 3'
        );
        -- Keeps the index in step with row deletes, including ON DELETE CASCADE from accounts.
        CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
          DELETE FROM messages_fts WHERE rowid = old.id;
        END;

        CREATE TABLE contacts (
          address TEXT PRIMARY KEY COLLATE NOCASE,
          name TEXT,
          last_used INTEGER,
          use_count INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE pop3_seen (
          account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
          uidl TEXT NOT NULL,
          downloaded_at INTEGER NOT NULL,
          deleted_on_server_at INTEGER,
          PRIMARY KEY (account_id, uidl)
        );
      `)
    },
  },
  {
    version: 2,
    name: 'POP3 UIDLs a server listed twice',
    up(db) {
      // A UIDL the server ever listed for two messages is never deleted on the server, even after it
      // lists it only once again: the copy left may be the one never downloaded.
      db.exec(`
        CREATE TABLE pop3_doubled (
          account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
          uidl TEXT NOT NULL,
          PRIMARY KEY (account_id, uidl)
        );
      `)
    },
  },
  {
    version: 3,
    name: 'the vault moves out of the database',
    up(db) {
      // the DEK is sealed in vault.json next to the database, because the database itself
      // can only be opened with a key derived from it. The table of the earlier in-database vault goes.
      db.exec('DROP TABLE IF EXISTS vault')
    },
  },
  {
    version: 4,
    name: 'settings: one place for the app settings, encrypted with the database',
    up(db) {
      // MCP: the Claude access switch is the first key. Additive: no other table changes.
      db.exec(`
        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `)
    },
  },
  {
    version: 5,
    name: 'the address book: people with their addresses and phones, and the addresses not to add again',
    up(db) {
      // 0.12.0, the address book. Additive: the `contacts` table (the use count and the
      // completion's ranking) and every other table stay as they are.
      db.exec(`
        -- AUTOINCREMENT: a deleted person's id never comes back, so a stale id (an editor left open) cannot hit another
        -- person
        CREATE TABLE people (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          display_name TEXT NOT NULL DEFAULT '',
          given_name TEXT,
          family_name TEXT,
          org TEXT,
          title TEXT,
          note TEXT,
          source TEXT NOT NULL CHECK (source IN ('auto', 'manual', 'import')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          vcard_extra TEXT
        );
        CREATE INDEX people_display_name ON people (display_name COLLATE NOCASE);
        -- one address belongs to at most one person: the duplicate handling of the import rests on it
        CREATE TABLE person_emails (
          person_id INTEGER NOT NULL REFERENCES people (id) ON DELETE CASCADE,
          address TEXT NOT NULL UNIQUE COLLATE NOCASE,
          label TEXT,
          is_primary INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX person_emails_person ON person_emails (person_id);
        CREATE TABLE person_phones (
          person_id INTEGER NOT NULL REFERENCES people (id) ON DELETE CASCADE,
          number TEXT NOT NULL,
          label TEXT
        );
        CREATE INDEX person_phones_person ON person_phones (person_id);
        -- a deleted person's addresses: the automatic adding does not bring them back
        CREATE TABLE contact_suppressed (
          address TEXT PRIMARY KEY COLLATE NOCASE,
          created_at INTEGER NOT NULL
        );
      `)
      // every address we sent to so far becomes an automatic person, once (the contacts rows are unique)
      const now = Date.now()
      const person = db.prepare("INSERT INTO people (display_name, source, created_at, updated_at) VALUES (?, 'auto', ?, ?)")
      const email = db.prepare('INSERT OR IGNORE INTO person_emails (person_id, address, is_primary) VALUES (?, ?, 1)')
      const drop = db.prepare('DELETE FROM people WHERE id = ?')
      for (const c of db.prepare('SELECT address, name, last_used FROM contacts ORDER BY address').all()) {
        const address = String(c.address || '').trim().toLowerCase()
        if (!address) continue
        const at = Number.isInteger(c.last_used) && c.last_used > 0 ? c.last_used : now
        // the same name cleaning as the automatic adding (People.autoAdd): a name taken over as it was could not be
        // saved later without a change, so it is cleaned, not dropped
        const id = person.run(cleanName(c.name), at, at).lastInsertRowid
        if (!email.run(id, address).changes) drop.run(id)
      }
    },
  },
  {
    version: 6,
    name: 'accounts: a signature image per account',
    up(db) {
      // 0.13.0, the image under the text signature. Additive: two NULL columns, every existing row and column unchanged,
      // and the older code reads the table as before.
      db.exec(`
        ALTER TABLE accounts ADD COLUMN signature_image BLOB;
        ALTER TABLE accounts ADD COLUMN signature_image_type TEXT;
      `)
    },
  },
  {
    version: 7,
    name: 'messages: a partial index of the unread rows',
    up(db) {
      // 0.13.0, the taskbar badge (core/db/unread-total.js): its count reads only this index. On the encrypted file a
      // full count of 100 000 inbox rows was 177 ms (every table page decrypted), through this index 1.3 ms. The WHERE
      // is the sidebar's unread rule, LETTER FOR LETTER: SQLite uses a partial index only for a query that repeats its
      // expression. Additive: the older code ignores it.
      db.exec(`CREATE INDEX idx_messages_unread ON messages (account_id, folder) WHERE instr(flags, '\\Seen') = 0`)
    },
  },
  {
    version: 8,
    name: 'folders: a manual order among siblings',
    up(db) {
      // 0.14.0: the order the user gave the folders among their siblings (core/imap/folders.js buildFolderTree); NULL = no
      // manual order (the old rule: role folders first, the rest alphabetical). Local only: IMAP has no folder order.
      // Additive: the older code ignores the column.
      db.exec('ALTER TABLE folders ADD COLUMN sort_order INTEGER')
    },
  },
  {
    version: 9,
    name: 'folders: the role the sync decided',
    up(db) {
      // 0.14.1: the folder's role (inbox, drafts, sent, trash, junk, archive) as the IMAP sync decides it once per LIST
      // (core/imap/folders.js resolveRoles), NULL = none. Every reader takes it from here (assignRoles), so a role does
      // not depend on which copy of the old name rule ran. NULL until the first full sync after the upgrade: until
      // then the old rule answers. Additive: the older code ignores the column.
      db.exec('ALTER TABLE folders ADD COLUMN role TEXT')
    },
  },
  {
    version: 10,
    name: 'folders: the role the user chose',
    up(db) {
      // 0.15.0: 1 = the folder's role was chosen by hand in the account settings (MailIndex.setManualRole); it beats
      // every automatic rule (resolveRoles) until the user goes back to "Automatic" or the folder disappears from the
      // server (the row goes, and the choice with it). Additive: the older code ignores the column.
      db.exec('ALTER TABLE folders ADD COLUMN role_manual INTEGER NOT NULL DEFAULT 0')
    },
  },
  {
    version: 11,
    name: 'accounts: the archive mode',
    up(db) {
      // 0.15.0: how the Archive action files a message (core/imap/folders.js archiveModeOf): 'single' (into the
      // Archive), 'yearly' (into its year folder, "Archívum/2024"), NULL = by the Archive's year folders. Additive.
      db.exec('ALTER TABLE accounts ADD COLUMN archive_mode TEXT')
    },
  },
  {
    version: 12,
    name: 'folders: kept without a subscription',
    up(db) {
      // 0.15.0: the sync shows and syncs only the subscribed server folders (and the role folders). A folder the user
      // already had in the app before stays (nothing that showed disappears with the upgrade): its kept flag
      // is decided by the first full sync after the upgrade (NULL = not decided yet, 1 = kept although unsubscribed on
      // the server, 0 = by the subscription). Local only, the server is not written. Additive.
      db.exec('ALTER TABLE folders ADD COLUMN kept INTEGER DEFAULT 0')
      db.exec('UPDATE folders SET kept = NULL WHERE is_local = 0')
    },
  },
  {
    version: 13,
    name: 'scheduled: messages waiting to be sent later',
    up(db) {
      // 0.16.0: "Küldés később". A message waits here, locally only (the server has no such folder), until the
      // scheduler sends it through the composer's own path. Its whole content (the form, the attachments, the original's
      // flag, the signature image) is a sealed file in the store (payload_path, relative to the store); the row holds
      // what the list shows. state: waiting | sending | failed | late. Times in ms (UTC). A new table: additive.
      db.exec(`CREATE TABLE scheduled (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
        send_at INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'waiting',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_try_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        subject TEXT NOT NULL DEFAULT '',
        recipients TEXT NOT NULL DEFAULT '',
        claude INTEGER NOT NULL DEFAULT 0,
        payload_path TEXT NOT NULL
      )`)
      db.exec('CREATE INDEX idx_scheduled_due ON scheduled (state, send_at)')
    },
  },
  {
    version: 14,
    name: 'messages: the Bcc recipients',
    up(db) {
      // 0.16.0 (written for 0.15.1, which was never released): the Bcc line of a message that keeps one (the Sent and
      // Drafts copies), for the recipient column of those lists when To and Cc are empty. NULL = not known (a row
      // stored before 0.16.0; the sync fills the ones that need it), '' = none. Additive: the older code ignores it.
      db.exec('ALTER TABLE messages ADD COLUMN bcc_addrs TEXT')
    },
  },
]

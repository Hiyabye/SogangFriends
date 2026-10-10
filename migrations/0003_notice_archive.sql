-- Raw bodies live only in private R2 objects; D1 holds identities and resumable cursors.
CREATE TABLE notice_archive (
 source TEXT NOT NULL,
 id TEXT NOT NULL,
 title TEXT NOT NULL,
 published TEXT NOT NULL,
 url TEXT NOT NULL,
 raw_key TEXT NOT NULL,
 content_hash TEXT NOT NULL,
 captured_at TEXT NOT NULL,
 PRIMARY KEY (source,id)
);
-- Definitive historical 404/410 evidence is a checkpoint marker, never a fake raw object.
CREATE TABLE notice_archive_unavailable (
 source TEXT NOT NULL,
 id TEXT NOT NULL,
 status INTEGER NOT NULL CHECK(status IN (404,410)),
 checked_at TEXT NOT NULL,
 PRIMARY KEY (source,id)
);
CREATE TABLE notice_archive_progress (
 source TEXT PRIMARY KEY,
 page INTEGER NOT NULL DEFAULT 1 CHECK(page>=1),
 state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','done')),
 updated_at TEXT NOT NULL,
 started_at TEXT NOT NULL
);

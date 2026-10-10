-- D1-only source storage. 0003 identities/progress remain unchanged; raw_key is a logical key.
-- Bodies are separate TEXT columns so JSON escaping cannot inflate HTML toward D1's row limit.
CREATE TABLE notice_archive_raw (
 source TEXT NOT NULL,
 id TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version=1),
 notice_json TEXT NOT NULL,
 body_html TEXT NOT NULL,
 attachments_json TEXT NOT NULL,
 image_urls_json TEXT NOT NULL,
 content_hash TEXT NOT NULL,
 captured_at TEXT NOT NULL,
 PRIMARY KEY (source,id)
);

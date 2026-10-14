-- Existing single-row captures remain unchanged. Oversized original HTML is
-- split into ordered TEXT rows in the same atomic batch as its metadata/index.
ALTER TABLE notice_archive_raw ADD COLUMN body_storage TEXT NOT NULL DEFAULT 'inline' CHECK(body_storage IN ('inline','chunked'));
ALTER TABLE notice_archive_raw ADD COLUMN body_chunk_count INTEGER NOT NULL DEFAULT 0 CHECK(body_chunk_count BETWEEN 0 AND 33);
ALTER TABLE notice_archive_raw ADD COLUMN body_bytes INTEGER CHECK(body_bytes BETWEEN 0 AND 8388608);
CREATE TABLE notice_archive_raw_chunks (
 source TEXT NOT NULL,
 id TEXT NOT NULL,
 ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 32),
 body_html TEXT NOT NULL CHECK(length(CAST(body_html AS BLOB)) BETWEEN 1 AND 1900000),
 PRIMARY KEY(source,id,ordinal),
 FOREIGN KEY(source,id) REFERENCES notice_archive_raw(source,id) ON DELETE CASCADE
);

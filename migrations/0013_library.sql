ALTER TABLE guilds ADD COLUMN library_channel TEXT;

-- Latest observation only. Delivery/job history remains in the existing outbox.
CREATE TABLE library_watches (
 guild_id TEXT PRIMARY KEY REFERENCES guilds(id),
 channel_id TEXT NOT NULL,
 day TEXT NOT NULL,
 remaining INTEGER NOT NULL CHECK(remaining >= 0),
 source_at TEXT NOT NULL,
 observed_at TEXT NOT NULL,
 revision TEXT NOT NULL,
 event_id TEXT
);

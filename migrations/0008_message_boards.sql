-- Preserve existing schedule IDs, uncertainty, leases and all delivery/audit history.
ALTER TABLE schedule_messages ADD COLUMN content_hash TEXT;
ALTER TABLE schedule_messages ADD COLUMN projection_key TEXT;
CREATE TABLE meal_messages (
 guild_id TEXT NOT NULL,
 channel_id TEXT NOT NULL,
 message_id TEXT,
 state TEXT NOT NULL DEFAULT 'idle' CHECK(state IN ('idle','creating','editing','ready','retry','failed','uncertain')),
 updated_date TEXT,
 updated_at TEXT NOT NULL,
 lease_owner TEXT,
 lease_until TEXT,
 retry_at TEXT,
 error TEXT,
 content_hash TEXT,
 projection_key TEXT,
 PRIMARY KEY(guild_id,channel_id)
);

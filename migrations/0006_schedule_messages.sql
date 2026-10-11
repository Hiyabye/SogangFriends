-- Keep retired channel identities too: channel changes must not delete unrelated posts
-- or forget an uncertain initial POST. Only the currently configured channel is updated.
CREATE TABLE schedule_messages (
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
 PRIMARY KEY(guild_id,channel_id)
);

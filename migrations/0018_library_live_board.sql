-- Coordinate direct status edits and queued opening POSTs without per-minute jobs.
-- Confirmed message identities remain in library_messages; never use placeholder IDs.
CREATE TABLE library_board_state (
 guild_id TEXT NOT NULL,
 channel_id TEXT NOT NULL,
 lease_owner TEXT,
 lease_until TEXT,
 operation TEXT,
 post_state TEXT,
 post_delivery_id TEXT,
 retry_at TEXT,
 display_key TEXT,
 error TEXT,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(guild_id,channel_id)
);

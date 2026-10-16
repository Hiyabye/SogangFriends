-- Track only confirmed library posts. Existing delivery and watch history is unchanged.
CREATE TABLE library_messages (
 guild_id TEXT NOT NULL,
 channel_id TEXT NOT NULL,
 message_id TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(guild_id,channel_id)
);

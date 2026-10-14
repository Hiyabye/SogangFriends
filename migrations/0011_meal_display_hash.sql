-- Keep the intended projection hash separate from the confirmed displayed fallback.
ALTER TABLE meal_messages ADD COLUMN display_hash TEXT;

CREATE TABLE meal_sources (
 source_url TEXT PRIMARY KEY,
 image_url TEXT NOT NULL,
 published TEXT NOT NULL,
 start_date TEXT NOT NULL,
 end_date TEXT NOT NULL,
 verified_at TEXT NOT NULL,
 UNIQUE(start_date,end_date)
);
-- Weekly body cleanup should not scan notice/interaction job history on every Cron.
CREATE INDEX jobs_meal_rejected_bodies ON jobs(kind)
 WHERE kind='meal-extract' AND json_type(payload,'$.rejectedExtraction.data') IS NOT NULL;

-- Review disposition is separate from execution state: a closed failure was not a success.
-- A changed state/attempt count invalidates the review in operational status queries.
CREATE TABLE job_reviews (
 job_id TEXT PRIMARY KEY REFERENCES jobs(id),
 job_state TEXT NOT NULL CHECK(job_state IN ('failed','needs_review')),
 attempts INTEGER NOT NULL,
 disposition TEXT NOT NULL CHECK(disposition IN ('closed','deferred')),
 reason TEXT NOT NULL,
 reviewed_at TEXT NOT NULL
);

-- Every settlement the platform refuses, recorded with the reason it refused.
--
-- The verification paths already reject tampered signatures, expired
-- assertions, and replays. Nothing recorded those refusals, so a demonstration
-- of the security property depended on someone reading a log line. Persisting
-- them lets the dashboard show attribution integrity holding in real time,
-- which is the claim this project exists to make.

CREATE TABLE rejected_attempts (
    attempt_id   BIGSERIAL PRIMARY KEY,
    publisher_id TEXT        NOT NULL,
    assertion_id TEXT,
    merchant_id  TEXT,
    reason       TEXT        NOT NULL,
    detail       TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Deliberately no foreign key on publisher_id. An attempt naming a publisher
-- that does not exist is itself the signal worth keeping, and a constraint
-- here would discard exactly the rows a fraud view wants to show.

CREATE INDEX rejected_attempts_publisher_idx
    ON rejected_attempts (publisher_id, created_at DESC);

CREATE INDEX rejected_attempts_created_idx
    ON rejected_attempts (created_at DESC);

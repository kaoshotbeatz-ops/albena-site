-- Support "view as": read-only sessions opened by an Access-authenticated staff member.
ALTER TABLE sessions ADD COLUMN view_as INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN readonly INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN actor TEXT;

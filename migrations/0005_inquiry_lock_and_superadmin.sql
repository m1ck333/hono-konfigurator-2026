-- Inquiry "lock" (claim) so Belgrade/Niš admins can mark an inquiry as being handled, with a note.
-- A locked inquiry can't be deleted; only the admin who locked it (or a superadmin) can unlock it.
ALTER TABLE inquiries ADD COLUMN locked_by TEXT;   -- username of the admin who locked it
ALTER TABLE inquiries ADD COLUMN locked_at TEXT;   -- when it was locked (datetime)
ALTER TABLE inquiries ADD COLUMN lock_note TEXT;   -- note written at lock time

-- Promote the existing owner account to the new superadmin tier (override unlock/delete, manage admins).
-- City admins stay role='admin'. Currently there is exactly one 'admin' row (the owner).
UPDATE users SET role = 'superadmin' WHERE role = 'admin';

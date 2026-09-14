-- Inquiry form collects fullName, city, postalCode and street, and they already appear in the
-- notification email — but the inquiries table never stored them (INSERT only wrote name/email/
-- phone/message/config, and it bound `name` while the FE sends `fullName`). Add the missing
-- columns so the admin panel shows exactly what the customer submitted. (`name` already exists;
-- from now on it's filled from `fullName`.)
ALTER TABLE inquiries ADD COLUMN city TEXT;
ALTER TABLE inquiries ADD COLUMN postal_code TEXT;
ALTER TABLE inquiries ADD COLUMN street TEXT;

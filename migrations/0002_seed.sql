-- Sample data. Model image (1254x1254) + one handle overlay + admin user.
INSERT INTO models (id, name, image_key, price, width, height, is_shown, sort_order)
VALUES (1, 'Model 1', 'models/1.png', 500, 1254, 1254, 1, 0);

INSERT INTO categories (id, code, name, sort_order) VALUES
  (1, 'handrail', 'Rukohvat', 0),
  (2, 'spy', 'Špijunka', 1),
  (3, 'hinges', 'Šarke', 2),
  (4, 'houseNumbers', 'Kućni broj', 3);

INSERT INTO equipment (id, category_id, name, image_key, price, anchor_x, anchor_y, is_shown, sort_order)
VALUES (1, 1, 'Rukohvat ES-40', 'equipment/1.png', 80, 0.47, 0.22, 1, 0);

-- admin / Algreen2026!!!
INSERT INTO users (id, username, password_hash, role)
VALUES (1, 'Admin', 'pbkdf2$100000$7BbT3UQT66UjBpVTJPn9UA==$gUoVQQByy7g0zmnfZx8TJL+CGtqjFJdNhD1VfvhwLrg=', 'admin');

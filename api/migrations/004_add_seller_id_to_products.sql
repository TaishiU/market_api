-- step 1: NULLABLEで追加（既存レコードがあるためいきなりNOT NULLにできない）
ALTER TABLE products ADD COLUMN seller_id INT UNSIGNED AFTER id;

-- step 2 と 3 はシードユーザー投入後に手動で実行（phase2-auth.md の 3-3. シードデータ投入　を参照）
UPDATE products SET seller_id = 1;

ALTER TABLE products MODIFY COLUMN seller_id INT UNSIGNED NOT NULL,
ADD CONSTRAINT fk_products_seller FOREIGN KEY (seller_id) REFERENCES users(id);
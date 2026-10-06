-- 複合インデックス（status + category_id + created_at）
-- ① status = 'published' で絞り込み
-- ② category_id で絞り込み
-- ③ created_at の ORDER BY をインデックスで解決（filesort 不要になる）
CREATE INDEX idx_products_status_category_created
ON products (status, category_id, created_at);
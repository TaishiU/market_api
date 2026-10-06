INSERT INTO categories (name) VALUES ('スマホ・タブレット'), ('PC・周辺機器'), ('ファッション');

INSERT INTO products (category_id, name, description, price, stock, status) VALUES
(1, 'iPhone 14', '美品。傷なし。', 80000, 1, 'published'),
(1, 'iPad Pro 11inch', 'ケース付き。', 90000, 2, 'published'),
(1, 'Galaxy S23', 'SIM フリー。バッテリー良好。', 65000, 1, 'published'),
(1, 'AirPods Pro 第 2 世代', '充電ケース付き。', 22000, 1, 'published'),
(1, 'Apple Watch Series 8', '傷なし。バンド 2 本付き。', 35000, 1, 'published'),
(1, 'Kindle Paperwhite', '広告なし版。ほぼ新品。', 12000, 1, 'published'),
(1, 'Nintendo Switch', 'ドック・コントローラー付き。', 25000, 1, 'published'),
(2, 'MacBook Air M2', '2023 年購入。', 120000, 1, 'published'),
(2, 'メカニカルキーボード', '茶軸。', 8000, 5, 'published'),
(2, 'Dell モニター 27 インチ', '4K 対応。使用期間 1 年。', 30000, 1, 'published'),
(2, 'Logicool MX Master 3', '充電ケーブル付き。', 7000, 2, 'published'),
(2, 'Anker USB-C ハブ 7in1', '未使用品。', 3500, 3, 'published'),
(2, 'ロジクール Web カメラ C920', '1080p。箱付き。', 5000, 1, 'published'),
(2, 'ゼンハイザー ヘッドセット', '在宅勤務用。状態良好。', 9000, 1, 'published'),
(3, 'ユニクロ ダウン L', '1 回使用。', 5000, 1, 'published'),
(3, 'ナイキ エアマックス 27cm', '3 回着用。', 6000, 1, 'published'),
(3, 'ノースフェイス フリース M', 'ブラック。洗濯済み。', 8000, 1, 'published'),
(3, 'リーバイス 501 W32', '古着。色落ち良好。', 4000, 1, 'published'),
(3, 'ノースフェイス バックパック', '20L。ほぼ未使用。', 11000, 1, 'published'),
(3, 'GU オーバーサイズパーカー XL', '昨シーズン購入。', 1500, 2, 'published');
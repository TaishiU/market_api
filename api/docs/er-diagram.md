# Flutter Market - ER図

## テーブル一覧

```
ユーザー系    : users, user_profiles
商品系       : categories, products, product_images
お気に入り系  : favorites
カート系      : carts, cart_items
注文系       : orders, order_items, payments, shipments
レビュー系    : reviews
通知・ログ系  : notifications, audit_logs
```

---

## ER図（全体）

```
┌─────────────────┐        ┌──────────────────┐
│    users        │        │  user_profiles   │
│─────────────────│        │──────────────────│
│ id (PK)         │────────│ user_id (FK)     │
│ email           │        │ display_name     │
│ password_hash   │        │ avatar_url       │
│ role            │        │ bio              │
│ status          │        │ created_at       │
│ created_at      │        └──────────────────┘
│ updated_at      │
└──────┬──────────┘
       │ 1
       │ (seller_id)
       │                ┌──────────────┐
       │                │  categories  │
       │                │──────────────│
       │                │ id (PK)      │
       │                │ name         │
       │                │ created_at   │
       │                └──────┬───────┘
       │                       │ 1
       │ (出品者)               │ (category_id)
       │ *                     │ *
┌──────┴───────────────────────┴──────┐
│               products              │
│─────────────────────────────────────│
│ id          (PK)                    │
│ seller_id   (FK → users.id)         │
│ category_id (FK → categories.id)    │
│ name                                │
│ description                         │
│ price       BIGINT ※整数で管理        │
│ stock                               │
│ status      ENUM(draft/published/   │
│             archived)               │
│ version     ※楽観的ロック用           │
│ created_at                          │
│ updated_at                          │
└──────┬──────────────────────────────┘
       │ 1
       ├─────────────────────────────────────────────────────┐
       │                                                     │
       │ * (product_id)                                      │ * (product_id)
┌──────┴──────────┐    ┌──────────────────┐    ┌─────────────┴──────┐
│ product_images  │    │    favorites     │    │    cart_items      │
│─────────────────│    │──────────────────│    │────────────────────│
│ id (PK)         │    │ user_id (FK)     │    │ id (PK)            │
│ product_id (FK) │    │ product_id (FK)  │    │ cart_id (FK)       │
│ url             │    │   (FK)           │    │ product_id (FK)    │
│ display_order   │    │ created_at       │    │ quantity           │
│ created_at      │    │──────────────────│    │ created_at         │
└─────────────────┘    │ UNIQUE(          │    └────────────────────┘
                       │  user_id,        │           │ * (cart_id)
                       │  product_id)     │    ┌──────┘
                       └──────┬───────────┘    │ 1
                              │ * (user_id)    │
                     ┌────────┘        ┌───────┴──────┐
                     │ 1 (user_id)     │    carts     │
                     │                 │──────────────│
                     │                 │ id (PK)      │
                     │                 │ user_id (FK) │
                     │                 │ created_at   │
                     │                 └──────────────┘
                     │
              ┌──────┘ 1 (buyer_id / user_id)
              │ *
       ┌──────┴──────────────────────────┐
       │             orders              │
       │─────────────────────────────────│
       │ id            (PK)              │
       │ buyer_id      (FK → users.id)   │
       │ status        ENUM(pending/     │
       │               paid/preparing/   │
       │               shipped/delivered/│
       │               completed/        │
       │               cancelled)        │
       │ subtotal                        │
       │ shipping_fee                    │
       │ total_amount                    │
       │ idempotency_key  ※二重注文防止    │
       │ created_at                      │
       │ updated_at                      │
       └──────┬──────────────────────────┘
              │ 1
              ├─────────────────────────────────────────┐
              │                                         │
              │ * (order_id)                            │ * (order_id)
       ┌──────┴──────────────────────────┐    ┌────────┴──────────────────┐
       │          order_items            │    │  order_status_histories   │
       │─────────────────────────────────│    │───────────────────────────│
       │ id           (PK)               │    │ id (PK)                   │
       │ order_id     (FK → orders.id)   │    │ order_id (FK)             │
       │ product_id   (FK → products.id) │    │ from_status               │
       │ seller_id    (FK → users.id)    │    │ to_status                 │
       │ product_name ※注文時点の名前コピー │    │ changed_by (FK→users.id)  │
       │ unit_price   ※注文時点の価格コピー │    │ created_at                │
       │ quantity                        │    └───────────────────────────┘
       │ subtotal                        │
       └──────┬──────────────────────────┘
              │ 1 (order_id)
       ┌──────┴──────────┐    ┌──────────────────────────┐
       │    payments     │    │        shipments         │
       │─────────────────│    │──────────────────────────│
       │ id (PK)         │    │ id (PK)                  │
       │ order_id (FK)   │    │ order_id (FK)            │
       │ amount          │    │ tracking_number          │
       │ method          │    │ shipped_at               │
       │ status          │    │ delivered_at             │
       │ paid_at         │    │ created_at               │
       │ created_at      │    └──────────────────────────┘
       └─────────────────┘

       ┌─────────────────────────────────────────────────┐
       │                   reviews                       │
       │─────────────────────────────────────────────────│
       │ id           (PK)                               │
       │ order_id     (FK → orders.id)                   │
       │ product_id   (FK → products.id)                 │
       │ reviewer_id  (FK → users.id)                    │
       │ rating       1〜5                               │
       │ comment                                         │
       │ created_at                                      │
       │─────────────────────────────────────────────────│
       │ UNIQUE(order_id, product_id, reviewer_id)       │
       │ ※1注文につき同一商品へのレビューは1件のみ             │
       └─────────────────────────────────────────────────┘

       ┌──────────────────────────────────┐
       │          notifications           │
       │──────────────────────────────────│
       │ id (PK)                          │
       │ user_id    (FK → users.id)       │
       │ type       (order_paid 等)       │
       │ message                          │
       │ is_read                          │
       │ created_at                       │
       └──────────────────────────────────┘

       ┌─────────────────────────────────┐
       │           audit_logs            │
       │─────────────────────────────────│
       │ id (PK)                         │
       │ user_id (FK → users.id)         │
       │ action (order_status_changed等) │
       │ target_type (orders 等)         │
       │ target_id                       │
       │ detail     JSON                 │
       │ created_at                      │
       └─────────────────────────────────┘
```

---

## リレーション一覧

| テーブル | カラム | 参照先 | 説明 |
|---|---|---|---|
| user_profiles | user_id | users.id | **1対1**。ユーザー1人に対してプロフィール1件。`user_id` に UNIQUE制約を付けることで1対1を保証する |
| products | seller_id | users.id | 商品の出品者 |
| products | category_id | categories.id | 商品のカテゴリ |
| product_images | product_id | products.id | 商品に複数枚の画像 |
| favorites | user_id | users.id | お気に入り登録したユーザー |
| favorites | product_id | products.id | お気に入り登録された商品 |
| carts | user_id | users.id | カートはユーザー1人に1つ |
| cart_items | cart_id | carts.id | カート内の各商品行 |
| cart_items | product_id | products.id | カートに入れた商品 |
| orders | buyer_id | users.id | 注文した購入者 |
| order_items | order_id | orders.id | 注文の明細行 |
| order_items | product_id | products.id | 注文した商品（削除されても履歴は残る） |
| order_items | seller_id | users.id | 明細ごとの出品者（複数出品者対応） |
| order_status_histories | order_id | orders.id | 注文のステータス変更履歴 |
| order_status_histories | changed_by | users.id | 誰がステータスを変えたか |
| payments | order_id | orders.id | 注文1件に対して支払い1件 |
| shipments | order_id | orders.id | 注文1件に対して配送情報1件 |
| reviews | order_id | orders.id | どの注文に対するレビューか |
| reviews | product_id | products.id | レビュー対象の商品 |
| reviews | reviewer_id | users.id | レビューを書いたユーザー |
| notifications | user_id | users.id | 通知の宛先ユーザー |
| audit_logs | user_id | users.id | 操作を行ったユーザー |

---

## 設計上の重要ポイント

### order_items に価格・商品名をコピーする理由
```
products.price    → 現在の販売価格（変動する）
order_items.unit_price → 注文時点の価格（変動しない）

商品マスタの価格を後から変更しても
過去の注文履歴の金額は変わらない
```

### favorites の UNIQUE 制約
```sql
UNIQUE(user_id, product_id)
-- 同一ユーザーが同じ商品を二重にお気に入り登録できない
-- アプリ側だけでなくDB側でも保証する
```

### reviews の UNIQUE 制約
```sql
UNIQUE(order_id, product_id, reviewer_id)
-- 1注文につき同じ商品へのレビューは1件のみ
-- completed 状態の注文のみ投稿可（アプリ側でチェック）
```

### products.version（楽観的ロック）
```
複数ユーザーが同時に同じ商品を購入しようとした場合の
在庫二重消費を防ぐためのカラム（Phase 7で詳細実装）
UPDATE products SET stock = stock - 1, version = version + 1
WHERE id = ? AND version = ? AND stock >= 1
→ 更新件数0行 = 誰かに先を越された = 409エラー
```

### idempotency_key（二重注文防止）
```
Flutterからの注文リクエストが通信失敗で再送された場合でも
同じidempotency_keyを持つ注文は2件目をINSERTしない
（Phase 6で詳細実装）
```

---

## Phaseごとに登場するテーブル

| Phase | 追加されるテーブル |
|---|---|
| Phase 1 | categories, products |
| Phase 2 | users, user_profiles |
| Phase 3 | product_images |
| Phase 4 | （インデックス追加のみ、新テーブルなし） |
| Phase 5 | favorites, carts, cart_items |
| Phase 6 | orders, order_items |
| Phase 7 | （トランザクション・ロック、新テーブルなし） |
| Phase 8 | order_status_histories, shipments, payments, reviews |
| Phase 9 | notifications, audit_logs, 集計テーブル（daily_sales_summary） |
| Phase 10 | （運用・性能改善、新テーブルなし） |

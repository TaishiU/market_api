フルスタックエンジニアになるためのバックエンド学習ロードマップとして **「フリマ・マーケットプレイス型のECシステム」** が最も適しています。

単純なECではなく、

> **ユーザーが商品を出品し、他のユーザーが検索・購入・決済・配送管理・レビューまで行えるフリマアプリ**

を、Flutter＋Node.js＋MySQLで段階的に構築するのがおすすめです。

このシステムなら、SNSよりも業務処理・トランザクション・整合性を深く学べます。単純なECよりも、出品者・購入者・管理者という複数の立場があり、認証・権限・在庫・注文・決済状態・検索・集計・運用まで扱えるため、実務に近いバックエンド経験を積めます。

## 作るシステム

仮称として、次のようなアプリを作ります。

```text
「Flutter Market」

ユーザーが商品を出品し、
他のユーザーが商品を検索・購入できる
フリマ型マーケットプレイス
```

### ユーザー側の機能

```text
会員登録・ログイン
プロフィール管理
商品検索
カテゴリ・価格による絞り込み
商品詳細表示
お気に入り
カート
注文
購入履歴
レビュー
```

### 出品者側の機能

```text
商品登録
画像登録
価格・在庫変更
出品停止
注文状況確認
売上確認
```

### 管理者側の機能

```text
ユーザー管理
商品審査
カテゴリ管理
注文管理
不正報告対応
売上分析
```

OpenAPIは、HTTP APIを人間とツールの両方が理解できる形で定義する仕様です。API仕様書からドキュメント・クライアント・テストなどにつなげられるため、このプロジェクトでは最初からOpenAPIを中心に設計すると実務的です。 [spec.openapis](https://spec.openapis.org/oas/latest.html)

## なぜフリマ型ECが最適か

### SNSより業務処理を学びやすい

SNSでは、投稿・フォロー・いいね・コメントなどを学べます。

```text
SNSで学べること
- CRUD
- 認証
- ページネーション
- フォロー関係
- タイムライン
```

しかし、SNSだけでは次のような経験が弱くなりがちです。

```text
- 在庫の同時更新
- 注文確定
- 金額計算
- 状態遷移
- トランザクション
- 売上集計
- 業務上の不変条件
```

フリマ型ECでは、これらを自然に扱えます。

### 単純なECより複雑で実務的

単純なECでは、

```text
管理者が商品を登録
ユーザーが購入
```

という構成になりやすいです。

フリマ型では、

```text
出品者が商品を登録
購入者が商品を検索
購入者が注文
在庫・注文状態を更新
出品者が発送
購入者が受取確認
レビュー投稿
売上を集計
```

となります。

```text
👤 出品者
   │ 出品
   ▼
📦 商品
   │ 購入
   ▼
👤 購入者
   │ 注文・決済・受取
   ▼
⭐ レビュー
```

複数のユーザー・状態・権限・更新処理が関係するため、バックエンドの学習題材として非常に優れています。

***

# 全体のドメイン設計

最初から全機能を作らず、次のように段階的に拡張します。

```text
Phase 1：商品一覧
Phase 2：認証
Phase 3：出品
Phase 4：検索・ページング
Phase 5：お気に入り・カート
Phase 6：注文
Phase 7：在庫・トランザクション
Phase 8：レビュー・通知
Phase 9：管理画面・分析
Phase 10：運用・性能改善
```

## 主なテーブル

最終的には、次のようなテーブル構成を目指します。

```text
users
user_profiles
categories
products
product_images
favorites
carts
cart_items
orders
order_items
payments
shipments
reviews
notifications
audit_logs
```

### users

```text
users
────────────────────
id
email
password_hash
role
status
created_at
updated_at
```

### products

```text
products
────────────────────
id
seller_id
category_id
name
description
price
stock
status
version
created_at
updated_at
```

### orders

```text
orders
────────────────────
id
buyer_id
status
subtotal
shipping_fee
total_amount
created_at
updated_at
```

### order_items

```text
order_items
────────────────────
id
order_id
product_id
seller_id
product_name
unit_price
quantity
subtotal
```

ここで重要なのは、`order_items`に購入時点の商品名・価格を保存することです。

```text
商品マスタの現在価格：200円
注文時の価格　　　　：100円
```

商品マスタを後から更新しても、過去の注文履歴が変わらないようにします。

```text
products.price
  → 現在の販売価格

order_items.unit_price
  → その注文時点の価格
```

これは正規化だけではなく、業務上の履歴保持という観点で重要です。

***

# Phase 1：商品一覧から始める

## 作る画面

Flutter側：

```text
商品一覧画面
商品詳細画面
```

API：

```text
GET /api/v1/products
GET /api/v1/products/{productId}
```

SQL：

```sql
SELECT
    p.id,
    p.name,
    p.price,
    p.status,
    p.created_at
FROM products p
WHERE p.status = 'published'
ORDER BY p.created_at DESC
LIMIT 20 OFFSET 0;
```

### ここで学ぶこと

```text
- Node.jsプロジェクト構成
- HTTPメソッド
- Router / Controller / Service / Repository
- MySQL接続
- SELECT
- WHERE
- ORDER BY
- LIMIT / OFFSET
- JSONレスポンス
- エラーレスポンス
- OpenAPIの基本
```

最初から複雑な認証や決済を入れず、FlutterからAPIを呼び、DBから取得したデータを表示するところまで完成させます。

### 推奨ディレクトリ

```text
src/
├── app.ts
├── routes/
├── controllers/
├── services/
├── repositories/
├── middlewares/
├── db/
├── schemas/
└── errors/
```

最初から完全なDDDにする必要はありませんが、最低限、

```text
Route
  → Controller
  → Service
  → Repository
  → MySQL
```

の流れを作ると、実務の責務分離を理解しやすくなります。

***

# Phase 2：認証・認可

## 作る画面

```text
会員登録
ログイン
プロフィール
```

API：

```text
POST /api/v1/auth/register
POST /api/v1/auth/login
GET  /api/v1/me
PATCH /api/v1/me
```

### 学ぶこと

```text
- パスワードハッシュ化
- JWTまたはセッション
- Authorizationヘッダー
- 認証ミドルウェア
- バリデーション
- ユーザー権限
- 401 / 403の使い分け
```

APIの流れ：

```text
Flutter
  │ Authorization: Bearer xxx
  ▼
authMiddleware
  │ トークン検証
  ▼
Controller
  │
Service
  ▼
MySQL
```

### 認証と認可の違い

```text
認証：あなたは誰か？
認可：その操作をしてよいか？
```

たとえば、

```text
購入者Aが商品Bを編集しようとする
```

場合、

```text
ログインしているか → 認証
商品Bの出品者か   → 認可
```

となります。

***

# Phase 3：出品機能

## 作る画面

```text
出品フォーム
出品商品一覧
商品編集
出品停止
```

API：

```text
POST   /api/v1/products
GET    /api/v1/me/products
PATCH  /api/v1/products/{productId}
DELETE /api/v1/products/{productId}
```

### ここで学ぶこと

```text
- INSERT
- UPDATE
- DELETE
- 所有者チェック
- 入力値バリデーション
- 論理削除
- enum的なステータス
- created_at / updated_at
```

商品削除は、いきなり物理削除しない方が実務的です。

```sql
UPDATE products
SET status = 'archived',
    updated_at = CURRENT_TIMESTAMP
WHERE id = ?
  AND seller_id = ?;
```

```text
deleted = 物理的に消す
archived = 表示対象から外す
```

過去の注文から参照される商品を物理削除すると、履歴や外部キーとの関係で問題が起きるためです。

***

# Phase 4：検索・インデックス・EXPLAIN

## 作る画面

```text
商品検索画面
カテゴリ絞り込み
価格帯絞り込み
並び替え
ページング
```

API：

```text
GET /api/v1/products?q=keyboard&category_id=2&min_price=1000&max_price=5000
```

SQL：

```sql
SELECT
    id,
    name,
    price,
    created_at
FROM products
WHERE status = 'published'
  AND category_id = ?
  AND price BETWEEN ? AND ?
ORDER BY created_at DESC
LIMIT ? OFFSET ?;
```

### 最初のインデックス

```sql
CREATE INDEX idx_products_status_category_created
ON products (status, category_id, created_at);
```

ただし、インデックスは多ければよいわけではありません。

```text
INSERT / UPDATEが遅くなる
ディスク容量を使う
オプティマイザが迷う
```

### EXPLAINを使う

```sql
EXPLAIN
SELECT id, name, price
FROM products
WHERE status = 'published'
  AND category_id = 2
ORDER BY created_at DESC
LIMIT 20;
```

確認する項目：

```text
type
possible_keys
key
rows
filtered
Extra
```

学習では、次の順番が分かりやすいです。

```text
1. インデックスなしでEXPLAIN
2. インデックスを追加
3. 再度EXPLAIN
4. rowsやtypeの変化を比較
5. データ件数を増やして再計測
```

少ないデータでは、インデックスの効果が見えにくいので、開発用データを10万件程度作るとよいです。

***

# Phase 5：お気に入り・カート

## お気に入り

```text
POST   /api/v1/products/{productId}/favorite
DELETE /api/v1/products/{productId}/favorite
GET    /api/v1/me/favorites
```

テーブル：

```text
favorites
────────────────
user_id
product_id
created_at
```

制約：

```sql
ALTER TABLE favorites
ADD CONSTRAINT uq_favorites_user_product
UNIQUE (user_id, product_id);
```

同じユーザーが同じ商品を二重にお気に入り登録することを、アプリだけでなくDBでも防ぎます。

## カート

```text
GET    /api/v1/cart
POST   /api/v1/cart/items
PATCH  /api/v1/cart/items/{itemId}
DELETE /api/v1/cart/items/{itemId}
```

ここで価格の扱いを決めます。

おすすめは、

```text
カート表示：現在価格を表示
注文確認：最新価格を再計算
注文確定：注文に価格をコピー
```

です。

***

# Phase 6：注文・価格確定

## 作る画面

```text
カート画面
注文確認画面
注文完了画面
購入履歴画面
```

API：

```text
POST /api/v1/orders/preview
POST /api/v1/orders
GET  /api/v1/me/orders
GET  /api/v1/orders/{orderId}
```

## 注文確定時の流れ

```text
Flutter
  │ 商品ID・数量を送信
  ▼
Backend
  │
  ├─ 商品の存在確認
  ├─ 最新価格取得
  ├─ 在庫確認
  ├─ 合計金額計算
  ├─ orders作成
  ├─ order_items作成
  ├─ 在庫減少
  └─ COMMIT
```

重要なのは、Flutterから送られた価格を信用しないことです。

```json
{
  "product_id": 1,
  "quantity": 2
}
```

価格はサーバー側で計算します。

```text
Flutterから送られたprice：信用しない
DBの価格               ：Backendで取得
合計金額               ：Backendで計算
```

## 注文テーブルには価格を保存する

```sql
INSERT INTO order_items (
    order_id,
    product_id,
    product_name,
    unit_price,
    quantity,
    subtotal
)
SELECT
    ?,
    p.id,
    p.name,
    p.price,
    ?,
    p.price * ?
FROM products p
WHERE p.id = ?;
```

実務では、計算した値の検証や、商品取得・在庫減少・注文登録を同一トランザクション内で扱います。

***

# Phase 7：在庫・トランザクション

ここで、これまで学んだ分離レベルが実際に登場します。

## 危険な実装

```text
1. 在庫をSELECT
2. 在庫があれば注文登録
3. 在庫をUPDATE
```

2人が同時に購入すると、

```text
A：在庫1個を確認
B：在庫1個を確認

A：購入成功
B：購入成功

在庫は1個なのに2人購入 ❌
```

## 原子的UPDATE

```sql
UPDATE products
SET stock = stock - ?
WHERE id = ?
  AND stock >= ?;
```

更新件数を確認します。

```text
1行更新
  → 在庫確保成功

0行更新
  → 在庫不足
```

## 行ロック

```sql
START TRANSACTION;

SELECT id, price, stock
FROM products
WHERE id = ?
FOR UPDATE;
```

その後、在庫を更新して注文を登録します。

```sql
UPDATE products
SET stock = stock - ?
WHERE id = ?;

INSERT INTO orders (...);
INSERT INTO order_items (...);

COMMIT;
```

### ここでの分離レベル

この処理では、単純に、

```text
Repeatable Readだから安全
```

とは考えません。

必要なのは、

```text
トランザクション
＋FOR UPDATEまたは原子的UPDATE
＋在庫条件
＋エラー処理
```

です。

MySQLのInnoDBでは、通常の非ロック`SELECT`はスナップショットを読みますが、`SELECT ... FOR UPDATE`は対象行をロックする読み取りです。この違いは在庫・注文・残高処理で重要です。 [dev.mysql](https://dev.mysql.com/doc/en/innodb-consistent-read.html)

***

# Phase 8：注文状態・配送・レビュー

## 注文状態

```text
pending
  ↓
paid
  ↓
preparing
  ↓
shipped
  ↓
delivered
  ↓
completed
```

キャンセルもあります。

```text
pending → cancelled
paid    → refund_pending
```

Flutter画面では、

```text
注文確認中
支払い済み
発送準備中
発送済み
配送完了
```

のように表示します。

### API側で状態遷移を制御

たとえば、発送済みの注文を再び未払いに戻すことは許可しません。

```text
現在：shipped
次の状態：delivered
```

```text
現在：shipped
次の状態：pending
→ エラー
```

テーブルとしては、

```text
order_status_histories
────────────────────
id
order_id
from_status
to_status
changed_by
created_at
```

を作ると、状態変更履歴を残せます。

ここで学べること：

```text
- 状態遷移
- 業務ルール
- 履歴テーブル
- 監査ログ
- 冪等性
```

## レビュー

```text
POST /api/v1/orders/{orderId}/review
```

レビュー投稿条件：

```text
- 購入者本人である
- 注文がcompletedである
- まだレビューしていない
```

DBでも重複を防ぎます。

```sql
UNIQUE(order_id, product_id, reviewer_id)
```

***

# Phase 9：管理画面・分析

ここで、ウィンドウ関数や集計SQLを実践します。

## 売上ランキング

```sql
SELECT
    seller_id,
    order_month,
    monthly_sales,
    RANK() OVER (
        PARTITION BY order_month
        ORDER BY monthly_sales DESC
    ) AS seller_rank
FROM seller_monthly_sales;
```

MySQLは、関連する行を対象に各行ごとの計算を行うウィンドウ関数をサポートしています。 [dev.mysql](https://dev.mysql.com/doc/refman/8.3/en/window-functions.html)

## 出品者ごとの累計売上

```sql
SELECT
    seller_id,
    order_date,
    daily_sales,
    SUM(daily_sales) OVER (
        PARTITION BY seller_id
        ORDER BY order_date
    ) AS cumulative_sales
FROM seller_daily_sales;
```

## 商品ごとの順位

```sql
SELECT
    category_id,
    product_id,
    product_name,
    sales_amount,
    DENSE_RANK() OVER (
        PARTITION BY category_id
        ORDER BY sales_amount DESC
    ) AS category_rank
FROM product_sales;
```

### 管理画面で作る画面

```text
売上ダッシュボード
月別売上
カテゴリ別売上
出品者ランキング
注文ステータス集計
平均注文単価
リピート購入率
```

### ここで学ぶこと

```text
- GROUP BY
- HAVING
- サブクエリ
- CTE
- ウィンドウ関数
- 集計用インデックス
- View
- 日次・月次集計
- レポート用テーブル
```

大量データでは、毎回複雑な集計を実行するより、

```text
注文データ
  ↓ バッチ集計
日次売上集計テーブル
  ↓
管理画面
```

という構成も学べます。

***

# Phase 10：バックアップ・運用・性能改善

最後に、実務で重要な「作って終わりではない」領域に進みます。

## バックアップ

```text
毎日：フルバックアップ
定期：復元テスト
障害時：バックアップから復旧
```

MySQLの公式マニュアルでは、バックアップ方式、`mysqldump`、ポイントインタイムリカバリなどが説明されています。 [dev.mysql](https://dev.mysql.com/doc/refman/8.2/en/)

学習では、次を実際に試します。

```text
1. 商品・注文データを作成
2. mysqldumpでバックアップ
3. DBを削除
4. バックアップから復元
5. 件数・外部キー・注文履歴を確認
```

バックアップは、

```text
バックアップを取った
```

だけでは不十分です。

```text
実際に復元できる
```

ところまで経験する必要があります。

## 性能改善

次のような課題を意図的に作ります。

```text
商品100万件
注文100万件
商品検索
売上ランキング
購入履歴
管理画面集計
```

そして、

```text
EXPLAIN
EXPLAIN ANALYZE
slow query log
```

などで調査します。

比較する内容：

```text
- インデックス追加前後
- OFFSETページングとカーソルページング
- SELECT *と必要列のみ
- JOIN前後
- サブクエリとJOIN
- 集計テーブル導入前後
```

***

# APIの最終構成

最終的には、次のようなAPIを持つシステムになります。

```text
Auth
POST   /api/v1/auth/register
POST   /api/v1/auth/login
POST   /api/v1/auth/refresh

Users
GET    /api/v1/me
PATCH  /api/v1/me

Products
GET    /api/v1/products
POST   /api/v1/products
GET    /api/v1/products/{id}
PATCH  /api/v1/products/{id}
DELETE /api/v1/products/{id}

Favorites
POST   /api/v1/products/{id}/favorite
DELETE /api/v1/products/{id}/favorite

Cart
GET    /api/v1/cart
POST   /api/v1/cart/items
PATCH  /api/v1/cart/items/{id}
DELETE /api/v1/cart/items/{id}

Orders
POST   /api/v1/orders/preview
POST   /api/v1/orders
GET    /api/v1/me/orders
GET    /api/v1/orders/{id}
POST   /api/v1/orders/{id}/cancel

Shipping
POST   /api/v1/orders/{id}/ship
POST   /api/v1/orders/{id}/receive

Reviews
POST   /api/v1/products/{id}/reviews
GET    /api/v1/products/{id}/reviews

Admin
GET    /api/v1/admin/dashboard
GET    /api/v1/admin/orders
GET    /api/v1/admin/users
```

OpenAPIファイルは、最初から「実装後に作るドキュメント」ではなく、APIを作る前の契約として扱います。

```text
openapi.yaml
  ↓
API仕様レビュー
  ↓
Node.js実装
  ↓
Flutter連携
  ↓
APIテスト
```

***

# 実装する技術スタック

## Flutter

Flutterはすでに十分な経験がある前提なので、ここではバックエンドとの接続確認に使います。

```text
- Dioまたはhttp
- 認証トークン管理
- APIエラー表示
- ローディング
- ページング
- リトライ
```

## Node.js

候補は次のいずれかです。

```text
Node.js
TypeScript
FastifyまたはExpress
mysql2
Zod
JWTライブラリ
OpenAPI関連ライブラリ
VitestまたはJest
Supertest
```

学習目的なら、最初はExpressで始めてもよいですが、TypeScriptを使うことをおすすめします。

```text
Node.js + TypeScript + Express
```

理由は、実務で重要な、

```text
リクエスト型
レスポンス型
DTO
Repositoryの戻り値
エラー型
```

を意識しやすくなるからです。

## MySQL

```text
MySQL 8.x系
InnoDB
mysql2
```

MySQLでは、トランザクション、インデックス、`EXPLAIN`、バックアップ、ストアドプログラムなどを一通り経験できます。公式マニュアルにもこれらの機能が体系的に整理されています。 [dev.mysql](https://dev.mysql.com/doc/refman/8.2/en/)

## マイグレーション

SQLファイルを直接手で実行するだけでなく、マイグレーションを使います。

```text
migrations/
├── 001_create_users.sql
├── 002_create_products.sql
├── 003_create_orders.sql
└── 004_add_product_indexes.sql
```

学ぶこと：

```text
- スキーマのバージョン管理
- 開発環境と本番環境の差分
- ロールバック
- CIでのDB構築
```

***

# 実務レベルに近づける課題

各フェーズで、単に機能を作るだけでなく、必ず次の成果物を作ります。

```text
1. OpenAPI仕様書
2. ER図
3. テーブル定義書
4. APIエラー仕様
5. SQL
6. ユニットテスト
7. API結合テスト
8. EXPLAIN結果
9. マイグレーション
10. README
```

## 例：注文APIの成果物

```text
POST /api/v1/orders
```

### 正常系

```text
在庫あり
価格一致
注文作成成功
```

### 異常系

```text
未ログイン
商品が存在しない
在庫不足
価格変更
同じ注文の二重送信
販売停止中
```

### テストケース

```text
- 在庫1個を1人が購入できる
- 在庫1個を2人が同時購入したら1人だけ成功する
- 価格が変更されたら注文を止める
- 決済失敗時に注文状態が不整合にならない
- 同じリクエストを2回送っても二重注文にならない
```

ここまでやると、単なるCRUDではなく、実務的なバックエンド開発になります。

***

# 最も重要な実務テーマ

このプロジェクトでは、以下を意識して実装してください。

## 1. 金額は整数で扱う

```text
100円 → 100
1,200円 → 1200
```

小数の浮動小数点で金額を扱わず、通貨の最小単位または整数で管理します。

```sql
unit_price BIGINT NOT NULL
```

## 2. 注文時点の価格を保存する

```text
products.price
  → 現在価格

order_items.unit_price
  → 注文時価格
```

## 3. 重要な処理はトランザクション化する

```text
注文作成
注文詳細作成
在庫減少
支払い状態更新
```

## 4. DB制約を使う

```text
PRIMARY KEY
FOREIGN KEY
UNIQUE
NOT NULL
CHECK
```

アプリケーションのチェックだけに頼らず、DBにも不変条件を持たせます。

## 5. 冪等性を実装する

Flutterでは、通信失敗時にユーザーが再度ボタンを押すことがあります。

```text
購入ボタン
  ↓
注文成功したがレスポンスだけ失敗
  ↓
ユーザーが再タップ
```

これで注文が2件できないようにします。

```text
idempotency_key
```

をリクエストに含め、注文作成時に一意制約を設定します。

***

# 最終的な学習ロードマップ

## レベル1：CRUD

```text
商品一覧
商品詳細
商品登録
商品編集
```

習得：

```text
SQL基本文法
Node.js API
MySQL接続
OpenAPI
```

## レベル2：認証

```text
登録
ログイン
プロフィール
権限
```

習得：

```text
Middleware
JWT
パスワードハッシュ
認証・認可
```

## レベル3：検索と性能

```text
検索
絞り込み
ページング
```

習得：

```text
インデックス
EXPLAIN
クエリ改善
カーソルページング
```

## レベル4：注文

```text
カート
注文確認
注文作成
購入履歴
```

習得：

```text
正規化
注文時点データ
トランザクション
```

## レベル5：競合制御

```text
在庫
座席のような同時購入
二重注文
```

習得：

```text
分離レベル
行ロック
原子的UPDATE
楽観的ロック
冪等性
```

## レベル6：業務システム

```text
配送
レビュー
通知
管理画面
```

習得：

```text
状態遷移
権限設計
監査ログ
```

## レベル7：分析

```text
売上集計
ランキング
期間比較
出品者分析
```

習得：

```text
GROUP BY
CTE
ウィンドウ関数
View
集計テーブル
```

## レベル8：運用

```text
バックアップ
復元
ログ
監視
障害対応
```

習得：

```text
mysqldump
リストア
slow query log
エラーログ
デプロイ
```

## レベル9：性能・スケール

```text
大量データ
負荷試験
検索性能
集計性能
```

習得：

```text
EXPLAIN ANALYZE
インデックス設計
キャッシュ
非同期処理
バッチ
```

***

# まず作るべき最小バージョン

最初からフリマアプリ全体を作るのではなく、最初の完成目標を次に絞ります。

```text
Flutterアプリ：
- 商品一覧
- 商品詳細
- 会員登録
- ログイン
- 商品出品
- 自分の出品一覧
```

Node.js API：

```text
POST /auth/register
POST /auth/login
GET /products
GET /products/:id
POST /products
GET /me/products
```

MySQL：

```text
users
products
categories
```

この段階で、

```text
Flutter
  ↓ HTTP
Node.js
  ↓ SQL
MySQL
```

の流れを、自分の手で一周完成させます。

その後に、

```text
お気に入り
→ カート
→ 注文
→ 在庫
→ 支払い状態
→ レビュー
→ 分析
```

と追加します。

## あなたに最適なテーマ

最終的な学習テーマは、次のように定義するとよいです。

> **Flutter Market：Flutterアプリで商品を出品・検索・購入できるフリマ型マーケットプレイスを、Node.js API・MySQL・OpenAPIで構築し、認証、正規化、インデックス、トランザクション、在庫競合、注文状態管理、分析、バックアップ、性能改善まで段階的に実装する。**

この1つのシステムを完成させれば、

```text
CRUDだけのアプリ開発
```

ではなく、

```text
API設計
DB設計
認証
権限
トランザクション
同時実行制御
性能改善
集計
運用
```

まで、実務で必要になるバックエンドの主要領域を一通り経験できます。
# Flutter Market - バックエンド学習ロードマップ

## システム概要

**フリマ型マーケットプレイス**（Flutter + Node.js + MySQL）

ユーザーが商品を出品し、他ユーザーが検索・購入・レビューできるシステム。

---

## 機能一覧

### ユーザー
会員登録・ログイン / プロフィール管理 / 商品検索・絞り込み / 商品詳細 / お気に入り / カート / 注文・購入履歴 / レビュー

### 出品者
商品登録・画像登録 / 価格・在庫変更 / 出品停止 / 注文状況・売上確認

### 管理者
ユーザー管理 / 商品審査 / カテゴリ管理 / 注文管理 / 売上分析

---

## テーブル構成

```
users / user_profiles / categories / products / product_images
favorites / carts / cart_items
orders / order_items / payments / shipments
reviews / notifications / audit_logs
```

### 主要テーブル定義

```sql
users: id, email, password_hash, role, status, created_at, updated_at

products: id, seller_id, category_id, name, description, price, stock, status, version, created_at, updated_at

orders: id, buyer_id, status, subtotal, shipping_fee, total_amount, created_at, updated_at

order_items: id, order_id, product_id, seller_id, product_name, unit_price, quantity, subtotal
-- unit_price は注文時点の価格をコピーして保存（マスタ変更の影響を受けない）
```

---

## フェーズ・学習内容

### Phase 1 - 商品一覧

```
API: GET /api/v1/products, GET /api/v1/products/{id}
```

学習内容：
- Node.jsプロジェクト構成（Route → Controller → Service → Repository → MySQL）
- SELECT / WHERE / ORDER BY / LIMIT OFFSET
- JSONレスポンス・エラーレスポンス
- OpenAPI基本

推奨ディレクトリ：
```
market-api/
├── src/
│   ├── app.ts          # Expressアプリの起点。ミドルウェア・ルーターの登録、サーバー起動
│   ├── routes/         # URLとControllerの紐付け（例: GET /products → ProductController.list）
│   ├── controllers/    # リクエスト受信・レスポンス返却。HTTPの入出力だけを担当
│   ├── services/       # ビジネスロジック（例: 在庫チェック・金額計算・状態遷移バリデーション）
│   ├── repositories/   # DBアクセスのみを担当（SQL文を書く場所）。Serviceから呼ばれる
│   ├── middlewares/    # リクエストの前処理（例: JWT認証・ログ出力・エラーハンドリング）
│   ├── db/             # DB接続設定（mysql2のコネクションプール初期化など）
│   ├── schemas/        # Zodによるリクエスト/レスポンスの型定義・バリデーションルール
│   └── errors/         # カスタムエラークラス定義（例: NotFoundError・UnauthorizedError）
├── migrations/         # テーブル作成・変更SQLファイル（連番管理）
└── seeds/              # 開発用ダミーデータのSQLファイル
```

リクエスト〜レスポンスの流れ：
```
[Flutter]
    │  HTTP Request (GET /api/v1/products)
    ▼
[app.ts]
    │  登録済みのミドルウェア・ルーターに流す
    ▼
[middlewares/]
    │  認証チェック・ログ出力など前処理
    │  ※ エラー時はここで responses して終了（errors/ のクラスを使用）
    ▼
[routes/]
    │  URLとHTTPメソッドに対応するControllerのメソッドを特定
    │  例: GET /products → ProductController.list
    ▼
[controllers/]
    │  リクエストのパラメータ・ボディを取り出す
    │  schemas/ でバリデーション実行
    │  ※ バリデーションエラー時は 400 を返して終了
    ▼
[services/]
    │  ビジネスロジック実行
    │  例: 在庫あり？ → 注文してよい、なし → エラー
    │  ※ 業務エラー時は errors/ のクラスをthrowしてcontrollerに返す
    ▼
[repositories/]
    │  SQL実行（SELECT / INSERT / UPDATE / DELETE）
    ▼
[db/]
    │  コネクションプールからDB接続を取得してクエリ発行
    ▼
  MySQL
    │  クエリ結果を返す
    ▼
[repositories/] → [services/] → [controllers/]
    │  結果をJSONに整形してレスポンス
    ▼
[Flutter]
    　 HTTP Response (200 OK + JSON)
```

#### TODO

**環境構築**
- [ ] Node.js + TypeScript + Express プロジェクト初期化
  - `npm init` でpackage.json生成 → `npm i express` `npm i -D typescript tsx @types/express @types/node` インストール → `npx tsc --init` で `tsconfig.json` 生成（`target: esnext` / `module: nodenext` が自動設定される）→ `rootDir` / `outDir` / `strict` を手動追記 → `src/app.ts` にExpressサーバー起動コードを書いて `npx tsx src/app.ts` で起動確認するまでの一連の手順
- [ ] mysql2 インストール・DB接続設定
- [ ] `.env` で DB接続情報管理（dotenv）
- [ ] `tsconfig.json` 設定

**DB**
- [ ] `migrations/001_create_categories.sql` 作成・実行
  - `CREATE TABLE categories (...)` のSQL文を `migrations/001_create_categories.sql` というファイルに書き、`mysql -u root -p market < migrations/001_create_categories.sql` のようにコマンドで実行してテーブルを作成すること。マイグレーションとは「スキーマ変更をSQLファイルで管理し、順番通りに実行することでDBの状態を再現できるようにする運用」のこと
- [ ] `migrations/002_create_products.sql` 作成・実行
- [ ] 開発用シードデータ（商品20件）投入
  - 動作確認用のダミーデータをDBに挿入すること。`INSERT INTO products (...) VALUES (...)` を20件分書いたSQLファイル（例：`seeds/products.sql`）を実行する。本番データとは別に「開発・テスト用の初期データ」を用意する作業

**OpenAPI（実装前に仕様を決める）**
- [ ] `openapi.yaml` 作成（`/products` エンドポイント定義）
- [ ] レスポンスのスキーマ定義（Product型）
- [ ] エラーレスポンス（400/404/500）のスキーマ定義

> **Phase 1 で省略しているカラムの補足**
> productsテーブルの以下カラムはPhase 1のAPIレスポンスから意図的に省略している。
> - `seller_id`: Phase 2（認証）完了後、Productスキーマに追加する
> - `category_id`: Phase 4（検索・絞り込み）でカテゴリフィルタ実装時にProductスキーマに追加する
> - `updated_at`: Phase 3（出品機能・PATCH）で商品更新レスポンスに含めるタイミングで追加する
> - `version`: 楽観的ロック用内部カラム。GETエンドポイントのSELECT文には含めず、在庫減算のUPDATE文の中でのみ使用する。openapi.yaml の Product スキーマにも定義しない（Phase 7で実装するが常に非公開）

**API実装**
- [ ] `GET /api/v1/products` 実装（一覧・ページング）
- [ ] `GET /api/v1/products/:id` 実装（詳細）
- [ ] Route → Controller → Service → Repository の層分離
- [ ] 存在しないIDへの404レスポンス実装
- [ ] 共通エラーハンドラーMiddleware実装

**Flutter連携**
- [ ] Flutter側でDio設定・APIベースURL設定
- [ ] 商品一覧画面でAPIから取得・表示
- [ ] 商品詳細画面でAPIから取得・表示
- [ ] ローディング・エラー表示実装

---

### Phase 2 - 認証・認可

```
API: POST /auth/register, POST /auth/login, GET /me, PATCH /me
```

学習内容：
- パスワードハッシュ化
- JWTまたはセッション
- 認証ミドルウェア（Authorizationヘッダー検証）
- バリデーション
- ユーザー権限
- 401（未認証）/ 403（権限なし）の使い分け

#### TODO

**DB**
- [ ] `migrations/003_create_users.sql` 作成・実行
- [ ] `users` テーブル：`role`（buyer/seller/admin）・`status`（active/banned）カラム確認

**API実装**
- [ ] `POST /auth/register`：bcryptでパスワードハッシュ化・ユーザー登録
- [ ] `POST /auth/login`：パスワード検証・JWT発行
- [ ] `GET /me`：認証済みユーザー情報取得
- [ ] `PATCH /me`：プロフィール更新
- [ ] 認証Middleware実装（`Authorization: Bearer <token>` 検証）
- [ ] Zodによるリクエストバリデーション（email形式・password最小文字数）
- [ ] 重複メールの409エラー実装
- [ ] 認証が必要なルートにMiddleware適用

**OpenAPI**
- [ ] `/auth/register` `/auth/login` `/me` のエンドポイント定義追加
- [ ] `securitySchemes`（BearerAuth）定義
- [ ] 認証が必要なエンドポイントに `security` フィールド追加
- [ ] Product スキーマに `seller_id`（integer）を追加（Phase 1 で省略）

**Flutter連携**
- [ ] 会員登録画面・API連携
- [ ] ログイン画面・API連携
- [ ] JWTトークンをSecureStorageに保存
- [ ] Dioインターセプターでリクエストヘッダーに自動付与
- [ ] プロフィール画面・API連携

---

### Phase 3 - 出品機能

```
API: POST /products, GET /me/products, PATCH /products/{id}, DELETE /products/{id}
```

学習内容：
- INSERT / UPDATE / DELETE
- 所有者チェック（自分の商品のみ編集可）
- 論理削除（statusを`archived`に変更、物理削除しない）
- enumステータス管理

#### TODO

**DB**
- [ ] `product_images` テーブル migration 作成・実行
- [ ] `products.status` のENUM値定義（draft/published/archived）

**API実装**
- [ ] `POST /products`：商品登録（認証必須）
- [ ] `GET /me/products`：自分の出品一覧取得
- [ ] `PATCH /products/:id`：商品情報更新（所有者のみ）
- [ ] `DELETE /products/:id`：論理削除（`status = 'archived'` に更新）
- [ ] 所有者チェック（`seller_id !== req.user.id` → 403）
- [ ] バリデーション（price > 0・stock >= 0・nameの文字数上限）
- [ ] `updated_at` の自動更新

**OpenAPI**
- [ ] 出品APIのエンドポイント定義追加
- [ ] Product登録・更新のリクエストボディスキーマ定義
- [ ] Product スキーマに `updated_at`（string, date-time）を追加（Phase 1 で省略）

**Flutter連携**
- [ ] 出品フォーム画面・API連携
- [ ] 自分の出品一覧画面
- [ ] 商品編集・削除UI

---

### Phase 4 - 検索・インデックス・EXPLAIN

```
API: GET /products?q=&category_id=&min_price=&max_price=&sort=&cursor=
```

学習内容：
- 複合インデックス設計・効果測定
- EXPLAINの見方（type / key / rows / Extra）
- インデックスなし→追加→再計測の比較
- カーソルページング vs OFFSETページング
- 開発用データ10万件で効果を確認

```sql
CREATE INDEX idx_products_status_category_created
ON products (status, category_id, created_at);
```

#### TODO

**DB**
- [ ] シードスクリプトで商品データ10万件生成
- [ ] インデックスなしの状態でEXPLAIN実行・記録
- [ ] 複合インデックス追加（status, category_id, created_at）
- [ ] インデックス追加後に同クエリでEXPLAIN再実行・比較

**API実装**
- [ ] キーワード検索（`name LIKE ?`）実装
- [ ] カテゴリ・価格帯・ステータスの絞り込み実装
- [ ] OFFSETページング実装
- [ ] カーソルページング実装（`created_at < ?` 方式）
- [ ] ソート切り替え（新着順・価格順）実装
- [ ] 全文検索インデックス（FULLTEXT）の追加と比較

**OpenAPI**
- [ ] 検索クエリパラメータ（`q` / `category_id` / `min_price` / `max_price` / `sort` / `cursor`）をエンドポイント定義に追加
- [ ] Product スキーマに `category_id`（integer）を追加（Phase 1 で省略）

**計測・記録**
- [ ] EXPLAIN結果を `docs/explain/` 以下にMarkdownで保存
- [ ] OFFSET vs カーソルの実行時間比較
- [ ] `type: ALL`（フルスキャン）→ `type: ref` への改善を確認
- [ ] 一覧APIのレスポンスサイズ計測（`description` を含む場合 vs 除いた場合）
  - `GET /products` のレスポンスボディのバイト数を比較する
  - EXPLAINで `description`（TEXT）の有無によるクエリコストの差を確認する
  - 計測結果をもとに「一覧SELECTから `description` を外すべきか」を判断する
  - 分離が必要と判断した場合は `ProductSummary` スキーマを追加し、一覧と詳細でスキーマを分ける

**Flutter連携**
- [ ] 検索バー・絞り込みUI実装
- [ ] 無限スクロール（カーソルページング）実装

---

### Phase 5 - お気に入り・カート

```
API: POST/DELETE /products/{id}/favorite, GET /me/favorites
     GET/POST /cart, PATCH/DELETE /cart/items/{id}
```

学習内容：
- UNIQUE制約でDB側でも重複防止
- カート価格の扱い（表示：現在価格、注文確定：価格コピー）

#### TODO

**DB**
- [ ] `migrations/004_create_favorites.sql`（UNIQUE(user_id, product_id)）
- [ ] `migrations/005_create_carts.sql` / `006_create_cart_items.sql`

**API実装（お気に入り）**
- [ ] `POST /products/:id/favorite`：登録（重複時は409ではなく冪等に200）
- [ ] `DELETE /products/:id/favorite`：削除
- [ ] `GET /me/favorites`：一覧取得

**API実装（カート）**
- [ ] `GET /cart`：カート内容取得（商品の現在価格を表示）
- [ ] `POST /cart/items`：カートに商品追加
- [ ] `PATCH /cart/items/:id`：数量変更
- [ ] `DELETE /cart/items/:id`：カートから削除
- [ ] 存在しない・販売停止商品の追加をバリデーション

**Flutter連携**
- [ ] お気に入りボタンのトグルUI
- [ ] カート画面（数量変更・削除・合計金額表示）

---

### Phase 6 - 注文・価格確定

```
API: POST /orders/preview, POST /orders, GET /me/orders, GET /orders/{id}
```

学習内容：
- クライアント送信価格を信用しない（サーバー側でDBから取得・計算）
- order_itemsに注文時点の価格・商品名をコピー保存
- トランザクション内で在庫確認→注文作成→在庫減少

#### TODO

**DB**
- [ ] `migrations/007_create_orders.sql`
- [ ] `migrations/008_create_order_items.sql`（unit_price・product_name カラム含む）

**API実装**
- [ ] `POST /orders/preview`：注文内容確認（価格・合計をサーバーで計算して返す）
- [ ] `POST /orders`：注文確定
  - [ ] DB から最新価格を取得（クライアント価格は使わない）
  - [ ] 在庫確認
  - [ ] トランザクション内で orders / order_items INSERT
  - [ ] トランザクション内で stock 減算
  - [ ] idempotency_key でリクエスト一意制約（二重注文防止）
- [ ] `GET /me/orders`：購入履歴一覧
- [ ] `GET /orders/:id`：注文詳細

**OpenAPI**
- [ ] `/orders` エンドポイント定義
- [ ] OrderPreview・Order・OrderItem スキーマ定義

**Flutter連携**
- [ ] 注文確認画面（preview APIで価格表示）
- [ ] 注文完了画面
- [ ] 購入履歴画面

---

### Phase 7 - 在庫・トランザクション

学習内容：
- 原子的UPDATE（SELECT→判定→UPDATEの分離が危険な理由）
- `SELECT ... FOR UPDATE`による行ロック
- 楽観的ロック（versionカラム）
- MySQLのスナップショット読み取りとロック読み取りの違い

```sql
-- 原子的UPDATE
UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?;
-- 更新件数0行 → 在庫不足

-- 行ロック
START TRANSACTION;
SELECT id, price, stock FROM products WHERE id = ? FOR UPDATE;
UPDATE products SET stock = stock - ? WHERE id = ?;
INSERT INTO orders (...); INSERT INTO order_items (...);
COMMIT;
```

#### TODO

**実装**
- [ ] 原子的UPDATEで在庫減算実装（affectedRows === 0 → 在庫不足エラー）
- [ ] `SELECT ... FOR UPDATE` + トランザクションの実装パターンを試す
- [ ] `products.version` カラム追加・楽観的ロック実装（`WHERE version = ?` + version+1）
  - DB: 新規マイグレーションファイルで `ALTER TABLE products ADD COLUMN version INT UNSIGNED NOT NULL DEFAULT 0;` を実行
  - repository: UPDATE文を `SET stock = stock - 1, version = version + 1 WHERE id = ? AND version = ? AND stock >= 1` に変更
  - ※ openapi.yaml への追加は不要（クライアントに公開しない内部カラム）
- [ ] トランザクション失敗時のROLLBACK処理実装
- [ ] DB接続エラー・デッドロック時のリトライ実装

**検証**
- [ ] 同時購入テストスクリプト作成（在庫1個に対して2リクエスト同時送信）
- [ ] 原子的UPDATE / FOR UPDATE / 楽観的ロック それぞれで結果比較
- [ ] デッドロックを意図的に発生させ確認
- [ ] Supertest で在庫不足・同時注文のテストケース追加

---

### Phase 8 - 注文状態・配送・レビュー

注文ステータス遷移：
```
pending → paid → preparing → shipped → delivered → completed
pending → cancelled / paid → refund_pending
```

学習内容：
- API側で状態遷移バリデーション（後戻り禁止）
- 状態変更履歴テーブル（order_status_histories）
- レビュー投稿条件（本人・completed・未投稿）をDB制約でも保証
- 冪等性・監査ログ

#### TODO

**DB**
- [ ] `migrations/009_create_order_status_histories.sql`
- [ ] `migrations/010_create_reviews.sql`（UNIQUE(order_id, product_id, reviewer_id)）
- [ ] `migrations/011_create_audit_logs.sql`

**API実装（注文状態）**
- [ ] 状態遷移マップ定義（許可される遷移のみ通す）
- [ ] `POST /orders/:id/cancel`：キャンセル処理
- [ ] `POST /orders/:id/ship`：発送登録（出品者のみ）
- [ ] `POST /orders/:id/receive`：受取確認（購入者のみ）
- [ ] 状態変更時に `order_status_histories` にINSERT
- [ ] 不正な遷移への422エラー実装

**API実装（レビュー）**
- [ ] `POST /products/:id/reviews`：レビュー投稿（条件チェック：本人・completed・未投稿）
- [ ] `GET /products/:id/reviews`：レビュー一覧取得
- [ ] DB UNIQUE制約で二重投稿防止

**監査ログ**
- [ ] 注文状態変更を `audit_logs` に記録するMiddleware実装

**Flutter連携**
- [ ] 注文ステータス表示UI
- [ ] レビュー投稿フォーム

---

### Phase 9 - 管理画面・分析

学習内容：
- GROUP BY / HAVING / サブクエリ / CTE
- ウィンドウ関数（RANK / DENSE_RANK / SUM OVER）
- 集計テーブル（バッチで日次集計 → 管理画面から参照）
- View

```sql
-- 売上ランキング例
SELECT seller_id, order_month, monthly_sales,
    RANK() OVER (PARTITION BY order_month ORDER BY monthly_sales DESC) AS rank
FROM seller_monthly_sales;
```

#### TODO

**DB**
- [ ] `migrations/012_create_daily_sales_summary.sql`（日次集計テーブル）
- [ ] 日次集計バッチスクリプト作成（Node.js or SQLスクリプト）
- [ ] 月別売上Viewの作成
- [ ] カテゴリ別売上Viewの作成

**SQL実装・検証**
- [ ] 月別売上集計（GROUP BY + SUM）
- [ ] 出品者別累計売上（SUM OVER PARTITION BY seller_id）
- [ ] 出品者売上ランキング（RANK() OVER）
- [ ] カテゴリ内商品ランキング（DENSE_RANK() OVER PARTITION BY category_id）
- [ ] CTEを使った複数段階集計
- [ ] 各クエリのEXPLAIN取得・集計用インデックス追加

**API実装**
- [ ] `GET /admin/dashboard`：売上サマリ取得
- [ ] `GET /admin/orders`：注文一覧（フィルタ・ページング）
- [ ] `GET /admin/users`：ユーザー一覧
- [ ] 管理者ロールチェックMiddleware実装（role !== 'admin' → 403）

**Flutter連携**
- [ ] 売上ダッシュボード画面（グラフ表示）
- [ ] 注文管理・ユーザー管理画面

---

### Phase 10 - バックアップ・性能改善

学習内容：
- mysqldump → DB削除 → リストア → データ整合性確認（復元テストまで行う）
- slow query log / EXPLAIN ANALYZE
- 100万件データで検索・集計・購入履歴の性能測定
- 比較：インデックス前後 / OFFSET vs カーソル / SELECT * vs 必要列 / 集計テーブル導入前後

#### TODO

**バックアップ**
- [ ] `mysqldump` でフルバックアップ取得・スクリプト化
- [ ] バックアップからのリストア手順ドキュメント化
- [ ] リストア後のデータ整合性確認（件数・外部キー・注文履歴）
- [ ] バイナリログを使ったポイントインタイムリカバリを試す

**性能測定**
- [ ] シードスクリプトで商品100万件・注文100万件生成
- [ ] slow query log 有効化・閾値設定（1秒以上）
- [ ] 商品検索・売上ランキング・購入履歴 それぞれで `EXPLAIN ANALYZE` 実行・記録
- [ ] `docs/performance/` 以下に計測結果をMarkdownで保存

**性能改善**
- [ ] `SELECT *` → 必要カラムのみに絞り込み・実行時間比較
- [ ] OFFSETページング → カーソルページング置き換え・比較
- [ ] サブクエリ → JOINへの書き換え比較
- [ ] 集計テーブル導入前後の管理画面レスポンス時間比較
- [ ] カバリングインデックスの検討・適用
- [ ] `GET /me/products` のN+1解消：`productImageRepository.findByProductId` をN回呼ぶ実装を `WHERE product_id IN (...)` のバッチ取得に置き換える（Phase 3 時点では Promise.all で並列化しているが、DBラウンドトリップはN+1のまま）。phase3-listing.mdの「4-4. services/ - productService 更新」にてgetMyProducts() の上の行にコメントアウトを記載済み

**運用**
- [ ] `Dockerfile` + `docker-compose.yml` でDB・APIをコンテナ化
- [ ] GitHub Actionsでマイグレーション自動実行（CI）
- [ ] 環境変数管理（開発・本番の切り替え）

---

## 最終API一覧

```
Auth:     POST /auth/register, /auth/login, /auth/refresh
Users:    GET/PATCH /me
Products: GET/POST /products, GET/PATCH/DELETE /products/{id}
Favorites: POST/DELETE /products/{id}/favorite
Cart:     GET/POST /cart, PATCH/DELETE /cart/items/{id}
Orders:   POST /orders/preview, POST /orders, GET /me/orders, GET/POST /orders/{id}/cancel
Shipping: POST /orders/{id}/ship, /orders/{id}/receive
Reviews:  POST/GET /products/{id}/reviews
Admin:    GET /admin/dashboard, /admin/orders, /admin/users
```

OpenAPIフロー：`openapi.yaml → レビュー → Node.js実装 → Flutter連携 → APIテスト`

---

## 技術スタック

| 領域 | 採用 |
|------|------|
| API | Node.js + TypeScript（target: esnext / module: nodenext）+ Express |
| DB | MySQL 8.x (InnoDB) + mysql2 |
| 認証 | JWT |
| バリデーション | Zod |
| 実行（開発時） | tsx（ESM対応。`npx tsx src/app.ts`） |
| テスト | Vitest + Supertest |
| マイグレーション | SQLファイル連番管理 |

マイグレーション例：
```
migrations/
├── 001_create_users.sql
├── 002_create_products.sql
└── 003_add_product_indexes.sql
```

---

## 実装ルール（重要）

1. **金額は整数**（`BIGINT NOT NULL`、浮動小数点禁止）
2. **注文時点の価格を保存**（`order_items.unit_price`）
3. **重要処理はトランザクション化**（注文作成・在庫減少・状態更新）
4. **DB制約を使う**（PRIMARY KEY / FOREIGN KEY / UNIQUE / NOT NULL / CHECK）
5. **冪等性**（`idempotency_key`で二重注文防止）

---

## 各フェーズの成果物

```
1. OpenAPI仕様書（実装前に作成）
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

---

## 学習ロードマップ（レベル別）

| レベル | 機能 | 習得スキル |
|--------|------|-----------|
| 1 | 商品CRUD | SQL基本 / Node.js API / OpenAPI |
| 2 | 認証 | JWT / Middleware / パスワードハッシュ / 認証認可 |
| 3 | 検索・性能 | インデックス / EXPLAIN / カーソルページング |
| 4 | 注文 | 正規化 / 注文時点データ / トランザクション |
| 5 | 競合制御 | 行ロック / 原子的UPDATE / 楽観的ロック / 冪等性 |
| 6 | 業務システム | 状態遷移 / 権限設計 / 監査ログ |
| 7 | 分析 | GROUP BY / CTE / ウィンドウ関数 / 集計テーブル |
| 8 | 運用 | mysqldump / slow query log / デプロイ |
| 9 | 性能・スケール | EXPLAIN ANALYZE / インデックス設計 / キャッシュ / バッチ |

---

## まず作る最小バージョン

Flutter:
```
商品一覧 / 商品詳細 / 会員登録 / ログイン / 商品出品 / 自分の出品一覧
```

API:
```
POST /auth/register, POST /auth/login
GET /products, GET /products/:id
POST /products, GET /me/products
```

DB:
```
users / products / categories
```

完成後に順次追加：お気に入り → カート → 注文 → 在庫 → 支払い状態 → レビュー → 分析

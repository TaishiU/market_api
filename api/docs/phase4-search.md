# Phase 4 - 検索・インデックス・EXPLAIN 詳細作業ログ

## 概要

Phase 3 までで商品CRUD・認証・出品機能を実装した。
Phase 4 では `GET /products` に検索・絞り込み・ソートを追加し、インデックスがない状態とある状態のクエリ性能差を実際に計測する。

- 10万件のデータで EXPLAIN の `rows` 差を確認
- 複合インデックス（`status, category_id, created_at`）の設計・追加
- `type: ALL`（フルスキャン）→ `type: ref`（インデックス参照）への改善を数値で確認
- OFFSET ページングとカーソルページングの実装と実行時間比較
- 一覧レスポンスから `description`（TEXT）を除いた場合のサイズ・コスト比較
- Phase 1 で省略していた `category_id` を Product スキーマに追加

---

## 1. DB（大量データ生成・EXPLAIN 計測）

### 1-1. シードスクリプトで商品 10 万件生成

10件・100件レベルではインデックスの効果が体感できない。10万件のデータで EXPLAIN の `rows` の差を確認する。

`seeds/seed_products_100k.ts` を作成：

```typescript
import 'dotenv/config';
import { pool } from '../src/db/connection.js';

const TOTAL      = 100_000;
const BATCH      = 1_000;
const SELLER_ID  = 1; // Phase 2 でシード済みのユーザー

const CATEGORY_IDS = [1, 2, 3];
const STATUSES     = ['published', 'published', 'published', 'draft', 'archived'] as const;

function rand(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const startTime = Date.now();
console.log(`[${new Date().toISOString()}] 開始: ${TOTAL} 件を ${BATCH} 件ずつ挿入中...`);

// 行ごとに1分ずつずらす（行0が最古、行99999が最新）
// 100000行 = 約69日のタイムラインに分散
const baseTime = new Date();
const MS_PER_MINUTE = 60 * 1_000;

for (let i = 0; i < TOTAL; i += BATCH) {
  const rows: unknown[][] = [];
  for (let j = 0; j < BATCH && i + j < TOTAL; j++) {
    const rowIndex   = i + j;
    const n          = rowIndex + 21;
    const categoryId = CATEGORY_IDS[rand(0, CATEGORY_IDS.length - 1)];
    const status     = STATUSES[rand(0, STATUSES.length - 1)];
    const price      = rand(100, 300_000);
    const stock      = rand(0, 100);
    const createdAt  = new Date(baseTime.getTime() - (TOTAL - 1 - rowIndex) * MS_PER_MINUTE).toISOString().slice(0, 19).replace('T', ' ');
    rows.push([
      SELLER_ID,
      categoryId,
      `テスト商品${n}`,
      `${n} 番目の商品説明文。開発・計測用のサンプルデータです。`,
      price,
      stock,
      status,
      createdAt,
    ]);
  }
  await pool.query(
    `INSERT INTO products (seller_id, category_id, name, description, price, stock, status, created_at) VALUES ?`,
    [rows]
  );
  process.stdout.write(`\r${Math.min(i + BATCH, TOTAL)} / ${TOTAL} 件完了`);
}

const elapsedMs = Date.now() - startTime;
const elapsedSec = (elapsedMs / 1000).toFixed(2);
console.log(`\n[${new Date().toISOString()}] 完了: ${elapsedSec} 秒 (${elapsedMs} ms)`);

await pool.end();

```

実行：

```bash
npx tsx seeds/seed_products_100k.ts
```

ターミナル：
```
api % npx tsx seeds/seed_products_100k.ts

[2026-09-21T12:01:43.814Z] 開始: 100000 件を 1000 件ずつ挿入中...
100000 / 100000 件完了
[2026-09-21T12:01:44.890Z] 完了: 1.08 秒 (1076 ms)
```

確認：

```bash
mysql market -e "SELECT COUNT(*) FROM products;"
# → 100020 件（既存 20 件 + 10 万件）

mysql market -e "SELECT status, COUNT(*) as cnt FROM products GROUP BY status;"
# → published / draft / archived の割合を確認
```

**バルク INSERT とは**：`VALUES ?` に2次元配列を渡すと、mysql2 が `VALUES (a,b,...), (a,b,...), ...` に展開して1クエリで複数行挿入する。1件ずつ INSERT するより DB との往復回数が 1/1000 になり、10万件の挿入が数十倍高速になる。

---

### 1-2. EXPLAIN 実行・記録（インデックスなし）

**EXPLAIN とは**：実際にクエリを実行せず、MySQL がどのように実行計画を立てるかを確認するコマンド。インデックスが使われているか、何行スキャンするかを事前に把握できる。

インデックス追加前に EXPLAIN を実行して結果を記録する。

**EXPLAIN の出力形式について**：MySQL 8.0 以降の環境ではデフォルトの EXPLAIN 出力がツリー形式になる場合がある。`EXPLAIN FORMAT=TRADITIONAL` で従来のテーブル形式を取得できる。以降のコマンドはすべて `FORMAT=TRADITIONAL` を使う。

**FK インデックスについて**：`category_id` は外部キー制約で定義されているため、MySQL が自動でインデックスを作成している（`SHOW INDEX FROM products` で `category_id` が表示される）。この段階では migration 006 の複合インデックスは未適用だが、`category_id` 単体のインデックスは存在する状態。

---

**クエリ①：カテゴリ絞り込み + 新着順**

```bash
mysql market -e "
EXPLAIN FORMAT=TRADITIONAL
SELECT id, seller_id, category_id, name, price, stock, status, created_at
FROM products
WHERE status = 'published' AND category_id = 1
ORDER BY created_at DESC
LIMIT 20 OFFSET 0;
"
```

結果（複合インデックスなし・FK インデックスあり）：

| id | select_type | table    | partitions | type | possible_keys | key         | key_len | ref   | rows  | filtered | Extra                       |
|----|-------------|----------|------------|------|---------------|-------------|---------|-------|-------|----------|-----------------------------|
| 1  | SIMPLE      | products | NULL       | ref  | category_id   | category_id | 4       | const | 49535 | 33.33    | Using where; Using filesort |

`category_id` の FK インデックスが使われるため `type: ref`（`type: ALL` にはならない）。`status` と `created_at` はインデックスにないため `Using where`（status の絞り込みをメモリで評価）と `Using filesort`（ORDER BY をメモリでソート）が発生。`rows: 49535` はカテゴリ 1 該当行の推定値（全 3 カテゴリ均等分布で約 1/3 × 全体の `filtered: 33.33%`）。

`key_len: 4` は MySQL がインデックスのうち 4 バイト分を使用していることを示す。`category_id` のデータ型は `INT`（4 バイト）なので、インデックスの先頭カラム 1 列だけを使っていることが確認できる。単カラムインデックスではデータ型の確認程度の意味しかないが、**複合インデックスでは何カラム目まで使われているかを判断できる重要な指標になる**。

migration 006 で追加する複合インデックス `(status, category_id, created_at)` の場合：

| key_len | 使われているカラム |
|---------|-----------------|
| 1 | `status` のみ（ENUM = 1バイト） |
| 5 | `status` + `category_id`（1+4） |
| 10 | `status` + `category_id` + `created_at`（5+5） |

`status` のデータ型は `ENUM('draft','published','archived')` で、値が 255 種類以下なら 1 バイトで格納される。migration 006 適用後のクエリ①（`WHERE status = 'published' AND category_id = 1 ORDER BY created_at DESC`）では `key_len: 5`（status 1バイト + category_id 4バイト）となり、WHERE 条件の 2 カラムがインデックスで処理されていることを確認できる。`created_at` は ORDER BY に使われるが key_len には加算されない。

---

**クエリ②：`status` のみ絞り込み（`category_id` なし）**

FK インデックスが介在しない状態でフルスキャンを確認するクエリ。

```bash
mysql market -e "
EXPLAIN FORMAT=TRADITIONAL
SELECT id, seller_id, category_id, name, price, stock, status, created_at
FROM products
WHERE status = 'published'
ORDER BY created_at DESC
LIMIT 20 OFFSET 0;
"
```

結果（インデックスなし・フルスキャン）：

| id | select_type | table    | partitions | type | possible_keys | key  | key_len | ref  | rows  | filtered | Extra                       |
|----|-------------|----------|------------|------|---------------|------|---------|------|-------|----------|-----------------------------|
| 1  | SIMPLE      | products | NULL       | ALL  | NULL          | NULL | NULL    | NULL | 99071 | 33.33    | Using where; Using filesort |

`type: ALL` = テーブル全行スキャン。`key: NULL` = 使用インデックスなし。`rows: 99071` = テーブル全件を走査。OFFSET が大きくなっても MySQL はスキャン行数を変えられない（全件スキャン後にスキップする）。

**EXPLAIN の type（速い順）：**

| type     | 意味 |
|----------|------|
| `const`  | PRIMARY KEY で 1 行確定 |
| `eq_ref` | JOIN の結合側で 1 行確定 |
| `ref`    | 非ユニークインデックスで絞り込み |
| `range`  | インデックスの範囲スキャン（BETWEEN・>・<） |
| `index`  | インデックス全体をスキャン（テーブルスキャンよりはマシ） |
| `ALL`    | テーブル全行スキャン（最悪） |

**Extra の主要値：**

| Extra | 意味 |
|---|---|
| `Using filesort` | `ORDER BY` をインデックスで解決できずメモリでソート |
| `Backward index scan` | インデックスを逆順スキャンして `ORDER BY ... DESC` を解決（filesort 不要） |
| `Using index condition` | インデックスのみで WHERE を処理（テーブルアクセス削減） |
| `Using where` | WHERE 条件をストレージエンジン外で評価 |
| `Using index` | カバリングインデックス（SELECT 列がすべてインデックス内に収まる） |

結果を `docs/explain/` に保存しておく：

```bash
mkdir -p docs/explain

mysql market -e "
EXPLAIN FORMAT=TRADITIONAL
SELECT id, seller_id, category_id, name, price, stock, status, created_at
FROM products
WHERE status = 'published' AND category_id = 1
ORDER BY created_at DESC
LIMIT 20;
" > docs/explain/before-index.txt
```

---

### 1-3. migrations/006_add_product_indexes.sql

```sql
-- 複合インデックス（status + category_id + created_at）
-- ① status = 'published' で絞り込み
-- ② category_id で絞り込み
-- ③ created_at の ORDER BY をインデックスで解決（filesort 不要になる）
CREATE INDEX idx_products_status_category_created
ON products (status, category_id, created_at);
```

実行：

```bash
mysql market < migrations/006_add_product_indexes.sql
```

確認：

```bash
mysql market -e "SHOW INDEX FROM products;"
# → idx_products_status_category_created が表示されること
```

**なぜこのカラム順序か**：

```
(status, category_id, created_at)
  ↑等値       ↑等値        ↑範囲 / ORDER BY
```

MySQL の複合インデックスは左端から順に使われる（最左前置の原則）。
- `WHERE status = ?` → インデックス先頭を使用
- `WHERE status = ? AND category_id = ?` → 先頭2カラムを使用
- `WHERE status = ? AND category_id = ? ORDER BY created_at` → 3カラムすべて使用（filesort 不要）
- `WHERE category_id = ?`（status なし）→ このインデックスは使用されない

**等値条件は範囲条件・ORDER BY より前に置く**：
`(created_at, status, category_id)` にすると `ORDER BY created_at DESC` はインデックスで解決できるが、`WHERE status = ? AND category_id = ?` は等値条件がインデックスの先頭でないため効果が薄い。

---

### 1-4. EXPLAIN 再実行・比較（インデックスあり）

**クエリ①：カテゴリ絞り込み + 新着順**

```bash
mysql market -e "
EXPLAIN FORMAT=TRADITIONAL
SELECT id, seller_id, category_id, name, price, stock, status, created_at
FROM products
WHERE status = 'published' AND category_id = 1
ORDER BY created_at DESC
LIMIT 20;
"
```

結果（インデックスあり）：

| id | select_type | table    | partitions | type | possible_keys                                    | key                                  | key_len | ref         | rows  | filtered | Extra               |
|----|-------------|----------|------------|------|--------------------------------------------------|--------------------------------------|---------|-------------|-------|----------|---------------------|
| 1  | SIMPLE      | products | NULL       | ref  | category_id,idx_products_status_category_created | idx_products_status_category_created | 5       | const,const | 37908 | 100.00   | Backward index scan |

| 変化 | 改善前（FK インデックスのみ） | 改善後（複合インデックスあり） |
|------|------------------------------|-------------------------------|
| `key` | `category_id` | `idx_products_status_category_created` |
| `key_len` | `4`（category_id の INT 4バイトのみ） | `5`（status 1バイト + category_id 4バイト） |
| `ref` | `const`（category_id の等値条件 1つ） | `const,const`（status + category_id の等値条件 2つ） |
| `rows` | `49535` | `37908`（status でさらに絞り込まれた推定値） |
| `filtered` | `33.33`（status の絞り込みをメモリで評価） | `100.00`（インデックスで完全に絞り込み済み） |
| `Using filesort` | あり | なし → `Backward index scan` |

`Using filesort` が消えて `Backward index scan` になったのは `ORDER BY created_at DESC` がインデックスの3番目のカラムと一致するため。MySQL がインデックスを逆順にスキャンすることで降順ソートをメモリソートなしに実現している。`key_len: 5` は WHERE 条件（status + category_id）の 2 カラムを示す。created_at は ORDER BY に使われているが key_len には含まれない（key_len は等値・範囲条件のバイト数のみ加算される）。

結果を保存：

```bash
mysql market -e "
EXPLAIN FORMAT=TRADITIONAL
SELECT id, seller_id, category_id, name, price, stock, status, created_at
FROM products
WHERE status = 'published' AND category_id = 1
ORDER BY created_at DESC
LIMIT 20;
" > docs/explain/after-index.txt
```

---

## 2. OpenAPI（仕様更新）

### 2-1. GET /products クエリパラメータ追加

`openapi.yaml` の `GET /products` を更新：

```yaml
  /products:
    get:
      summary: 商品一覧取得（検索・絞り込み対応）
      parameters:
        - name: q
          in: query
          description: キーワード検索（name の部分一致）
          schema:
            type: string
        - name: category_id
          in: query
          schema:
            type: integer
        - name: min_price
          in: query
          schema:
            type: integer
            minimum: 0
        - name: max_price
          in: query
          schema:
            type: integer
            minimum: 0
        - name: sort
          in: query
          schema:
            type: string
            enum: [newest, price_asc, price_desc]
            default: newest
        - name: limit
          in: query
          schema:
            type: integer
            default: 20
            minimum: 1
            maximum: 100
        - name: offset
          in: query
          description: OFFSET ページング（sort=newest 以外、または cursor 未指定時に使用）
          schema:
            type: integer
            default: 0
            minimum: 0
        - name: cursor
          in: query
          description: カーソルページング用トークン（sort=newest 時のみ有効）
          schema:
            type: string
      responses:
        '200':
          description: 成功
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: array
                    items:
                      $ref: '#/components/schemas/ProductSummary'
                  total:
                    type: integer
                    nullable: true
                    description: OFFSET ページング時のみ返す。カーソルページング時は null
                  next_cursor:
                    type: string
                    nullable: true
                    description: 次ページのカーソル。最終ページの場合は null
        '400':
          $ref: '#/components/responses/BadRequest'
        '500':
          $ref: '#/components/responses/InternalServerError'
```

### 2-2. ProductSummary スキーマ追加・既存 Product スキーマの使い分け整理

`components/schemas:` に追記：

```yaml
    ProductSummary:
      description: 一覧用スキーマ（description を除いてレスポンスサイズを削減）
      type: object
      properties:
        id:
          type: integer
        seller_id:
          type: integer
        category_id:
          type: integer
        name:
          type: string
        price:
          type: integer
        stock:
          type: integer
        status:
          type: string
          enum: [draft, published, archived]
        created_at:
          type: string
          format: date-time
```

**`ProductSummary` と `ProductDetail` の使い分け：**

| スキーマ | 使用箇所 | description | images | updated_at |
|----------|----------|-------------|--------|------------|
| `ProductSummary` | `GET /products`（一覧） | なし | なし | なし |
| `ProductDetail` | `GET /products/{id}`（詳細）・出品 CRUD | あり | あり | あり |

`description` を一覧から除く理由は「5. 計測・記録」で確認する。

**`GET /products/{id}` のレスポンスを `ProductDetail` に更新：**

既存の `GET /products/{productId}` のレスポンス定義を変更：

```yaml
  /products/{productId}:
    get:
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ProductDetail'
```

Phase 3 で `ProductDetail` スキーマは定義済み（`images`, `description`, `updated_at` を含む）なのでスキーマ自体の変更は不要。

---

## 3. API実装

### 3-1. schemas/ - 検索クエリバリデーション追加

`src/schemas/productSchema.ts` を更新：

```typescript
import { z } from 'zod';

export const searchProductsQuerySchema = z.object({
  q:           z.string().optional(),
  category_id: z.coerce.number().int().positive().optional(),
  min_price:   z.coerce.number().int().min(0).optional(),
  max_price:   z.coerce.number().int().min(0).optional(),
  sort:        z.enum(['newest', 'price_asc', 'price_desc']).default('newest'),
  limit:       z.coerce.number().int().min(1).max(100).default(20),
  offset:      z.coerce.number().int().min(0).default(0),
  cursor:      z.string().optional(),
}).refine(
  data => data.min_price === undefined || data.max_price === undefined || data.min_price <= data.max_price,
  { message: 'min_price は max_price 以下にしてください', path: ['min_price'] }
);
// `.refine()` は複数フィールドをまたぐバリデーション（クロスフィールドバリデーション）に使う。
// 単一フィールドの `.min()` `.max()` では「他のフィールドの値と比較する」検証ができないため `.refine()` が必要。
//
// 条件式の読み方：
//   min_price が未入力          → 比較不要なので通過
//   max_price が未入力          → 比較不要なので通過
//   両方入力済み                 → min_price <= max_price でなければエラー
//
// `path: ['min_price']` はエラーを min_price フィールドに紐付ける設定。
// 指定しないとスキーマ全体のエラーになり、クライアントがどのフィールドの問題か判別できなくなる。

// Phase 3 で定義済みのスキーマはそのまま残す
export const createProductSchema = /* ... */;
export const updateProductSchema = /* ... */;
export const getMyProductsQuerySchema = /* ... */;
```

**既存スキーマの扱い：**

| スキーマ | 対応 | 理由 |
|---|---|---|
| `getProductsQuerySchema` | **削除** | `productController.list` で使用していたが、Phase 4 で `searchProductsQuerySchema` に置き換えるため不要になる。`list` の切り替え完了後に定義ごと削除する |
| `getProductParamsSchema` | **残す** | `show`・`update`・`archive` の3メソッドでパスパラメータ `id` の検証に使用中。Phase 4 では変更しない |
| `createProductSchema` | **残す** | `create` メソッドで使用中 |
| `updateProductSchema` | **残す** | `update` メソッドで使用中 |
| `getMyProductsQuerySchema` | **残す** | `myList` メソッドで使用中 |

---

### 3-2. repositories/ - 検索メソッド追加

**カーソルとは何か**

カーソルは「今どこまで取得したか」を示すしおり。次のリクエストでそのしおりを渡すと「しおりの続きから」取得できる。

id ベースの「1ページ目は id 1〜10、2ページ目は id 11〜20」はカーソルではなく OFFSET ページング（`LIMIT 10 OFFSET 10`）と同じ発想。MySQL は OFFSET 分の行をスキャンして捨てるため、ページが深くなるほど遅くなる。

カーソルページングは WHERE 句で「しおりより古いレコード」を直接絞り込むため、何ページ目でもスキャン行数が変わらない：

```
OFFSET方式:  LIMIT 10 OFFSET 10000  → 10010行スキャンして先頭10000行を捨てる
カーソル方式: WHERE created_at < ?   → インデックスで直接対象位置にアクセス
```

**カーソルの値は「ソート順を決めているカラム」で作る**

カーソルの中身は固定ではなく、「何で並び替えているか」によって変わる。

| ソート順 | カーソルに入れる値 |
|---|---|
| `ORDER BY created_at DESC`（新着順） | `created_at`（+ タイブレーカーの `id`） |
| `ORDER BY price ASC`（安い順） | `price`（+ タイブレーカーの `id`） |
| `ORDER BY id DESC` | `id`（id は一意なのでタイブレーカー不要） |

本実装は `sort=newest`（`ORDER BY created_at DESC`）の場合にのみカーソルページングを使うため、カーソルの値は `created_at` と `id` になる。「しおりの続き」= 「しおりの `created_at` より古いレコード」を WHERE 句で絞り込む仕組み。

**カーソルエンコード・デコードのユーティリティ**

`src/utils/cursor.ts` を作成：

```typescript
import { BadRequestError } from '../errors/AppError.js';

type NewestCursor = { created_at: string; id: number };

export function encodeCursor(createdAt: string, id: number): string {
  return Buffer.from(JSON.stringify({ created_at: createdAt, id })).toString('base64url');
}

export function decodeCursor(cursor: string): NewestCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8'));
    if (typeof parsed.created_at !== 'string' || typeof parsed.id !== 'number') {
      throw new BadRequestError('カーソルの形式が不正です');
    }
    return parsed as NewestCursor;
  } catch (e) {
    // JSON.parse の失敗など、BadRequestError 以外の例外もすべて 400 として返す
    if (e instanceof BadRequestError) throw e;
    throw new BadRequestError('カーソルの形式が不正です');
  }
}
```

`throw new Error(...)` は `AppError` を継承していないため errorHandler の 500 ハンドラーに落ちる。`BadRequestError`（`AppError` のサブクラス）を throw することで errorHandler が `statusCode: 400` を読み取り 400 レスポンスを返す。`AppError.ts` に `BadRequestError` を追加する必要がある（他のエラークラスと同じパターン）：

```typescript
export class BadRequestError extends AppError {
    constructor(message = 'Bad Request') {
        super(400, message);
    }
}
```

**なぜ `created_at` と `id` の2つでカーソルを作るか**：

`created_at` だけではページ境界を一意に決められない。シードスクリプトのようなバルク INSERT では複数レコードが同一の `created_at` を持つことがある。

```
// created_at が同じレコードが3件ある場合
id=100  created_at='2026-09-21 12:00:00'
id=101  created_at='2026-09-21 12:00:00'  ← ページ末尾
id=102  created_at='2026-09-21 12:00:00'
```

`created_at` のみをカーソルにして `WHERE created_at < '2026-09-21 12:00:00'` とすると、id=100・101・102 の3件すべてが除外され次ページに表示されない（抜け落ち）。

`id` をタイブレーカーとして加えることで同一 `created_at` の中でも位置を一意に特定できる：

```sql
WHERE (created_at < ? OR (created_at = ? AND id < ?))
-- created_at が小さい → 確実に前ページより古い
-- created_at が同じ   → id が小さいものだけを取得（境界レコードより古い側）
```

`id` は AUTO_INCREMENT で一意かつ挿入順と一致するため、`created_at` が同じ場合のソート順としてそのまま使える。

**カーソルを Base64URL でエンコードする理由**：クライアントが `?cursor=eyJ...` のようにクエリパラメータとして送る。`created_at` と `id` の生値を直接クエリパラメータに入れると、フォーマット変換やURLエンコードの問題が起きやすい。Base64URL（URLセーフな Base64）でラップすることで不透明（opaque）なトークンとして扱える。クライアントは中身を解釈せず、受け取った値をそのまま次のリクエストで送ればよい。

**`dateStrings: true` が必須な理由（タイムゾーンずれ）**：

mysql2 はデフォルトで DATETIME カラムを JavaScript の `Date` オブジェクトとして返す。`Date` オブジェクトを `JSON.stringify` すると ISO 8601 UTC 形式（`"2026-09-21T12:01:44.000Z"`）に変換される。

```
DBに保存された値（JST）:  2026-09-21 21:01:44
mysql2 が返す型:          Date オブジェクト
JSON.stringify(Date):     "2026-09-21T12:01:44.000Z"  ← UTCのISO文字列（9時間ずれ）
```

この文字列をカーソルの WHERE 句で使うと、MySQL はローカル時刻として解釈するため DBの値と9時間ずれる：

```sql
-- DB の値(21:01:44) と カーソルの値(12:01:44) が一致しない
WHERE (created_at < '2026-09-21T12:01:44.000Z'  -- 21:01:44 < 12:01:44 → FALSE
   OR (created_at = '2026-09-21T12:01:44.000Z'  -- 21:01:44 = 12:01:44 → FALSE
   AND id < N))
```

バルク INSERT されたシードデータは同一秒に大量挿入されるため全件が同じ `created_at` を持つ。上記の条件が全件 FALSE になると、2ページ目以降のシードデータが一切ヒットせず `next_cursor: null` が返り続ける。

`dateStrings: true` を設定すると、mysql2 が DATETIME を `Date` オブジェクトに変換せず MySQL のフォーマット（`"2026-09-21 21:01:44"`）のまま文字列で返す。カーソルにそのまま格納され、WHERE 句でも DB の値と正確に比較できる。

`src/db/connection.ts` に追加：

```typescript
export const pool = mysql.createPool({
  host:             process.env.DB_HOST!,
  user:             process.env.DB_USER!,
  password:         process.env.DB_PASSWORD!,
  database:         process.env.DB_NAME!,
  waitForConnections: true,
  connectionLimit:  10,
  dateStrings: true, // DATETIME を Date オブジェクトでなく文字列で返す（カーソルのタイムゾーンずれ防止）
});
```

`dateStrings: true` を設定すると `created_at` などの API レスポンス形式が ISO 8601（`"2026-09-21T12:01:44.000Z"`）から MySQL フォーマット（`"2026-09-21 21:01:44"`）に変わる。Flutter 側は `String` として保持しているため動作に影響はないが、フォーマットの変化として認識しておく。

`src/repositories/productRepository.ts` に `search` と `countSearch` を追加：

```typescript
import { pool } from '../db/connection.js';

// ─── 既存メソッドはそのまま ───────────────────────────────────

export const productRepository = {
  // (findAll, findById, findByIdRaw, findBySellerId, countBySellerId,
  //  create, updateById, archiveById, count は Phase 1〜3 のまま)

  // ─── Phase 4 で追加 ──────────────────────────────────────────

  async search(filters: {
    q?:          string | undefined;
    categoryId?: number | undefined;
    minPrice?:   number | undefined;
    maxPrice?:   number | undefined;
    sort:        'newest' | 'price_asc' | 'price_desc';
    limit:       number;
    offset:      number;
    // カーソルページング用（sort=newest 時のみ有効）
    cursor?: { created_at: string; id: number } | undefined;
  }) {
    // ① WHERE 句の条件を動的に組み立てる
    // conditions は SQL の WHERE 条件を文字列で積み上げる配列。
    // values はプレースホルダー（?）に対応する値を同じ順番で積み上げる配列。
    // 最終的に conditions.join(' AND ') で "status = 'published' AND category_id = ?" のような文字列になる。
    const conditions: string[] = ["status = 'published'"];
    const values: unknown[] = [];

    // フィルターが渡された場合のみ条件を追加する（渡されなければ条件なし = 全件対象）
    if (filters.q) {
      conditions.push('name LIKE ?');
      values.push(`%${filters.q}%`); // 前後ワイルドカードは全文検索できないがシンプル
    }
    if (filters.categoryId !== undefined) {
      conditions.push('category_id = ?');
      values.push(filters.categoryId);
    }
    if (filters.minPrice !== undefined) {
      conditions.push('price >= ?');
      values.push(filters.minPrice);
    }
    if (filters.maxPrice !== undefined) {
      conditions.push('price <= ?');
      values.push(filters.maxPrice);
    }

    // ② カーソルページング条件（sort=newest 時のみ使用）
    // カーソルが存在する場合、「しおりより古いレコード」に絞る WHERE 条件を追加する。
    const useCursor = filters.cursor && filters.sort === 'newest';
    // useCursor が truthy なら実行時は filters.cursor も必ず存在するが、
    // TypeScript は useCursor から filters.cursor の存在を推論できないため
    // `&& filters.cursor` を追加して型ガードとして機能させている。
    // これにより filters.cursor.created_at / .id へのアクセスで型エラーが出なくなる。
    if (useCursor && filters.cursor) {
      // created_at で同じレコードが複数ある場合に id でタイブレーク
      conditions.push('(created_at < ? OR (created_at = ? AND id < ?))');
      values.push(filters.cursor.created_at, filters.cursor.created_at, filters.cursor.id);
    }

    // ③ ソート順を決める
    // sort パラメータに対応する ORDER BY 句を map で引く。
    // id を常に末尾に加えることで created_at / price が同値のレコードの順序も一意になる。
    const orderMap: Record<string, string> = {
      newest:     'created_at DESC, id DESC',
      price_asc:  'price ASC, id ASC',
      price_desc: 'price DESC, id DESC',
    };
    const order = orderMap[filters.sort];

    // ④ WHERE 句を文字列に結合する
    // conditions が ['status = \'published\'', 'category_id = ?'] なら
    // where = "status = 'published' AND category_id = ?" になる。
    const where = conditions.join(' AND ');

    // ⑤ limit + 1 件取得して「次ページの有無」を判定する
    // COUNT クエリを追加発行せずに次ページ有無を判断するテクニック。
    // 例: limit=20 → 21件取得を試みる。
    //   21件取得できた → 次ページあり（21件目は捨てて20件だけ返す）
    //   20件以下しか取得できなかった → 最終ページ
    // カーソルページング時は WHERE で位置を絞っているため OFFSET は不要（0固定）。
    const fetchLimit = filters.limit + 1;
    const offset     = useCursor ? 0 : filters.offset;

    // ⑥ SQL を実行する
    // WHERE・ORDER BY・LIMIT・OFFSET をすべて動的に組み立てた上で pool.query に渡す。
    // プレースホルダー（?）の値は [...values, fetchLimit, offset] の順番で対応する。
    const [rows] = await pool.query(
      `SELECT id, seller_id, category_id, name, price, stock, status, created_at
       FROM products
       WHERE ${where}
       ORDER BY ${order}
       LIMIT ? OFFSET ?`,
      [...values, fetchLimit, offset]
    ) as any[];

    return rows as any[];
  },

  async countSearch(filters: {
    q?:          string | undefined;
    categoryId?: number | undefined;
    minPrice?:   number | undefined;
    maxPrice?:   number | undefined;
  }) {
    const conditions: string[] = ["status = 'published'"];
    const values: unknown[] = [];

    if (filters.q)               { conditions.push('name LIKE ?');     values.push(`%${filters.q}%`); }
    if (filters.categoryId)      { conditions.push('category_id = ?'); values.push(filters.categoryId); }
    if (filters.minPrice !== undefined) { conditions.push('price >= ?'); values.push(filters.minPrice); }
    if (filters.maxPrice !== undefined) { conditions.push('price <= ?'); values.push(filters.maxPrice); }

    const [rows] = await pool.query(
      `SELECT COUNT(*) as total FROM products WHERE ${conditions.join(' AND ')}`,
      values
    ) as any[];
    return rows[0].total as number;
  },
};
```

**`limit + 1` 取得によるページ末端検出**：

```
limit = 20 で limit+1 = 21 件取得した場合：
  取得結果が 21 件 → 次ページあり → 21件目を切り捨てて 20 件を返し next_cursor を生成
  取得結果が 20 件以下 → 最終ページ → そのまま返して next_cursor = null
```

COUNT クエリを追加実行せずに「次ページの有無」を判定できる。

**OFFSET が深くなるほど遅い理由**：
```
OFFSET 10000 で LIMIT 20 → MySQL は 10020 行スキャン後に先頭 10000 行を捨て残り 20 行を返す
OFFSET 50000 で LIMIT 20 → MySQL は 50020 行スキャン後に先頭 50000 行を捨てる
```
カーソルページングは `WHERE created_at < ?` で対象行を絞るため、何ページ目でもスキャン行数が変わらない。

---

### 3-3. services/ - searchProducts 追加

`src/services/productService.ts` を更新：

```typescript
import { encodeCursor, decodeCursor } from '../utils/cursor.js';
import { productRepository } from '../repositories/productRepository.js';
import { productImageRepository } from '../repositories/productImageRepository.js';
import { NotFoundError, ForbiddenError } from '../errors/AppError.js';

export const productService = {
  // ─── Phase 1〜3 から引き続き ─────────────────────────────────
  // (getProductById, createProduct, getMyProducts, updateProduct, archiveProduct)

  // ─── Phase 4: getProducts を searchProducts に置き換え ───────

  async searchProducts(input: {
    q?:          string;
    categoryId?: number;
    minPrice?:   number;
    maxPrice?:   number;
    sort:        'newest' | 'price_asc' | 'price_desc';
    limit:       number;
    offset:      number;
    cursor?:     string; // Base64URL エンコード済みカーソル
  }) {
    const useCursor = input.sort === 'newest';

    let decodedCursor: { created_at: string; id: number } | undefined;
    if (useCursor && input.cursor) {
      decodedCursor = decodeCursor(input.cursor); // 不正なら BadRequestError → errorHandler が 400 を返す
    }

    const filters = {
      q:          input.q,
      categoryId: input.categoryId,
      minPrice:   input.minPrice,
      maxPrice:   input.maxPrice,
      sort:       input.sort,
      limit:      input.limit,
      offset:     input.offset,
      cursor:     decodedCursor,
    };

    const rows = await productRepository.search(filters);
    const hasNextPage = rows.length > input.limit;
    const data        = hasNextPage ? rows.slice(0, input.limit) : rows;

    if (useCursor) {
      // カーソルページング：total は返さず next_cursor を返す
      const lastItem   = data[data.length - 1];
      const nextCursor = hasNextPage && lastItem
        ? encodeCursor(lastItem.created_at, lastItem.id)
        : null;
      return { data, total: null, next_cursor: nextCursor };
    } else {
      // OFFSET ページング：total を COUNT クエリで取得して返す
      const total = await productRepository.countSearch({
        q:          input.q,
        categoryId: input.categoryId,
        minPrice:   input.minPrice,
        maxPrice:   input.maxPrice,
      });
      return { data, total, next_cursor: null };
    }
  },
};
```

---

### 3-4. controllers/ - list 更新

`src/controllers/productController.ts` の `list` メソッドを更新：

```typescript
import { searchProductsQuerySchema } from '../schemas/productSchema.js';

export const productController = {
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const query = searchProductsQuerySchema.parse(req.query);
      const result = await productService.searchProducts({
        q:          query.q,
        categoryId: query.category_id,
        minPrice:   query.min_price,
        maxPrice:   query.max_price,
        sort:       query.sort,
        limit:      query.limit,
        offset:     query.offset,
        cursor:     query.cursor,
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  },

  // 他のメソッド（show, create, myList, update, archive）は Phase 3 のまま
};
```

---

### 3-5. middlewares/ - errorHandler 修正

バリデーションエラー確認（`min_price > max_price`）で `{"error":"min_price は max_price 以下にしてください"}` が返るべきところ、`{"error":"バリデーションエラー"}` が返る問題。

**原因：Zod v4 で `ZodError.errors` が廃止された**

Zod v3 では `ZodError.errors` は `ZodError.issues` の getter エイリアスだった。Zod v4 でこの getter が廃止され、`err.errors` が `undefined` になる。

| プロパティ | Zod v3 | Zod v4 |
|---|---|---|
| `issues` | あり（primary） | あり（primary） |
| `errors` | あり（`issues` の getter エイリアス） | 廃止 → `undefined` |

`err.errors[0]` で `TypeError: Cannot read properties of undefined (reading '0')` が発生するのはこのため。

**修正：`err.errors` → `err.issues` に変更**

`src/middlewares/errorHandler.ts` を更新：

```typescript
if (err instanceof ZodError) {
    const message = err.issues[0]?.message ?? 'バリデーションエラー';
    return res.status(400).json({ error: message });
}
```

`err.issues[0]?.message` で最初のバリデーションエラーメッセージを取り出す。`.refine()` で設定したメッセージ（`'min_price は max_price 以下にしてください'`）がそのまま返るようになる。

---

### 3-6. 動作確認

```bash
# 基本（フィルタなし）
curl http://localhost:3000/api/v1/products
# → {"data":[...],"total":60012,"next_cursor":null}

# キーワード検索
curl "http://localhost:3000/api/v1/products?q=iPhone"
# → name に 'iPhone' を含む商品のみ

# カテゴリ絞り込み
curl "http://localhost:3000/api/v1/products?category_id=1"

# 価格帯絞り込み
curl "http://localhost:3000/api/v1/products?min_price=1000&max_price=10000"

# 複合絞り込み
curl "http://localhost:3000/api/v1/products?category_id=2&sort=price_asc&min_price=5000"

# OFFSET ページング（price 昇順 2 ページ目）
curl "http://localhost:3000/api/v1/products?sort=price_asc&limit=20&offset=20"

# カーソルページング（1 ページ目）
curl "http://localhost:3000/api/v1/products?sort=newest&limit=20"
# → {"data":[...],"total":null,"next_cursor":"eyJjcmVhdGVkX2..."}

# カーソルページング（2 ページ目）
curl "http://localhost:3000/api/v1/products?sort=newest&limit=20&cursor=eyJjcmVhdGVkX2..."
# → {"data":[...],"total":null,"next_cursor":"eyJjcmVhdGVkX2..."}  または  "next_cursor":null（最終ページ）

# バリデーションエラー確認
curl "http://localhost:3000/api/v1/products?min_price=5000&max_price=1000"
# → {"error":"min_price は max_price 以下にしてください"}

curl "http://localhost:3000/api/v1/products?sort=invalid"
# → {"error":"Invalid option: expected one of \"newest\"|\"price_asc\"|\"price_desc\""}
```

#### Postman での確認

**事前準備**

カーソルページングの確認でレスポンスの `next_cursor` を次のリクエストに渡す必要があるため、環境変数 `nextCursor` を追加しておく。

1. 右上のドロップダウンで「market-api」環境を選択
2. ENVIRONMENTS タブを開き、変数 `nextCursor` を追加（Initial value・Current value は空でよい）
3. 「Save」

なお、`GET /products` は認証不要のため Authorization 設定は不要。

**基本（フィルタなし）（GET /api/v1/products）**

1. Method: `GET`、URL: `http://localhost:3000/api/v1/products`
2. Send → 200 と `{"data":[...],"total":N,"next_cursor":null}` が返ること確認

**キーワード検索（GET /api/v1/products?q=iPhone）**

1. Method: `GET`、URL: `http://localhost:3000/api/v1/products`
2. Params タブ → 以下を追加：

   | KEY | VALUE |
   |-----|-------|
   | q   | iPhone |

3. Send → `data` の全件が `name` に「iPhone」を含むこと確認

**カテゴリ絞り込み（GET /api/v1/products?category_id=1）**

1. Method: `GET`、URL: `http://localhost:3000/api/v1/products`
2. Params タブ → 以下を追加：

   | KEY         | VALUE |
   |-------------|-------|
   | category_id | 1     |

3. Send → `data` の全件の `category_id` が `1` であること確認

**価格帯絞り込み（GET /api/v1/products?min_price=1000&max_price=10000）**

1. Method: `GET`、URL: `http://localhost:3000/api/v1/products`
2. Params タブ → 以下を追加：

   | KEY       | VALUE |
   |-----------|-------|
   | min_price | 1000  |
   | max_price | 10000 |

3. Send → `data` の全件の `price` が 1000 以上 10000 以下であること確認

**複合絞り込み + ソート（GET /api/v1/products?category_id=2&sort=price_asc&min_price=5000）**

1. Method: `GET`、URL: `http://localhost:3000/api/v1/products`
2. Params タブ → 以下を追加：

   | KEY         | VALUE     |
   |-------------|-----------|
   | category_id | 2         |
   | sort        | price_asc |
   | min_price   | 5000      |

3. Send → `data` が `category_id=2`・`price >= 5000` のみで価格昇順に並ぶこと確認

**OFFSET ページング（price 昇順 2 ページ目）**

1. Method: `GET`、URL: `http://localhost:3000/api/v1/products`
2. Params タブ → 以下を追加：

   | KEY    | VALUE     |
   |--------|-----------|
   | sort   | price_asc |
   | limit  | 20        |
   | offset | 20        |

3. Send → `data` が price 昇順の 21〜40 件目であること確認（1 ページ目の末尾 `price` より高いこと）

**カーソルページング 1 ページ目（GET /api/v1/products?sort=newest&limit=20）**

1. Method: `GET`、URL: `http://localhost:3000/api/v1/products`
2. Params タブ → 以下を追加：

   | KEY   | VALUE  |
   |-------|--------|
   | sort  | newest |
   | limit | 20     |

3. Scripts タブ → **After response** に以下を入力（レスポンスの `next_cursor` を環境変数に自動保存）：
   ```javascript
   const json = pm.response.json();
   pm.environment.set("nextCursor", json.next_cursor ?? "");
   ```
4. Send → 200 と `{"data":[...],"total":null,"next_cursor":"eyJ..."}` が返ること確認（`next_cursor` が Base64URL 文字列であること）

**カーソルページング 2 ページ目**

1. Method: `GET`、URL: `http://localhost:3000/api/v1/products`
2. Params タブ → 以下を追加：

   | KEY    | VALUE          |
   |--------|----------------|
   | sort   | newest         |
   | limit  | 20             |
   | cursor | `{{nextCursor}}` |

3. Send → 1 ページ目と重複なく続きの 20 件が返ること確認
4. `next_cursor` が `null` になるまで同手順を繰り返すことで最終ページに達すること確認

**バリデーションエラー確認（400）**

min_price > max_price の場合：

1. Method: `GET`、URL: `http://localhost:3000/api/v1/products`
2. Params タブ → 以下を追加：

   | KEY       | VALUE |
   |-----------|-------|
   | min_price | 5000  |
   | max_price | 1000  |

3. Send → 400 と `{"error":"min_price は max_price 以下にしてください"}` が返ること確認

sort に無効値を渡した場合：

1. Params の `min_price`・`max_price` を削除し、代わりに以下を追加：

   | KEY  | VALUE   |
   |------|---------|
   | sort | invalid |

2. Send → 400 と `{"error":"Invalid option: expected one of \"newest\"|\"price_asc\"|\"price_desc\""}` が返ること確認

---

## 4. 計測・記録

### 4-1. OFFSET vs カーソルの実行時間比較

**計測方法**：

```bash
# OFFSET ページング（先頭付近）
time mysql market -e "
SELECT id, seller_id, category_id, name, price, stock, status, created_at
FROM products
WHERE status = 'published'
ORDER BY created_at DESC
LIMIT 20 OFFSET 0;
"

# OFFSET ページング（深い位置：500 ページ目）
time mysql market -e "
SELECT id, seller_id, category_id, name, price, stock, status, created_at
FROM products
WHERE status = 'published'
ORDER BY created_at DESC
LIMIT 20 OFFSET 10000;
"

# カーソルページング（OFFSET 10000 相当の位置）
# ← cursor 値は下記「OFFSET 10000 の末尾レコード取得」で確認した値を使う
time mysql market -e "
SELECT id, seller_id, category_id, name, price, stock, status, created_at
FROM products
WHERE status = 'published'
  AND (created_at < '2026-09-10 21:47:06' OR (created_at = '2026-09-10 21:47:06' AND id < 283250))
ORDER BY created_at DESC
LIMIT 20;
"
```

**EXPLAIN で確認：**

```bash
# OFFSET 10000 の計画
mysql market -e "
EXPLAIN FORMAT=TRADITIONAL
SELECT id, seller_id, category_id, name, price, stock, status, created_at
FROM products WHERE status = 'published'
ORDER BY created_at DESC LIMIT 20 OFFSET 10000;
"

# カーソル方式の計画
mysql market -e "
EXPLAIN FORMAT=TRADITIONAL
SELECT id, seller_id, category_id, name, price, stock, status, created_at
FROM products WHERE status = 'published'
  AND (created_at < '2026-09-10 21:47:06' OR (created_at = '2026-09-10 21:47:06' AND id < 283250))
ORDER BY created_at DESC LIMIT 20;
"
```

**OFFSET 10000 の結果：**

| id | select_type | table    | partitions | type | possible_keys                        | key                                  | key_len | ref   | rows  | filtered | Extra          |
|----|-------------|----------|------------|------|--------------------------------------|--------------------------------------|---------|-------|-------|----------|----------------|
| 1  | SIMPLE      | products | NULL       | ref  | idx_products_status_category_created | idx_products_status_category_created | 1       | const | 49535 | 100.00   | Using filesort |

**カーソル方式の結果：**

| id | select_type | table    | partitions | type | possible_keys                                | key                                  | key_len | ref   | rows  | filtered | Extra                                 |
|----|-------------|----------|------------|------|----------------------------------------------|--------------------------------------|---------|-------|-------|----------|---------------------------------------|
| 1  | SIMPLE      | products | NULL       | ref  | PRIMARY,idx_products_status_category_created | idx_products_status_category_created | 1       | const | 49535 | 35.55    | Using index condition; Using filesort |

| 項目 | OFFSET 10000 | カーソル方式 |
|------|-------------|------------|
| `key` | `idx_products_status_category_created` | `idx_products_status_category_created` |
| `key_len` | `1`（status の 1 バイトのみ） | `1`（同左） |
| `rows` | `49535` | `49535` |
| `filtered` | `100.00` | `35.55`（カーソル条件でさらに絞り込み） |
| `Extra` | `Using filesort` | `Using index condition; Using filesort` |

**`key_len: 1` の理由**：このクエリは `WHERE status = 'published'` のみ（`category_id` なし）。複合インデックス `(status, category_id, created_at)` は先頭の `status`（1 バイト ENUM）しか使えない。

**両クエリとも `Using filesort` が残る理由**：`category_id` が WHERE にないため、最左前置の原則でインデックスの 2 番目カラム `category_id` を飛ばして `created_at` を ORDER BY に使えない。`ORDER BY created_at DESC` はメモリソートになる。`Using filesort` を消せるのはクエリ①（`WHERE status = ? AND category_id = ?` の両方が揃うケース）のみ。

**カーソルの `Using index condition` について**：OR 条件 `(created_at < ? OR (created_at = ? AND id < ?))` を ICP（Index Condition Pushdown）でストレージエンジン側に push して処理。`filtered: 35.55` はこの条件で約 64% の行を除外していることを示す。

**OFFSET の遅さが EXPLAIN に現れにくい理由**：OFFSET 10000 で「何行スキャンするか」は `rows` に出るが、「スキャン後に何行捨てるか」は EXPLAIN では見えない。実行時は OFFSET 分の行をフェッチして捨てる処理が発生するため、ページが深くなるほど実行時間が線形に増加する。

---

カーソル方式のクエリは OFFSET 10000 の末尾レコードを事前に取得してカーソル値に使う：

```bash
# OFFSET 10000 の末尾レコードを取得してカーソル値を確認
mysql market -e "
SELECT id, created_at FROM products
WHERE status = 'published'
ORDER BY created_at DESC, id DESC
LIMIT 1 OFFSET 10000;
"
# → id=283250, created_at='2026-09-10 21:47:06'
```

結果を `docs/explain/offset-vs-cursor.md` に保存：

```markdown
# OFFSET vs カーソルページング 比較

データ: 行ごとに 1 分ずつ created_at をずらした 10 万件（100,000 種の一意なタイムスタンプ）
カーソル値: created_at='2026-09-10 21:47:06', id=283250（OFFSET 10000 の末尾レコード）

## OFFSET 0（先頭）
実行時間: ~87ms

## OFFSET 10000（500 ページ目相当）
実行時間: ~85ms

## カーソル方式（OFFSET 10000 相当の位置）
実行時間: ~76ms

カーソル結果の先頭が id=283249（OFFSET 10000 末尾 id=283250 の直後）→ データ連続性が正しく機能

---

## 考察

カーソル（~76ms）は OFFSET 10000（~85ms）より約 9ms 速い。

OFFSET 0 と OFFSET 10000 の差がほぼないのは、mysql コマンド自体の
起動・接続オーバーヘッド（推定 ~65ms）が全体の大半を占めているため。
オーバーヘッドを除くと差が明確になる：

| クエリ         | 合計   | 推定クエリ時間 |
|----------------|--------|----------------|
| OFFSET 0       | ~87ms  | ~22ms          |
| OFFSET 10000   | ~85ms  | ~20ms          |
| カーソル       | ~76ms  | ~11ms          |

カーソルのクエリ時間は OFFSET 10000 の約半分。
WHERE created_at < ? でインデックスが目的位置に直接シークするため、
ページが深くなるほど OFFSET との差は大きくなる。
API 経由（接続確立済み）の実計測ではこのオーバーヘッドがないため
差がより顕著に現れる。

今回のデータは created_at が全 100,000 行で一意（実運用データに近い分布）のため、
カーソルページングの効果を正しく計測できる状態での結果となっている。
```

---

### 4-2. description 有無のレスポンスサイズ比較

**計測方法：**

```bash
# description を含む場合のサイズ（現在の実装）
curl -so /dev/null -w "%{size_download} bytes\n" \
  "http://localhost:3000/api/v1/products?limit=20"

# 一時的に description なし版のエンドポイントを作って比較（確認用）
mysql market -e "
SELECT id, seller_id, category_id, name, price, stock, status, created_at
FROM products WHERE status='published' LIMIT 20;
" | wc -c

mysql market -e "
SELECT id, seller_id, category_id, name, description, price, stock, status, created_at
FROM products WHERE status='published' LIMIT 20;
" | wc -c
```

**計測結果：**

| 計測方法 | 値 |
|----------|-----|
| curl API（JSON、description なし・現行実装） | **3,228 bytes** |
| mysql CLI description なし | 1,429 bytes |
| mysql CLI description あり | 3,083 bytes |

mysql CLI での差：3,083 − 1,429 = **+1,654 bytes**（約 2.16 倍）。シードデータの description は "N 番目の商品説明文。開発・計測用のサンプルデータです。"（約 24 文字）と短いため差が小さい。実運用の数百〜数千文字の説明文では差がさらに大きくなる。

**EXPLAIN でのコスト差：**

```bash
# description を含む場合（TEXT 列あり → 行全体を読む）
mysql market -e "
EXPLAIN FORMAT=TRADITIONAL
SELECT id, seller_id, category_id, name, description, price, stock, status, created_at
FROM products WHERE status='published' AND category_id=1 LIMIT 20;
"

# description を除く場合（インデックスのみで解決できる列がある）
mysql market -e "
EXPLAIN FORMAT=TRADITIONAL
SELECT id, seller_id, category_id, name, price, stock, status, created_at
FROM products WHERE status='published' AND category_id=1 LIMIT 20;
"
```

**計測結果の見方：**

| 観点 | description あり | description なし |
|------|-----------------|-----------------|
| レスポンスサイズ | mysql 出力 3,083 bytes（シードデータ短文のため小さい。実運用の長文ではさらに大きい） | API JSON **3,228 bytes**（実測）・mysql 出力 1,429 bytes |
| Extra | `Using index condition` | `Using index condition` |
| 実行時間 | ほぼ同等（インデックス効いているため） | ほぼ同等 |

TEXT 列の有無で EXPLAIN 上の `rows` は変わらないが、ネットワーク転送量に大きな差が出る。20 件 × 説明文 200 バイトで約 4KB の節約は一見小さいが、同時接続 100 の場合は 400KB → 100 リクエスト毎に体感できる差になる。

**判断**：`description` を一覧の SELECT から除外し、`ProductSummary` スキーマを一覧に適用する（すでに OpenAPI 定義済み）。詳細 API（`GET /products/{id}`）には引き続き `description` を含める。

`productRepository.search` の SELECT が `description` を含まないことを確認：

```typescript
// ✅ Phase 4 で追加した search メソッドは description を含まない
`SELECT id, seller_id, category_id, name, price, stock, status, created_at FROM products ...`

// ✅ findById（詳細）は description を含む
`SELECT id, seller_id, category_id, name, description, price, stock, status, created_at, updated_at FROM products ...`
```

---

### 4-3. FULLTEXT vs LIKE 比較

**LIKE の問題点**：

```sql
-- % で始まる LIKE は B-tree インデックスを使えない（前方一致でないため）
WHERE name LIKE '%iPhone%'
-- → type: ALL, key: NULL（フルスキャン）
```

**FULLTEXT インデックスの追加：**

`migrations/007_add_fulltext_index.sql` を作成：

```sql
ALTER TABLE products ADD FULLTEXT INDEX ft_products_name (name);
```

実行：

```bash
mysql market < migrations/007_add_fulltext_index.sql
```

**FULLTEXT 検索クエリ：**

```bash
mysql market -e "
EXPLAIN FORMAT=TRADITIONAL
SELECT id, seller_id, category_id, name, price, stock, status, created_at
FROM products
WHERE status = 'published'
  AND MATCH(name) AGAINST('テスト' IN BOOLEAN MODE)
ORDER BY created_at DESC
LIMIT 20;
"
```

| 方式 | type | key | rows | Extra |
|------|------|-----|------|-------|
| `LIKE '%テスト%'` | ALL | NULL | 100020 | Using where |
| `MATCH AGAINST` | fulltext | ft_products_name | 1 | Using where; Ft_hints: sorted |

**FULLTEXT の制約（MySQL InnoDB の場合）：**

| 制約 | 内容 |
|------|------|
| 最小ワード長 | デフォルト 3 文字以上（`ft_min_word_len`）。2 文字以下は検索不可 |
| 日本語 | デフォルトパーサーは英単語区切りのため日本語は不向き。ngram パーサーが必要 |
| ngram パーサー | 文字列を n 文字（デフォルト 2 文字）単位のトークンに分割。日本語で有効 |

**ngram パーサーでの FULLTEXT 追加（日本語対応）：**

```sql
-- デフォルトの FULLTEXT インデックスを削除
ALTER TABLE products DROP INDEX ft_products_name;

-- ngram パーサーで再作成（2 文字以上の日本語キーワードに対応）
ALTER TABLE products ADD FULLTEXT INDEX ft_products_name (name) WITH PARSER ngram;
```

**ngram での検索：**

```sql
MATCH(name) AGAINST('iPhone' IN BOOLEAN MODE)
-- ngram は 'iPh', 'Pho', 'hon', 'one' のように 2 文字ずつトークン化して検索
```

**実装への採用判断**：Phase 4 では LIKE と FULLTEXT の性能差を確認することが目的。本番用途では ngram FULLTEXT 検索の採用を推奨するが、Phase 4 のメインの API 実装は LIKE のままとし、FULLTEXT は計測・比較のみ行う。実際に切り替える場合は repository の `search` メソッドの WHERE 句を変更するだけ。

結果を保存：

```bash
# LIKE の EXPLAIN
mysql market -e "EXPLAIN FORMAT=TRADITIONAL SELECT ... WHERE name LIKE '%テスト%' ..." \
  > docs/explain/like-vs-fulltext.md
```

---

## 5. Flutter連携

### 5-1. 検索バー・絞り込みUI

`lib/features/product/data/product_search_params.dart` を作成：

```dart
class ProductSearchParams {
  final String? q;
  final int?    categoryId;
  final int?    minPrice;
  final int?    maxPrice;
  final String  sort;

  const ProductSearchParams({
    this.q,
    this.categoryId,
    this.minPrice,
    this.maxPrice,
    this.sort = 'newest',
  });

  Map<String, dynamic> toQueryParams({int limit = 20, int offset = 0, String? cursor}) => {
    if (q          != null)  'q':           q,
    if (categoryId != null)  'category_id': categoryId,
    if (minPrice   != null)  'min_price':   minPrice,
    if (maxPrice   != null)  'max_price':   maxPrice,
    'sort':  sort,
    'limit': limit,
    if (cursor != null) 'cursor': cursor else 'offset': offset,
  };
}
```

`lib/features/product/data/product_repository.dart` を更新：

```dart
Future<Map<String, dynamic>> searchProducts(
  ProductSearchParams params, {
  int    limit  = 20,
  int    offset = 0,
  String? cursor,
}) async {
  final response = await dio.get('/products', queryParameters:
    params.toQueryParams(limit: limit, offset: offset, cursor: cursor));
  return response.data as Map<String, dynamic>;
}
```

`lib/features/product/ui/product_search_screen.dart` を作成：

```dart
import 'package:flutter/material.dart';
import '../data/product.dart';
import '../data/product_repository.dart';
import '../data/product_search_params.dart';

class ProductSearchScreen extends StatefulWidget {
  const ProductSearchScreen({super.key});
  @override
  State<ProductSearchScreen> createState() => _ProductSearchScreenState();
}

class _ProductSearchScreenState extends State<ProductSearchScreen> {
  final _repo           = ProductRepository();
  final _searchCtrl     = TextEditingController();
  final _minPriceCtrl   = TextEditingController();
  final _maxPriceCtrl   = TextEditingController();

  List<Product> _products    = [];
  bool          _isLoading   = false;
  String?       _error;
  int?          _selectedCategory;
  String        _sort         = 'newest';

  Future<void> _search() async {
    setState(() { _isLoading = true; _error = null; });
    try {
      final params = ProductSearchParams(
        q:          _searchCtrl.text.isEmpty ? null : _searchCtrl.text,
        categoryId: _selectedCategory,
        minPrice:   int.tryParse(_minPriceCtrl.text),
        maxPrice:   int.tryParse(_maxPriceCtrl.text),
        sort:       _sort,
      );
      final result = await _repo.searchProducts(params, limit: 20, offset: 0);
      final List data = result['data'];
      setState(() {
        _products  = data.map((e) => Product.fromJson(e)).toList();
        _isLoading = false;
      });
    } catch (e) {
      setState(() { _error = '検索に失敗しました'; _isLoading = false; });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('商品を探す')),
      body: Column(
        children: [
          // 検索フォーム
          Padding(
            padding: const EdgeInsets.all(8),
            child: Column(
              children: [
                TextField(
                  controller: _searchCtrl,
                  decoration: const InputDecoration(
                    hintText: 'キーワードを入力',
                    prefixIcon: Icon(Icons.search),
                    border: OutlineInputBorder(),
                  ),
                  onSubmitted: (_) => _search(),
                ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _minPriceCtrl,
                        keyboardType: TextInputType.number,
                        decoration: const InputDecoration(
                          labelText: '最低価格',
                          border: OutlineInputBorder(),
                        ),
                      ),
                    ),
                    const Padding(
                      padding: EdgeInsets.symmetric(horizontal: 8),
                      child: Text('〜'),
                    ),
                    Expanded(
                      child: TextField(
                        controller: _maxPriceCtrl,
                        keyboardType: TextInputType.number,
                        decoration: const InputDecoration(
                          labelText: '最高価格',
                          border: OutlineInputBorder(),
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    const Text('並び順：'),
                    const SizedBox(width: 8),
                    DropdownButton<String>(
                      value: _sort,
                      items: const [
                        DropdownMenuItem(value: 'newest',     child: Text('新着順')),
                        DropdownMenuItem(value: 'price_asc',  child: Text('価格が安い順')),
                        DropdownMenuItem(value: 'price_desc', child: Text('価格が高い順')),
                      ],
                      onChanged: (v) => setState(() { _sort = v!; }),
                    ),
                    const Spacer(),
                    ElevatedButton(
                      onPressed: _search,
                      child: const Text('検索'),
                    ),
                  ],
                ),
              ],
            ),
          ),
          // 結果一覧
          Expanded(
            child: _isLoading
              ? const Center(child: CircularProgressIndicator())
              : _error != null
                ? Center(child: Text(_error!))
                : ListView.builder(
                    itemCount: _products.length,
                    itemBuilder: (context, index) {
                      final p = _products[index];
                      return ListTile(
                        title:    Text(p.name),
                        subtitle: Text('¥${p.price}'),
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}
```

---

### 5-2. 無限スクロール（カーソルページング）

`lib/features/product/ui/product_list_screen.dart` を更新：

```dart
import 'package:flutter/material.dart';
import '../data/product.dart';
import '../data/product_repository.dart';
import '../data/product_search_params.dart';

class ProductListScreen extends StatefulWidget {
  const ProductListScreen({super.key});
  @override
  State<ProductListScreen> createState() => _ProductListScreenState();
}

class _ProductListScreenState extends State<ProductListScreen> {
  final _repo        = ProductRepository();
  final _scrollCtrl  = ScrollController();

  List<Product> _products     = [];
  bool          _isLoading    = false;
  bool          _hasMore      = true;
  String?       _nextCursor;
  String?       _error;

  static const _limit = 20;

  @override
  void initState() {
    super.initState();
    _loadFirst();
    _scrollCtrl.addListener(_onScroll);
  }

  @override
  void dispose() {
    _scrollCtrl.dispose();
    super.dispose();
  }

  void _onScroll() {
    // スクロールが末尾 200px 以内に来たら次ページ取得
    if (_scrollCtrl.position.pixels >= _scrollCtrl.position.maxScrollExtent - 200) {
      _loadMore();
    }
  }

  Future<void> _loadFirst() async {
    setState(() { _isLoading = true; _products = []; _nextCursor = null; _hasMore = true; });
    await _fetch();
  }

  Future<void> _loadMore() async {
    if (_isLoading || !_hasMore) return;
    setState(() { _isLoading = true; });
    await _fetch();
  }

  Future<void> _fetch() async {
    try {
      final result = await _repo.searchProducts(
        const ProductSearchParams(sort: 'newest'),
        limit:  _limit,
        cursor: _nextCursor,
      );

      final List data  = result['data'];
      final products   = data.map((e) => Product.fromJson(e)).toList();
      final nextCursor = result['next_cursor'] as String?;

      setState(() {
        _products    = [..._products, ...products];
        _nextCursor  = nextCursor;
        _hasMore     = nextCursor != null;
        _isLoading   = false;
      });
    } catch (e) {
      setState(() { _error = 'データの取得に失敗しました'; _isLoading = false; });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null && _products.isEmpty) {
      return Center(child: Text(_error!));
    }

    return RefreshIndicator(
      onRefresh: _loadFirst,
      child: ListView.builder(
        controller:  _scrollCtrl,
        itemCount:   _products.length + (_hasMore ? 1 : 0),
        itemBuilder: (context, index) {
          if (index == _products.length) {
            // 末尾のローディングインジケーター
            return const Padding(
              padding: EdgeInsets.all(16),
              child:   Center(child: CircularProgressIndicator()),
            );
          }
          final p = _products[index];
          return ListTile(
            title:    Text(p.name),
            subtitle: Text('¥${p.price}'),
          );
        },
      ),
    );
  }
}
```

**無限スクロールの仕組み：**

```
初回: cursor なし → 最新 20 件 + next_cursor A を取得
スクロール末尾: cursor=A → 次の 20 件 + next_cursor B を取得
スクロール末尾: cursor=B → 次の 20 件 + next_cursor null → hasMore=false
```

- `RefreshIndicator` で Pull-to-Refresh（下に引いて最初から再取得）に対応
- `_hasMore` が false になると `_loadMore` が呼ばれても何もしない
- リスト末尾に `CircularProgressIndicator` を表示してロード中を示す

---

## 確認チェックリスト

Phase 4 完了の判断基準：

```
[ ] npx tsx seeds/seed_products_100k.ts で 10 万件のシードデータが投入される
[ ] インデックスなしの EXPLAIN で Table scan（type: ALL 相当）・rows: ~99071 を確認（category_id なしのクエリ②で確認。クエリ①は FK インデックスが使われるため Table scan にはならない）
[ ] migrations/006_add_product_indexes.sql 実行後、EXPLAIN で type が ref に変わることを確認
[ ] Using filesort が消えることを確認（ORDER BY created_at DESC が idx に一致）
[ ] GET /products?q=iPhone でキーワード絞り込みができる
[ ] GET /products?category_id=1 でカテゴリ絞り込みができる
[ ] GET /products?min_price=1000&max_price=10000 で価格帯絞り込みができる
[ ] GET /products?sort=price_asc で安い順に並ぶ
[ ] GET /products?sort=newest でカーソルページングが動作する
[ ] next_cursor を使った 2 ページ目取得ができる
[ ] 最終ページで next_cursor が null になる
[ ] GET /products?min_price=5000&max_price=1000 → 400 が返る
[ ] OFFSET vs カーソルの実行時間比較結果を docs/explain/ に保存
[ ] description 有無のレスポンスサイズ比較を実施・判断した
[ ] FULLTEXT と LIKE の EXPLAIN 結果を比較・保存
[ ] openapi.yaml の GET /products にクエリパラメータが追加されている
[ ] openapi.yaml に ProductSummary スキーマが定義されている
[ ] Flutter アプリで検索バーからキーワード検索ができる
[ ] Flutter アプリで価格帯・ソート切り替えができる
[ ] Flutter アプリで無限スクロールが動作する
[ ] Pull-to-Refresh で一覧が最初から読み込み直される
```

---

## この段階で理解すべきこと

| テーマ | 内容 |
|--------|------|
| 複合インデックスの左端前置の原則 | `(status, category_id, created_at)` は `WHERE status = ? AND category_id = ?` には使えるが、`WHERE category_id = ?`（status なし）には使えない。インデックスは左から順に使われる |
| インデックスで ORDER BY を解消する | ORDER BY カラムがインデックスの末尾にあれば `Using filesort` が不要になる。`(status, category_id, created_at)` の created_at が ORDER BY に対応するのがこのパターン |
| OFFSET ページングの計算量 | `LIMIT 20 OFFSET 10000` は 10020 行スキャンして先頭 10000 行を捨てる。ページが深くなるほど線形に遅くなる |
| カーソルページングの原理 | `WHERE created_at < ?` で直前ページの最後のアイテム以降を取得。何ページ目でもスキャン行数が変わらない。代わりに「総件数」「任意ページへのジャンプ」が取れない |
| LIKE '%keyword%' はインデックスを使えない | B-tree インデックスは前方一致（`'keyword%'`）にしか使えない。後方ワイルドカードが入ると全行スキャンになる |
| FULLTEXT の仕組みと ngram | 転置インデックスで全文検索。MySQL 標準パーサーは英単語向けなので日本語には ngram パーサーが必要 |
| TEXT 列と一覧 SELECT | TEXT 列を SELECT するとレコード全体をストレージから読む必要がある。一覧表示には不要なので除外することでネットワーク転送量を削減できる |
| limit + 1 で次ページ判定 | `COUNT(*)` クエリを追加発行せずに「次ページの有無」を判定するテクニック。+1 件多く取得し、その件数が limit を超えるか否かで判断する |
| Base64URL なカーソルトークン | クライアントには不透明なトークンとして渡す。中身の型・フォーマットを変えてもクライアントコードを変更不要。URLクエリパラメータとして安全に渡せる |

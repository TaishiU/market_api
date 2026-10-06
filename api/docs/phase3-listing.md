# Phase 3 - 出品機能 詳細作業ログ

## 概要

Phase 2 で構築した認証機能を使って、出品者が商品を登録・編集・停止できる出品機能を追加する。
認証済みユーザーが自分の商品を管理し、所有者チェックにより他人の商品を操作できないようにする。

- 商品の INSERT / UPDATE / 論理削除（status = 'archived'）
- `seller_id` と `req.user.id` の比較による所有者チェック
- 商品と画像の同時登録にトランザクションを使用
- enum的なステータス（draft / published / archived）管理

---

## 1. 新規パッケージ

Phase 3 では新規パッケージは不要。Phase 2 までのパッケージで実装できる。

---

## 2. DB（テーブル作成）

### 2-1. migrations/005_create_product_images.sql

```sql
CREATE TABLE product_images (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  product_id    INT UNSIGNED NOT NULL,
  url           VARCHAR(2083) NOT NULL,
  display_order INT UNSIGNED NOT NULL DEFAULT 0,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);
```

実行：

```bash
mysql market < migrations/005_create_product_images.sql
```

確認：

```bash
mysql market -e "SHOW TABLES;"
# → product_images が表示されれば成功

# 詳細確認
mysql market -e "DESCRIBE product_images;"
```

| カラム | 理由 |
|---|---|
| `url VARCHAR(2083)` | URLの最大長はRFC規格上2083文字。画像URLの格納に対応できる長さ |
| `display_order` | 複数画像の表示順を管理。0が先頭 |
| `ON DELETE CASCADE` | 商品が物理削除された場合に画像レコードも自動削除 |

**CASCADEとは**：親テーブル（products）のレコードが削除されたとき、子テーブル（product_images）の関連レコードをDBが自動で削除する設定。

```
products のレコード削除
    ↓ ON DELETE CASCADE が発火
product_images の product_id = そのid のレコードも自動削除

← アプリ側で DELETE FROM product_images WHERE product_id = ? を書かなくてよい
```

CASCADEを設定しないと、子レコードが残ったまま親だけ消そうとしたとき外部キー制約エラーになる（DBが整合性を守るため）。

**ON DELETE を省略した場合（RESTRICT）**：「子が残っているなら親は消させない」というDBの安全装置。

```sql
-- CASCADE あり → DBが自動で連鎖削除
DELETE FROM products WHERE id = 1;
-- product_images.product_id=1 も自動削除 → 成功

-- RESTRICT（省略時デフォルト） → 子が残っていると失敗
DELETE FROM products WHERE id = 1;
-- ERROR: Cannot delete or update a parent row: a foreign key constraint fails

-- RESTRICT の場合はアプリ側でこの順番が必須
DELETE FROM product_images WHERE product_id = 1; -- 先に子を消す
DELETE FROM products WHERE id = 1;               -- その後に親を消す
```

CASCADEはこの2ステップをDB側が自動でやってくれるイメージ。

> **注意**：Phase 3 では商品を論理削除（`status = 'archived'`）するため `ON DELETE CASCADE` が発火するケースはない。将来の物理削除に備えた設定。

---

### 2-2. シードデータ投入（商品画像）

Phase 1 で投入したシード商品に画像URLを追加する。

`seeds/product_images.sql` を作成：

```sql
INSERT INTO product_images (product_id, url, display_order) VALUES
(1,  'https://placehold.jp/400x400.png?text=iPhone14-1',     0),
(1,  'https://placehold.jp/400x400.png?text=iPhone14-2',     1),
(2,  'https://placehold.jp/400x400.png?text=iPadPro',        0),
(3,  'https://placehold.jp/400x400.png?text=GalaxyS23',      0),
(4,  'https://placehold.jp/400x400.png?text=AirPodsPro',     0),
(5,  'https://placehold.jp/400x400.png?text=AppleWatch',     0),
(6,  'https://placehold.jp/400x400.png?text=Kindle',         0),
(7,  'https://placehold.jp/400x400.png?text=Switch',         0),
(8,  'https://placehold.jp/400x400.png?text=MacBookAirM2-1', 0),
(8,  'https://placehold.jp/400x400.png?text=MacBookAirM2-2', 1),
(9,  'https://placehold.jp/400x400.png?text=Keyboard',       0),
(10, 'https://placehold.jp/400x400.png?text=DellMonitor',    0),
(11, 'https://placehold.jp/400x400.png?text=MXMaster3',      0),
(12, 'https://placehold.jp/400x400.png?text=USBHub',         0),
(13, 'https://placehold.jp/400x400.png?text=Webcam',         0),
(14, 'https://placehold.jp/400x400.png?text=Headset',        0),
(15, 'https://placehold.jp/400x400.png?text=Down',           0),
(16, 'https://placehold.jp/400x400.png?text=AirMax',         0),
(17, 'https://placehold.jp/400x400.png?text=Fleece',         0),
(18, 'https://placehold.jp/400x400.png?text=Levi501',        0),
(19, 'https://placehold.jp/400x400.png?text=Backpack',       0),
(20, 'https://placehold.jp/400x400.png?text=Parka',          0);
```

実行：

```bash
mysql market < seeds/product_images.sql
```

確認：

```bash
# レコード確認（22件）
mysql market -e "SELECT * FROM product_images;"

# 件数確認
mysql market -e "SELECT COUNT(*) FROM product_images;"
```

**プレースホルダー画像とは**：`placehold.jp` は開発用のダミー画像サービス。`/400x400.png?text=文字列` でサイズ・テキスト付きの画像URLを即時取得できる。実際のS3アップロードを実装しなくても画像の動作確認ができる。

---

## 3. OpenAPI（仕様更新）

### 3-1. 出品エンドポイント追加

`openapi.yaml` の `paths:` セクションに追記：

```yaml
  /products:
    post:
      summary: 商品出品
      security:
        - BearerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CreateProductRequest'
      responses:
        '201':
          description: 出品成功
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ProductDetail'
        '400':
          $ref: '#/components/responses/BadRequest'
        '401':
          $ref: '#/components/responses/Unauthorized'
        '500':
          $ref: '#/components/responses/InternalServerError'

  /products/{productId}:
    patch:
      summary: 商品編集
      security:
        - BearerAuth: []
      parameters:
        - name: productId
          in: path
          required: true
          schema:
            type: integer
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/UpdateProductRequest'
      responses:
        '200':
          description: 更新成功
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ProductDetail'
        '400':
          $ref: '#/components/responses/BadRequest'
        '401':
          $ref: '#/components/responses/Unauthorized'
        '403':
          $ref: '#/components/responses/Forbidden'
        '404':
          $ref: '#/components/responses/NotFound'
        '500':
          $ref: '#/components/responses/InternalServerError'
    delete:
      summary: 出品停止（論理削除）
      security:
        - BearerAuth: []
      parameters:
        - name: productId
          in: path
          required: true
          schema:
            type: integer
      responses:
        '204':
          description: 出品停止成功
        '401':
          $ref: '#/components/responses/Unauthorized'
        '403':
          $ref: '#/components/responses/Forbidden'
        '404':
          $ref: '#/components/responses/NotFound'
        '500':
          $ref: '#/components/responses/InternalServerError'

  /me/products:
    get:
      summary: 自分の出品一覧取得
      security:
        - BearerAuth: []
      parameters:
        - name: status
          in: query
          schema:
            type: string
            enum: [draft, published, archived]
        - name: limit
          in: query
          schema:
            type: integer
            default: 20
        - name: offset
          in: query
          schema:
            type: integer
            default: 0
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
                      $ref: '#/components/schemas/ProductDetail'
                  total:
                    type: integer
        '401':
          $ref: '#/components/responses/Unauthorized'
        '500':
          $ref: '#/components/responses/InternalServerError'
```

### 3-2. 新スキーマ・新レスポンス追加

`components/schemas:` に追記：

```yaml
    ProductImage:
      type: object
      properties:
        id:
          type: integer
        url:
          type: string
        display_order:
          type: integer

    ProductDetail:
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
        description:
          type: string
          nullable: true
        price:
          type: integer
        stock:
          type: integer
        status:
          type: string
          enum: [draft, published, archived]
        images:
          type: array
          items:
            $ref: '#/components/schemas/ProductImage'
        created_at:
          type: string
          format: date-time
        updated_at:
          type: string
          format: date-time

    CreateProductRequest:
      type: object
      required: [category_id, name, price, stock]
      properties:
        category_id:
          type: integer
        name:
          type: string
          maxLength: 255
        description:
          type: string
          nullable: true
        price:
          type: integer
          minimum: 1
        stock:
          type: integer
          minimum: 0
        status:
          type: string
          enum: [draft, published]
          default: draft
        images:
          type: array
          items:
            type: string
            format: uri
          maxItems: 10

    UpdateProductRequest:
      type: object
      properties:
        category_id:
          type: integer
        name:
          type: string
          maxLength: 255
        description:
          type: string
          nullable: true
        price:
          type: integer
          minimum: 1
        stock:
          type: integer
          minimum: 0
        status:
          type: string
          enum: [draft, published]
        images:
          type: array
          items:
            type: string
            format: uri
          maxItems: 10
```

`components/responses:` に追記：

```yaml
    Forbidden:
      description: 権限なし
      content:
        application/json:
          schema:
            type: object
            properties:
              error:
                type: string
```

**`UpdateProductRequest` に `archived` を含めない理由**：archived（出品停止）は `DELETE /products/{id}` で行う。PATCHで直接 archived に変更できると、誤操作で停止した商品を編集経由で再公開する操作が不明確になる。状態遷移のルートを分けることで意図が明確になる。

---

## 4. API実装

### 4-1. schemas/ - バリデーション定義追加

`src/schemas/productSchema.ts` を更新：

```typescript
import { z } from 'zod';

export const getProductsQuerySchema = z.object({
  limit:  z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const getProductParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const createProductSchema = z.object({
  category_id: z.number().int().positive(),
  name:        z.string().min(1).max(255),
  description: z.string().optional(),
  price:       z.number().int().min(1),
  stock:       z.number().int().min(0),
  status:      z.enum(['draft', 'published']).default('draft'),
  images:      z.array(z.url()).max(10).default([]),
});

export const updateProductSchema = z.object({
  category_id: z.number().int().positive().optional(),
  name:        z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  price:       z.number().int().min(1).optional(),
  stock:       z.number().int().min(0).optional(),
  status:      z.enum(['draft', 'published']).optional(),
  images:      z.array(z.url()).max(10).optional(),
}).refine(data => Object.values(data).some(v => v !== undefined), {
  message: '更新するフィールドを1つ以上指定してください',
});

export const getMyProductsQuerySchema = z.object({
  status: z.enum(['draft', 'published', 'archived']).optional(),
  limit:  z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
```

**`getProductParamsSchema` を定義する理由**：`Number(req.params.id)` は `"abc"` → `NaN`、`"1.5"` → `1.5` のように不正な入力を素通りさせる。Zod でパスパラメーターを検証することで、不正な形式のIDに対して 400 を返せる。`show` / `update` / `archive` の3メソッドで共有する。

**`updateProductSchema` の `.refine`**：全フィールドがオプションのとき、空のオブジェクト `{}` を送っても通過してしまう。`refine` で「少なくとも1フィールドが必要」という条件を追加する。

---

### 4-2. repositories/ - productImageRepository 新規作成

`src/repositories/productImageRepository.ts` を作成：

```typescript
import { PoolConnection } from 'mysql2/promise';
import { pool } from '../db/connection.js';

export const productImageRepository = {
  async insertMany(productId: number, urls: string[], conn?: PoolConnection) {
    if (urls.length === 0) return;
    const values = urls.map((url, i) => [productId, url, i]);
    const sql = `INSERT INTO product_images (product_id, url, display_order) VALUES ?`;
    if (conn) {
      await conn.query(sql, [values]);
    } else {
      await pool.query(sql, [values]);
    }
  },

  async findByProductId(productId: number) {
    const [rows] = await pool.query(
      `SELECT id, product_id, url, display_order
       FROM product_images
       WHERE product_id = ?
       ORDER BY display_order ASC`,
      [productId]
    ) as any[];
    return rows as { id: number; product_id: number; url: string; display_order: number }[];
  },

  async deleteByProductId(productId: number, conn?: PoolConnection) {
    const sql = `DELETE FROM product_images WHERE product_id = ?`;
    if (conn) {
      await conn.query(sql, [productId]);
    } else {
      await pool.query(sql, [productId]);
    }
  },
};
```

**`conn?` 引数の理由**：商品登録時は「商品INSERT + 画像INSERT」をトランザクション内で実行する必要がある。同一コネクションを渡すことでトランザクションの範囲内に処理を含められる。コネクションなしで呼ぶ場合（単体更新など）はプールから自動取得する。

**バルクINSERT（`VALUES ?`）とは**：画像URLを1件ずつINSERTするのではなく、配列をまとめて1クエリで送る方式。10件の画像を登録する場合、INSERTが1回で済む（個別INSERT × 10回との違い）。`mysql2` は `VALUES ?` に2次元配列を渡すとバルクINSERTを展開してくれる。

---

### 4-3. repositories/ - productRepository 更新

`src/repositories/productRepository.ts` に追記：

```typescript
import { pool } from '../db/connection.js';

export const productRepository = {
  // ─── Phase 1 から引き続き ───────────────────────────────
  // 公開中商品の一覧取得（ページネーション対応）
  async findAll(limit: number, offset: number) {
    const [rows] = await pool.query(
      `SELECT id, seller_id, name, description, price, stock, status, created_at
       FROM products
       WHERE status = 'published'
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    return rows;
  },

  // 公開中商品を1件取得
  async findPublishedById(id: number) {
    const [rows] = await pool.query(
      `SELECT id, seller_id, category_id, name, description, price, stock, status, created_at, updated_at
       FROM products
       WHERE id = ? AND status = 'published'`,
      [id]
    ) as any[];
    return rows[0] ?? null;
  },

  // 公開中商品の総件数取得
  async count() {
    const [rows] = await pool.query(
      `SELECT COUNT(*) as total FROM products WHERE status = 'published'`
    ) as any[];
    return rows[0].total as number;
  },

  // ─── Phase 3 で追加 ─────────────────────────────────────

  // 商品を1件登録し、挿入IDを返す
  async create(data: {
    sellerId: number;
    categoryId: number;
    name: string;
    description?: string | undefined;
    price: number;
    stock: number;
    status: 'draft' | 'published';
  }, conn: import('mysql2/promise').PoolConnection) {
    const [result] = await conn.query(
      `INSERT INTO products (seller_id, category_id, name, description, price, stock, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [data.sellerId, data.categoryId, data.name, data.description ?? null, data.price, data.stock, data.status]
    ) as any[];
    return result.insertId as number;
  },

  // IDで商品を1件取得（statusフィルタなし）
  async findById(id: number) {
    const [rows] = await pool.query(
      `SELECT id, seller_id, category_id, name, description, price, stock, status, created_at, updated_at
       FROM products
       WHERE id = ?`,
      [id]
    ) as any[];
    return rows[0] ?? null;
  },

  // 出品者の商品一覧取得（statusフィルタ・ページネーション対応）
  async findBySellerId(sellerId: number, filters: { status?: string | undefined; limit: number; offset: number }) {
    const conditions: string[] = ['seller_id = ?'];
    const values: unknown[] = [sellerId];

    if (filters.status) {
      conditions.push('status = ?');
      values.push(filters.status);
    }

    const where = conditions.join(' AND ');
    const [rows] = await pool.query(
      `SELECT id, seller_id, category_id, name, description, price, stock, status, created_at, updated_at
       FROM products
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [...values, filters.limit, filters.offset]
    ) as any[];
    return rows as any[];
  },

  // 出品者の商品数取得（statusフィルタ対応）
  async countBySellerId(sellerId: number, status?: string | undefined) {
    const conditions: string[] = ['seller_id = ?'];
    const values: unknown[] = [sellerId];
    if (status) { conditions.push('status = ?'); values.push(status); }
    const [rows] = await pool.query(
      `SELECT COUNT(*) as total FROM products WHERE ${conditions.join(' AND ')}`,
      values
    ) as any[];
    return rows[0].total as number;
  },

  // 渡されたフィールドのみ部分更新
  async updateById(id: number, fields: {
    categoryId?: number | undefined;
    name?: string | undefined;
    description?: string | undefined;
    price?: number | undefined;
    stock?: number | undefined;
    status?: 'draft' | 'published' | undefined;
  }, conn?: import('mysql2/promise').PoolConnection) {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (fields.categoryId  !== undefined) { sets.push('category_id = ?');  values.push(fields.categoryId); }
    if (fields.name        !== undefined) { sets.push('name = ?');         values.push(fields.name); }
    if (fields.description !== undefined) { sets.push('description = ?');  values.push(fields.description); }
    if (fields.price       !== undefined) { sets.push('price = ?');        values.push(fields.price); }
    if (fields.stock       !== undefined) { sets.push('stock = ?');        values.push(fields.stock); }
    if (fields.status      !== undefined) { sets.push('status = ?');       values.push(fields.status); }
    if (sets.length === 0) return;
    values.push(id);
    const query = `UPDATE products SET ${sets.join(', ')} WHERE id = ?`;
    if (conn) {
      await conn.query(query, values);
    } else {
      await pool.query(query, values);
    }
  },

  // statusをarchivedに変更して出品停止
  async archiveById(id: number) {
    await pool.query(
      `UPDATE products SET status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [id]
    );
  },
};
```

**`findPublishedById` と `findById` の使い分け**：

| メソッド | 用途 | status条件 |
|---|---|---|
| `findPublishedById` | 公開商品の参照（購入者向け） | `published` のみ |
| `findById` | 所有者チェック・編集・削除 | 制限なし |

出品者が自分の `draft` 商品を編集する場合、`findPublishedById` では取得できない。`findById` を使って取得し、`seller_id` を確認する。

---

### 4-4. services/ - productService 更新

`src/services/productService.ts` を更新：

```typescript
import { pool } from '../db/connection.js';
import { productRepository } from '../repositories/productRepository.js';
import { productImageRepository } from '../repositories/productImageRepository.js';
import { NotFoundError, ForbiddenError } from '../errors/AppError.js';

export const productService = {
  // ─── Phase 1 から引き続き ───────────────────────────────
  // 公開商品の一覧と総件数を返す
  async getProducts(limit: number, offset: number) {
    const [data, total] = await Promise.all([
      productRepository.findAll(limit, offset),
      productRepository.count(),
    ]);
    return { data, total };
  },

  // 公開商品を画像込みで返す
  async getProductById(id: number) {
    const [product, images] = await Promise.all([
      productRepository.findPublishedById(id),
      productImageRepository.findByProductId(id),
    ]);
    if (!product) throw new NotFoundError('商品が見つかりません');
    return { ...product, images };
  },

  // ─── Phase 3 で追加 ─────────────────────────────────────

  // 商品と画像をトランザクションで登録し、登録結果を返す
  async createProduct(sellerId: number, input: {
    categoryId: number;
    name: string;
    description?: string | undefined;
    price: number;
    stock: number;
    status: 'draft' | 'published';
    images: string[];
  }) {
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    try {
      const productId = await productRepository.create(
        {
          sellerId,
          categoryId: input.categoryId,
          name:        input.name,
          description: input.description,
          price:       input.price,
          stock:       input.stock,
          status:      input.status,
        },
        conn
      );
      await productImageRepository.insertMany(productId, input.images, conn);
      await conn.commit();

      const [product, images] = await Promise.all([
        productRepository.findById(productId),
        productImageRepository.findByProductId(productId),
      ]);
      return { ...product, images };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },

  // 自分の出品一覧を画像込みで返す（statusフィルタ対応）
  // ⚠️ N+1: 商品N件に対して画像取得クエリがN回発行される（Promise.allで並列化済みだがラウンドトリップはN+1）
  //         Phase 10 で product_images の IN句バッチ取得に置き換える
  async getMyProducts(sellerId: number, filters: { status?: string | undefined; limit: number; offset: number }) {
    const [products, total] = await Promise.all([
      productRepository.findBySellerId(sellerId, filters),
      productRepository.countBySellerId(sellerId, filters.status),
    ]);

    const productIds = products.map((p: any) => p.id);
    const imagesAll = productIds.length > 0
      ? await Promise.all(productIds.map((id: number) => productImageRepository.findByProductId(id)))
      : [];

    // products と imagesAll は同じ順番・同じ長さの並列配列
    // imagesAll[i] = products[i] に対応する画像配列（インデックスで紐付け）
    // ?? [] は画像なし商品に対して空配列を返すフォールバック
    const data = products.map((p: any, i: number) => ({ ...p, images: imagesAll[i] ?? [] }));
    return { data, total };
  },

  // 所有者チェック後に商品情報と画像を更新する
  async updateProduct(
    productId: number,
    requesterId: number,
    input: {
      categoryId?: number | undefined;
      name?: string | undefined;
      description?: string | undefined;
      price?: number | undefined;
      stock?: number | undefined;
      status?: 'draft' | 'published' | undefined;
      images?: string[] | undefined;
    }
  ) {
    const product = await productRepository.findById(productId);
    if (!product) throw new NotFoundError('商品が見つかりません');
    if (product.seller_id !== requesterId) throw new ForbiddenError('この商品を編集する権限がありません');

    const { images, ...fields } = input;

    if (images !== undefined) {
      // imagesを含む場合：UPDATE→DELETE→INSERTの3操作を1つの業務単位として扱う
      const conn = await pool.getConnection();
      await conn.beginTransaction();
      try {
        await productRepository.updateById(productId, fields, conn);
        await productImageRepository.deleteByProductId(productId, conn);
        await productImageRepository.insertMany(productId, images, conn);
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    } else {
      // imagesなし：productsの更新のみ、トランザクション不要
      await productRepository.updateById(productId, fields);
    }

    const [updated, updatedImages] = await Promise.all([
      productRepository.findById(productId),
      productImageRepository.findByProductId(productId),
    ]);
    return { ...updated, images: updatedImages };
  },

  // 所有者チェック後に商品を出品停止にする
  async archiveProduct(productId: number, requesterId: number) {
    const product = await productRepository.findById(productId);
    if (!product) throw new NotFoundError('商品が見つかりません');
    if (product.seller_id !== requesterId) throw new ForbiddenError('この商品を停止する権限がありません');
    await productRepository.archiveById(productId);
  },
};
```

**`getMyProducts` の並列配列によるインデックス紐付け**：

`products` と `imagesAll` は同じ順番・同じ長さの並列配列になっており、インデックス `i` で対応する商品と画像を紐付ける。

```
products:  [ 商品A,          商品B,     商品C ]
imagesAll: [ [A画像1,A画像2], [B画像1],  []   ]
インデックス:  i=0              i=1        i=2
```

この対応が成立するのは、`imagesAll` を `productIds.map(id => findByProductId(id))` で生成しており、`productIds` 自体が `products.map(p => p.id)` の順番を保持しているため。

**トランザクションの使い方**：

```text
pool.getConnection()     → プールから接続を1本取得
conn.beginTransaction()  → トランザクション開始
    productRepository.create(...)     → INSERT products
    productImageRepository.insertMany(...)  → INSERT product_images
conn.commit()            → コミット（両方確定）

例外発生時
conn.rollback()          → ロールバック（両方巻き戻し）
conn.release()           → 接続をプールに返却（finally で必ず実行）
```

商品のINSERT後にエラーが起きても画像が残ったり、画像INSERT失敗で商品だけ残るといった中途半端な状態にならない。

**画像更新の置換方式**：PATCHで `images` を渡すと既存画像を全削除して入れ替える。これにより「どの画像を追加/削除するか」を個別に管理するAPIを不要にできる。Phase 3 では全置換で十分。

---

**`getMyProducts` のN+1とJOINによる解決が適切でない理由**：

`getMyProducts` は商品N件を取得後、各商品の画像をN回クエリで取得する。これはN+1問題に該当する。`Promise.all` で並列化しているためシーケンシャルN+1より速いが、DBへのラウンドトリップ数は変わらない。

JOINで解決できないかという疑問は自然だが、ページネーションと相性が悪い。

```sql
-- products × product_images をJOINすると行が展開される
SELECT p.*, pi.url, pi.display_order
FROM products p
LEFT JOIN product_images pi ON p.id = pi.product_id
WHERE p.seller_id = ?
LIMIT 20;
-- → 画像2枚の商品は2行に展開されるため、LIMIT 20 = 20商品ではなく20行になる
--   画像枚数によって取得できる商品数が変動してしまう
```

正しい解決策はIN句によるバッチ取得。2クエリで完結し、ページネーションも正しく動作する。

```sql
-- 1クエリ目：商品取得（LIMIT/OFFSETはここにかける）
SELECT ... FROM products WHERE seller_id = ? LIMIT 20 OFFSET 0;

-- 2クエリ目：取得した商品IDをまとめて画像を1回で取得
SELECT id, product_id, url, display_order
FROM product_images
WHERE product_id IN (1, 2, 3, ..., 20)
ORDER BY product_id, display_order ASC;
```

この修正はPhase 10 の性能改善フェーズで行う。

---

### 4-5. controllers/ - productController 更新

`src/controllers/productController.ts` を更新：

```typescript
import type { Request, Response, NextFunction } from 'express';
import { productService } from '../services/productService.js';
import {
  getProductsQuerySchema,
  getProductParamsSchema,
  createProductSchema,
  updateProductSchema,
  getMyProductsQuerySchema,
} from '../schemas/productSchema.js';

export const productController = {
  // ─── Phase 1 から引き続き ───────────────────────────────
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const query = getProductsQuerySchema.parse(req.query);
      const result = await productService.getProducts(query.limit, query.offset);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },

  async show(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = getProductParamsSchema.parse(req.params);
      const product = await productService.getProductById(id);
      res.json(product);
    } catch (error) {
      next(error);
    }
  },

  // ─── Phase 3 で追加 ─────────────────────────────────────

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const body = createProductSchema.parse(req.body);
      const product = await productService.createProduct(req.user!.id, {
        categoryId:  body.category_id,
        name:        body.name,
        description: body.description,
        price:       body.price,
        stock:       body.stock,
        status:      body.status,
        images:      body.images,
      });
      res.status(201).json(product);
    } catch (error) {
      next(error);
    }
  },

  async myList(req: Request, res: Response, next: NextFunction) {
    try {
      const query = getMyProductsQuerySchema.parse(req.query);
      const result = await productService.getMyProducts(req.user!.id, {
        status: query.status,
        limit:  query.limit,
        offset: query.offset,
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  },

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const { id: productId } = getProductParamsSchema.parse(req.params);
      const body = updateProductSchema.parse(req.body);
      const product = await productService.updateProduct(productId, req.user!.id, {
        categoryId:  body.category_id,
        name:        body.name,
        description: body.description,
        price:       body.price,
        stock:       body.stock,
        status:      body.status,
        images:      body.images,
      });
      res.json(product);
    } catch (error) {
      next(error);
    }
  },

  async archive(req: Request, res: Response, next: NextFunction) {
    try {
      const { id: productId } = getProductParamsSchema.parse(req.params);
      await productService.archiveProduct(productId, req.user!.id);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  },
};
```

**`204 No Content`**：削除・停止など「返すボディがない」成功レスポンスに使う。`res.status(204).send()` でボディなしのレスポンスを返す。

---

### 4-6. routes/ - productRoutes 更新

`src/routes/productRoutes.ts` を更新：

```typescript
import { Router } from 'express';
import { productController } from '../controllers/productController.js';
import { authenticate } from '../middlewares/authenticate.js';

const router = Router();

// 公開エンドポイント（認証不要）
router.get('/',    productController.list);
router.get('/:id', productController.show);

// 認証必須エンドポイント
router.post('/',       authenticate, productController.create);
router.patch('/:id',   authenticate, productController.update);
router.delete('/:id',  authenticate, productController.archive);

export default router;
```

**同一ルーターに公開・認証エンドポイントが混在する場合**：メソッド（GET / POST / PATCH / DELETE）が異なるため、`authenticate` を個別に付与できる。`router.use(authenticate)` でルーター全体に適用すると `GET /products`（公開）も認証必須になってしまうため、エンドポイントごとに指定する。

---

### 4-7. routes/ - userRoutes 更新

`src/routes/userRoutes.ts` に追記：

```typescript
import { Router } from 'express';
import { authController } from '../controllers/authController.js';
import { productController } from '../controllers/productController.js';
import { authenticate } from '../middlewares/authenticate.js';

const router = Router();

router.get('/me',          authenticate, authController.me);
router.patch('/me',        authenticate, authController.updateMe);
router.get('/me/products', authenticate, productController.myList);  // Phase 3 で追加

export default router;
```

**`/me/products` を `userRoutes.ts` に置く理由**：`/me/products` は「自分のリソース」を表す `me` 名前空間のエンドポイント。商品系の操作（`/products`）と分けることで、「自分のデータを参照する」操作と「商品リソースを操作する」操作の責務が明確になる。

---

### 4-8. 動作確認

```bash
# ログインしてトークン取得（Phase 2 で登録済みの seller アカウント）
TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"seller@example.com","password":"password123"}' \
  | jq -r '.token')

# 商品出品（draft で作成）
curl -X POST http://localhost:3000/api/v1/products \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "category_id": 1,
    "name": "テスト出品商品",
    "description": "動作確認用の商品です",
    "price": 5000,
    "stock": 3,
    "status": "draft",
    "images": ["https://placehold.jp/400x400.png?text=test1"]
  }'
# → {"id":21,"seller_id":1,"category_id":1,"name":"テスト出品商品","status":"draft","images":[...],...}

# 商品出品（published で即公開）
curl -X POST http://localhost:3000/api/v1/products \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "category_id": 2,
    "name": "即公開テスト商品",
    "price": 10000,
    "stock": 1,
    "status": "published",
    "images": []
  }'

# 自分の出品一覧取得
curl http://localhost:3000/api/v1/me/products \
  -H "Authorization: Bearer $TOKEN"
# → {"data":[...],"total":22}

# 自分の出品一覧（draft のみ）
curl "http://localhost:3000/api/v1/me/products?status=draft" \
  -H "Authorization: Bearer $TOKEN"

# 商品編集
curl -X PATCH http://localhost:3000/api/v1/products/21 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"price": 4500, "status": "published"}'
# → {"id":21,...,"price":4500,"status":"published",...}

# 出品停止（論理削除）
curl -X DELETE http://localhost:3000/api/v1/products/21 \
  -H "Authorization: Bearer $TOKEN"
# → 204 No Content

# 停止後に公開エンドポイントで確認（404になること）
curl http://localhost:3000/api/v1/products/21
# → {"error":"商品が見つかりません"}

# 他人の商品を操作（403になること）
BUYER_TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"buyer@example.com","password":"password123"}' \
  | jq -r '.token')

curl -X PATCH http://localhost:3000/api/v1/products/1 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $BUYER_TOKEN" \
  -d '{"price": 1}'
# → {"error":"この商品を編集する権限がありません"}

# トークンなしで出品（401になること）
curl -X POST http://localhost:3000/api/v1/products \
  -H "Content-Type: application/json" \
  -d '{"category_id":1,"name":"test","price":100,"stock":1}'
# → {"error":"認証トークンがありません"}
```

#### Postman での確認

**事前準備**

Phase 2 の Postman 設定で環境変数 `token` が保存済みであること。未設定の場合は phase2-auth.md の「Postman での確認 → ログイン」手順を先に実施する。

また商品登録後の手順で商品IDを使い回すため、環境変数 `productId` を追加しておく。

1. 右上のドロップダウンで「market-api」環境を選択
2. ENVIRONMENTS タブを開き、変数 `productId` を追加（Initial value・Current value は空でよい）
3. 「Save」

**商品出品・draft（POST /api/v1/products）**

1. Method: `POST`、URL: `http://localhost:3000/api/v1/products`
2. Authorization タブ → Type: `Bearer Token` → Token: `{{token}}`
3. Headers タブ → `Content-Type: application/json`
4. Body タブ → raw → JSON を選択し以下を入力：
   ```json
   {
     "category_id": 1,
     "name": "テスト出品商品",
     "description": "動作確認用の商品です",
     "price": 5000,
     "stock": 3,
     "status": "draft",
     "images": ["https://placehold.jp/400x400.png?text=test1"]
   }
   ```
5. Scripts タブ → **After response** に以下を入力（レスポンスの `id` を環境変数に自動保存）：
   ```javascript
   const json = pm.response.json();
   pm.environment.set("productId", json.id);
   ```
6. Send → 201 と登録した商品情報・images配列が返ること確認

**商品出品・即公開（POST /api/v1/products）**

1. 上記と同じリクエストで `status` を `"published"` に変更
2. Send → 201 が返ること確認

**自分の出品一覧（GET /api/v1/me/products）**

1. Method: `GET`、URL: `http://localhost:3000/api/v1/me/products`
2. Authorization タブ → Type: `Bearer Token` → Token: `{{token}}`
3. Send → 200 と `{"data":[...],"total":N}` が返ること確認

ステータスフィルタの確認：

1. Params タブ → 以下を追加：

   | KEY    | VALUE |
   |--------|-------|
   | status | draft |

2. Send → `data` が draft の商品のみになること確認
3. `status` を `published` / `archived` に変えて同様に確認

**商品編集（PATCH /api/v1/products/:productId）**

1. Method: `PATCH`、URL: `http://localhost:3000/api/v1/products/{{productId}}`
2. Authorization タブ → Type: `Bearer Token` → Token: `{{token}}`
3. Headers: `Content-Type: application/json`
4. Body:
   ```json
   {
     "price": 4500,
     "status": "published"
   }
   ```
5. Send → 200 と更新後の商品情報が返ること確認（`price` が 4500、`status` が `published` になっていること）

**出品停止（DELETE /api/v1/products/:productId）**

1. Method: `DELETE`、URL: `http://localhost:3000/api/v1/products/{{productId}}`
2. Authorization タブ → Type: `Bearer Token` → Token: `{{token}}`
3. Send → 204 が返ること確認（レスポンスボディなし）

**停止後に公開エンドポイントで404確認（GET /api/v1/products/:productId）**

1. Method: `GET`、URL: `http://localhost:3000/api/v1/products/{{productId}}`
2. Authorization 不要
3. Send → 404 と `{"error":"商品が見つかりません"}` が返ること確認

**他人の商品を編集（403確認）**

別アカウント（buyer@example.com など）でログインしてトークンを取得し、他人が作成した商品IDで PATCH を試みる。

1. POST /api/v1/auth/login で buyer のトークンを取得し、一時的に Authorization の Token に貼り付ける
2. Method: `PATCH`、URL: `http://localhost:3000/api/v1/products/1`（seller が作成した商品）
3. Body: `{"price": 1}`
4. Send → 403 と `{"error":"この商品を編集する権限がありません"}` が返ること確認

**認証なしで出品（401確認）**

1. Method: `POST`、URL: `http://localhost:3000/api/v1/products`
2. Authorization タブ → Type: `No Auth`
3. Body: `{"category_id":1,"name":"test","price":100,"stock":1}`
4. Send → 401 と `{"error":"認証トークンがありません"}` が返ること確認

---

## 5. Flutter連携

### 5-1. ProductImage モデル追加

`lib/features/product/data/product_image.dart` を作成：

```dart
class ProductImage {
  final int id;
  final int productId;
  final String url;
  final int displayOrder;

  ProductImage({
    required this.id,
    required this.productId,
    required this.url,
    required this.displayOrder,
  });

  factory ProductImage.fromJson(Map<String, dynamic> json) => ProductImage(
    id:           json['id'],
    productId:    json['product_id'],
    url:          json['url'],
    displayOrder: json['display_order'],
  );
}
```

---

### 5-2. Product モデル更新（images追加）

`lib/features/product/data/product.dart` を更新：

```dart
import 'product_image.dart';

class Product {
  final int id;
  final int sellerId;
  final int? categoryId;
  final String name;
  final String? description;
  final int price;
  final int stock;
  final String status;
  final List<ProductImage> images;
  final String createdAt;
  final String? updatedAt;

  Product({
    required this.id,
    required this.sellerId,
    this.categoryId,
    required this.name,
    this.description,
    required this.price,
    required this.stock,
    required this.status,
    this.images = const [],
    required this.createdAt,
    this.updatedAt,
  });

  factory Product.fromJson(Map<String, dynamic> json) => Product(
    id:          json['id'],
    sellerId:    json['seller_id'],
    categoryId:  json['category_id'],
    name:        json['name'],
    description: json['description'] as String?,
    price:       json['price'],
    stock:       json['stock'],
    status:      json['status'],
    images:      (json['images'] as List? ?? [])
                   .map((e) => ProductImage.fromJson(e as Map<String, dynamic>))
                   .toList(),
    createdAt:   json['created_at'],
    updatedAt:   json['updated_at'] as String?,
  );
}
```

---

### 5-3. ProductRepository 更新（Flutter）

`lib/features/product/data/product_repository.dart` を更新：

```dart
import 'package:dio/dio.dart';
import 'product.dart';
import '../../../core/api/dio_client.dart';

class ProductRepository {
  Future<List<Product>> getProducts({int limit = 20, int offset = 0}) async {
    final response = await dio.get('/products', queryParameters: {
      'limit': limit,
      'offset': offset,
    });
    final List data = response.data['data'];
    return data.map((e) => Product.fromJson(e)).toList();
  }

  Future<Product> getProductById(int id) async {
    final response = await dio.get('/products/$id');
    return Product.fromJson(response.data);
  }

  Future<Product> createProduct({
    required int categoryId,
    required String name,
    String? description,
    required int price,
    required int stock,
    String status = 'draft',
    List<String> images = const [],
  }) async {
    final response = await dio.post('/products', data: {
      'category_id': categoryId,
      'name':        name,
      if (description != null) 'description': description,
      'price':       price,
      'stock':       stock,
      'status':      status,
      'images':      images,
    });
    return Product.fromJson(response.data);
  }

  Future<List<Product>> getMyProducts({
    String? status,
    int limit = 20,
    int offset = 0,
  }) async {
    final response = await dio.get('/me/products', queryParameters: {
      if (status != null) 'status': status,
      'limit':  limit,
      'offset': offset,
    });
    final List data = response.data['data'];
    return data.map((e) => Product.fromJson(e)).toList();
  }

  Future<Product> updateProduct(
    int id, {
    int? categoryId,
    String? name,
    String? description,
    int? price,
    int? stock,
    String? status,
    List<String>? images,
  }) async {
    final response = await dio.patch('/products/$id', data: {
      if (categoryId  != null) 'category_id': categoryId,
      if (name        != null) 'name':         name,
      if (description != null) 'description':  description,
      if (price       != null) 'price':         price,
      if (stock       != null) 'stock':         stock,
      if (status      != null) 'status':        status,
      if (images      != null) 'images':        images,
    });
    return Product.fromJson(response.data);
  }

  Future<void> archiveProduct(int id) async {
    await dio.delete('/products/$id');
  }
}
```

---

### 5-4. 出品フォーム画面

`lib/features/product/ui/create_product_screen.dart` を作成：

```dart
import 'package:flutter/material.dart';
import '../data/product_repository.dart';

class CreateProductScreen extends StatefulWidget {
  const CreateProductScreen({super.key});
  @override
  State<CreateProductScreen> createState() => _CreateProductScreenState();
}

class _CreateProductScreenState extends State<CreateProductScreen> {
  final _repo = ProductRepository();
  final _nameController        = TextEditingController();
  final _descriptionController = TextEditingController();
  final _priceController       = TextEditingController();
  final _stockController       = TextEditingController();
  int    _categoryId   = 1;
  String _status       = 'draft';
  bool   _isLoading    = false;
  String? _error;

  Future<void> _submit() async {
    final price = int.tryParse(_priceController.text);
    final stock = int.tryParse(_stockController.text);
    if (price == null || stock == null) {
      setState(() { _error = '価格と在庫数は整数で入力してください'; });
      return;
    }

    setState(() { _isLoading = true; _error = null; });
    try {
      await _repo.createProduct(
        categoryId:  _categoryId,
        name:        _nameController.text,
        description: _descriptionController.text.isEmpty ? null : _descriptionController.text,
        price:       price,
        stock:       stock,
        status:      _status,
      );
      if (mounted) {
        Navigator.pop(context, true); // 前の画面に更新を通知
      }
    } catch (e) {
      setState(() { _error = '出品に失敗しました'; });
    } finally {
      setState(() { _isLoading = false; });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('商品を出品する')),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextField(
              controller: _nameController,
              decoration: const InputDecoration(labelText: '商品名 *'),
            ),
            TextField(
              controller: _descriptionController,
              decoration: const InputDecoration(labelText: '説明'),
              maxLines: 3,
            ),
            TextField(
              controller: _priceController,
              decoration: const InputDecoration(labelText: '価格（円）*'),
              keyboardType: TextInputType.number,
            ),
            TextField(
              controller: _stockController,
              decoration: const InputDecoration(labelText: '在庫数 *'),
              keyboardType: TextInputType.number,
            ),
            const SizedBox(height: 8),
            DropdownButtonFormField<String>(
              value: _status,
              decoration: const InputDecoration(labelText: '公開設定'),
              items: const [
                DropdownMenuItem(value: 'draft',     child: Text('下書き')),
                DropdownMenuItem(value: 'published', child: Text('即公開')),
              ],
              onChanged: (v) => setState(() { _status = v!; }),
            ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(_error!, style: const TextStyle(color: Colors.red)),
              ),
            const SizedBox(height: 16),
            _isLoading
              ? const Center(child: CircularProgressIndicator())
              : ElevatedButton(
                  onPressed: _submit,
                  child: const Text('出品する'),
                ),
          ],
        ),
      ),
    );
  }
}
```

---

### 5-5. 自分の出品一覧画面

`lib/features/product/ui/my_products_screen.dart` を作成：

```dart
import 'package:flutter/material.dart';
import '../data/product_repository.dart';
import '../data/product.dart';
import 'edit_product_screen.dart';

class MyProductsScreen extends StatefulWidget {
  const MyProductsScreen({super.key});
  @override
  State<MyProductsScreen> createState() => _MyProductsScreenState();
}

class _MyProductsScreenState extends State<MyProductsScreen> {
  final _repo = ProductRepository();
  List<Product> _products = [];
  bool   _isLoading = true;
  String? _error;
  String? _filterStatus;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() { _isLoading = true; _error = null; });
    try {
      final products = await _repo.getMyProducts(status: _filterStatus);
      setState(() { _products = products; _isLoading = false; });
    } catch (e) {
      setState(() { _error = '取得に失敗しました'; _isLoading = false; });
    }
  }

  Future<void> _archive(int productId) async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('出品停止'),
        content: const Text('この商品の出品を停止しますか？'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('キャンセル')),
          TextButton(onPressed: () => Navigator.pop(context, true),  child: const Text('停止する')),
        ],
      ),
    );
    if (confirm != true) return;
    await _repo.archiveProduct(productId);
    _load();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('自分の出品'),
        actions: [
          IconButton(
            icon: const Icon(Icons.add),
            onPressed: () async {
              final updated = await Navigator.push<bool>(
                context,
                MaterialPageRoute(builder: (_) => const CreateProductScreen()),
              );
              if (updated == true) _load();
            },
          ),
        ],
      ),
      body: Column(
        children: [
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
            child: Row(
              children: [
                for (final s in [null, 'published', 'draft', 'archived'])
                  Padding(
                    padding: const EdgeInsets.only(right: 4),
                    child: FilterChip(
                      label: Text(s ?? '全て'),
                      selected: _filterStatus == s,
                      onSelected: (_) {
                        setState(() { _filterStatus = s; });
                        _load();
                      },
                    ),
                  ),
              ],
            ),
          ),
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
                        title: Text(p.name),
                        subtitle: Text('¥${p.price}  [${p.status}]'),
                        trailing: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            IconButton(
                              icon: const Icon(Icons.edit),
                              onPressed: () async {
                                final updated = await Navigator.push<bool>(
                                  context,
                                  MaterialPageRoute(
                                    builder: (_) => EditProductScreen(product: p),
                                  ),
                                );
                                if (updated == true) _load();
                              },
                            ),
                            if (p.status != 'archived')
                              IconButton(
                                icon: const Icon(Icons.archive),
                                onPressed: () => _archive(p.id),
                              ),
                          ],
                        ),
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

### 5-6. 商品編集画面

`lib/features/product/ui/edit_product_screen.dart` を作成：

```dart
import 'package:flutter/material.dart';
import '../data/product.dart';
import '../data/product_repository.dart';

class EditProductScreen extends StatefulWidget {
  final Product product;
  const EditProductScreen({super.key, required this.product});
  @override
  State<EditProductScreen> createState() => _EditProductScreenState();
}

class _EditProductScreenState extends State<EditProductScreen> {
  final _repo = ProductRepository();
  late final TextEditingController _nameController;
  late final TextEditingController _descriptionController;
  late final TextEditingController _priceController;
  late final TextEditingController _stockController;
  late String _status;
  bool   _isLoading = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    final p = widget.product;
    _nameController        = TextEditingController(text: p.name);
    _descriptionController = TextEditingController(text: p.description ?? '');
    _priceController       = TextEditingController(text: p.price.toString());
    _stockController       = TextEditingController(text: p.stock.toString());
    _status = p.status == 'archived' ? 'draft' : p.status;
  }

  Future<void> _submit() async {
    final price = int.tryParse(_priceController.text);
    final stock = int.tryParse(_stockController.text);
    if (price == null || stock == null) {
      setState(() { _error = '価格と在庫数は整数で入力してください'; });
      return;
    }

    setState(() { _isLoading = true; _error = null; });
    try {
      await _repo.updateProduct(
        widget.product.id,
        name:        _nameController.text,
        description: _descriptionController.text.isEmpty ? null : _descriptionController.text,
        price:       price,
        stock:       stock,
        status:      _status,
      );
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      setState(() { _error = '更新に失敗しました'; });
    } finally {
      setState(() { _isLoading = false; });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('商品編集')),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextField(
              controller: _nameController,
              decoration: const InputDecoration(labelText: '商品名'),
            ),
            TextField(
              controller: _descriptionController,
              decoration: const InputDecoration(labelText: '説明'),
              maxLines: 3,
            ),
            TextField(
              controller: _priceController,
              decoration: const InputDecoration(labelText: '価格（円）'),
              keyboardType: TextInputType.number,
            ),
            TextField(
              controller: _stockController,
              decoration: const InputDecoration(labelText: '在庫数'),
              keyboardType: TextInputType.number,
            ),
            const SizedBox(height: 8),
            DropdownButtonFormField<String>(
              value: _status,
              decoration: const InputDecoration(labelText: '公開設定'),
              items: const [
                DropdownMenuItem(value: 'draft',     child: Text('下書き')),
                DropdownMenuItem(value: 'published', child: Text('公開中')),
              ],
              onChanged: (v) => setState(() { _status = v!; }),
            ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(_error!, style: const TextStyle(color: Colors.red)),
              ),
            const SizedBox(height: 16),
            _isLoading
              ? const Center(child: CircularProgressIndicator())
              : ElevatedButton(
                  onPressed: _submit,
                  child: const Text('更新する'),
                ),
          ],
        ),
      ),
    );
  }
}
```

---

## 確認チェックリスト

Phase 3 完了の判断基準：

```
[ ] POST /api/v1/products でログイン済みユーザーが商品を登録できる
[ ] POST /api/v1/products でトークンなし → 401 が返る
[ ] POST /api/v1/products でバリデーション違反（price=-1等）→ 400 が返る
[ ] GET /api/v1/me/products で自分の出品一覧が返る（draft・published・archived 含む）
[ ] GET /api/v1/me/products?status=draft でフィルタリングができる
[ ] PATCH /api/v1/products/{id} で自分の商品を更新できる
[ ] PATCH /api/v1/products/{id} で他人の商品 → 403 が返る
[ ] PATCH /api/v1/products/{id} で存在しない商品 → 404 が返る
[ ] DELETE /api/v1/products/{id} で自分の商品が archived になる
[ ] DELETE /api/v1/products/{id} 後に GET /api/v1/products/{id} → 404 が返る
[ ] DELETE /api/v1/products/{id} で他人の商品 → 403 が返る
[ ] 商品登録・画像登録がトランザクション内で実行される（画像INSERT失敗時に商品もロールバック）
[ ] Flutterアプリで出品フォームから商品を登録できる
[ ] Flutterアプリで自分の出品一覧が表示される
[ ] Flutterアプリで商品を編集できる
[ ] Flutterアプリで出品停止ダイアログが表示され、停止できる
[ ] openapi.yaml に POST /products・PATCH /products/{id}・DELETE /products/{id}・GET /me/products が定義されている
```

---

## この段階で理解すべきこと

| テーマ | 内容 |
|---|---|
| 論理削除 vs 物理削除 | `DELETE FROM products` でレコードを消すと過去の注文履歴から参照できなくなる。`status = 'archived'` で表示対象から外すだけにすることで参照整合性を維持する |
| 所有者チェック | 認証（「誰か」の確認）と認可（「その操作をしていいか」の確認）は別。`seller_id !== req.user.id` のチェックが認可にあたる |
| 403 vs 404 | 「その商品は存在するが権限がない」場合でも 404 を返す設計があり得る（商品の存在自体を漏らさない）。Phase 3 では分かりやすさを優先して 403 を使う |
| トランザクション | 「商品登録 + 画像登録」は1つの業務単位。片方だけ成功した状態にならないようにする。`BEGIN → 処理 → COMMIT / ROLLBACK → RELEASE` が基本パターン |
| バルクINSERT | 画像を1件ずつINSERTするとN回のクエリが発生する。`INSERT INTO ... VALUES ?, ?, ?` でまとめることで1クエリに削減できる |
| UPDATE の動的SQL | 更新フィールドが可変の場合、`SET` 句を動的に組み立てる。`updateById` メソッドがその例。渡されたフィールドだけをUPDATEする |
| コネクション管理 | トランザクションは「1本の接続」に紐づく。`pool.getConnection()` で明示的にコネクションを取得し、`finally` で必ず `release()` する。しないとコネクションが枯渇してサーバーが応答しなくなる |
| ステータス設計 | `draft → published → archived` の一方向遷移。PATCHで `archived` を直接セットできないようにすることで、誤操作による意図しない停止を防ぐ |

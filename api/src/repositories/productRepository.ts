import {pool} from '../db/connection.js';

export const productRepository = {
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
            `SELECT id, seller_id, name, description, price, stock, status, created_at
            FROM products
            WHERE id = ?
            AND status = 'published'`,
            [id]
        ) as any[];
        return rows[0] ?? null;
    },

    // 公開中商品の総件数取得
    async count() {
        const [rows] = await pool.query(
            `SELECT COUNT(*) as total
            FROM products
            WHERE status = 'published'`,
        ) as any[];
        return rows[0].total as number;
    },

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
        if (fields.categoryId !== undefined) { sets.push('category_id = ?'); values.push(fields.categoryId); }
        if (fields.name !== undefined) { sets.push('name = ?'); values.push(fields.name); }
        if (fields.description !== undefined) { sets.push('description = ?'); values.push(fields.description); }
        if (fields.price !== undefined) { sets.push('price = ?'); values.push(fields.price); }
        if (fields.stock !== undefined) { sets.push('stock = ?'); values.push(fields.stock); }
        if (fields.status !== undefined) { sets.push('status = ?'); values.push(fields.status); }
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

    async search(filters: {
        q?: string | undefined;
        categoryId?: number | undefined;
        minPrice?: number | undefined;
        maxPrice?: number | undefined;
        sort: 'newest' | 'price_asc' | 'price_desc';
        limit: number;
        offset: number;
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
            // created_at が同じレコードが複数ある場合に id でタイブレーク
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
        const offset = useCursor ? 0 : filters.offset; // カーソル時は OFFSET 不使用

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
        q?: string | undefined;
        categoryId?: number | undefined;
        minPrice?: number | undefined;
        maxPrice?: number | undefined;
    }) {
        const conditions: string[] = ["status = 'published'"];
        const values: unknown[] = [];

        if (filters.q) { conditions.push('name LIKE ?');     values.push(`%${filters.q}%`); }
        if (filters.categoryId) { conditions.push('category_id = ?'); values.push(filters.categoryId); }
        if (filters.minPrice !== undefined) { conditions.push('price >= ?'); values.push(filters.minPrice); }
        if (filters.maxPrice !== undefined) { conditions.push('price <= ?'); values.push(filters.maxPrice); }

        const [rows] = await pool.query(
            `SELECT COUNT(*) as total FROM products WHERE ${conditions.join(' AND ')}`,
            values
        ) as any[];
        return rows[0].total as number;
    },
};
import { pool } from '../db/connection.js';

export const favoriteRepository = {
    // お気に入り登録（INSERT IGNORE で重複を無視）
    async add(userId: number, productId: number) {
        await pool.query(
            `INSERT IGNORE INTO favorites (user_id, product_id) VALUES (?, ?)`,
            [userId, productId]
        );
        // INSERT IGNORE は成功・重複どちらでも同じレコードを返す
        return this.findByUserAndProduct(userId, productId);
    },

    // お気に入り削除
    async remove(userId: number, productId: number) {
        const [result] = await pool.query(
                `DELETE FROM favorites WHERE user_id = ? AND product_id = ?`,
                [userId, productId]
        ) as any[];
        return result.affectedRows as number; // 0 なら存在しなかった
    },

    // お気に入り一覧取得（商品情報を JOIN）
    async findByUserId(userId: number, limit: number, offset: number) {
        const [rows] = await pool.query(
            `SELECT f.id, f.product_id, f.created_at,
                    p.seller_id, p.category_id, p.name, p.price, p.stock, p.status,
                    p.created_at AS product_created_at
            FROM favorites f
            JOIN products p ON p.id = f.product_id
            WHERE f.user_id = ?
            ORDER BY f.created_at DESC
            LIMIT ? OFFSET ?`,
            [userId, limit, offset]
        ) as any[];
        return rows as any[];
    },

    // お気に入り件数取得
    async countByUserId(userId: number) {
        const [rows] = await pool.query(
            `SELECT COUNT(*) as total FROM favorites WHERE user_id = ?`,
            [userId]
        ) as any[];
        return rows[0].total as number;
    },

    // user_id + product_id でお気に入りを 1 件取得
    async findByUserAndProduct(userId: number, productId: number) {
        const [rows] = await pool.query(
            `SELECT f.id, f.product_id, f.created_at,
                    p.seller_id, p.category_id, p.name, p.price, p.stock, p.status,
                    p.created_at AS product_created_at
            FROM favorites f
            JOIN products p ON p.id = f.product_id
            WHERE f.user_id = ? AND f.product_id = ?`,
            [userId, productId]
        ) as any[];
        return rows[0] ?? null;
    },
};
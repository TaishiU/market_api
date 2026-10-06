import { pool } from '../db/connection.js';

export const cartRepository = {
    // ユーザーのカートを取得または作成してカート ID を返す（findOrCreate パターン）
    async findOrCreateByUserId(userId: number): Promise<number> {
        // INSERT IGNORE：カートが存在しなければ作成。既に存在すれば何もしない
        await pool.query(
            `INSERT IGNORE INTO carts (user_id) VALUES (?)`,
            [userId]
        );
        // INSERT の有無に関わらず、SELECT で cart id を取得
        const [rows] = await pool.query(
            `SELECT id FROM carts WHERE user_id = ?`,
            [userId]
        ) as any[];
        return rows[0].id as number;
    },
};
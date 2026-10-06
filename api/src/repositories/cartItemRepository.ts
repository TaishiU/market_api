import { pool } from '../db/connection.js';

export const cartItemRepository = {
    // カートアイテムを追加（既に同じ商品があれば数量加算）
    async addOrIncrement(cartId: number, productId: number, quantity: number) {
        await pool.query(
            `INSERT INTO cart_items (cart_id, product_id, quantity)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity)`,
            [cartId, productId, quantity]
        );
    },

    // 数量変更
    async updateQuantity(id: number, quantity: number) {
        await pool.query(
            `UPDATE cart_items SET quantity = ? WHERE id = ?`,
            [quantity, id]
        );
    },

    // カートアイテム削除
    async deleteById(id: number) {
        const [result] = await pool.query(
            `DELETE FROM cart_items WHERE id = ?`,
            [id]
        ) as any[];
        return result.affectedRows as number;
    },

    // カートアイテムを 1 件取得（所有者チェック用：user_id を JOIN で取得）
    async findById(id: number) {
        const [rows] = await pool.query(
            `SELECT ci.id, ci.cart_id, ci.product_id, ci.quantity, c.user_id
            FROM cart_items ci
            JOIN carts c ON c.id = ci.cart_id
            WHERE ci.id = ?`,
            [id]
        ) as any[];
        return rows[0] ?? null;
    },

    // カートのアイテム一覧取得（商品の現在価格を JOIN）
    async findWithProductByCartId(cartId: number) {
        const [rows] = await pool.query(
            `SELECT ci.id, ci.product_id, ci.quantity,
                    p.name AS product_name,
                    p.price AS unit_price,
                    p.status AS product_status,
                    (p.price * ci.quantity) AS subtotal
            FROM cart_items ci
            JOIN products p ON p.id = ci.product_id
            WHERE ci.cart_id = ?
            ORDER BY ci.created_at ASC`,
            [cartId]
        ) as any[];
        return rows as any[];
    },
};
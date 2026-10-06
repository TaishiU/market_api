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
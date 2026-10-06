import { favoriteRepository } from '../repositories/favoriteRepository.js';
import { productRepository } from '../repositories/productRepository.js';
import { NotFoundError } from '../errors/AppError.js';

export const favoriteService = {
    // お気に入り登録（商品存在チェック後、INSERT IGNORE で冪等に処理）
    async addFavorite(userId: number, productId: number) {
        // 公開中の商品のみお気に入り登録可能（draft・archived は不可）
        const product = await productRepository.findPublishedById(productId);
        if (!product) throw new NotFoundError('商品が見つかりません');

        return favoriteRepository.add(userId, productId);
    },

    // お気に入り削除（冪等：未登録でも 204 を返す）
    async removeFavorite(userId: number, productId: number) {
        await favoriteRepository.remove(userId, productId);
    },

    // お気に入り一覧取得
    async getFavorites(userId: number, limit: number, offset: number) {
        const [rows, total] = await Promise.all([
            favoriteRepository.findByUserId(userId, limit, offset),
            favoriteRepository.countByUserId(userId),
        ]);
        // レスポンス形式に整形（JOIN で取得したフラットな行をネスト構造に変換）
        const data = rows.map((row: any) => ({
            id: row.id,
            product_id: row.product_id,
            created_at: row.created_at,
            product: {
                id: row.product_id,
                seller_id: row.seller_id,
                category_id: row.category_id,
                name: row.name,
                price: row.price,
                stock: row.stock,
                status: row.status,
                created_at: row.product_created_at,
            },
        }));
        return { data, total };
    },
};
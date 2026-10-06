import { pool } from '../db/connection.js';
import { encodeCursor, decodeCursor } from '../utils/cursor.js';
import { productRepository } from "../repositories/productRepository.js";
import { productImageRepository } from '../repositories/productImageRepository.js';
import { NotFoundError, ForbiddenError } from '../errors/AppError.js';

export const productService = {
    // 公開商品の一覧と総件数を返す
    // async getProducts(limit: number, offset: number){
    //     const [data, total] = await Promise.all([
    //         productRepository.findAll(limit, offset),
    //         productRepository.count(),
    //     ]);
    //     return {data, total};
    // },

    // 公開商品を画像込みで返す
    async getProductById(id: number) {
        const [product, images] = await Promise.all([
            productRepository.findPublishedById(id),
            productImageRepository.findByProductId(id),
        ]);
        if (!product) throw new NotFoundError('商品が見つかりません');
        return { ...product, images };
    },

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
                name: input.name,
                description: input.description,
                price: input.price,
                stock: input.stock,
                status: input.status,
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

    async searchProducts(input: {
        q?: string | undefined;
        categoryId?: number | undefined;
        minPrice?: number | undefined;
        maxPrice?: number | undefined;
        sort: 'newest' | 'price_asc' | 'price_desc';
        limit: number;
        offset: number;
        cursor?: string | undefined; // Base64URL エンコード済みカーソル
    }) {
        const useCursor = input.sort === 'newest';

        let decodedCursor: { created_at: string; id: number } | undefined;
        if (useCursor && input.cursor) {
            decodedCursor = decodeCursor(input.cursor); // 不正なら例外 → 400
        }

        const filters = {
            q: input.q,
            categoryId: input.categoryId,
            minPrice: input.minPrice,
            maxPrice: input.maxPrice,
            sort: input.sort,
            limit: input.limit,
            offset: input.offset,
            cursor: decodedCursor,
        };

        const rows = await productRepository.search(filters);
        const hasNextPage = rows.length > input.limit;
        const data = hasNextPage ? rows.slice(0, input.limit) : rows;

        if (useCursor) {
            // カーソルページング：total は返さず next_cursor を返す
            const lastItem = data[data.length - 1];
            const nextCursor = hasNextPage && lastItem
                ? encodeCursor(lastItem.created_at, lastItem.id)
                : null;
            return { data, total: null, next_cursor: nextCursor };
        } else {
            // OFFSET ページング：total を COUNT クエリで取得して返す
            const total = await productRepository.countSearch({
                q: input.q,
                categoryId: input.categoryId,
                minPrice: input.minPrice,
                maxPrice: input.maxPrice,
            });
            return { data, total, next_cursor: null };
        }
    },
};
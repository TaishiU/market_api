import { z } from 'zod';

export const searchProductsQuerySchema = z.object({
    q: z.string().optional(),
    category_id: z.coerce.number().int().positive().optional(),
    min_price: z.coerce.number().int().min(0).optional(),
    max_price: z.coerce.number().int().min(0).optional(),
    sort: z.enum(['newest', 'price_asc', 'price_desc']).default('newest'),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
    cursor: z.string().optional(),
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

export const getProductParamsSchema = z.object({
    id: z.coerce.number().int().positive(),
});

export const createProductSchema = z.object({
    category_id: z.number().int().positive(),
    name: z.string().min(1).max(255),
    description: z.string().optional(),
    price: z.number().int().min(1),
    stock: z.number().int().min(0),
    status: z.enum(['draft', 'published']).default('draft'),
    images: z.array(z.url()).max(10).default([]),
});

export const updateProductSchema = z.object({
    category_id: z.number().int().positive().optional(),
    name: z.string().min(1).max(255).optional(),
    description: z.string().optional(),
    price: z.number().int().min(1).optional(),
    stock: z.number().int().min(0).optional(),
    status: z.enum(['draft', 'published']).optional(),
    images: z.array(z.url()).max(10).optional(),
    }).refine(data => Object.values(data).some(v => v !== undefined), {
    message: '更新するフィールドを1つ以上指定してください',
});

export const getMyProductsQuerySchema = z.object({
    status: z.enum(['draft', 'published', 'archived']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
});
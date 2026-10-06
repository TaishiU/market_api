import { z } from 'zod';

export const addCartItemSchema = z.object({
    product_id: z.number().int().positive(),
    quantity: z.number().int().min(1).max(99).default(1),
});

export const updateCartItemSchema = z.object({
    quantity: z.number().int().min(1).max(99),
});

export const cartItemParamsSchema = z.object({
    id: z.coerce.number().int().positive(), // URL の :id はカートアイテム ID
});
import type { Request, Response, NextFunction } from 'express';
import { productService } from '../services/productService.js';
import {
    searchProductsQuerySchema,
    getProductParamsSchema,
    createProductSchema,
    updateProductSchema,
    getMyProductsQuerySchema,
} from '../schemas/productSchema.js';

export const productController = {
    async list(req: Request, res: Response, next: NextFunction) {
        try {
            const query = searchProductsQuerySchema.parse(req.query);
            const result = await productService.searchProducts({
                q: query.q,
                categoryId: query.category_id,
                minPrice: query.min_price,
                maxPrice: query.max_price,
                sort: query.sort,
                limit: query.limit,
                offset: query.offset,
                cursor: query.cursor,
            });
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
        } catch(error) {
            next(error);
        }
    },

    async create(req: Request, res: Response, next: NextFunction) {
        try {
        const body = createProductSchema.parse(req.body);
        const product = await productService.createProduct(req.user!.id, {
            categoryId: body.category_id,
            name: body.name,
            description: body.description,
            price: body.price,
            stock: body.stock,
            status: body.status,
            images: body.images,
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
            limit: query.limit,
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
        } catch(error) {
            next(error);
        }
    },

    async archive(req: Request, res: Response, next: NextFunction) {
        try {
            const { id: productId } = getProductParamsSchema.parse(req.params);
            await productService.archiveProduct(productId, req.user!.id);
            res.status(204).send();
        } catch(error) {
            next(error);
        }
    },
};
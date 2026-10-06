import { cartRepository } from '../repositories/cartRepository.js';
import { cartItemRepository } from '../repositories/cartItemRepository.js';
import { productRepository } from '../repositories/productRepository.js';
import { NotFoundError, ForbiddenError, UnprocessableEntityError } from '../errors/AppError.js';

export const cartService = {
    // カート取得（findOrCreate で初回も空カートを返す）
    async getCart(userId: number) {
        const cartId = await cartRepository.findOrCreateByUserId(userId);
        const items = await cartItemRepository.findWithProductByCartId(cartId);
        const totalAmount = items.reduce(
            (sum: number, item: any) => sum + Number(item.subtotal),
            0
        );
        return { items, total_amount: totalAmount };
    },

    // カートに商品追加（販売停止・存在しない商品は追加不可）
    async addItem(userId: number, productId: number, quantity: number) {
        // status に関わらず商品を取得して公開状態を確認
        const product = await productRepository.findById(productId);
        if (!product) throw new NotFoundError('商品が見つかりません');
        if (product.status !== 'published') {
            throw new UnprocessableEntityError('販売停止または下書き状態の商品はカートに追加できません');
        }

        const cartId = await cartRepository.findOrCreateByUserId(userId);
        await cartItemRepository.addOrIncrement(cartId, productId, quantity);

        // 追加後のカート全体を返す
        return this.getCart(userId);
    },

    // カートアイテムの数量変更（自分のカートのアイテムかチェック）
    async updateItem(userId: number, cartItemId: number, quantity: number) {
        const item = await cartItemRepository.findById(cartItemId);
        if (!item) throw new NotFoundError('カートアイテムが見つかりません');
        if (item.user_id !== userId) throw new ForbiddenError('このカートアイテムを変更する権限がありません');

        await cartItemRepository.updateQuantity(cartItemId, quantity);
        return this.getCart(userId);
    },

    // カートからアイテム削除（自分のカートのアイテムかチェック）
    async removeItem(userId: number, cartItemId: number) {
        const item = await cartItemRepository.findById(cartItemId);
        if (!item) throw new NotFoundError('カートアイテムが見つかりません');
        if (item.user_id !== userId) throw new ForbiddenError('このカートアイテムを削除する権限がありません');

        await cartItemRepository.deleteById(cartItemId);
    },
};
import { Router } from 'express';
import { productController } from '../controllers/productController.js';
import { authenticate } from '../middlewares/authenticate.js';

const router = Router();

// 公開エンドポイント（認証不要）
router.get('/',    productController.list);
router.get('/:id', productController.show);

// 認証必須エンドポイント
router.post('/', authenticate, productController.create);
router.patch('/:id', authenticate, productController.update);
router.delete('/:id', authenticate, productController.archive);

export default router;
import { Router } from 'express';
import { authController } from '../controllers/authController.js';
import { productController } from '../controllers/productController.js';
import { authenticate } from '../middlewares/authenticate.js';

const router = Router();

router.get('/me', authenticate, authController.me);
router.patch('/me', authenticate, authController.updateMe);
router.get('/me/products', authenticate, productController.myList);

export default router;
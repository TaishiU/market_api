import type { Request, Response, NextFunction } from "express";
import { authService } from "../services/authService.js";
import { registerSchema, loginSchema, updateProfileSchema } from "../schemas/authSchema.js";

export const authController = {
    async register(req: Request, res: Response, next: NextFunction) {
        try {
            const body = registerSchema.parse(req.body); // Zodでバリデーション（失敗しするとZodError → 400になる）
            const result = await authService.register(body.email, body.password);
            res.status(201).json(result); // 201 Created: リソースが新規作成されたことを示す
        } catch (error) {
            next(error); // 共通エラーハンドラーへ転送
        }
    },

    async login(req: Request, res: Response, next: NextFunction) {
        try {
            const body = loginSchema.parse(req.body);
            const result = await authService.login(body.email, body.password);
            // res.json()はデフォルトで200を付与するためres.status(200)の明示不要
            res.json(result); // 200 OK: 既存リソース取得のため201ではなく200
        } catch (error) {
            next(error); // 共通エラーハンドラーへ転送
        }
    },

    async me(req: Request, res: Response, next: NextFunction) {
        try {
            // req.userはauthenticateミドルウェアがセットした値（!でnullでないとTypescriptに保証）
            const user = await authService.getMe(req.user!.id);
            res.json(user);
        } catch (error) {
            next(error); // 共通エラーハンドラーへ転送
        }
    },

    async updateMe(req: Request, res: Response, next: NextFunction) {
        try {
            const body = updateProfileSchema.parse(req.body); // 全フィールドがオプション（送られたものだけ更新）
            const user = await authService.updateMe(req.user!.id, body);
            res.json(user); // 更新後のユーザー情報を返す
        } catch (error) {
            next(error); // 共通エラーハンドラーへ転送
        }
    },
};
import type { Request, Response, NextFunction } from "express";
import jwt from 'jsonwebtoken';
import { UnauthorizedError } from "../errors/AppError.js";

const JWT_SECRET = process.env.JWT_SECRET!;

export function authenticate(req: Request, _res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization; // 'Bearer eyJ...'の形式で届く
    // ヘッダーがない、または'Bearer'で始まらない場合は401
    if(!authHeader?.startsWith('Bearer ')) {
        return next(new UnauthorizedError('認証トークンがありません'));
    }

    const token = authHeader.slice(7); // 'Bearer '（7文字）を取り除いてトークン部分だけ取り出す
    try {
        // 署名の検証と有効期限チェックを同時に行う。改ざん・期限切れなら例外が投げられる
        const payload = jwt.verify(token, JWT_SECRET) as {id: number; email: string; role: string};
        req.user = payload; // 検証済みのユーザー情報をリクエストに付与（後続のControllerでreq.user.idなどを参照できる）
        next(); // 認証成功: 次のミドルウェアまたはControllerに処理を渡す
    } catch {
        // 署名不一致・期限切れなどjwt.verifyが投げた例外をまとめて401にする
        next(new UnauthorizedError('トークンが無効または有効期限切れです'));
    }
};
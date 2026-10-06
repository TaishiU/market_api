import type { Request, Response, NextFunction } from "express";
import { AppError } from "../errors/AppError.js";
import { ZodError } from "zod";
import { error } from "node:console";

export function errorHandler(
    err: unknown,
    req: Request,
    res: Response,
    next: NextFunction
){
    if(err instanceof ZodError) {
        const message = err.issues[0]?.message ?? 'バリデーションエラー';
        return res.status(400).json({error: message});
    }
    if(err instanceof AppError) {
        return res.status(err.statusCode).json({error: err.message});
    }
    console.log(err);
    res.status(500).json({error: 'Internal Server Error'});
};
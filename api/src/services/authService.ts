import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { userRepository } from "../repositories/userRepository.js";
import { ConflictError, NotFoundError, UnauthorizedError } from "../errors/AppError.js";

const JWT_SECRET = process.env.JWT_SECRET!;
const JWT_EXPIRES_IN = '7d'; // トークンの有効期限: 7日

export const authService = {
    async register(email: string, password: string) {
        // 同じメールがすでに登録されていたら409 Conflict
        const existing = await userRepository.findByEmail(email);
        if(existing) throw new ConflictError('このメールアドレスはすでに登録されています');

        // パスワードをハッシュ化（10ラウンド = 2^10回の計算。平文は保存しない）
        const passwordHash = await bcrypt.hash(password, 10);
        const id = await userRepository.craete(email, passwordHash);
        const user = await userRepository.findById(id); // INSERT後に改めて取得（password_hashを除いた形で）

        // jwt.sign() で署名付き JWT（JWS）を生成する
        // JWT には「署名（JWS）」と「暗号化（JWE）」の2種類があるが、
        // jsonwebtoken ライブラリは JWS のみ対応しており JWE は非対応（JWE が必要なら jose ライブラリを使う）
        // JWS はペイロードを Base64url エンコードするだけなので誰でもデコードして中身を読める。
        // 「改ざんを検知する署名」であり「内容を隠す暗号化」ではない。
        //
        // もしペイロードに password_hash を含めた場合：
        // JWT はレスポンスボディ・通信ログ・ブラウザの開発者ツール・フロント側ストレージなど
        // 多くの場所を経由するため、トークンが漏れる経路はDBよりはるかに多い。
        // 攻撃者がトークンを1つ入手するだけでハッシュ値を取り出せてしまい、
        // サーバーのレートリミットを一切受けずにオフラインでブルートフォース攻撃が可能になる。
        // bcrypt のコスト係数で遅くしてあっても、ハッシュさえあればローカルで総当たりできる。
        // そのためペイロードには password_hash や個人情報を絶対に含めず、id・email・role だけにする
        const token = jwt.sign(
            {id: user.id, email: user.email, role: user.role},
            JWT_SECRET,
            {expiresIn: JWT_EXPIRES_IN}
        );
        return {token, user};
    },

    async login(email: string, password: string) {
        const user = await userRepository.findByEmail(email);
        // ユーザーが存在しない場合もbcrypt.compareと同じパスを通り、同じエラーを返す（ユーザー列挙攻撃防止）
        // bcrypt.compareはリクエストの平文passwordとDBのpassword_hashを照合し、一致すればtrueを返す
        // &&の短絡評価により、userがnullならcompareは実行されず、isValidはnull（false）になる
        const isValid = user && await bcrypt.compare(password, user.password_hash);
        if(!isValid) throw new UnauthorizedError('メールアドレスまたはパスワードが正しくありません');

        // 分割代入でpassword_hashを除外し、残りをsafeUserとしてレスポンスに使う
        const {password_hash, ...safeUser} = user;
        // jwt.sign()は署名（JWS）を生成する。ペイロードはBase64urlエンコードのみで誰でも読めるため
        // password_hashをsafeUserから除いた後にsignする（registerと同じ理由）
        const token = jwt.sign(
            {id: safeUser.id, email: safeUser.email, role: safeUser.role},
            JWT_SECRET,
            {expiresIn: JWT_EXPIRES_IN}
        );
        return {token, user: safeUser};
    },

    async getMe(id: number) {
        const user = await userRepository.findById(id);
        if(!user) throw new NotFoundError('ユーザーが見つかりません');
        return user;
    },

    async updateMe(id: number, fields: {email?: string | undefined, password?: string | undefined}){
        if(fields.email) {
            // 変更先のメールアドレスが他のユーザーに使われていないか確認
            const existing = await userRepository.findByEmail(fields.email);
            if(existing && existing.id !== id) throw new ConflictError('このメールアドレスは既に使用されています');
        }
        const updates: {email?: string, passwordHash?: string} = {};
        if(fields.email) {
            updates.email = fields.email;
        };
        if(fields.password) {
            updates.passwordHash = await bcrypt.hash(fields.password, 10); // 新パスワードをハッシュ化
        };

        await userRepository.updateById(id, updates);
        return userRepository.findById(id);
    },
};
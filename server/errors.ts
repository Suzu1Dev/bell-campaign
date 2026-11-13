export class AppError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function publicError(err: unknown): { status: number; message: string } {
  if (err instanceof AppError) {
    return { status: err.status, message: err.message };
  }
  return { status: 500, message: "伺服器處理請求時發生錯誤，請稍後再試。" };
}

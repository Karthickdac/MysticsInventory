import type { Request, Response, NextFunction } from "express";
import type { ZodType, ZodIssue } from "zod";

export function validateBody<S extends ZodType>(schema: S) {
  return function (
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: "Validation failed",
        issues: result.error.issues.map((i: ZodIssue) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    req.body = result.data;
    next();
  };
}

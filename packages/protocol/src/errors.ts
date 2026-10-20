import type { ToolErrorCode } from './types.js';

/** Wire shape of an error, independent of transport. */
export interface ProtocolErrorShape {
  code: ToolErrorCode;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export class CelesteError extends Error {
  readonly code: ToolErrorCode;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(
    code: ToolErrorCode,
    message: string,
    options: { retryable?: boolean; details?: unknown; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'CelesteError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }

  toShape(): ProtocolErrorShape {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }

  static from(err: unknown, fallbackCode: ToolErrorCode = 'INTERNAL'): CelesteError {
    if (err instanceof CelesteError) return err;
    if (err instanceof Error) {
      return new CelesteError(fallbackCode, err.message, { cause: err });
    }
    return new CelesteError(fallbackCode, String(err));
  }
}

export class TimeoutError extends CelesteError {
  constructor(message: string, details?: unknown) {
    super('TIMEOUT', message, { retryable: true, ...(details !== undefined ? { details } : {}) });
    this.name = 'TimeoutError';
  }
}

export class PermissionError extends CelesteError {
  constructor(message: string, details?: unknown) {
    super('PERMISSION_DENIED', message, { details });
    this.name = 'PermissionError';
  }
}

export class NeedsApprovalError extends CelesteError {
  constructor(message: string, details?: unknown) {
    super('NEEDS_APPROVAL', message, { details });
    this.name = 'NeedsApprovalError';
  }
}

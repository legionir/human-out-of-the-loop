/**
 * G-08: the CLI (`plans resume`) and the web server (`POST /api/plans/:id/resume`)
 * must refuse the same plans for the same reasons.
 */

export type ResumeAction = 'resume' | 'finalize-cancel' | 'refuse' | 'noop' | 'not-found';

export interface ResumeDecision {
  action: ResumeAction;
  /** HTTP status the server should use (CLI maps 200/202 → 0, 4xx → 1). */
  httpStatus: number;
  message: string;
  code?: string;
}

export function evaluatePlanResume(opts: {
  found: boolean;
  status?: string;
  liveOwner: boolean;
}): ResumeDecision {
  if (!opts.found) {
    return {
      action: 'not-found',
      httpStatus: 404,
      message: 'Plan not found (or not resumable).',
      code: 'PLAN_NOT_FOUND',
    };
  }
  if (opts.liveOwner) {
    return {
      action: 'refuse',
      httpStatus: 409,
      message: 'Plan is already running.',
      code: 'PLAN_LIVE_OWNER',
    };
  }
  if (opts.status === 'cancelling') {
    return {
      action: 'finalize-cancel',
      httpStatus: 409,
      message: 'Plan was being cancelled — it is now cancelled.',
      code: 'PLAN_CANCELLING',
    };
  }
  if (opts.status === 'cancelled') {
    return {
      action: 'refuse',
      httpStatus: 409,
      message: 'Plan is cancelled — cancellation is final and it will not be resumed.',
      code: 'PLAN_CANCELLED',
    };
  }
  if (opts.status === 'completed') {
    return {
      action: 'noop',
      httpStatus: 200,
      message: 'Plan is already completed — nothing to resume.',
      code: 'PLAN_COMPLETED',
    };
  }
  return {
    action: 'resume',
    httpStatus: 202,
    message: 'Resuming.',
    code: 'OK',
  };
}

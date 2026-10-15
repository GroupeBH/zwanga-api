/** Keep generic upstream ECONNRESET failures distinct from aborted bodies. */
export function isHttpRequestAborted(exception: unknown): boolean {
  if (!(exception instanceof Error)) return false;
  const error = exception as Error & { code?: string; type?: string };
  return error.code === 'ECONNABORTED' || error.type === 'request.aborted' ||
    error.message.toLowerCase() === 'request aborted' ||
    (error.code === 'ECONNRESET' && error.message.toLowerCase() === 'aborted');
}

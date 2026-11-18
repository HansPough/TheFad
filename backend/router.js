/** Shared router helper: tags each request with its endpoint, checks approval, catches async errors. */
import { approvalGuard } from '../approval.js';

const wrap = (handler) => (req, res, next) => {
  try {
    const result = handler(req, res, next);
    if (result && typeof result.catch === 'function') result.catch(next);
  } catch (error) {
    next(error);
  }
};

/** `approval` is the POST guard; pass null to register routes without the admin PIN check (preview). */
export function makeRouter(app, { approval = approvalGuard } = {}) {
  const add = (method) => (path, endpoint, ...handlers) => {
    const guards = [wrap((req, res, next) => { req.endpoint = endpoint; next(); })];
    if (approval) guards.push(wrap(approval));
    app[method](path, ...guards, ...handlers.map(wrap));
  };
  return { get: add('get'), post: add('post') };
}

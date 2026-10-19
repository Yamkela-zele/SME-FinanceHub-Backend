export const asyncHandler = (fn) => (req, res, next) => void fn(req, res, next).catch(next);

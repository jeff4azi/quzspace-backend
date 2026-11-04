// middleware/spaceAccess.js
// Route guard for the `/spaces/:id/*` tree. Resolves the caller's role from
// `req.params.id` and enforces a minimum privilege level.

const { assertSpaceRole } = require('../lib/access');
const { AppError } = require('../lib/errors');
const { HTTP_STATUS, ERROR_CODES } = require('../config/constants');

// min ∈ 'viewer' | 'collaborator' | 'owner'
function requireSpaceRole(min = 'viewer') {
  return async function spaceAccessGuard(req, res, next) {
    try {
      const userId = req.user && req.user.id;
      if (!userId) {
        throw new AppError({
          code: ERROR_CODES.UNAUTHORIZED,
          message: 'Authentication required',
          status: HTTP_STATUS.UNAUTHORIZED,
        });
      }
      await assertSpaceRole({ spaceId: req.params.id, userId, min });
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireSpaceRole };

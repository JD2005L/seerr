// Levac fork: GET /api/v1/pipeline, see server/lib/pipelineStatus.ts.
import { libraryAccess } from '@server/lib/libraryAccess';
import { pipelineStatusesFor } from '@server/lib/pipelineStatus';
import logger from '@server/logger';
import { Router } from 'express';

const pipelineRoutes = Router();

// ?requestIds=1,2,3 narrows the list; without it, every open request the
// caller can see (the pages share one copy of that).
pipelineRoutes.get('/', async (req, res) => {
  try {
    let ids: number[] | undefined;
    if (typeof req.query.requestIds === 'string' && req.query.requestIds) {
      ids = req.query.requestIds
        .split(',')
        .map(Number)
        .filter((n) => Number.isSafeInteger(n) && n > 0)
        .slice(0, 500);
    }
    const access = await libraryAccess(req.user);
    return res
      .status(200)
      .json(await pipelineStatusesFor(req.user, access, ids));
  } catch (e) {
    logger.error(`Pipeline status failed: ${e.message}`, {
      label: 'Pipeline Status',
    });
    return res.status(200).json({ available: false, statuses: [] });
  }
});

export default pipelineRoutes;

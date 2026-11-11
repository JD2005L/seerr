// Levac fork: which titles are in the libraries this person can see, so the
// site can tell "Available to you" from "available in someone else's library".
import {
  accessibleTitleKeys,
  libraryAccess,
  libraryIndex,
} from '@server/lib/libraryAccess';
import { Router } from 'express';

const libraryRoutes = Router();

libraryRoutes.get('/mine', async (req, res) => {
  const access = await libraryAccess(req.user);
  if (!access) return res.status(200).json({ limited: false });
  const index = await libraryIndex();
  // Without the library list we can't say what is theirs: behave as before.
  if (!index) return res.status(200).json({ limited: false });
  return res
    .status(200)
    .json({ limited: true, titles: accessibleTitleKeys(index, access) });
});

export default libraryRoutes;

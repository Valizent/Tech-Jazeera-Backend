/**
 * Client routes.
 *
 * Role design: READ is Section Access key 'clientsManage' at the 'read'
 * level (default mirrors the write circle below — see
 * sectionAccess.service.js). WRITE (create/update/decide) is the same key
 * at the 'write' level, default ['Manager','Coordinator'] — matches today's
 * create/update circle exactly; decide's floor widens from Admin/Manager to
 * also admit Coordinator by default, but client.service.js's own "must be
 * THIS coordinator's manager" check (decideClient) still gates the actual
 * decision regardless of this floor, so this is a low-risk widening, not a
 * new capability for a typical Coordinator login. DELETE stays hardcoded
 * Admin/Manager only — an extra safety rail on the single most destructive
 * action, also guarded in the service against clients with assigned
 * workers. Setting status = Inactive is the everyday alternative to
 * deletion.
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireRoles, requireStaff } from '../../middleware/rbac.js';
import { requireSectionAccess } from '../sectionAccess/sectionAccess.middleware.js';
import { validate } from '../../middleware/validate.js';
import {
  createClientSchema,
  updateClientSchema,
  listClientsSchema,
  clientIdParamSchema,
  decideClientSchema,
} from './client.validation.js';
import * as clientController from './client.controller.js';

const router = Router();

router.use(requireAuth);
router.use(requireStaff); // staff-only module; Workers use the ESS portal (P2-M2)

const canReadClients = requireSectionAccess('clientsManage', 'read');
const canManageClients = requireSectionAccess('clientsManage', 'write');

router.get('/', canReadClients, validate({ query: listClientsSchema }), asyncHandler(clientController.list));
router.get('/:id', canReadClients, validate({ params: clientIdParamSchema }), asyncHandler(clientController.get));
router.post(
  '/',
  canManageClients,
  validate({ body: createClientSchema }),
  asyncHandler(clientController.create)
);
router.patch(
  '/:id',
  canManageClients,
  validate({ params: clientIdParamSchema, body: updateClientSchema }),
  asyncHandler(clientController.update)
);
router.patch(
  '/:id/decide',
  canManageClients,
  validate({ params: clientIdParamSchema, body: decideClientSchema }),
  asyncHandler(clientController.decide)
);
router.delete(
  '/:id',
  requireRoles('Admin', 'Manager'),
  validate({ params: clientIdParamSchema }),
  asyncHandler(clientController.remove)
);

export default router;

// Vermieter Cockpit overlay (issue #398; docs/development/betrieb.md §11.7): this file is services/api/src/routes.js of
// MicroRealEstate 479d0ad703436071b64dfdf4e48321c121d8efb5 (the pinned image), changed only so that the Realm of a
// record comes from the authorized request (req.realm, set by Middlewares.checkOrganization()) and never from the
// body: every route of the api drops `realmId` from the JSON body and refuses a body with an update operator (a top-level
// key starting with `$`), before any manager sees it. Without it, PATCH /properties/:id, /leases/:id and /tenants/:id
// with `"realmId": "<other Realm>"` (or `"$set": { "realmId": … }`) moved the record into that Realm. MRE 1.0.0 still
// passes the body on for properties. deploy/mre-api/realm-398.patch holds the change; .github/scripts/mre-overlay-check.sh
// checks it reproduces this file from the original. Remove with the MRE upgrade (VC-X-06) once the managers do the same.
import * as accountingManager from './managers/accountingmanager.js';
import * as dashboardManager from './managers/dashboardmanager.js';
import * as emailManager from './managers/emailmanager.js';
import * as leaseManager from './managers/leasemanager.js';
import * as occupantManager from './managers/occupantmanager.js';
import * as propertyManager from './managers/propertymanager.js';
import * as realmManager from './managers/realmmanager.js';
import * as rentManager from './managers/rentmanager.js';
import { Middlewares, Service } from '@microrealestate/common';
import express from 'express';

export default function routes() {
  const { ACCESS_TOKEN_SECRET } = Service.getInstance().envConfig.getValues();
  const router = express.Router();
  router.use(
    // protect the api access by checking the access token
    Middlewares.needAccessToken(ACCESS_TOKEN_SECRET),
    // update req with the user organizations
    Middlewares.checkOrganization(),
    // forbid access to tenant
    Middlewares.notRoles(['tenant']),
    // the Realm of a record is req.realm, never a value of the body (issue #398)
    (req, res, next) => {
      const body = req.body;
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        if (Object.keys(body).some((key) => key.startsWith('$'))) {
          return res.sendStatus(422);
        }
        delete body.realmId;
      }
      next();
    }
  );

  const realmsRouter = express.Router();
  realmsRouter.get('/', realmManager.all);
  realmsRouter.get('/:id', realmManager.one);
  realmsRouter.post('/', Middlewares.asyncWrapper(realmManager.add));
  realmsRouter.patch('/:id', Middlewares.asyncWrapper(realmManager.update));
  router.use('/realms', realmsRouter);

  const dashboardRouter = express.Router();
  dashboardRouter.get('/', Middlewares.asyncWrapper(dashboardManager.all));
  router.use('/dashboard', dashboardRouter);

  const leasesRouter = express.Router();
  leasesRouter.get('/', Middlewares.asyncWrapper(leaseManager.all));
  leasesRouter.get('/:id', Middlewares.asyncWrapper(leaseManager.one));
  leasesRouter.post('/', Middlewares.asyncWrapper(leaseManager.add));
  leasesRouter.patch('/:id', Middlewares.asyncWrapper(leaseManager.update));
  leasesRouter.delete('/:ids', Middlewares.asyncWrapper(leaseManager.remove));
  router.use('/leases', leasesRouter);

  const occupantsRouter = express.Router();
  occupantsRouter.get('/', Middlewares.asyncWrapper(occupantManager.all));
  occupantsRouter.get('/:id', Middlewares.asyncWrapper(occupantManager.one));
  occupantsRouter.post('/', Middlewares.asyncWrapper(occupantManager.add));
  occupantsRouter.patch(
    '/:id',
    Middlewares.asyncWrapper(occupantManager.update)
  );
  occupantsRouter.delete(
    '/:ids',
    Middlewares.asyncWrapper(occupantManager.remove)
  );
  router.use('/tenants', occupantsRouter);

  const rentsRouter = express.Router();
  rentsRouter.patch(
    '/payment/:id/:term',
    Middlewares.asyncWrapper(rentManager.updateByTerm)
  );
  rentsRouter.get(
    '/tenant/:id',
    Middlewares.asyncWrapper(rentManager.rentsOfOccupant)
  );
  rentsRouter.get(
    '/tenant/:id/:term',
    Middlewares.asyncWrapper(rentManager.rentOfOccupantByTerm)
  );
  rentsRouter.get('/:year/:month', Middlewares.asyncWrapper(rentManager.all));
  router.use('/rents', rentsRouter);

  const propertiesRouter = express.Router();
  propertiesRouter.get('/', Middlewares.asyncWrapper(propertyManager.all));
  propertiesRouter.get('/:id', Middlewares.asyncWrapper(propertyManager.one));
  propertiesRouter.post('/', Middlewares.asyncWrapper(propertyManager.add));
  propertiesRouter.patch(
    '/:id',
    Middlewares.asyncWrapper(propertyManager.update)
  );
  propertiesRouter.delete(
    '/:ids',
    Middlewares.asyncWrapper(propertyManager.remove)
  );
  router.use('/properties', propertiesRouter);

  router.get(
    '/accounting/:year',
    Middlewares.asyncWrapper(accountingManager.all)
  );
  router.get(
    '/csv/tenants/incoming/:year',
    Middlewares.asyncWrapper(accountingManager.csv.incomingTenants)
  );
  router.get(
    '/csv/tenants/outgoing/:year',
    Middlewares.asyncWrapper(accountingManager.csv.outgoingTenants)
  );
  router.get(
    '/csv/settlements/:year',
    Middlewares.asyncWrapper(accountingManager.csv.settlements)
  );

  const emailRouter = express.Router();
  emailRouter.post('/', Middlewares.asyncWrapper(emailManager.send));
  router.use('/emails', emailRouter);

  const apiRouter = express.Router();
  apiRouter.use('/api/v2', router);

  return apiRouter;
}

// Vermieter Cockpit overlay (issue #398; docs/development/betrieb.md §11.7): this file is
// services/pdfgenerator/src/routes/index.js of MicroRealEstate 479d0ad703436071b64dfdf4e48321c121d8efb5 (the pinned
// image), changed only so that the templates and documents routes answer a request only with a Realm that the
// middleware authorized (a tenant session has none) and never for the role tenant, as the api does.
// deploy/mre-pdfgenerator/realm-398.patch holds the change; .github/scripts/mre-overlay-check.sh checks it reproduces
// this file from the original. Remove with the MRE upgrade (VC-X-06).
import { Middlewares, Service } from '@microrealestate/common';
import documents from './documents.js';
import express from 'express';
import templates from './templates.js';

export default function () {
  const apiRoutes = express.Router('/pdfgenerator');
  apiRoutes.use(
    Middlewares.needAccessToken(
      Service.getInstance().envConfig.getValues().ACCESS_TOKEN_SECRET
    ),
    Middlewares.checkOrganization(),
    // issue #398: only a request with a Realm that Middlewares.checkOrganization() authorized, and not as a tenant. The
    // pinned middleware skips every check for a tenant session (sessionToken cookie without Authorization) and leaves
    // req.realm unset; templates and documents then trusted the organizationid header. 404 as for a foreign Realm.
    (req, res, next) => (req.realm ? next() : res.sendStatus(404)),
    Middlewares.notRoles(['tenant'])
  );
  apiRoutes.use('/templates', templates());
  apiRoutes.use('/documents', documents());

  const routes = express.Router();
  routes.use('/pdfgenerator', apiRoutes);
  return routes;
}

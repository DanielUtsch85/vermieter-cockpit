// Vermieter Cockpit overlay (issue #401; docs/development/betrieb.md §11.8): this file is
// services/api/src/managers/leasemanager.js of MicroRealEstate 479d0ad703436071b64dfdf4e48321c121d8efb5 (the pinned
// image), changed only in update(): for a lease a tenant already uses, the pinned code read dbLease inside the statement
// that declares it (ReferenceError, PATCH /leases/:id answered 500). As upstream v1.0.0 (leasemanager.ts) does, the
// update of such a lease is built from the request alone: name, and description, active and stepperMode where given;
// the stored values of the other fields stay. deploy/mre-api/realm-401.patch holds the change;
// .github/scripts/mre-overlay-check.sh checks it reproduces this file from the original. Remove with the MRE upgrade
// (VC-X-06).
import { Collections, logger, ServiceError } from '@microrealestate/common';

/**
 * @returns a Set of leaseId (_id)
 */
async function _leaseUsedByTenant(realm) {
  const tenants = await Collections.Tenant.find(
    { realmId: realm._id },
    { realmId: 1, leaseId: 1 }
  ).lean();
  return tenants.reduce((acc, { leaseId }) => {
    acc.add(leaseId);
    return acc;
  }, new Set());
}

////////////////////////////////////////////////////////////////////////////////
// Exported functions
////////////////////////////////////////////////////////////////////////////////
export async function add(req, res) {
  const lease = req.body;
  if (!lease.name) {
    logger.error('missing lease name');
    throw new ServiceError('missing fields', 422);
  }

  const realm = req.realm;
  const dbLease = new Collections.Lease({
    ...lease,
    active: !!lease.active && !!lease.numberOfTerms && !!lease.timeRange,
    realmId: realm._id
  });
  const savedLease = await dbLease.save();
  const setOfUsedLeases = await _leaseUsedByTenant(realm);
  savedLease.usedByTenants = setOfUsedLeases.has(savedLease._id);
  res.json(savedLease);
}

export async function update(req, res) {
  const realm = req.realm;
  const lease = req.body;

  if (!lease.name) {
    logger.error('missing lease name');
    throw new ServiceError('missing fields', 422);
  }

  if (lease.active === undefined) {
    lease.active = lease.numberOfTerms > 0 && !!lease.timeRange;
  }

  const setOfUsedLeases = await _leaseUsedByTenant(realm);

  // if lease already used by tenants, only allow to update name, description, active fields
  let updatedLease = lease;
  if (setOfUsedLeases.has(lease._id)) {
    updatedLease = { name: lease.name };
    if (lease.description != null) {
      updatedLease.description = lease.description;
    }
    if (lease.active != null) {
      updatedLease.active = lease.active;
    }
    if (lease.stepperMode != null) {
      updatedLease.stepperMode = lease.stepperMode;
    }
  }

  const dbLease = await Collections.Lease.findOneAndUpdate(
    {
      realmId: realm._id,
      _id: lease._id
    },
    updatedLease,
    { new: true }
  ).lean();

  if (!dbLease) {
    throw new ServiceError('lease not found', 404);
  }

  dbLease.usedByTenants = setOfUsedLeases.has(dbLease._id);
  res.json(dbLease);
}

export async function remove(req, res) {
  const realm = req.realm;
  const leaseIds = req.params.ids.split(',') || [];

  if (!leaseIds.length) {
    logger.error('missing lease ids');
    throw new ServiceError('missing fields', 422);
  }

  const setOfUsedLeases = await _leaseUsedByTenant(realm);
  if (leaseIds.some((leaseId) => setOfUsedLeases.has(leaseId))) {
    logger.error('lease used by tenants and cannot be removed');
    throw new ServiceError('missing fields', 422);
  }

  const leases = await Collections.Lease.find({
    realmId: realm._id,
    _id: { $in: leaseIds }
  });

  if (!leases.length) {
    throw new ServiceError('lease not found', 404);
  }

  const templates = await Collections.Template.find({
    realmId: realm._id,
    linkedResourceIds: { $in: leaseIds }
  });

  const templateIdsToRemove = templates
    .filter(({ linkedResourceIds }) => linkedResourceIds.length <= 1)
    .reduce((acc, { _id }) => [...acc, _id], []);

  const session = await Collections.startSession();
  session.startTransaction();
  try {
    await Promise.all([
      Collections.Lease.deleteMany({
        _id: { $in: leaseIds },
        realmId: realm._id
      }),
      Collections.Template.deleteMany({
        _id: { $in: templateIdsToRemove },
        realmId: realm._id
      }),
      Collections.Template.updateMany(
        {
          realmId: realm._id,
          linkedResourceIds: { $in: leaseIds }
        },
        {
          // remove leaseIds from linkedResourceIds
          $pull: { linkedResourceIds: { $in: leaseIds } }
        }
      )
    ]);
    await session.commitTransaction();
  } catch (error) {
    await session.abortTransaction();
    throw new ServiceError(error, 500);
  } finally {
    session.endSession();
  }
  res.sendStatus(200);
}

export async function all(req, res) {
  const realm = req.realm;
  const setOfUsedLeases = await _leaseUsedByTenant(realm);
  const dbLeases = await Collections.Lease.find({ realmId: realm._id })
    .sort({
      name: 1
    })
    .lean();

  res.json(
    dbLeases.map((dbLease) => ({
      ...dbLease,
      usedByTenants: setOfUsedLeases.has(dbLease._id)
    }))
  );
}

export async function one(req, res) {
  const realm = req.realm;
  const leaseId = req.params.id;

  const dbLease = await Collections.Lease.findOne({
    _id: leaseId,
    realmId: realm._id
  }).lean();

  if (!dbLease) {
    throw new ServiceError('lease not found', 404);
  }

  const setOfUsedLeases = await _leaseUsedByTenant(realm);
  dbLease.usedByTenants = setOfUsedLeases.has(dbLease._id);
  res.json(dbLease);
}

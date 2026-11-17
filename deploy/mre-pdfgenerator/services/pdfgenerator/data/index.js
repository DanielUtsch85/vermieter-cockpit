// Vermieter Cockpit overlay (issue #396, backlog VC-X-82; docs/development/betrieb.md §11.7): this file is
// services/pdfgenerator/data/index.js of MicroRealEstate 479d0ad703436071b64dfdf4e48321c121d8efb5 (the pinned image),
// changed only where the realm fix of upstream microrealestate/microrealestate#273 (in v1.0.0) needs it: the tenant is
// read by its id AND the realm the route authorized, so a tenant id of another realm finds nothing (and a request
// without a realm, realmId undefined, matches no tenant: the driver sends it as null). The same lines as upstream; the
// rest of upstream's diff to v1.0.0 is not taken. deploy/mre-pdfgenerator/realm-396.patch holds the change;
// .github/scripts/mre-overlay-check.sh checks it reproduces this file from the original. Remove with the MRE upgrade
// (VC-X-06).
import { Collections, logger } from '@microrealestate/common';
import moment from 'moment';

export async function getRentsData(params) {
  const { id: tenantId, term, realmId } = params;

  let dbTenant;
  try {
    dbTenant = await Collections.Tenant.findOne({ _id: tenantId, realmId })
      .populate('realmId')
      .populate('leaseId')
      .populate('properties.propertyId');
  } catch (error) {
    logger.error(error);
  }
  if (!dbTenant) {
    throw new Error(`tenant ${tenantId} not found`);
  }

  const landlord = dbTenant.realmId;
  landlord.name =
    (landlord.isCompany
      ? landlord.companyInfo?.name
      : landlord.contacts?.[0]?.name) || '';
  landlord.hasCompanyInfo = !!landlord.companyInfo;
  landlord.hasBankInfo = !!landlord.bankInfo;
  landlord.hasAddress = !!landlord.addresses?.length;
  landlord.hasContact = !!landlord.contacts?.length;

  let rents = [];
  if (dbTenant.rents.length) {
    rents = dbTenant.rents
      .filter((rent) => String(rent.term).startsWith(term))
      .map((rent) => ({
        ...rent,
        period: rent.term,
        billingReference: `${moment(rent.term, 'YYYYMMDDHH').format('MM_YY_')}${
          dbTenant.reference
        }`,
        total: {
          ...rent.total,
          payment: rent.total.payment || 0,
          subTotal:
            rent.total.preTaxAmount +
            rent.total.charges -
            rent.total.discount +
            rent.total.debts,
          newBalance: rent.total.grandTotal - rent.total.payment
        }
      }));
  }

  const tenant = {
    name: dbTenant.isCompany ? dbTenant.company : dbTenant.name,
    isCompany: dbTenant.isCompany,
    companyInfo: {
      name: dbTenant.company,
      capital: dbTenant.capital,
      ein: dbTenant.siret,
      dos: dbTenant.rcs,
      vatNumber: dbTenant.vatNumber,
      legalRepresentative: dbTenant.manager
    },
    addresses: [
      {
        street1: dbTenant.street1,
        street2: dbTenant.street2,
        city: dbTenant.city,
        state: dbTenant.state,
        country: dbTenant.country
      }
    ],
    contract: {
      name: dbTenant.contract,
      lease: dbTenant.leaseId,
      beginDate: dbTenant.beginDate,
      endDate: dbTenant.endDate,
      properties: dbTenant.properties.reduce((acc, { propertyId }) => {
        acc.push(propertyId);
        return acc;
      }, [])
    },
    rents
  };
  if (dbTenant.terminationDate) {
    tenant.contract.terminationDate = dbTenant.terminationDate;
  }

  return {
    fileName: `${dbTenant.name}-${term}`,
    tenant,
    landlord
  };
}

export function avoidWeekend(aMoment) {
  const day = aMoment.isoWeekday();
  if (day === 6) {
    // if saturday shift the due date to friday
    aMoment.subtract(1, 'days');
  } else if (day === 7) {
    // if sunday shift the due date to friday
    aMoment.subtract(2, 'days');
  }
  return aMoment;
}

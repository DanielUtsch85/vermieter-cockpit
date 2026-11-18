// Vermieter Cockpit overlay (issue #398; docs/development/betrieb.md §11.7): this file is
// services/tenantapi/dist/controllers/tenants.js of MicroRealEstate 479d0ad703436071b64dfdf4e48321c121d8efb5 (the pinned
// image, compiled from src/controllers/tenants.ts), changed only in how a tenant is found by e-mail: the address of the
// session is compared exactly (case-insensitive, as an escaped and anchored pattern), no longer used as a regular
// expression, so `.*` or a prefix no longer matches every tenant; and a request that carries a Realm (an account that is
// a member of a Realm with the role tenant, req.realm set by Middlewares.checkOrganization()) sees only tenants of that
// Realm. The tenant session of the OTP sign-in (no Realm) keeps seeing every tenant with its exact address, as upstream.
// MRE 1.0.0 compares exactly too. deploy/mre-tenantapi/realm-398.patch holds the change;
// .github/scripts/mre-overlay-check.sh checks it reproduces this file from the original. Remove with the MRE upgrade
// (VC-X-06).
import { Collections, logger, ServiceError } from '@microrealestate/common';
import moment from 'moment';
export async function getOneTenant(request, response) {
    const req = request;
    const res = response;
    const email = req.user.email;
    if (!email) {
        logger.error('missing email field');
        throw new ServiceError('unauthorized', 401);
    }
    const tenantId = req.params.tenantId;
    const dbTenant = await Collections.Tenant.findOne({
        _id: tenantId,
        ..._byEmail(req, email)
    }).populate(['realmId', 'leaseId']);
    if (!dbTenant) {
        throw new ServiceError('tenant not found', 404);
    }
    const now = moment();
    const lastTerm = Number(now.format('YYYYMMDDHH'));
    res.json({
        results: [_toTenantResponse(dbTenant, lastTerm)]
    });
}
export async function getAllTenants(request, response) {
    const req = request;
    const res = response;
    const email = req.user.email;
    if (!email) {
        logger.error('missing email field');
        throw new ServiceError('unauthorized', 401);
    }
    // find tenants from mongo which has a given email contact
    const dbTenants = await Collections.Tenant.find(_byEmail(req, email)).populate(['realmId', 'leaseId']);
    // the last term considering the current date
    const lastTerm = Number(moment().format('YYYYMMDDHH'));
    res.json({
        results: dbTenants.map((tenant) => _toTenantResponse(tenant, lastTerm))
    });
}
// The filter for the tenants of an e-mail address: exact (case-insensitive), and within the request's Realm if it has one.
function _byEmail(req, email) {
    const exact = new RegExp(`^${String(email).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    return {
        'contacts.email': { $regex: exact },
        ...(req.realm ? { realmId: String(req.realm._id) } : {})
    };
}
function _toTenantResponse(tenant, lastTerm) {
    const now = moment();
    const firstRent = tenant.rents?.[0];
    const totalPreTaxAmount = firstRent?.total.preTaxAmount || 0;
    const totalChargesAmount = firstRent?.total.charges || 0;
    const totalVatAmount = firstRent?.total.vat || 0;
    const totalAmount = totalPreTaxAmount + totalChargesAmount + totalVatAmount;
    const { remainingIterations, remainingIterationsToPay } = _computeRemainingIterations(tenant, lastTerm, totalAmount);
    const landlord = tenant.realmId;
    const lease = tenant.leaseId;
    return {
        tenant: {
            id: tenant._id,
            name: tenant.name,
            contacts: tenant.contacts.map((contact) => ({
                name: contact.contact,
                email: contact.email,
                phone1: contact.phone
            })),
            addresses: [
                {
                    street1: tenant.street1,
                    street2: tenant.street2,
                    zipCode: tenant.zipCode,
                    city: tenant.city,
                    state: '',
                    country: ''
                }
            ]
        },
        landlord: {
            name: landlord.name,
            addresses: landlord.addresses,
            contacts: landlord.contacts,
            currency: landlord.currency,
            locale: landlord.locale
        },
        lease: {
            name: lease.name,
            beginDate: tenant.beginDate,
            endDate: tenant.endDate,
            terminationDate: tenant.terminationDate,
            timeRange: lease.timeRange,
            status: tenant.terminationDate
                ? 'terminated'
                : moment(tenant.endDate, 'YYYY-MM-DD').isBefore(now)
                    ? 'ended'
                    : 'active',
            rent: {
                totalPreTaxAmount,
                totalChargesAmount,
                totalVatAmount,
                totalAmount
            },
            remainingIterations,
            remainingIterationsToPay,
            properties: tenant.properties?.map((property) => ({
                id: property.property._id,
                name: property.property.name,
                description: property.property.description,
                type: property.property.type
            })) || [],
            documents: [],
            // tenant.leaseId.documents.map((document) => ({
            //   name: document.name,
            //   description: document.description,
            //   url: document.url,
            // })),
            invoices: tenant.rents
                ?.filter(({ term }) => term <= lastTerm)
                .sort((r1, r2) => r2.term - r1.term)
                .map((rent) => {
                return {
                    id: `${tenant._id}-${rent.term}`,
                    term: rent.term,
                    balance: rent.total.balance,
                    grandTotal: rent.total.grandTotal,
                    payment: rent.total.payment || 0,
                    methods: rent.payments
                        .filter((payment) => !!payment)
                        .map((payment) => payment.type),
                    status: rent.total.grandTotal - (rent.total.payment || 0) <= 0
                        ? 'paid'
                        : rent.total.payment > 0
                            ? 'partially-paid'
                            : 'unpaid',
                    payments: rent.payments.map((payment) => ({
                        date: payment.date,
                        method: payment.type,
                        reference: payment.reference,
                        amount: payment.amount || 0
                    })) || []
                };
            }),
            balance: _computeBalance(tenant.rents, lastTerm),
            deposit: tenant.guaranty - tenant.guarantyPayback
        }
    };
}
function _computeRemainingIterations(tenant, lastTerm, rentAmount) {
    const timeRange = tenant.leaseId.timeRange;
    const remainingIterations = Math.ceil(moment(tenant.terminationDate || tenant.endDate).diff(moment(lastTerm, 'YYYYMMDDHH').startOf(timeRange), timeRange, true));
    let remainingIterationsToPay = remainingIterations;
    const balance = _computeBalance(tenant.rents, lastTerm);
    if (balance === 0) {
        remainingIterationsToPay -= 1;
    }
    else if (balance > 0) {
        const nbIterationWhereRentPaid = Math.abs(balance / rentAmount);
        remainingIterationsToPay -= Math.floor(nbIterationWhereRentPaid);
    }
    return {
        remainingIterations,
        remainingIterationsToPay
    };
}
function _computeBalance(rents, lastTerm) {
    // find the rent closest to the last term
    const rent = rents.reduce((prev, curr) => {
        if (curr.term <= lastTerm) {
            return curr;
        }
        return prev;
    });
    return -rent.total.grandTotal + rent.total.payment;
}

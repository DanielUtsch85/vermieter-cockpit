#!/usr/bin/env bash
# VC-0-08 / VC-0-09 seed: proves the delegated MRE authentication (mre-integration.md
# §47.1) against the real pinned MRE images of the compose stack, not a fake:
# signup → signin → create Realm in MRE, then call DE /api/v1/health; then
# VC-1-01/02: create an MRE Property, link it to a DE PropertyReference and refresh it;
# VC-1-03: create and close a FinancialAccount; VC-1-04: book a manual Transaction; VC-1-07: split it; VC-1-08: confirm it; VC-1-11: correct it; VC-X-16: amend, ignore and restore a draft;
# VC-1-05/06: import a bank CSV, re-import it as duplicates; VC-1-06a: review and resolve a reordered file.
set -euo pipefail

MRE=${MRE:-http://localhost:8080/api/v2}
DE=${DE:-http://localhost:8090/api/v1}
run=$(date +%s)
admin="admin-$run@example.com"
renter="renter-$run@example.com"
password="Smoke-$run-password"

json() { curl -fsS -H 'content-type: application/json' "$@"; }

for email in "$admin" "$renter"; do
  json -X POST "$MRE/authenticator/landlord/signup" \
    -d "{\"firstname\":\"Smoke\",\"lastname\":\"Test\",\"email\":\"$email\",\"password\":\"$password\"}" >/dev/null
done

token() {
  json -X POST "$MRE/authenticator/landlord/signin" \
    -d "{\"email\":\"$1\",\"password\":\"$password\"}" | jq -r .accessToken
}
admin_token=$(token "$admin")

realm_id=$(json -X POST "$MRE/realms" -H "authorization: Bearer $admin_token" \
  -d "{\"name\":\"Smoke $run\",\"currency\":\"EUR\",\"locale\":\"de-DE\",\"members\":[
        {\"name\":\"Admin\",\"email\":\"$admin\",\"role\":\"administrator\",\"registered\":true},
        {\"name\":\"Renter\",\"email\":\"$renter\",\"role\":\"renter\",\"registered\":true}]}" | jq -r ._id)
echo "created MRE realm $realm_id"

status() { # token realm
  curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $1" -H "organizationid: $2" "$DE/health"
}
expect() { # label actual expected
  echo "$1: $2"
  [ "$2" = "$3" ] || { echo "expected $3"; exit 1; }
}

# Tokens live 30 s in MRE; sign in again right before each call.
expect "administrator, own realm" "$(status "$(token "$admin")" "$realm_id")" 200
expect "administrator, foreign realm" "$(status "$(token "$admin")" "000000000000000000000000")" 403
expect "renter, own realm (no DE access)" "$(status "$(token "$renter")" "$realm_id")" 403
expect "no token" "$(curl -s -o /dev/null -w '%{http_code}' -H "organizationid: $realm_id" "$DE/health")" 401

# VC-1-01: link a real MRE Property to a DE PropertyReference.
property_id=$(json -X POST "$MRE/properties" -H "authorization: Bearer $(token "$admin")" -H "organizationid: $realm_id" \
  -d '{"type":"apartment","name":"Smoke Wohnung","surface":64.5,"address":{"city":"Berlin"}}' | jq -r ._id)
echo "created MRE property $property_id"

link() { # realm property; sets link_status and link_body
  local out
  out=$(curl -s -w '\n%{http_code}' -X POST "$DE/property-references/link" \
    -H "authorization: Bearer $(token "$admin")" -H "organizationid: $realm_id" -H 'content-type: application/json' \
    -d "{\"mreRealmId\":\"$1\",\"mrePropertyId\":\"$2\"}")
  link_status=$(echo "$out" | tail -n1)
  link_body=$(echo "$out" | sed '$d')
}

link "$realm_id" "$property_id"
expect "link MRE property" "$link_status" 201
reference_id=$(echo "$link_body" | jq -r .propertyReferenceId)
expect "cached display name" "$(echo "$link_body" | jq -r .displayName)" "Smoke Wohnung"
expect "cached surface (exact decimal string)" "$(echo "$link_body" | jq -r .cachedSurface)" "64.5"
link "$realm_id" "$property_id"
expect "repeat link (idempotent)" "$link_status" 200
expect "repeat returns the same reference" "$(echo "$link_body" | jq -r .propertyReferenceId)" "$reference_id"
link "$realm_id" "000000000000000000000000"
expect "unknown MRE property" "$link_status" 404
link "$realm_id" "not-an-object-id"
expect "malformed mrePropertyId" "$link_status" 400

# VC-1-02: refresh takes over MRE changes and marks a deleted Property MISSING.
refresh() { # reference; sets refresh_status and refresh_body
  local out
  out=$(curl -s -w '\n%{http_code}' -X POST "$DE/property-references/$1/refresh" \
    -H "authorization: Bearer $(token "$admin")" -H "organizationid: $realm_id")
  refresh_status=$(echo "$out" | tail -n1)
  refresh_body=$(echo "$out" | sed '$d')
}
mre_admin() { # method path [body]
  json -X "$1" "$MRE$2" -H "authorization: Bearer $(token "$admin")" -H "organizationid: $realm_id" ${3:+-d "$3"} >/dev/null
}

mre_admin PATCH "/properties/$property_id" "{\"_id\":\"$property_id\",\"name\":\"Smoke Wohnung EG\",\"surface\":65.25}"
refresh "$reference_id"
expect "refresh after MRE change" "$refresh_status" 200
expect "refreshed display name" "$(echo "$refresh_body" | jq -r .displayName)" "Smoke Wohnung EG"
expect "refreshed surface" "$(echo "$refresh_body" | jq -r .cachedSurface)" "65.25"
expect "version bumped" "$(echo "$refresh_body" | jq -r .version)" 2

mre_admin DELETE "/properties/$property_id"
refresh "$reference_id"
expect "refresh after MRE delete" "$refresh_status" 200
expect "state after MRE delete" "$(echo "$refresh_body" | jq -r .externalReferenceState)" MISSING
expect "cached name kept" "$(echo "$refresh_body" | jq -r .displayName)" "Smoke Wohnung EG"
refresh "00000000-0000-4000-8000-000000000000"
expect "refresh unknown reference" "$refresh_status" 404

# VC-1-03: FinancialAccount create (with Idempotency-Key) and close.
account() { # [extra curl args...] — POST /financial-accounts; sets account_status and account_body
  local out
  out=$(curl -s -w '\n%{http_code}' -X POST "$DE/financial-accounts" \
    -H "authorization: Bearer $(token "$admin")" -H "organizationid: $realm_id" -H 'content-type: application/json' "$@")
  account_status=$(echo "$out" | tail -n1)
  account_body=$(echo "$out" | sed '$d')
}
key="smoke-$run"
account -H "idempotency-key: $key" -d '{"accountType":"BANK","displayName":"Smoke Girokonto","currency":"EUR","iban":"DE89 3704 0044 0532 0130 00"}'
expect "create financial account" "$account_status" 201
account_id=$(echo "$account_body" | jq -r .financialAccountId)
expect "IBAN normalized" "$(echo "$account_body" | jq -r .iban)" DE89370400440532013000
account -H "idempotency-key: $key" -d '{"accountType":"BANK","displayName":"Smoke Girokonto","currency":"EUR","iban":"DE89370400440532013000"}'
expect "idempotent replay" "$account_status" 201
expect "replay returns the same account" "$(echo "$account_body" | jq -r .financialAccountId)" "$account_id"
account -H "idempotency-key: $key" -d '{"accountType":"CASH","displayName":"Smoke Kasse","currency":"EUR"}'
expect "same key, other payload" "$account_status" 409
account -d '{"accountType":"BANK","displayName":"x","currency":"USD"}'
expect "unsupported currency" "$account_status" 400
close_status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$DE/financial-accounts/$account_id/close" \
  -H "authorization: Bearer $(token "$admin")" -H "organizationid: $realm_id")
expect "close financial account" "$close_status" 200

# VC-1-04: manual Transaction on an open account; refused on a closed one.
tx() { # [extra curl args...] — POST /transactions; sets tx_status and tx_body
  local out
  out=$(curl -s -w '\n%{http_code}' -X POST "$DE/transactions" \
    -H "authorization: Bearer $(token "$admin")" -H "organizationid: $realm_id" -H 'content-type: application/json' "$@")
  tx_status=$(echo "$out" | tail -n1)
  tx_body=$(echo "$out" | sed '$d')
}
account -d '{"accountType":"BANK","displayName":"Smoke Mietkonto","currency":"EUR"}'
ledger_account=$(echo "$account_body" | jq -r .financialAccountId)
rent="{\"financialAccountId\":\"$ledger_account\",\"amount\":{\"amount\":\"1250.00\",\"currency\":\"EUR\"},\"direction\":\"INFLOW\",\"bookingDate\":\"2026-09-01\",\"propertyReferenceId\":\"$reference_id\"}"
tx -H "idempotency-key: tx-$run" -d "$rent"
expect "book manual transaction" "$tx_status" 201
transaction_id=$(echo "$tx_body" | jq -r .transactionId)
expect "amount exact" "$(echo "$tx_body" | jq -r .amount.amount)" "1250.00"
expect "status" "$(echo "$tx_body" | jq -r .status)" UNREVIEWED
tx -H "idempotency-key: tx-$run" -d "$rent"
expect "transaction replay" "$(echo "$tx_body" | jq -r .transactionId)" "$transaction_id"
tx -d "{\"financialAccountId\":\"$ledger_account\",\"amount\":{\"amount\":\"1.005\",\"currency\":\"EUR\"},\"direction\":\"INFLOW\",\"bookingDate\":\"2026-09-01\"}"
expect "amount beyond EUR scale" "$tx_status" 400

# VC-1-07: split the rent into base rent and operating-cost advance; one cent off is refused.
splits() { # body — PUT /transactions/$transaction_id/splits; sets splits_status and splits_body
  local out
  out=$(curl -s -w '\n%{http_code}' -X PUT "$DE/transactions/$transaction_id/splits" \
    -H "authorization: Bearer $(token "$admin")" -H "organizationid: $realm_id" -H 'content-type: application/json' -d "$1")
  splits_status=$(echo "$out" | tail -n1)
  splits_body=$(echo "$out" | sed '$d')
}
splits '{"splits":[{"amount":{"amount":"1000.00","currency":"EUR"},"financialCategoryCode":"RENT_BASE"},{"amount":{"amount":"250.00","currency":"EUR"},"financialCategoryCode":"RENT_OPERATING_COST_ADVANCE"}]}'
expect "split transaction" "$splits_status" 200
expect "classified" "$(echo "$splits_body" | jq -r .status)" CLASSIFIED
splits '{"splits":[{"amount":{"amount":"1000.00","currency":"EUR"},"financialCategoryCode":"RENT_BASE"},{"amount":{"amount":"249.99","currency":"EUR"},"financialCategoryCode":"RENT_OPERATING_COST_ADVANCE"}]}'
expect "split sum one cent off" "$splits_status" 409
expect "categories listed" "$(curl -s "$DE/financial-categories" -H "authorization: Bearer $(token "$admin")" -H "organizationid: $realm_id" | jq -r '[.items[].code] | index("RENT_BASE") != null')" true
# VC-1-08: confirm the split Transaction; a repeat is a no-op, the splits are frozen afterwards.
confirm_out=$(curl -s -w '\n%{http_code}' -X POST "$DE/transactions/$transaction_id/confirm" \
  -H "authorization: Bearer $(token "$admin")" -H "organizationid: $realm_id")
expect "confirm transaction" "$(echo "$confirm_out" | tail -n1)" 200
expect "confirmed" "$(echo "$confirm_out" | sed '$d' | jq -r .status)" CONFIRMED
replay_status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$DE/transactions/$transaction_id/confirm" \
  -H "authorization: Bearer $(token "$admin")" -H "organizationid: $realm_id")
expect "confirm repeat" "$replay_status" 200
splits '{"splits":[{"amount":{"amount":"1250.00","currency":"EUR"},"financialCategoryCode":"RENT_BASE"}]}'
expect "splits frozen after confirm" "$splits_status" 409

# VC-1-11: correct the booking date by reversal + replacement; a second correction names the first.
correct() { # body — POST /transactions/$transaction_id/correct; sets correct_status and correct_body
  local out
  out=$(curl -s -w '\n%{http_code}' -X POST "$DE/transactions/$transaction_id/correct" \
    -H "authorization: Bearer $(token "$admin")" -H "organizationid: $realm_id" -H 'content-type: application/json' -d "$1")
  correct_status=$(echo "$out" | tail -n1)
  correct_body=$(echo "$out" | sed '$d')
}
correct '{"reason":"Smoke: falsches Datum","replacement":{"bookingDate":"2026-09-03"}}'
expect "correct transaction" "$correct_status" 201
expect "original corrected" "$(echo "$correct_body" | jq -r .original.status)" CORRECTED
expect "reversal opposite" "$(echo "$correct_body" | jq -r .reversal.direction)" OUTFLOW
expect "replacement date" "$(echo "$correct_body" | jq -r .replacement.bookingDate)" "2026-09-03"
expect "replacement confirmed" "$(echo "$correct_body" | jq -r .replacement.status)" CONFIRMED
correct '{"reason":"Smoke: nochmal","replacement":{"bookingDate":"2026-09-04"}}'
expect "second correction refused" "$correct_status" 409
expect "names the first" "$(echo "$correct_body" | jq -r .error.details.reason)" ALREADY_CORRECTED

# VC-X-16: amend an unconfirmed Transaction, ignore it and restore it; the corrected one is not amendable.
on_transaction() { # id action [body] — POST /transactions/<id>/<action>; sets on_status and on_body
  local out data=()
  [ $# -ge 3 ] && data=(-d "$3")
  out=$(curl -s -w '\n%{http_code}' -X POST "$DE/transactions/$1/$2" \
    -H "authorization: Bearer $(token "$admin")" -H "organizationid: $realm_id" -H 'content-type: application/json' "${data[@]}")
  on_status=$(echo "$out" | tail -n1)
  on_body=$(echo "$out" | sed '$d')
}
tx -d "{\"financialAccountId\":\"$ledger_account\",\"amount\":{\"amount\":\"80.00\",\"currency\":\"EUR\"},\"direction\":\"OUTFLOW\",\"bookingDate\":\"2026-09-05\"}"
draft_id=$(echo "$tx_body" | jq -r .transactionId)
on_transaction "$draft_id" amend '{"amount":{"amount":"85.00","currency":"EUR"},"description":"Hausmeister"}'
expect "amend draft" "$on_status" 200
expect "amended amount" "$(echo "$on_body" | jq -r .amount.amount)" "85.00"
on_transaction "$draft_id" ignore '{"reason":"Smoke: doppelt"}'
expect "ignore draft" "$(echo "$on_body" | jq -r .status)" IGNORED
on_transaction "$draft_id" restore
expect "restore draft" "$(echo "$on_body" | jq -r .status)" UNREVIEWED
on_transaction "$transaction_id" amend '{"description":"x"}'
expect "corrected transaction not amendable" "$on_status" 409

# VC-1-05/06: bank CSV import (multipart); the identical file again is all duplicates.
statement_file=$(mktemp)
printf 'Buchungstag;Betrag;Verwendungszweck\r\n01.09.2026;1.250,00;Miete September\r\n02.09.2026;-310,40;Hausgeld\r\n' >"$statement_file"
import_metadata="{\"financialAccountId\":\"$ledger_account\",\"adapterId\":\"generic-csv\",\"adapterVersion\":\"1\",\"columnMapping\":{\"bookingDate\":\"Buchungstag\",\"amount\":\"Betrag\",\"description\":\"Verwendungszweck\"}}"
bank_import() { # sets import_status and import_body
  local out
  out=$(curl -s -w '\n%{http_code}' -X POST "$DE/imports/bank-transactions" \
    -H "authorization: Bearer $(token "$admin")" -H "organizationid: $realm_id" \
    -F "metadata=$import_metadata" -F "file=@$statement_file;filename=umsatz.csv")
  import_status=$(echo "$out" | tail -n1)
  import_body=$(echo "$out" | sed '$d')
}
bank_import
expect "bank import" "$import_status" 201
expect "imported rows" "$(echo "$import_body" | jq -r .transactionCount)" 2
import_batch_id=$(echo "$import_body" | jq -r .importBatchId)
bank_import
expect "re-import duplicates" "$(echo "$import_body" | jq -r '"\(.transactionCount)/\(.duplicateCount)"')" "0/2"
batch_status=$(curl -s -o /dev/null -w '%{http_code}' "$DE/imports/$import_batch_id" \
  -H "authorization: Bearer $(token "$admin")" -H "organizationid: $realm_id")
expect "get import batch" "$batch_status" 200
# The same rows in another order are another statement: both go to review, nothing is booked.
printf 'Buchungstag;Betrag;Verwendungszweck\r\n02.09.2026;-310,40;Hausgeld\r\n01.09.2026;1.250,00;Miete September\r\n' >"$statement_file"
bank_import
expect "reordered import needs review" "$(echo "$import_body" | jq -r '"\(.status)/\(.needsReviewCount)"')" "NEEDS_REVIEW/2"
review_batch_id=$(echo "$import_body" | jq -r .importBatchId)
review_items=$(curl -s "$DE/imports/$review_batch_id/review-items" \
  -H "authorization: Bearer $(token "$admin")" -H "organizationid: $realm_id")
expect "review items listed" "$(echo "$review_items" | jq -r '.items | length')" 2
for review_item_id in $(echo "$review_items" | jq -r '.items[].reviewItemId'); do
  resolve_status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$DE/imports/$review_batch_id/review-items/$review_item_id/resolve" \
    -H "authorization: Bearer $(token "$admin")" -H "organizationid: $realm_id" -H 'content-type: application/json' \
    -d '{"resolution":"SKIP"}')
  expect "resolve review item" "$resolve_status" 200
done
expect "batch completed after review" "$(curl -s "$DE/imports/$review_batch_id" \
  -H "authorization: Bearer $(token "$admin")" -H "organizationid: $realm_id" | jq -r .status)" COMPLETED
rm -f "$statement_file"

curl -fsS -o /dev/null -X POST "$DE/financial-accounts/$ledger_account/close" \
  -H "authorization: Bearer $(token "$admin")" -H "organizationid: $realm_id"
tx -d "$rent"
expect "transaction on closed account" "$tx_status" 409

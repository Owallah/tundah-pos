#!/usr/bin/env bash
# Simulate a customer paying the till, without Daraja credentials.
#
# This posts the exact payload shape Safaricom sends to the C2B confirmation
# webhook, so the whole M-Pesa path -- ingestion, the unmatched list, the
# tender panel matcher, attaching to a sale -- can be exercised today.
#
#   ./simulate-payment.sh 250                 # KES 250 from a default number
#   ./simulate-payment.sh 250 254712345678 JANE
#
# Run it twice with the same amount to see the ambiguity picker: the matcher
# refuses to auto-match two plausible payments and asks the cashier instead.
set -euo pipefail

AMOUNT="${1:-250}"
PHONE="${2:-254712345678}"
NAME="${3:-JANE}"
URL="${SUPABASE_FUNCTIONS_URL:-http://127.0.0.1:54321/functions/v1}/mpesa-c2b-confirm"

# M-Pesa codes are 10 alphanumerics. Random suffix keeps each run unique --
# reuse one deliberately to test duplicate rejection.
CODE="S$(tr -dc 'A-Z0-9' </dev/urandom | head -c 9)"
NOW="$(date +%Y%m%d%H%M%S)"

echo "Simulating KES ${AMOUNT} from ${PHONE} (${CODE})"

curl -sS -X POST "$URL" \
  -H 'Content-Type: application/json' \
  -d "{
    \"TransactionType\": \"Buy Goods Online\",
    \"TransID\": \"${CODE}\",
    \"TransTime\": \"${NOW}\",
    \"TransAmount\": \"${AMOUNT}.00\",
    \"BusinessShortCode\": \"123456\",
    \"BillRefNumber\": \"\",
    \"InvoiceNumber\": \"\",
    \"OrgAccountBalance\": \"0.00\",
    \"ThirdPartyTransID\": \"\",
    \"MSISDN\": \"${PHONE}\",
    \"FirstName\": \"${NAME}\",
    \"MiddleName\": \"\",
    \"LastName\": \"CUSTOMER\"
  }"

echo
echo "Open the tender panel on a till -- it should appear within ~3s."

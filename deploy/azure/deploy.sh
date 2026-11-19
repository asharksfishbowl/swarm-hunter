#!/usr/bin/env bash
# Deploys Swarm Hunter to Azure App Service (Linux container) and is safe to re-run for updates.
#
# Sign in first with `az login`, or set AZURE_CLIENT_ID, AZURE_CLIENT_SECRET and AZURE_TENANT_ID
# for a service principal. Optional: AZURE_SUBSCRIPTION_ID, AZURE_RESOURCE_GROUP (swarm-hunter),
# AZURE_LOCATION (westus2), AZURE_APP_NAME, AZURE_SKU (B1), AZURE_HUNTER_ACCESS_TOKEN.
set -euo pipefail

cd "$(dirname "$0")/../.."
rg_name="${AZURE_RESOURCE_GROUP:-swarm-hunter}"
location="${AZURE_LOCATION:-westus2}"
sku="${AZURE_SKU:-B1}"
token_file=".env.azure"

if ! az account show >/dev/null 2>&1; then
  if [[ -n "${AZURE_CLIENT_ID:-}" && -n "${AZURE_CLIENT_SECRET:-}" && -n "${AZURE_TENANT_ID:-}" ]]; then
    az login --service-principal --username "$AZURE_CLIENT_ID" --tenant "$AZURE_TENANT_ID" \
      --password "$AZURE_CLIENT_SECRET" --output none
  else
    echo "Not signed in to Azure. Run 'az login' or set AZURE_CLIENT_ID, AZURE_CLIENT_SECRET and AZURE_TENANT_ID." >&2
    exit 1
  fi
fi
if [[ -n "${AZURE_SUBSCRIPTION_ID:-}" ]]; then
  az account set --subscription "$AZURE_SUBSCRIPTION_ID"
fi
echo "Subscription: $(az account show --query name -o tsv)"

# The Azure token lives in its own file so a local .env token loaded in the shell is never sent to Azure.
token=""
if [[ -f "$token_file" ]]; then
  token="$(sed -n 's/^HUNTER_ACCESS_TOKEN=//p' "$token_file")"
fi
token="${token:-${AZURE_HUNTER_ACCESS_TOKEN:-}}"
if [[ -z "$token" ]]; then
  token="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
  umask 077
  printf 'HUNTER_ACCESS_TOKEN=%s\n' "$token" > "$token_file"
  echo "Generated a sign-in token and saved it to $token_file (git-ignored)."
fi

az provider register --namespace Microsoft.Web --wait --output none
az provider register --namespace Microsoft.ContainerRegistry --wait --output none
az provider register --namespace Microsoft.Storage --wait --output none
az group create --name "$rg_name" --location "$location" --output none

tag="$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)"
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then tag="$tag-dirty-$(date +%H%M%S)"; fi

push_image() {
  local registry="$1"
  local server
  server="$(az acr show --name "$registry" --query loginServer -o tsv)"
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    az acr login --name "$registry" --output none
    docker build --tag "$server/swarm-hunter:$tag" --tag "$server/swarm-hunter:latest" .
    docker push "$server/swarm-hunter:$tag"
    docker push "$server/swarm-hunter:latest"
  else
    az acr build --registry "$registry" --image "swarm-hunter:$tag" --image "swarm-hunter:latest" .
  fi
}

existing="$(az acr list --resource-group "$rg_name" --query "[?starts_with(name, 'swarmhunter')].name | [0]" -o tsv)"
if [[ -n "$existing" ]]; then
  push_image "$existing"
fi

params="$(mktemp)"
trap 'rm -f "$params"' EXIT
python3 - "$params" "$token" "$tag" "$sku" "$location" "${AZURE_APP_NAME:-}" <<'EOF'
import json, sys
path, token, tag, sku, location, app = sys.argv[1:]
values = {"accessToken": token, "imageTag": tag, "sku": sku, "location": location}
if app:
    values["appName"] = app
params = {k: {"value": v} for k, v in values.items()}
with open(path, "w") as f:
    json.dump({"$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
               "contentVersion": "1.0.0.0", "parameters": params}, f)
EOF

echo "Deploying infrastructure to resource group $rg_name ($location)..."
outputs="$(az deployment group create --resource-group "$rg_name" --name swarm-hunter \
  --template-file deploy/azure/main.bicep --parameters "@$params" \
  --query properties.outputs -o json)"
app="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["appName"]["value"])' "$outputs")"
registry="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["registryName"]["value"])' "$outputs")"
url="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["url"]["value"])' "$outputs")"

if [[ -z "$existing" ]]; then
  push_image "$registry"
fi
az webapp restart --resource-group "$rg_name" --name "$app" --output none

echo "Waiting for $url to come up (the first start downloads a 140 MB location database)..."
for _ in $(seq 1 60); do
  if curl -fsS --max-time 10 "$url/api/health" >/dev/null 2>&1; then
    echo "Live: $url  (sign in with the token in $token_file)"
    exit 0
  fi
  sleep 10
done
echo "Deployed, but $url is not answering yet. Check: az webapp log tail -g $rg_name -n $app" >&2
exit 1

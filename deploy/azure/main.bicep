@description('Web app name; becomes https://<name>.azurewebsites.net, so it must be globally unique.')
param appName string = 'swarm-hunter-${uniqueString(resourceGroup().id)}'

@description('Azure region for every resource.')
param location string = resourceGroup().location

@description('App Service plan size. B1 (1.75 GB) is enough; the app uses about 150 MB.')
param sku string = 'B1'

@description('Image tag in the registry, pushed by deploy.sh.')
param imageTag string = 'latest'

@secure()
@minLength(16)
@description('Access token for the console sign-in (16+ characters).')
param accessToken string

var suffix = uniqueString(resourceGroup().id)
var acrPullRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: 'swarmhunter${suffix}'
  location: location
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'swhunt${suffix}'
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
  }
}

resource files 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource share 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: files
  name: 'hunter-data'
  properties: {
    shareQuota: 5
  }
}

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: '${appName}-plan'
  location: location
  kind: 'linux'
  sku: { name: sku }
  properties: {
    reserved: true
  }
}

resource site 'Microsoft.Web/sites@2023-12-01' = {
  name: appName
  location: location
  kind: 'app,linux,container'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    clientAffinityEnabled: false
    siteConfig: {
      linuxFxVersion: 'DOCKER|${registry.properties.loginServer}/swarm-hunter:${imageTag}'
      acrUseManagedIdentityCreds: true
      alwaysOn: true
      http20Enabled: true
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      healthCheckPath: '/api/health'
      appSettings: [
        { name: 'WEBSITES_PORT', value: '43124' }
        { name: 'WEBSITES_ENABLE_APP_SERVICE_STORAGE', value: 'false' }
        { name: 'HUNTER_ACCESS_TOKEN', value: accessToken }
        { name: 'HUNTER_SECURE_COOKIE', value: '1' }
      ]
      azureStorageAccounts: {
        data: {
          type: 'AzureFiles'
          accountName: storage.name
          shareName: share.name
          mountPath: '/app/data'
          accessKey: storage.listKeys().keys[0].value
        }
      }
    }
  }
}

resource basicAuthFtp 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: site
  name: 'ftp'
  properties: { allow: false }
}

resource basicAuthScm 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: site
  name: 'scm'
  properties: { allow: false }
}

resource pull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, site.id, acrPullRole)
  properties: {
    roleDefinitionId: acrPullRole
    principalId: site.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output url string = 'https://${site.properties.defaultHostName}'
output appName string = site.name
output registryName string = registry.name

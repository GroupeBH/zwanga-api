param([Parameter(Mandatory=$true)][string]$PreflightStatePath)
$ErrorActionPreference = 'Stop'
$state = Get-Content -LiteralPath $PreflightStatePath -Raw | ConvertFrom-Json
$Region = $state.region
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Invoke-CheckedAws([string[]]$Arguments) {
  $result = & aws @Arguments --region $Region --output json --no-cli-pager
  if ($LASTEXITCODE -ne 0) { throw 'AWS activation command failed; inspect saved operation state before retrying.' }
  return ($result | ConvertFrom-Json)
}
function Save-Data([string]$Name, $Value) {
  $path = Join-Path $state.directory $Name
  [System.IO.File]::WriteAllText($path, ($Value | ConvertTo-Json -Depth 60), $utf8)
  return ('file://' + $path.Replace('\','/'))
}
if ($state.cluster -ne 'zwanga-api-production-cluster' -or $state.service -ne 'zwanga-api-production-api' -or
    $Region -ne 'eu-central-1') { throw 'Unexpected activation target.' }
if ([DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse($state.startedAt) -gt [TimeSpan]::FromMinutes(30)) { throw 'Preflight is too old.' }
$checkTask = (Invoke-CheckedAws @('ecs','describe-tasks','--cluster',$state.cluster,'--tasks',$state.taskArn)).tasks[0]
$checkApi = $checkTask.containers | Where-Object name -eq 'api'
if ($checkApi.exitCode -ne 0 -or $checkApi.imageDigest -ne $state.expectedDigest) { throw 'Preflight has not exited successfully with expected image.' }
$checkTaskId = ($state.taskArn -split '/')[-1]
$logs = Invoke-CheckedAws @('logs','get-log-events','--log-group-name','/ecs/zwanga-api-production/api','--log-stream-name',"api/api/$checkTaskId",'--limit','100')
$proofLines = @($logs.events | Where-Object { $_.message.StartsWith('ZWANGA_DISPATCH_PREFLIGHT ') })
if ($proofLines.Count -ne 1) { throw 'Preflight proof missing or ambiguous.' }
$proof = $proofLines[0].message.Substring('ZWANGA_DISPATCH_PREFLIGHT '.Length) | ConvertFrom-Json
foreach ($check in @('readOnly','schema','migrations','code','driverPayload','broadcastPreserved')) {
  if ($proof.$check -ne $true) { throw 'A prerequisite is not verified.' }
}
$service = (Invoke-CheckedAws @('ecs','describe-services','--cluster',$state.cluster,'--services',$state.service)).services[0]
if ($service.taskDefinition -ne $state.baselineTaskDefinition -or $service.deployments.Count -ne 1 -or
    $service.deployments[0].rolloutState -ne 'COMPLETED' -or $service.pendingCount -ne 0 -or
    $service.runningCount -ne $service.desiredCount) { throw 'Service changed since preflight.' }
$definitionResponse = Invoke-CheckedAws @('ecs','describe-task-definition','--task-definition',$state.baselineTaskDefinition,'--include','TAGS')
$definition = $definitionResponse.taskDefinition
$api = $definition.containerDefinitions | Where-Object name -eq 'api'
if ($api.image -notmatch '/([^/:]+):latest$') { throw 'Unexpected image reference.' }
$latest = (Invoke-CheckedAws @('ecr','describe-images','--repository-name',$Matches[1],'--image-ids','imageTag=latest')).imageDetails[0]
if ($latest.imageDigest -ne $state.expectedDigest) { throw 'Image changed since preflight.' }
if (@($api.secrets | Where-Object name -eq 'DRIVER_DISPATCH_ENABLED').Count -gt 0 -or
    @($api.environment | Where-Object name -eq 'DRIVER_DISPATCH_ENABLED').Count -gt 0) { throw 'Activation already configured; inspect rather than overwrite.' }
$parameterName = '/zwanga-api/production/env/DRIVER_DISPATCH_ENABLED'
$existing = Invoke-CheckedAws @('ssm','describe-parameters','--parameter-filters',"Key=Name,Option=Equals,Values=$parameterName")
if ($existing.Parameters.Count -ne 0) { throw 'SSM parameter already exists; inspect rather than overwrite.' }
$originalFile = Save-Data 'task-definition-before.json' $definitionResponse
$parameter = Invoke-CheckedAws @('ssm','put-parameter','--name',$parameterName,'--type','SecureString',
  '--key-id','alias/zwanga-api-production-application','--value','true',
  '--description','Enable automatic nearby driver dispatch after schema and notification preflight')
$null = Save-Data 'parameter-created.json' @{name=$parameterName;version=$parameter.Version;createdAt=[DateTimeOffset]::UtcNow.ToString('o')}
$accountId = ($state.baselineTaskDefinition -split ':')[4]
$api.secrets = @($api.secrets) + @([PSCustomObject]@{name='DRIVER_DISPATCH_ENABLED';valueFrom="arn:aws:ssm:${Region}:${accountId}:parameter$parameterName"})
$allowed = @('family','taskRoleArn','executionRoleArn','networkMode','containerDefinitions','volumes',
  'placementConstraints','requiresCompatibilities','cpu','memory','pidMode','ipcMode','proxyConfiguration',
  'inferenceAccelerators','ephemeralStorage','runtimePlatform','enableFaultInjection')
$registration = @{}
foreach ($field in $allowed) {
  if ($definition.PSObject.Properties.Name -contains $field -and $null -ne $definition.$field) { $registration[$field] = $definition.$field }
}
$registration.tags = @($definitionResponse.tags | Where-Object { -not $_.key.StartsWith('aws:') })
$registrationFile = Save-Data 'register-task-definition.json' $registration
$registered = Invoke-CheckedAws @('ecs','register-task-definition','--cli-input-json',$registrationFile)
$candidate = $registered.taskDefinition.taskDefinitionArn
$activation = @{baselineTaskDefinition=$state.baselineTaskDefinition;newTaskDefinition=$candidate;
  expectedDigest=$state.expectedDigest;parameterVersion=$parameter.Version;region=$Region;cluster=$state.cluster;service=$state.service;
  startedAt=[DateTimeOffset]::UtcNow.ToString('o');preflightStatePath=$PreflightStatePath}
$null = Save-Data 'activation.json' $activation
# Re-check immediately before changing the service. Do not overwrite a concurrent rollout.
$fresh = (Invoke-CheckedAws @('ecs','describe-services','--cluster',$state.cluster,'--services',$state.service)).services[0]
if ($fresh.taskDefinition -ne $state.baselineTaskDefinition -or $fresh.deployments.Count -ne 1 -or
    $fresh.deployments[0].rolloutState -ne 'COMPLETED') { throw 'Concurrent rollout detected; candidate registered but service left unchanged.' }
$deployed = Invoke-CheckedAws @('ecs','update-service','--cluster',$state.cluster,'--service',$state.service,'--task-definition',$candidate)
[PSCustomObject]@{newTaskDefinition=$candidate;oldTaskDefinition=$state.baselineTaskDefinition;
  deploymentStarted=$true;activationState=(Join-Path $state.directory 'activation.json');
  desired=$deployed.service.desiredCount;running=$deployed.service.runningCount} | ConvertTo-Json

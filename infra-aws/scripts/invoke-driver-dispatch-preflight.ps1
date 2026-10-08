param(
  [string]$Region = 'eu-central-1',
  [string]$Cluster = 'zwanga-api-production-cluster',
  [string]$Service = 'zwanga-api-production-api'
)
$ErrorActionPreference = 'Stop'
function Invoke-CheckedAws([string[]]$Arguments) {
  $result = & aws @Arguments --region $Region --output json --no-cli-pager
  if ($LASTEXITCODE -ne 0) { throw 'AWS preflight command failed.' }
  return ($result | ConvertFrom-Json)
}
$serviceData = (Invoke-CheckedAws @('ecs','describe-services','--cluster',$Cluster,'--services',$Service)).services[0]
if ($serviceData.status -ne 'ACTIVE' -or $serviceData.runningCount -ne $serviceData.desiredCount -or
    $serviceData.pendingCount -ne 0 -or $serviceData.deployments.Count -ne 1 -or
    $serviceData.deployments[0].rolloutState -ne 'COMPLETED') { throw 'Service is not stable; abort.' }
$running = @((Invoke-CheckedAws @('ecs','list-tasks','--cluster',$Cluster,'--service-name',$Service,'--desired-status','RUNNING')).taskArns)
if ($running.Count -ne 1) { throw 'Expected one running API task; review before proceeding.' }
$task = (Invoke-CheckedAws @('ecs','describe-tasks','--cluster',$Cluster,'--tasks',$running[0])).tasks[0]
$api = $task.containers | Where-Object name -eq 'api'
$definition = (Invoke-CheckedAws @('ecs','describe-task-definition','--task-definition',$serviceData.taskDefinition)).taskDefinition
$apiDefinition = $definition.containerDefinitions | Where-Object name -eq 'api'
if ($apiDefinition.image -notmatch '/([^/:]+):latest$') { throw 'Expected existing latest image workflow; review image before proceeding.' }
$repository = $Matches[1]
$latest = (Invoke-CheckedAws @('ecr','describe-images','--repository-name',$repository,'--image-ids','imageTag=latest')).imageDetails[0]
if ($latest.imageDigest -ne $api.imageDigest -or $task.healthStatus -ne 'HEALTHY') { throw 'Image changed or service unhealthy; abort.' }

# Compress only this reviewed source, not environment values, into the ECS command.
$source = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'check-driver-dispatch.cjs'))
$sourceBytes = [System.Text.Encoding]::UTF8.GetBytes($source)
$memory = New-Object System.IO.MemoryStream
$gzip = New-Object System.IO.Compression.GZipStream($memory, [System.IO.Compression.CompressionMode]::Compress, $true)
$gzip.Write($sourceBytes, 0, $sourceBytes.Length)
$gzip.Dispose()
$encoded = [Convert]::ToBase64String($memory.ToArray())
$memory.Dispose()
$code = "eval(require('node:zlib').gunzipSync(Buffer.from('$encoded','base64')).toString())"
$overrides = @{containerOverrides=@(@{name='api';command=@('node','-e',$code)})}
if (($overrides | ConvertTo-Json -Depth 10 -Compress).Length -gt 8000) { throw 'Preflight overrides exceed ECS budget.' }
$operationId = [guid]::NewGuid().ToString('N')
$operationDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ('zwanga-dispatch-preflight-' + $operationId)
New-Item -ItemType Directory -Path $operationDirectory | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)
$requestPath = Join-Path $operationDirectory 'run-task.json'
$request = @{cluster=$Cluster; taskDefinition=$serviceData.taskDefinition; launchType='FARGATE';
  networkConfiguration=$serviceData.networkConfiguration; overrides=$overrides;
  startedBy='zwanga-dispatch-preflight'; clientToken=$operationId}
if ($task.platformVersion) { $request.platformVersion = $task.platformVersion }
[System.IO.File]::WriteAllText($requestPath, ($request | ConvertTo-Json -Depth 30), $utf8)
$response = Invoke-CheckedAws @('ecs','run-task','--cli-input-json',('file://' + $requestPath.Replace('\','/')))
if ($response.failures.Count -gt 0 -or $response.tasks.Count -ne 1) { throw 'Preflight task was not started successfully.' }
$state = @{taskArn=$response.tasks[0].taskArn; expectedDigest=$api.imageDigest;
  baselineTaskDefinition=$serviceData.taskDefinition; baselineTaskArn=$task.taskArn;
  cluster=$Cluster; service=$Service; region=$Region;
  startedAt=[DateTimeOffset]::UtcNow.ToString('o'); directory=$operationDirectory}
[System.IO.File]::WriteAllText((Join-Path $operationDirectory 'state.json'), ($state | ConvertTo-Json -Depth 6), $utf8)
$state | ConvertTo-Json -Depth 6

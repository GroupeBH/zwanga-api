# Échantillonnage distant X-Ray avec ADOT sur ECS

## Objectif

Zwanga utilise l'auto-instrumentation ADOT Node.js pour créer des traces OpenTelemetry. Le sidecar AWS OpenTelemetry Collector reçoit ces traces et les exporte vers AWS X-Ray. Les règles d'échantillonnage centralisées sont lues via l'extension `awsproxy` du collecteur.

## Flux attendu

```text
Requête HTTP / Socket.IO
        |
        v
Auto-instrumentation ADOT Node.js
        |
        | règles: HTTP 127.0.0.1:2000
        v
ADOT awsproxy -------------> API AWS X-Ray Sampling
        |
        | traces: OTLP HTTP 127.0.0.1:4318
        v
ADOT Collector ------------> AWS X-Ray PutTraceSegments
```

Les conteneurs d'une même tâche ECS utilisant `awsvpc` partagent l'interface réseau de la tâche. L'application peut donc joindre le sidecar sur `127.0.0.1`. Le Security Group ECS n'ouvre pas les ports `2000`, `4317` ou `4318` à Internet ; ces communications restent internes à la tâche.

## Configuration de l'application

| Variable | Valeur | Rôle |
| --- | --- | --- |
| `NODE_OPTIONS` | chargement du registre ADOT Node.js | active l'auto-instrumentation avant NestJS |
| `OTEL_TRACES_EXPORTER` | `otlp` | envoie les traces au collecteur |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://127.0.0.1:4318` | endpoint OTLP HTTP du sidecar |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | protocole correspondant au receiver HTTP |
| `OTEL_TRACES_SAMPLER` | `xray` | active le sampler distant X-Ray |
| `OTEL_TRACES_SAMPLER_ARG` | endpoint local et intervalle de 300 secondes | indique où lire les règles |
| `OTEL_PROPAGATORS` | `xray` | propage le contexte X-Ray |

La valeur `xray_sampling_rate` n'est pas passée comme argument au sampler Node. Elle configure `aws_xray_sampling_rule.application` dans AWS. Le sampler récupère cette règle via `awsproxy`.

## Configuration du collecteur

Le collecteur expose :

- `4317/TCP` pour OTLP gRPC ;
- `4318/TCP` pour OTLP HTTP/protobuf ;
- `2000/TCP` pour le proxy HTTP des règles X-Ray.

Sa configuration contient :

```yaml
extensions:
  awsproxy:
    endpoint: 0.0.0.0:2000

service:
  extensions: [awsproxy]
```

L'image est épinglée sur une version précise. Une montée de version doit faire l'objet d'une nouvelle entrée dans le journal, d'une lecture des notes de version et d'un test de démarrage en tâche ECS avant le déploiement du service.

## IAM

Le rôle de tâche ECS doit conserver :

- `xray:GetSamplingRules` ;
- `xray:GetSamplingTargets` ;
- `xray:GetSamplingStatisticSummaries` ;
- `xray:PutTraceSegments` ;
- `xray:PutTelemetryRecords`.

Le rôle d'exécution ECS n'a pas besoin de ces permissions : il sert notamment à charger l'image, les logs et les paramètres SSM. C'est le rôle de tâche partagé par l'application et le sidecar qui appelle X-Ray.

## Symptôme d'une configuration incomplète

Le message suivant toutes les cinq minutes indique que `OTEL_TRACES_SAMPLER=xray` est actif mais que le proxy n'écoute pas :

```text
Error occurred when making an HTTP POST to http://localhost:2000/GetSamplingRules
ECONNREFUSED 127.0.0.1:2000
```

Ce message concerne l'échantillonnage des traces. Il ne prouve pas à lui seul que la requête métier a échoué. Lorsque les règles distantes sont indisponibles, le SDK utilise son sampler de repli, mais répète la tentative à chaque intervalle.

## Validation après déploiement

1. Vérifier que les conteneurs `api` et `aws-otel-collector` sont `RUNNING`.
2. Vérifier dans les logs du collecteur le démarrage de l'extension `awsproxy` sur `0.0.0.0:2000`.
3. Effectuer plusieurs requêtes API authentifiées et non authentifiées.
4. Attendre plus de cinq minutes et confirmer l'absence de nouveau `ECONNREFUSED`.
5. Vérifier l'apparition de traces récentes dans X-Ray.
6. Vérifier que les endpoints métier conservent leurs codes HTTP et latences habituels.

## Retour arrière

Le retour arrière consiste à restaurer la révision précédente de la définition ECS. Cela rétablit la collecte OTLP mais réintroduit les erreurs du sampler distant. Une alternative temporaire consiste à utiliser un sampler local `parentbased_traceidratio` avec le taux souhaité ; dans ce cas, les règles centralisées Terraform ne sont plus appliquées et ce changement doit être documenté séparément.

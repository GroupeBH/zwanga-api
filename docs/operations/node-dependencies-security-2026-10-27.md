# Node et dependances : securite - 27 octobre 2026

Perimetre : backend NestJS, execution Node, construction Docker et CI. Aucun deploiement ni migration.

## Corrections appliquees

- Node 24.22.1 LTS fixe dans `.nvmrc`, `engines.node`, le Dockerfile et les workflows deploy/deploy-staging. Compose transmet maintenant `NODE_VERSION`, effectivement lu par le Dockerfile.
- Audit initial npm : 30 paquets affectes (16 eleves, 14 moderes), y compris dependances indirectes et outils de developpement.
- Multer 2.5.0, PM2 7.1.1 et mises a jour compatibles du lockfile, dont body-parser, follow-redirects, Zod, brace-expansion et fast-uri.
- Substitutions explicites : gRPC 1.14.6, js-yaml 5.4.1 pour Swagger, huit instrumentations OpenTelemetry aux premieres versions corrigees. Les autres substitutions historiques sont conservees.
- `npm run check:security` permet de relancer l audit npm, avec echec a partir du niveau eleve. Le controle n est pas impose au demarrage de l API.

## Comportements conserves

NestJS 11, TypeORM et les schemas de donnees sont conserves. Le registre ADOT utilise par ECS reste disponible. Les dependances Firebase ne sont pas retrogradees. Aucun secret ou fichier .env n est lu par ces controles.

## Verifications et limites

- Audit final npm, dependances de developpement comprises : **0 vulnerabilite connue signalee** le 27 octobre 2026 (contre 30 initialement).
- Compilation NestJS reussie sous Node 24.22.1.
- Cinq nouveaux tests d integration des dependances reussis : upload HTTP Multer et rejet des fichiers trop volumineux, aller-retour gRPC local, construction des instrumentations ADOT, traitement d image Sharp et mots de passe bcrypt, serialisation YAML de Swagger. Aucun fournisseur distant contacte.
- Ces tests sont exposes par `npm run test:dependencies` et integres aux deux workflows existants avant compilation/deploiement. Aucun workflow n a ete declenche.
- Suite Jest complete : 239 suites reussies, deux en echec et 29 ignorees ; 2849 tests reussis, quatre en echec et 494 ignores. Les suites d integration optionnelles n ont pas ete activees avec une base dediee.
- Trois echecs concernaient les tests HTTP OAuth (depassements de cinq secondes et assertion suivante). Le quatrieme executait une ancienne simulation de dispatch. Des tests de notifications/dispatch ont ete modifies parallelement, hors de ce correctif Node/dependances, et conserves.
- Apres reduction des taches simultanees, nouvelle execution isolee des quatre suites OAuth/dispatch/notifications/claims concernees ou modifiees : **71 tests reussis, aucun echec**, sans augmenter les delais. La suite complete n a pas ete executee une seconde fois.
Une premiere installation npm ci a rencontre un verrou Windows sur la DLL Sharp utilisee par un processus existant. Ce processus utilisateur n a pas ete arrete ; installation terminee avec `npm install --ignore-scripts --include=dev`, sans suppression globale des modules. Une installation entierement neuve reste a verifier en CI/Linux.
Le binaire de test Node 24.22.1 est temporaire et verifie par SHA-256. Le Node global et les serveurs deja demarres ne sont pas remplaces. Les alertes npm ne constituent ni un test d intrusion ni un audit des images systeme et bibliotheques natives.

## Sources

- https://nodejs.org/en/blog/release/v24.22.1
- https://github.com/open-telemetry/opentelemetry-js-contrib/security/advisories/GHSA-qqmp-wf37-98f9

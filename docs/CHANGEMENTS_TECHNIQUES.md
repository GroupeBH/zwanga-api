# Journal des changements techniques

## 15 octobre 2026 — Réception interrompue du profil : diagnostic HTTP fiable

- **Problème constaté :** une interruption de `PUT /users/me` était journalisée
  comme une erreur serveur 500 par `LoggingInterceptor`, alors que le filtre
  global connaissait déjà certaines erreurs de réception. Cet événement isolé
  ne démontre pas la cause des fermetures Android après connexion.
- **Solution appliquée :** `src/common/http-request-abort.ts` centralise la
  reconnaissance de ces interruptions, y compris `ECONNRESET` + `aborted`.
  `src/common/interceptors/logging.interceptor.ts` laisse le filtre produire
  l'avertissement regroupé, sans doublon ni faux 500. Les statuts HTTP 4xx
  identifiés sont des avertissements ; les 5xx restent des erreurs. Les erreurs
  non standard ne font plus échouer le logger lors de leur lecture.
  `src/common/filters/api-exception.filter.ts` utilise le même classificateur.
- **Comportements conservés :** message français `REQUEST_ABORTED`/400 si la
  réponse est encore possible, absence de réponse sur connexion fermée,
  authentification, droits, validation et limites d'images, arrêt avant le
  gestionnaire métier en cas de multipart incomplet. Un `ECONNRESET` générique
  d'un service externe n'est pas assimilé à une réception interrompue. Aucun
  changement de schéma, de dépendance, de délai serveur ou de configuration AWS.
- **Tests :** `logging.interceptor.spec.ts`, `api-exception.filter.spec.ts`,
  `profile-upload-abort.spec.ts` et `auth/session-error.spec.ts` : **34 tests
  réussis**. Le test multipart ouvre un vrai serveur Nest HTTP local, envoie
  des données synthétiques incomplètes et coupe le client ; le gestionnaire ne
  s'exécute pas. Un envoi complet suivant réussit. Ni compte réel ni DB utilisés.
- **Vérifications :** `tsc -p tsconfig.build.json --noEmit --incremental false`
  et `git diff --check` réussis. `tsc` incluant toutes les specs reste en échec
  dans des tests hors périmètre non modifiés ; ne pas assimiler le build valide
  à une suite globale de tests entièrement validée.
- **Livraison et limites :** code prêt à intégrer au déploiement habituel, pas
  encore déployé ici. Aucune migration ou nouvelle variable requise. La correction
  supprime le diagnostic erroné, elle ne répare pas une connexion interrompue et
  ne démontre pas la résolution du crash natif Android. Le client mobile reçoit
  séparément un budget d'envoi du profil de 60 s, une session à propriétaire
  unique et des rapports de diagnostic complémentaires.

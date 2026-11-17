# Unicité des numéros de téléphone

Les écritures RDC `0891234567`, `891234567`, `243891234567`, `00243891234567`
et `+243891234567` désignent désormais une même identité de compte. Le backend
utilise les mêmes règles que l'OTP. Un indicatif international explicite est
conservé : les numéros étrangers ne deviennent pas des numéros RDC.

## Comportement

- Les inscriptions classiques, Google et Apple enregistrent les nouveaux numéros
  au format international avec `+`. La création d'administrateurs suit ces règles.
- La connexion mobile et admin, le PIN oublié et la vérification téléphonique
  retrouvent également les anciens comptes enregistrés au format local ou avec espaces.
- Depuis le correctif local du 11 novembre, la connexion mobile/admin, le PIN
  oublié et la vérification téléphonique ignorent les comptes désactivés
  (`isActive=false` **ou** `status=inactive`). Un seul compte non désactivé doit
  rester pour cette identité ; sinon aucun compte n'est sélectionné. Le compte
  désactivé ne peut pas être choisi, même si son numéro possède déjà `+243`.
- Un compte `pending_kyc` actif compte toujours. Un compte suspendu mais non
  désactivé compte aussi et reste interdit de connexion : la suspension n'est
  pas une libération automatique d'identité. La réponse du PIN oublié reste
  neutre pour ne pas révéler les comptes inscrits. Elle ne prouve pas un envoi SMS.
- Les sessions existantes ne sont pas révoquées par la migration. Les UUID,
  téléphones historiques, trajets, soldes, bonus et parrainages restent inchangés.
- Un changement réel de numéro vérifie les équivalences. Une simple différence
  de format dans un profil ne réinitialise pas la vérification téléphonique.
- Les anciennes applications peuvent continuer à envoyer un numéro local : la
  normalisation est effectuée côté serveur, pas seulement dans les formulaires.

## Protection PostgreSQL

La migration `CanonicalPhoneIdentity1780000119000` ajoute une fonction immutable,
un index d'identité et la table technique `user_phone_identities`. Une réservation
unique protège chaque numéro contre les inscriptions et modifications concurrentes,
y compris les écritures qui ne passent pas par le service d'inscription.

Une identité historique en conflit est réservée avec un propriétaire NULL.
Elle ne peut pas être réattribuée automatiquement. Les autres écritures sur ces
comptes restent possibles. Les nouvelles insertions et les modifications effectives
de téléphone sont normalisées par un trigger. Les numéros historiques malformés ne
sont pas réécrits ; ils nécessitent une vérification par le support.

La politique existante de réinscription pour un compte indisponible est conservée
uniquement en l'absence de conflit historique. Sa libération de numéro et la création
du nouveau compte sont atomiques. Aucun historique financier n'est transféré.

## Déploiement

1. Sauvegarder la base et tester la migration sur une copie isolée.
2. Exécuter les migrations avant de lancer ce nouveau code. Les recherches
   d'identité nécessitent la fonction PostgreSQL ; ne pas démarrer cette version
   contre un schéma non migré.
   Coordonner ce déploiement : pendant la coexistence avec l'ancien code, une
   inscription locale normalisée par le trigger peut ne plus être retrouvée par
   la recherche exacte de l'ancienne version. Ne pas laisser cet état transitoire
   se prolonger.
3. La migration limite l'attente d'un verrou à 3 secondes et chaque instruction à
   30 secondes. En cas de contention, elle échoue et sa transaction est annulée ;
   replanifier l'exécution, sans désactiver la protection.
4. Exécuter `phone-identity-audit.sql` via une connexion explicitement choisie et
   autorisée. Le diagnostic est en lecture seule, limite les détails à 200 groupes
   et masque les numéros. Garder ses résultats dans les outils internes du support.
5. Contrôler un compte historique unique et une nouvelle inscription, avec les
   variantes locale et internationale. Les tests SMS réels exigent un numéro
   contrôlé et une autorisation distincte.

Aucun déploiement ni diagnostic de données de production n'est déclenché par ces
fichiers. Une nouvelle version mobile n'est pas nécessaire à cette protection.

## Traitement des doublons existants

Ne pas choisir automatiquement le compte le plus ancien, le plus récent ou celui
dont le numéro possède déjà `+243`. Une preuve SMS ne permet pas à elle seule de
décider quel historique financier doit être conservé.

Pour chaque groupe, le support doit vérifier le titulaire, les justificatifs et les
historiques, puis faire approuver les UUID à conserver ou à dissocier du numéro.
Toute correction doit être journalisée, révoquer les sessions appropriées et rester
dans une transaction. Conserver les UUID et écritures financières des deux comptes.
Ne supprimer aucun compte et ne transférer aucun solde dans une normalisation.

Après cette décision seulement, une intervention contrôlée peut dissocier le
numéro des comptes non retenus et attribuer la réservation au compte retenu, puis
normaliser son téléphone. La réservation NULL reste volontairement bloquante tant
que cette intervention n'a pas été réalisée. Aucun script de fusion ou de choix
automatique de titulaire n'est fourni.

Le correctif de connexion du 11 novembre ne modifie ni ces réservations ni les
contrôles d'inscription, de changement de numéro ou de provisionnement admin.
Une désactivation validée par le support peut désormais laisser un seul compte
authentifiable, sans fusion ni réattribution du numéro dans les données. Si un
doublon est réactivé, la connexion redevient ambiguë et est bloquée. Les rôles,
UUID, soldes et historiques ne passent jamais d'un compte à l'autre.

Ce correctif est applicatif : aucune nouvelle migration n'est nécessaire si
`CanonicalPhoneIdentity1780000119000` est déjà appliquée. Il faut déployer le
backend corrigé pour changer le comportement de production. Les groupes `710`
et `654` diagnostiqués le 11 novembre avaient encore trois comptes non désactivés
chacun : ce changement seul ne les départage pas.

## Retour arrière

Revenir d'abord au code précédent, puis exécuter le `down` de cette migration
uniquement lorsque toutes les instances du nouveau code sont arrêtées. Le `down`
retire les objets techniques sans supprimer de compte ni modifier ses données.
Les numéros des comptes créés depuis la migration restent internationaux. Le retour
arrière retire aussi la protection contre les doublons de formats.

## Vérification locale

Les tests PostgreSQL se lancent avec `PHONE_REGISTRATION_TEST_POSTGRES_BIN` pointant
vers le dossier des binaires PostgreSQL, puis :

```text
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/database/registration-phone-postgres.spec.ts
```

Ils créent et suppriment une base temporaire isolée, sans lire `.env`. Ils couvrent
les variantes, les collisions historiques, les créations concurrentes, les erreurs
de modification, les annulations de transaction, le PIN oublié et le retour arrière.

Validation locale du 10 novembre 2026 :

- 29 tests PostgreSQL 18 réussis, migration aller et retour comprise.
- 441 tests réussis dans la sélection élargie authentification, OTP, comptes admin,
  profils, filtre d'erreurs et registre des migrations.
- 17 tests Redis de la sélection élargie ignorés faute d'activation de leur environnement dédié.
- Compilation TypeScript sans émission et contrôle des espaces du diff réussis.

Les appels aux fournisseurs SMS sont simulés dans ces tests. La migration n'a été
appliquée qu'aux bases temporaires des tests, ni à la base de travail ni à AWS.

Validation du correctif du 11 novembre 2026 :

- 41 tests PostgreSQL isolés réussis, dont connexion mobile/admin avec doublon
  désactivé, PIN erroné, sélection du compte au format local, OTP de réinitialisation,
  vérification du téléphone, plusieurs comptes actifs, tous désactivés, suspension,
  réactivation et conservation des historiques/réservations.
- 76 tests unitaires ciblés réussis (identité téléphonique, inscriptions et PIN).
- Passe élargie terminée avant le correctif OTP de reconnexion : 316 suites
  réussies, 45 ignorées ; 3 837 tests réussis, 940 ignorés. TypeScript sans émission
  et contrôle des espaces du diff réussis. Les tests ignorés ne sont pas validés.
- Aucun SMS réel, aucune désactivation automatique et aucune écriture AWS.

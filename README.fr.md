<h1 align="center">dsh-desktop-statusbar</h1>

<p align="center">
  <a href="https://github.com/raphael-y7/dsh-desktop-statusbar/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/raphael-y7/dsh-desktop-statusbar?style=flat&logo=github&color=f5f5f5"></a>
  <a href="https://www.npmjs.com/package/dsh-desktop-statusbar"><img alt="npm downloads" src="https://img.shields.io/npm/dt/dsh-desktop-statusbar?style=flat&logo=npm&label=downloads&color=e74c3c"></a>
  <a href="https://www.npmjs.com/package/dsh-desktop-statusbar"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-desktop-statusbar?style=flat&color=9B59B6"></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DeepSeek Harness" src="https://img.shields.io/github/v/tag/deepseek-ai/deepseek-harness?label=DeepSeek%20Harness&color=4d6bfe"></a>
  <a href="https://awesome-dsh-plugin.com/p/raphael-y7/dsh-desktop-statusbar/"><img alt="dshmarket" src="https://img.shields.io/badge/dshmarket-listed-%23e6b800?style=flat"></a>
  <a href="https://dshfind.com/zh/plugins/raphael-y7/dsh-desktop-statusbar"><img alt="dshfind" src="https://img.shields.io/badge/dshfind-listed-%2300897B?style=flat"></a>
  <a href="https://deepseek1024.com/plugins/Rapheal-Y7/dsh-desktop-statusbar"><img alt="1024Store" src="https://img.shields.io/badge/1024Store-listed-%23e67e22?style=flat"></a>
  <br>
  <a href="https://nodejs.org/"><img alt="node" src="https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-%230099cc?style=flat"></a>
  <img alt="language" src="https://img.shields.io/badge/javascript-100%25-%23ec407a?style=flat">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-%2327ae60?style=flat"></a>
</p>

<p align="center"><a href="README.md">简体中文</a> | <a href="README.en.md">English</a> | <a href="README.ja.md">日本語</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.de.md">Deutsch</a> | <a href="README.ru.md">Русский</a> | <a href="README.pt.md">Português</a></p>

Remplace la ligne de statistiques sous le champ de saisie des messages de l'application de bureau DSH par une barre d'état configurable : les champs, l'ordre, les prix par modèle et la devise sont tous configurables, avec des estimations de coût en temps réel selon les tarifs officiels heures pleines / heures creuses de DeepSeek.

https://github.com/user-attachments/assets/73f78ed6-cca3-433c-9a96-e1e579fcb2a1

## Fonctionnalités

- **9 champs facultatifs plus l'anneau de contexte** : occupation du contexte (l'anneau en tête de la barre), vérification heures pleines / creuses, tours et étapes, taux de réussite du cache, vitesse de sortie, TTFT, durée d'exécution, coût de ce tour, coût de la session, solde
- **Cliquez sur un champ pour les détails** :

  | Champ | Contenu |
  | --- | --- |
  | Anneau de contexte (tête de barre) | Invite système / définitions d'outils / messages |
  | Vérification heures pleines / creuses | Carte thermique d'utilisation : jour / semaine / mois / année |
  | Tours et étapes | Compactages du contexte / compétences injectées / appels d'outils |
  | Réussite combinée | Taux de réussite du cache de ce tour / le plus élevé / le plus bas |
  | TPS | Vitesse de ce tour / la plus rapide / la plus lente |
  | TTFT | Délai du premier jeton de ce tour / le plus rapide / le plus lent |
  | Durée d'exécution | Temps d'attente / temps du modèle / appels d'outils |
  | Coût de ce tour | Répartition des jetons de ce tour |
  | Coût de la session | Répartition cumulée des jetons de cette session |
  | Solde | Solde rechargé / solde offert / quota restant |

- **Exploration des données de session** : les compactages du contexte marquent le nœud où ils ont eu lieu, les compétences injectées comptent les compétences injectées dans cette session, et les appels d'outils listent chaque outil utilisé par la session avec son nombre d'appels ; cliquez sur le titre pour remonter
- **Vérification et mise à jour de version** : DSH recherche la dernière version au démarrage, affiche un indice à côté de l'élément de navigation « Barre d'état » lorsqu'une version est disponible, et propose un bouton de mise à jour en un clic dans les paramètres
- **Soutien GitHub** : le bouton ouvre la page du projet GitHub, où vous pouvez ajouter une étoile au projet.
- **Estimation des coûts** : tarifée selon les règles officielles heures pleines / heures creuses ; chaque appel est calculé à partir du moment où il a eu lieu et du modèle utilisé
- **Grille tarifaire** : vos propres prix, une répartition facultative heures pleines / heures creuses et un sélecteur de devise CNY / USD
- **Aussi** : mises à jour automatiques des jours fériés, solde rafraîchi chaque minute, 8 langues d'interface (chinois simplifié / English / 日本語 / Español / Français / Deutsch / Русский / Português)

## Installation

Dans l'application de bureau DSH, ouvrez **Modules → Ajouter un module** et installez par nom de paquet :

```
dsh-desktop-statusbar
```

Lorsque le registre npm n'est pas accessible, la même boîte de dialogue propose le miroir de Chine continentale comme source d'installation. Une URL de dépôt GitHub est également acceptée :

```
https://github.com/raphael-y7/dsh-desktop-statusbar
```

Ligne de commande :

```powershell
dsh plugin --profile desktop add dsh-desktop-statusbar
```

### Installer depuis npm

Les deux méthodes ci-dessus installent depuis le registre npm ; le nom du paquet est `dsh-desktop-statusbar`. Pour vérifier la version actuelle sur npm :

```powershell
npm view dsh-desktop-statusbar version
```

### Quand le programme de mise à jour intégré échoue

Le bouton de mise à jour en un clic intégré peut échouer sur certaines versions de bureau, soit en ne répondant pas, soit en signalant une erreur. Dans ce cas, utilisez l'entrée d'installation officielle et **ajoutez `@version` au nom du paquet** pour installer la version exacte :

```powershell
dsh plugin --profile desktop add dsh-desktop-statusbar@3.0.5
```

La même chaîne fonctionne dans le panneau des modules : saisissez `dsh-desktop-statusbar@3.0.5` dans le champ **Ajouter un module**.

Utilisez la dernière version actuelle (celle affichée sur la page de publication ou dans la sortie de `npm view` ci-dessus). Épingler la version garantit aussi que **vous installez exactement la compilation cible**, en évitant un paquet en cache obsolète.

Également répertorié sur [dshmarket](https://awesome-dsh-plugin.com/p/raphael-y7/dsh-desktop-statusbar/), [dshfind](https://dshfind.com/zh/plugins/raphael-y7/dsh-desktop-statusbar) et [1024Store](https://deepseek1024.com/plugins/Rapheal-Y7/dsh-desktop-statusbar).

## Utilisation

Ouvrez **Paramètres → Barre d'état** :

![Settings page](docs/settings.en.png)

- **Occupation du contexte** : l'anneau en tête de la barre — la progression montre la part de contexte utilisée, l'écart marque le seuil de compactage, et la couleur montre l'état d'exécution (inactif-gris / en cours-vert / sous-agent en cours-bleu / sous-agent plus profond en cours-violet / erreur-rouge / en attente d'approbation-ambre)
- **Champs de statistiques** : les cases ne contrôlent que la visibilité, donc décocher masque un champ sans le déplacer ; faites glisser la poignée à droite pour réorganiser ; « Réinitialiser les paramètres » restaure l'ordre d'usine
- **Prix de modèle personnalisés** : saisissez un nom de modèle et « Ajouter » pour créer une entrée ; « Modifier » ouvre l'éditeur et les changements sont écrits à l'enregistrement ; cochez « tarification heures pleines / creuses » pour diviser par moment de la journée, sinon un prix forfaitaire toute la journée s'applique
- **Devise** : CNY ou USD dans le coin supérieur droit de l'éditeur. La changer remplace les deux modèles intégrés par les prix de référence officiels de cette devise (les entrées modifiées sont conservées) et change le symbole dans les champs de coût ; le solde suit la devise indiquée par l'API
- **Jours fériés** : récupère et écrit automatiquement le calendrier de l'année suivante après le 31 décembre de chaque année
- **Solde** : rafraîchi une fois par minute

### Règles de facturation

Les heures pleines sont **09:00–12:00 et 14:00–18:00 heure de Pékin, du lundi au vendredi**, et les tarifs heures creuses sont la moitié des tarifs heures pleines ; les jours fériés publics chinois et les week-ends sont facturés heures creuses toute la journée (conforme à la [documentation officielle](https://api-docs.deepseek.com/quick_start/pricing), vérifié en 2026-09).

![Custom model prices](docs/pricing.en.png)

## Consultation du solde du relais

Lors de la consultation d'un solde, la barre d'état choisit la méthode de consultation selon **la plateforme réellement utilisée par la session en cours**, en deux cas : correspondance automatique et configuration manuelle.

### 1. Correspondance automatique

Lorsque le relais est configuré comme un provider ordinaire sur la page **Modèles** de DSH (avec une baseURL et une clé API), le module utilise cette clé pour sonder en parallèle les points de terminaison de solde courants ci-dessous ; dès qu'un point de terminaison analysable répond, le solde est affiché sans configuration supplémentaire :

- `/v1/usage`
- `/v1/user/self`, `/api/user/self`, `/api/v1/user/self`
- `/api/usage`
- `/v1/dashboard/billing/credit_grants`
- `/v1/credits`

Si le point de terminaison de solde du site relève de l'une des formes standard ci-dessus et est lisible via `Authorization: Bearer <clé API>`, le solde est affiché automatiquement.

### 2. Configuration manuelle

Dans l'un des cas suivants, vous devez ajouter une entrée de plateforme dans **Paramètres → Barre d'état → Prix de modèle personnalisés → Plateforme** et renseigner le point de terminaison et les identifiants :

- le provider n'a pas de baseURL configurée sur la page **Modèles** ;
- le point de terminaison de solde ou le mode d'authentification ne relève pas d'une forme standard (par exemple, New API nécessite un en-tête de requête supplémentaire avec l'ID utilisateur) ;
- la structure de réponse du point de terminaison ne peut pas être analysée automatiquement.

Les champs sont définis comme suit :

| Champ | Description | Exemple |
| --- | --- | --- |
| En-tête de requête | Nom de l'en-tête de requête utilisé pour l'ID utilisateur ; l'authentification par jeton utilise toujours `authorization: Bearer` et n'a pas à être renseignée | `New-Api-User` |
| ID utilisateur | L'identifiant utilisateur pour l'en-tête de requête ci-dessus | `12345` |
| Jeton | New API : saisissez le « jeton d'accès » (le jeton d'accès système dans les paramètres personnels) ; Sub2API : saisissez le « jeton de connexion » ; relais ordinaire : saisissez la clé `sk-` utilisée pour les appels de modèle | `sk-...` |
| Adresse de consultation du solde | URL complète du point de terminaison de solde | `https://example.com/api/user/self` |
| Champ de solde | Symbole de devise, chemin de champ et diviseur, au format `<devise><chemin de champ> / <diviseur>` | `$data.quota / 500000` |
| Modèles applicables | Les modèles rattachés à cette plateforme | — |
| Multiplicateur de coût | Multiplicateur de tarification, par défaut 1 | `1` |

#### Exemple 1 : site compatible New API

- Adresse de consultation du solde : `https://example.com/api/user/self`
- Champ de solde : `$data.quota / 500000` (ce site compte 500000 de quota pour 1 yuan)
- Jeton : le jeton d'accès généré dans les paramètres personnels (pas une clé d'appel de modèle)
- En-tête de requête : `New-Api-User` ; ID utilisateur : l'ID utilisateur du compte

#### Exemple 2 : site Sub2API

Le point de terminaison de solde des sites Sub2API prend couramment l'une des deux formes suivantes ; choisissez selon la situation réelle du site :

- Prend en charge `GET /v1/usage` compatible OpenAI (authentification avec la clé de modèle `sk-`) : généralement mis en correspondance automatiquement, sans configuration manuelle ; en cas d'échec, renseignez le jeton avec cette clé `sk-` et l'adresse de consultation du solde avec `https://example.com/v1/usage`.
- Seul un point de terminaison de console est disponible (le point de terminaison se trouve sous `/api/v1/*` et nécessite une session de connexion à la console) : renseignez l'adresse de consultation du solde avec le point de terminaison de solde de la console du site (selon le réel du site), **renseignez le jeton avec le « jeton de connexion »** (l'identifiant d'accès obtenu après connexion à la console, pas une clé d'appel de modèle), et remplissez le champ de solde selon la structure de réponse du point de terminaison.

#### Exemple 3 : relais compatible OpenAI à clé unique

- Jeton : la clé `sk-` utilisée pour les appels de modèle
- Généralement mis en correspondance automatiquement ; en cas d'échec, complétez l'adresse de consultation du solde et le champ de solde (par exemple `$balance` ou `$data.balance`).

> Remarque : si l'adresse de consultation du solde est laissée vide, le solde de cette plateforme n'est pas consulté, mais elle participe toujours à la facturation via le multiplicateur de coût.

## Limitations connues

- Le TTFT et la vitesse les plus rapides / les plus lents proviennent d'une nouvelle projection côté hôte : **vous devez quitter complètement et redémarrer DSH** avant qu'elle ne commence à collecter
- Un modèle sans prix n'est pas facturé ; ajouter le prix remplit rétroactivement ses appels antérieurs
- La mise à jour en un clic repose sur `pnpm` : l'application de bureau utilise la copie fournie avec l'hôte, tandis que l'utilisation en CLI / web nécessite `pnpm` sur le système. Si aucun n'est trouvé, la mise à jour le dit explicitement **et journalise chaque emplacement essayé** ; vous pouvez aussi la pointer vers une commande spécifique avec la variable d'environnement `DSH_DESKTOP_STATUSBAR_PNPM`

## Autorisations et accès externe

Le module lit les journaux de session et la configuration locale pour calculer l'utilisation, le solde et le coût, et prend en charge l'auto-mise à jour en un clic, c'est donc un **module à privilèges élevés**. Voici la véritable frontière des autorisations (correspondant au code de `lib/`). Veuillez l'examiner avant l'installation.

### Fichiers

| Chemin | Objet | Remarques |
| --- | --- | --- |
| <DSH_HOME>/dsh-status-bar/usage-ledger.json | Registre d'utilisation local, rempli depuis l'historique au démarrage | Écrit uniquement dans le propre répertoire du module |
| <DSH_HOME>/dsh-status-bar/holidays.json | Cache des jours fériés | Écrit lors des mises à jour automatiques des jours fériés en arrière-plan |
| <DSH_HOME>/dsh-status-bar/exchange-rate.json | Cache quotidien des taux de change | Écrit lors de l'actualisation des taux de change en arrière-plan |
| <DSH_HOME>/dsh-status-bar/tip-diag.log | Journal de diagnostic | Enregistre les diagnostics de position des infobulles pour faciliter le dépannage |
| <DSH_HOME>/dsh-status-bar/relay-balance.json | Configuration du solde du relais (sans secret en clair) | Répertoire du module |
| <DSH_HOME>/sessions | Lit les journaux de session pour calculer les statistiques de jetons / coût | Lecture seule |
| <DSH_HOME>/.credentials.yaml | Lit les clés API par refs uniquement lorsque ni le service d'identification ni les variables d'environnement n'en fournissent une | Lecture seule |
| Profile `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` | Sauvegardés et réécrits lors de l'auto-mise à jour en un clic | Uniquement lorsque vous cliquez sur « mise à jour en un clic » |

### Réseau

Les requêtes ne sont faites que pour afficher le solde, les taux de change, les jours fériés ou vérifier les mises à jour ; toutes via HTTPS sauf le loopback local 127.0.0.1, et elles échouent silencieusement en cas de délai d'attente sans bloquer les autres champs de la barre d'état.

| Domaine | Objet |
| --- | --- |
| `api.deepseek.com` | Solde du compte DeepSeek |
| `openrouter.ai` | Crédits OpenRouter |
| `api.siliconflow.com` / `api.siliconflow.cn` | Informations du compte SiliconFlow |
| `api.moonshot.ai` / `api.moonshot.cn` | Solde Moonshot |
| `open.bigmodel.cn` / `api.z.ai` | Quota Zhipu |
| `api.b.ai` | Solde B.AI |
| `api.xiaomimimo.com` | Solde Xiaomi MiMo |
| `api.stepfun.com` / `api.stepfun.ai` | Solde du compte StepFun (Chine / International) |
| `www.minimax.cn` | Quota MiniMax Token Plan |
| `management-api.x.ai` | Solde de l'équipe xAI |
| `business.aliyuncs.com` | Solde du compte BSS Alibaba Cloud |
| `open.er-api.com` | Taux de change CNY |
| `sousuo.www.gov.cn` | Mise à jour automatique des jours fériés |
| `registry.npmjs.org` | Vérification de version (auto-mise à jour) |
| `127.0.0.1` (loopback) | Port web de l'hôte / adaptateurs locaux |

Laisser vide l'URL de solde d'une plateforme signifie qu'elle n'est pas interrogée, et cela n'affecte pas la facturation.

### Identifiants

- Utilise d'abord le service d'identification de l'hôte `ctx.credentials` (la source faisant autorité écrite par la page des modèles) ; s'il n'est pas disponible, il bascule vers les variables d'environnement (par ex. `DEEPSEEK_API_KEY` et le nom refs de chaque adaptateur), puis vers la section refs de `<DSH_HOME>/.credentials.yaml`.
- Les clés API ne servent **qu'à interroger le solde de cette plateforme** ; elles ne sont jamais téléversées ailleurs, journalisées ni écrites dans le registre.
- La page des paramètres affiche les jetons sous forme de points avec sélection-pour-copier ; `GET /dsh-desktop-statusbar/api/relay-balance-config` renvoie le jeton de même origine au frontend. Ce point de terminaison est réservé au loopback (vérifications Host / Origin / remoteAddress) et ne quitte jamais la machine.

### Commandes

- `pnpm` n'est invoqué que lorsque vous cliquez sur « mise à jour en un clic » : il préfère le pnpm fourni avec l'hôte (par ex. `runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`), en se rabattant sur le `pnpm` du système ; vous pouvez le pointer avec la variable d'environnement `DSH_DESKTOP_STATUSBAR_PNPM`.
- En cas d'échec, la mise à jour restaure la sauvegarde du profil et affiche la raison ; si pnpm n'est pas trouvé, elle le signale explicitement et journalise chaque emplacement essayé.

### Limites en cas de défaillance

- Pas d'identifiants : le solde de cette plateforme affiche « — » ; les autres champs continuent de fonctionner.
- Échec réseau / délai d'attente : seul ce solde ou ce taux est affecté ; les autres statistiques ne sont pas affectées.
- pnpm introuvable : la mise à jour en un clic génère une erreur explicite au lieu d'échouer silencieusement.
- Échec de l'auto-mise à jour : la sauvegarde de `package.json` / fichier de verrouillage du profil est restaurée.

### Risques connus

- Module à privilèges élevés (lecture/écriture de fichiers + réseau + identifiants + commandes) — veuillez décider de l'installer après avoir pris connaissance de l'étendue des permissions.
- Lorsque les services externes de solde sont indisponibles, les chiffres associés sont manquants ou obsolètes.
- L'auto-mise à jour en un clic nécessite un accès en écriture au répertoire du profil.

## Développement

Chaque test est un script autonome destiné à être exécuté avec node simple — aucun framework de test.

```powershell
npm test          # runs every verify*.js/.mjs under tests/, then checks project vs installed plugin dir
npm run sync      # copies lib/ into the installed plugin dir
```

Les scripts de développement dans `tools/` sont fournis avec le paquet (le champ `files` les inclut),
ainsi un clone git et une installation npm les obtiennent tous deux :

| Script | Objet |
|---|---|
| `tools/test.cjs` | exécution complète des tests + garde de cohérence |
| `tools/sync-to-plugin.cjs` | `lib/` du projet → répertoire du module installé |
| `tools/sync-from-plugin.cjs` | répertoire du module installé → `lib/` du projet |
| `tools/plugin-dir.cjs` | localise le répertoire du module |
| `tools/shot.cjs` | régénère les captures d'écran du README |

Ils ne servent que pendant le développement ; le module ne les charge jamais à l'exécution.
Le paquet npm inclut `tests/` et `tools/`, donc une copie installée peut exécuter
`node tools/test.cjs` directement (exécution complète des tests + garde de cohérence).

Le répertoire du module est localisé automatiquement : variable d'environnement `DSH_STATUS_BAR_PLUGIN_DIR` →
agencements connus sous `~/.dsh` (`local-plugins/`, chaque `profiles/*/node_modules/`) → dérivé de l'emplacement
de `tools/`. Aucune modification de code nécessaire lors d'un changement de machine ou de nom d'utilisateur.

## Licence

[MIT](LICENSE) : libre d'utiliser, modifier et redistribuer ; conservez l'avis de copyright et de licence.

// Couche centralisée des indicateurs du tableau de bord AMI (cahier de spécifications, section 17).
// Chaque indicateur a un code stable, sa formule, sa date de référence et sa source ; les règles non
// encore validées par les responsables métier sont marquées « aValider » et restent paramétrables :
// elles ne doivent pas être présentées comme des indicateurs officiels.

/** Version des règles de calcul (affichée en pied de tableau de bord et dans les rapports). */
const VERSION_REGLES = '2026.10-proposition';

/** Paramètres proposés, à valider puis versionner (section 20). */
const PARAMETRES = {
  /** Délai de grâce après la date d'un rendez-vous CPN avant de le compter « en retard ». */
  graceCpnJours: 3,
  /** Sans consultation finalisée depuis ce délai (et sans rendez-vous à venir) : abandon CPN présumé. */
  abandonCpnJours: 60,
  /** Fenêtre du contact postnatal après l'accouchement. */
  postnatalFenetreJours: 7,
  /** Alerte ouverte au-delà de ce délai : en dépassement (SLA). */
  slaAlerteHeures: 48,
  /** Rendez-vous CPN en retard depuis plus longtemps : priorité « Prioritaire ». */
  retardCpnPrioritaireJours: 14,
};

/** Périodes proposées par le bandeau de filtres. */
const PERIODES = {
  jour: 'Aujourd’hui',
  '7j': '7 derniers jours',
  mois: 'Mois en cours',
  trimestre: 'Trimestre en cours',
  annee: 'Année en cours',
  perso: 'Période personnalisée',
};

/**
 * Catalogue des indicateurs (Annexe A) : module, libellé, formule, date de référence et source.
 * Le calcul lui-même est fait dans controllers/synthese.js, qui reprend ces définitions telles quelles.
 */
const CATALOGUE = {
  // --- Enregistrement et dossier unique (section 5) ---
  DOS_NOUVEAUX: { module: 'dossier', libelle: 'Nouveaux dossiers', unite: 'nombre', reference: 'création', source: 'Patientes',
    formule: 'Nombre de nouveaux identifiants AMI (AC-PAT) créés pendant la période.' },
  DOS_COMPLETS: { module: 'dossier', libelle: 'Dossiers complets', unite: '%', reference: 'création', source: 'Patientes', aValider: true,
    formule: 'Dossiers avec prénom, date de naissance (ou âge déclaré), téléphone, province et commune/quartier ÷ dossiers × 100.' },
  DOS_ID_VALIDE: { module: 'dossier', libelle: 'Identifiant unique valide', unite: '%', reference: 'création', source: 'Patientes',
    formule: 'Dossiers dont l’identifiant AMI respecte le format AC-PAT-000000 ÷ dossiers × 100.' },
  DOS_DOUBLONS: { module: 'dossier', libelle: 'Doublons présumés', unite: 'nombre', reference: 'détection', source: 'Patientes',
    formule: 'Dossiers partageant le même téléphone, ou les mêmes nom, prénom et date de naissance, en attente d’arbitrage humain.' },
  DOS_CONTINUITE: { module: 'dossier', libelle: 'Continuité mère-enfant', unite: '%', reference: 'naissance', source: 'Enfants',
    formule: 'Enfants liés à leur mère (et, nés dans la plateforme, à leur accouchement) ÷ enfants enregistrés × 100.' },
  DOS_CONSENTEMENT: { module: 'dossier', libelle: 'Consentement contact', unite: '%', reference: 'création', source: 'Patientes',
    formule: 'Dossiers avec téléphone et consentement de contact documenté (SMS, appel ou WhatsApp) ÷ dossiers avec téléphone × 100.' },

  // --- CPN digitale (section 6) ---
  CPN_INSCRITES: { module: 'cpn', libelle: 'Femmes nouvellement inscrites', unite: 'nombre', reference: 'création', source: 'Grossesses',
    formule: 'Femmes distinctes dont la grossesse est enregistrée pendant la période.' },
  CPN_CPN1: { module: 'cpn', libelle: 'CPN1 effectuées', unite: 'nombre', reference: 'activité', source: 'Consultations',
    formule: 'Femmes distinctes avec une première consultation prénatale finalisée pendant la période.' },
  CPN_RDV_PREVUS: { module: 'cpn', libelle: 'Rendez-vous CPN prévus', unite: 'nombre', reference: 'échéance', source: 'Rendez-vous',
    formule: 'Rendez-vous de la mère (non annulés) dont la date prévue tombe dans la période.' },
  CPN_RDV_HONORES: { module: 'cpn', libelle: 'Rendez-vous honorés', unite: 'nombre', reference: 'échéance', source: 'Rendez-vous',
    formule: 'Rendez-vous de la période marqués « Effectué ».' },
  CPN_HONORABILITE: { module: 'cpn', libelle: 'Taux d’honorabilité', unite: '%', reference: 'échéance', source: 'Rendez-vous',
    formule: 'Rendez-vous effectués ÷ rendez-vous prévus arrivés à échéance (non annulés) dans la période × 100.' },
  CPN_RETARD: { module: 'cpn', libelle: 'CPN en retard', unite: 'nombre', reference: 'échéance', source: 'Rendez-vous',
    formule: 'Rendez-vous de la mère échus, non réalisés, non annulés, après le délai de grâce configuré (instantané).' },
  CPN_ABANDON: { module: 'cpn', libelle: 'Abandon CPN présumé', unite: 'nombre', reference: 'détection', source: 'Grossesses, consultations, rendez-vous', aValider: true,
    formule: 'Grossesses en cours sans consultation finalisée depuis le délai configuré et sans rendez-vous à venir (statut présumé).' },
  CPN_COMPLETUDE: { module: 'cpn', libelle: 'Complétude CPN', unite: '%', reference: 'activité', source: 'Consultations', aValider: true,
    formule: 'Consultations prénatales finalisées avec poids, tension artérielle et prochain rendez-vous ÷ consultations prénatales finalisées × 100.' },
  CPN_ECHO: { module: 'cpn', libelle: 'Échographies réalisées', unite: 'nombre', reference: 'activité', source: 'Échographies',
    formule: 'Échographies obstétricales enregistrées pendant la période.' },
  CPN_REFERENCES: { module: 'cpn', libelle: 'Références CPN émises', unite: 'nombre', reference: 'activité', source: 'Consultations',
    formule: 'Consultations finalisées de la période avec au moins un motif de référence.' },

  // --- Accouchement, naissance et postnatal (section 7) ---
  ACC_ENREGISTRES: { module: 'accouchement', libelle: 'Accouchements enregistrés', unite: 'nombre', reference: 'activité', source: 'Accouchements',
    formule: 'Épisodes d’accouchement distincts dont l’heure de naissance tombe dans la période.' },
  ACC_ASSISTES: { module: 'accouchement', libelle: 'Accouchements assistés', unite: '%', reference: 'activité', source: 'Accouchements', aValider: true,
    formule: 'Accouchements avec accoucheur renseigné ÷ accouchements enregistrés × 100 (dénominateur officiel à valider).' },
  ACC_HORS_STRUCTURE: { module: 'accouchement', libelle: 'Naissances hors structure', unite: 'nombre', reference: 'naissance', source: 'Enfants',
    formule: 'Enfants nés hors plateforme (domicile, autre structure) enregistrés avec une naissance dans la période.' },
  ACC_EVACUATIONS: { module: 'accouchement', libelle: 'Références obstétricales urgentes', unite: 'nombre', reference: 'activité', source: 'Accouchements',
    formule: 'Évacuations documentées pendant le travail ou l’accouchement dans la période.' },
  ACC_VIVANTS: { module: 'accouchement', libelle: 'Naissances vivantes', unite: 'nombre', reference: 'naissance', source: 'Enfants',
    formule: 'Nouveau-nés nés dans la plateforme avec l’état « Vivant » pendant la période.' },
  ACC_FICHE_NN: { module: 'accouchement', libelle: 'Fiche nouveau-né complète', unite: '%', reference: 'naissance', source: 'Enfants', aValider: true,
    formule: 'Nouveau-nés avec poids, taille, périmètre crânien, APGAR 1 et 5 min, mise au sein et vitamine K1 renseignés ÷ nouveau-nés × 100.' },
  ACC_LIEN: { module: 'accouchement', libelle: 'Lien mère-enfant', unite: '%', reference: 'activité', source: 'Accouchements, enfants',
    formule: 'Accouchements dont chaque nouveau-né attendu a un dossier lié ÷ accouchements enregistrés × 100 (naissances multiples comprises).' },
  ACC_POSTNATAL: { module: 'accouchement', libelle: 'Suivi postnatal effectué', unite: '%', reference: 'activité', source: 'Accouchements, consultations', aValider: true,
    formule: 'Accouchées dont la fenêtre postnatale est écoulée, avec une consultation postnatale dans la fenêtre ÷ accouchées éligibles × 100.' },

  // --- Vaccination / PEV (section 8) ---
  VAC_DOSES: { module: 'vaccination', libelle: 'Doses administrées', unite: 'nombre', reference: 'administration', source: 'Carnets',
    formule: 'Doses valides (non annulées) dont la date d’administration tombe dans la période.' },
  VAC_DUES: { module: 'vaccination', libelle: 'Doses dues', unite: 'nombre', reference: 'échéance', source: 'Carnets',
    formule: 'Doses « à faire » selon le calendrier PEV configuré (dans la tolérance), enfants suivis (instantané).' },
  VAC_RETARD: { module: 'vaccination', libelle: 'Doses en retard', unite: 'nombre', reference: 'échéance', source: 'Carnets',
    formule: 'Doses dues dont la tolérance est dépassée, sans administration documentée (instantané).' },
  VAC_ABANDON: { module: 'vaccination', libelle: 'Abandon Penta1 → Penta3', unite: '%', reference: 'échéance', source: 'Carnets', aValider: true,
    formule: 'Enfants ayant reçu Penta1 sans Penta3 alors qu’elle est échue ÷ enfants ayant reçu Penta1 et dont Penta3 est échue × 100.' },
  VAC_ZERO_DOSE: { module: 'vaccination', libelle: 'Enfants zéro-dose', unite: 'nombre', reference: 'échéance', source: 'Carnets', aValider: true,
    formule: 'Proposition : enfants suivis dont Penta1 est échue et non reçue. Définition PEV RDC à confirmer avant activation.' },
  VAC_SOUS_VACCINES: { module: 'vaccination', libelle: 'Enfants sous-vaccinés', unite: 'nombre', reference: 'échéance', source: 'Carnets',
    formule: 'Enfants suivis avec au moins une dose attendue pour leur âge non documentée (en retard ou hors délai).' },
  VAC_QUALITE: { module: 'vaccination', libelle: 'Qualité du dossier vaccinal', unite: '%', reference: 'administration', source: 'Carnets',
    formule: 'Doses avec date valide (ni avant la naissance, ni dans le futur) et non répétées ÷ doses enregistrées × 100.' },

  // --- Relance communautaire RECO (section 9) ---
  REL_OUVERTES: { module: 'relance', libelle: 'Tâches RECO ouvertes', unite: 'nombre', reference: 'instantané', source: 'Tâches de relance',
    formule: 'Tâches non clôturées et non annulées à la date de consultation.' },
  REL_ECHUES: { module: 'relance', libelle: 'Tâches RECO échues', unite: 'nombre', reference: 'échéance', source: 'Tâches de relance',
    formule: 'Tâches ouvertes dont l’échéance est dépassée.' },
  REL_A_RETROUVER: { module: 'relance', libelle: 'Personnes à retrouver', unite: 'nombre', reference: 'instantané', source: 'Tâches de relance',
    formule: 'Personnes uniques avec une tâche de relance active (dédupliquées par dossier).' },
  REL_SANS_RECO: { module: 'relance', libelle: 'Tâches sans responsable', unite: 'nombre', reference: 'instantané', source: 'Tâches de relance',
    formule: 'Tâches ouvertes sans RECO attribué.' },
  REL_VISITES: { module: 'relance', libelle: 'Taux de réalisation des visites', unite: '%', reference: 'échéance', source: 'Tâches de relance',
    formule: 'Visites réalisées ÷ visites planifiées arrivées à échéance (tâches créées dans la période) × 100.' },
  REL_REINTEGRATION: { module: 'relance', libelle: 'Taux de réintégration', unite: '%', reference: 'détection', source: 'Tâches de relance',
    formule: 'Personnes dont la reprise du service est confirmée ÷ personnes éligibles identifiées dans la même cohorte × 100.' },
  REL_RESOLUTION: { module: 'relance', libelle: 'Taux de résolution', unite: '%', reference: 'échéance', source: 'Tâches de relance',
    formule: 'Tâches clôturées avec un résultat valide ÷ tâches arrivées à échéance dans la cohorte × 100.' },
  REL_DELAI: { module: 'relance', libelle: 'Délai médian de relance', unite: 'heures', reference: 'détection', source: 'Tâches de relance',
    formule: 'Médiane entre la création de la tâche et la première action documentée du RECO.' },
  REL_ORIENTATIONS: { module: 'relance', libelle: 'Références communautaires abouties', unite: '%', reference: 'activité', source: 'Tâches de relance',
    formule: 'Orientations avec prise en charge confirmée ÷ orientations émises dans la cohorte × 100.' },

  // --- Rendez-vous, alertes (section 10) ---
  ALE_OUVERTES: { module: 'alertes', libelle: 'Alertes ouvertes', unite: 'nombre', reference: 'détection', source: 'Alertes de relance',
    formule: 'Alertes sans accusé de réception, toutes priorités.' },
  ALE_URGENTES: { module: 'alertes', libelle: 'Alertes urgentes', unite: 'nombre', reference: 'détection', source: 'Urgences, alertes de relance',
    formule: 'Urgences de patientes non clôturées + alertes de relance « danger / urgence » ouvertes.' },
  ALE_DEPASSEMENT: { module: 'alertes', libelle: 'Alertes en dépassement', unite: 'nombre', reference: 'détection', source: 'Alertes de relance',
    formule: 'Alertes ouvertes au-delà du délai de traitement configuré (SLA).' },
  ALE_RDV_MANQUES: { module: 'alertes', libelle: 'Rendez-vous manqués après rappel', unite: 'nombre', reference: 'échéance', source: 'Rendez-vous',
    formule: 'Rendez-vous de la période échus non réalisés malgré un rappel envoyé (push).' },
  ALE_CLOTURE: { module: 'alertes', libelle: 'Taux de clôture des alertes', unite: '%', reference: 'détection', source: 'Alertes de relance',
    formule: 'Alertes de la période avec accusé de réception ÷ alertes émises dans la période × 100.' },
};

/**
 * Champs ou événements absents du prototype, nécessaires à certains indicateurs du cahier
 * (Annexe B : « signalez les champs ou événements manquants »).
 */
const DONNEES_MANQUANTES = [
  'Dénominateurs officiels (populations cibles CPN, accouchements attendus, cohortes PEV) : couvertures non calculables.',
  'Accusé de réception et contre-référence des références CPN et obstétricales (seule l’émission est enregistrée).',
  'Laboratoire : distinction examen prescrit / réalisé / résultat reçu.',
  'Statuts du fournisseur SMS/WhatsApp (soumis, délivré, lu) : seuls les rappels push sont tracés.',
  'Définitions validées RAC, ARC, RPC, IRC, TCC (dictionnaire métier AMI) et définition PEV RDC du zéro-dose.',
  'Rattachement géographique Zone de Santé → Aire de Santé → Structure pour les comparaisons territoriales officielles.',
];

module.exports = { VERSION_REGLES, PARAMETRES, PERIODES, CATALOGUE, DONNEES_MANQUANTES };

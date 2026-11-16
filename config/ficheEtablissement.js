// Fiche AMI d'un établissement sanitaire, alignée sur la fiche « Identification générale de la
// structure » (identification, localisation, population cible, contacts, responsables, services,
// infrastructures, ressources humaines, équipements, informations opérationnelles, validation).
// Référentiels, répartition des champs entre le comité de pilotage (obligatoires) et le médecin
// chef (facultatifs), valeurs déduites, contrôle automatique et calculs.

const { COEFFICIENTS_INITIAUX } = require('./epidemiologie');
const V = require('./ficheSpecifique');
const C = require('./catalogueStructure');

// --- Référentiels ----------------------------------------------------------------------------

const NIVEAUX_SANITAIRES = ['Central', 'Provincial', 'Zone', 'Aire', 'Prestation'];
const CATEGORIES = ['HGR', 'HP', 'HS', 'HN', 'HM', 'CSR', 'CS', 'PS', 'Polyclinique', 'Clinique', 'CM', 'Laboratoire', 'Maternité', 'Autre'];
/** Statut de fonctionnement (fiche « Identification générale ») ; les anciens libellés restent lisibles. */
const STATUTS_ACTUELS = [...C.STATUTS_FONCTIONNEMENT, ...Object.keys(C.STATUTS_ANCIENS)];
const STATUTS_JURIDIQUES = ['Public', 'Privé lucratif', 'Privé non lucratif', 'Confessionnel', 'Militaire', 'Associatif', 'Autre'];
/** Régime de gestion / tutelle (fiche « Identification générale » : État, Établissement public, Privé, Confessionnel, Militaire, ONG). */
const MODES_GESTION = [
  'Étatique', 'Établissement public', 'Confessionnelle', 'Privée', 'Militaire', 'ONG', 'Associative', 'Communautaire', 'Autre',
];
const OUI_NON = ['Oui', 'Non'];
const OUI_NON_PARTIEL = ['Oui', 'Non', 'Partiel'];
const ACCESSIBILITE = ['Oui', 'Non', 'Partielle'];
const DISPONIBILITE = ['Disponible', 'Indisponible'];
const ETATS_EQUIPEMENT = ['Bon', 'Moyen', 'Mauvais'];
const PROFESSIONS = [
  'Médecin généraliste', 'Médecin spécialiste', 'Infirmier', 'Sage-femme', 'Accoucheuse', 'Technicien laboratoire',
  'Pharmacien', 'Technicien vaccination', 'Nutritionniste', 'Administratif', 'Hygiéniste', 'Autre',
];
const CONTRATS = ['État', 'Contractuel', 'Bénévole', 'Autre'];
const STATUTS_AGENT = ['Actif', 'En congé', 'En formation', 'En mission', 'Suspendu', 'Sorti'];
const REGIMES = ['Temps plein', 'Temps partiel'];
const SOURCES_POPULATION = ['DPS', 'SNIS', 'Recensement', 'Estimation'];

// Référentiels de la fiche « Identification générale de la structure ».
const NIVEAUX_SOINS = ['Premier recours', 'Référence', 'Spécialisé', 'Autre'];
const TITRES_RESPONSABLE = ['Médecin directeur', 'Médecin chef', 'Infirmier titulaire', 'Administrateur gestionnaire', 'Autre'];
const DOMAINES_RESPONSABILITE = ['CPN', 'Maternité', 'PEV', 'Surveillance', 'Données', 'Informatique', 'Autre'];
const CANAUX_CONTACT = ['Appel', 'SMS', 'E-mail', 'WhatsApp institutionnel', 'Autre'];
const PROGRAMMES = [
  'PEV', 'Santé maternelle', 'Surveillance épidémiologique', 'Nutrition', 'Planification familiale', 'Paludisme', 'VIH / Tuberculose', 'Autre',
];
const METHODES_GPS = ['Récepteur GPS', 'Smartphone', 'Carte / imagerie satellite', 'Autre'];
const SOURCES_CODE = ['SNIS', 'DHIS2', 'DPS', 'Ministère de la Santé', 'Autre'];
const DISPONIBILITES_SERVICE = ['Permanente', 'Certains jours', 'Sur appel', 'Indisponible'];
const MOTIFS_INDISPONIBILITE = ['Rupture de personnel', 'Équipement', 'Intrants', 'Travaux', 'Autre'];
const ETATS_BATIMENT = ['Bon', 'Moyen', 'Mauvais', 'Dangereux'];
const STABILITES = ['Stable', 'Instable', 'Absente'];
const CONTINUITES = ['Continue', 'Intermittente', 'Absente'];
const ROUTES = ['Route asphaltée', 'Route en terre', 'Piste', 'Voie fluviale / lacustre', 'Sentier', 'Autre'];
const SOURCES_ELECTRICITE = ['Réseau', 'Solaire', 'Groupe électrogène', 'Autre'];
const CATEGORIES_RH = [
  'Médecins', 'Infirmiers A0', 'Infirmiers A1', 'Infirmiers A2', 'Infirmiers A3', 'Sages-femmes', 'Accoucheuses', 'Techniciens',
  'Administratifs', 'Données', 'Informatique', 'Autres',
];
const CATEGORIES_EQUIPEMENT = ['Maternité', 'Diagnostic', 'Vaccination', 'Informatique', 'Transport', 'Énergie', 'Mobilier', 'Autre'];
const PREUVES_EQUIPEMENT = ['Photo (sans patient)', 'Fiche d’inventaire'];
const MOYENS_REFERENCE = ['Ambulance', 'Véhicule', 'Moto', 'Convention de transport', 'Aucun'];
const SYSTEMES_RAPPORTAGE = ['DHIS2', 'Registre papier', 'Autre système', 'Aucun'];
const ETATS_INTRANTS = ['Disponibles', 'Ruptures partielles', 'Rupture totale'];
const TYPES_PIECE = ['Acte de création', 'Autorisation de fonctionnement', 'Agrément', 'Procès-verbal de vérification', 'Autre'];

/** Services et activités (§8) : catalogues hôpital et centre de santé, plus l'ancienne liste de 15 services. */
const SERVICES_SANITAIRES = C.NOMS_SERVICES;
/** Modules AMI ouverts par un service fonctionnel : module → noms de service (catalogue et anciens). */
const MODULES = C.SERVICES_MODULE;
/** Correspondance avec la liste courte `services` utilisée par le reste de la plateforme. */
const VERS_SERVICES_PLATEFORME = {
  CPN: 'CPN', Accouchement: 'Maternité', 'Salle d’accouchement': 'Maternité', Maternité: 'Maternité', Vaccination: 'Vaccination',
  'Vaccination et PEV': 'Vaccination', Urgences: 'Urgences', 'Urgences médicales': 'Urgences', 'Urgences de première ligne': 'Urgences',
  Ambulance: 'Ambulance', 'Transport et ambulance': 'Ambulance', Pédiatrie: 'Pédiatrie', 'Hospitalisation pédiatrique': 'Pédiatrie',
  Laboratoire: 'Laboratoire', 'Laboratoire de biologie médicale': 'Laboratoire', 'Laboratoire de première ligne': 'Laboratoire',
  Imagerie: 'Imagerie', 'Imagerie médicale': 'Imagerie', Radiologie: 'Imagerie', Échographie: 'Imagerie',
  Chirurgie: 'Chirurgie', 'Chirurgie générale': 'Chirurgie', 'Chirurgie spécialisée': 'Chirurgie', 'Blocs opératoires': 'Chirurgie',
};

/** Étape 10 : statuts informatiques du circuit de validation. */
const STATUTS_CIRCUIT = [
  'Brouillon', 'En attente de vérification', 'À corriger', 'En attente de validation', 'Validée', 'Active', 'Suspendue', 'Archivée',
  'Rejetée', 'Fermée',
];

/** Statut juridique (étape 3) → secteur affiché dans les listes de la plateforme. */
const SECTEUR_DU_STATUT = {
  Public: 'Public', 'Privé lucratif': 'Privé', 'Privé non lucratif': 'Privé', Confessionnel: 'Confessionnel',
  Militaire: 'Militaire', Associatif: 'ONG', Autre: 'Privé',
};

/** Type de structure → catégorie proposée (modifiable). */
const CATEGORIE_DU_TYPE = {
  // Types à catégorie unique : la catégorie se déduit du type (jamais redemandée).
  ...Object.fromEntries(Object.entries(C.CATEGORIES_DU_TYPE).filter(([, l]) => l.length === 1).map(([t, [c]]) => [t, c])),
  'Hôpital général de référence': 'HGR', 'Hôpital provincial': 'HP', 'Hôpital national': 'HN', 'Hôpital militaire': 'HM',
  'Centre de santé de référence': 'CSR', 'Centre de santé': 'CS', 'Poste de santé': 'PS', Polyclinique: 'Polyclinique',
  Clinique: 'Clinique', 'Centre médical': 'CM', Laboratoire: 'Laboratoire', Maternité: 'Maternité', Autre: 'Autre',
};

// --- Répartition des champs ------------------------------------------------------------------

/**
 * Champs que le médecin chef peut compléter (tous facultatifs). Le reste de la fiche (identité,
 * rattachement, statut juridique, responsable, services qui ouvrent les modules, coefficients) est
 * saisi par le comité de pilotage et passe par le circuit de validation.
 * `true` : toute la section ; liste : seulement ces champs de la section.
 */
const CHAMPS_CHEF = {
  identification: ['nomUsuel', 'sigle', 'anneeCreation', 'dateOuverture', 'siteWeb'],
  localisation: [
    'commune', 'quartier', 'groupement', 'avenue', 'numero', 'gps', 'reperes', 'distanceBczsKm', 'distanceHgrKm', 'distanceCsrKm', 'tempsDeplacement',
    'moyenTransport', 'accessibilitePluies', 'accessibiliteUrgence',
  ],
  organisation: [
    'proprietaire', 'tutelleAdministrative', 'tutelleTechnique', 'responsableMedical', 'responsableInfirmier',
    'responsableAdministratif', 'responsableMaternite', 'joursFonctionnement', 'horaires', 'garde',
  ],
  contacts: true,
  responsablesFonctionnels: true,
  infrastructures: true,
  equipements: true,
  agents: true,
  effectifsAttendus: true,
  effectifs: true,
  recos: true,
  personnel: true,
  populations: true,
  capacites: true,
  operationnel: true,
  // Volets spécifiques (hôpital ou centre de santé) : renseignés par le médecin chef ou le comité.
  hopital: true,
  centreSante: true,
};
const SECTIONS = [
  'identification', 'localisation', 'organisation', 'contacts', 'rattachementSanitaire', 'responsablesFonctionnels', 'infrastructures',
  'equipements', 'agents', 'effectifsAttendus', 'effectifs', 'recos', 'personnel', 'services', 'populations', 'capacites', 'operationnel',
  'hopital', 'centreSante',
];
/** Sections saisies sous forme de liste (remplacées en entier). */
const SECTIONS_LISTE = ['equipements', 'agents', 'effectifsAttendus', 'effectifs', 'personnel', 'services', 'responsablesFonctionnels'];

/** Responsables de l'étape 3 dont le changement est historisé. */
const RESPONSABLES = {
  responsable: 'Responsable de la structure', responsableMedical: 'Responsable médical', responsableInfirmier: 'Responsable infirmier',
  responsableAdministratif: 'Responsable administratif', responsableMaternite: 'Responsable maternité / CPN / Vaccination',
};

// --- Utilitaires -------------------------------------------------------------------------------

const rempli = (v) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length);
const nomPersonne = (p) => [p?.prenom, p?.nom, p?.postnom].filter(Boolean).join(' ').trim();
const abrege = (texte, n = 3) => String(texte || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, n) || 'XXX';

/** DPS et BCZS déduits de la province et de la zone principale. */
function rattachement(e) {
  return {
    dps: e.province ? `DPS ${e.province}` : '',
    bczs: e.zoneSante ? `BCZS ${e.zoneSante}` : '',
  };
}

// --- Étape 4 : taux de fonctionnalité ---------------------------------------------------------

const taux = (n, total) => (total > 0 ? Math.round((n / total) * 1000) / 10 : null);

function calculsEquipements(equipements = []) {
  const jour = new Date().toISOString().slice(0, 10);
  const lignes = equipements.map((q) => ({
    nom: q.nom, categorie: q.categorie || null, total: q.total ?? 0, fonctionnels: q.fonctionnels ?? 0,
    // Quantité hors service = Total − Fonctionnel (fiche « Identification générale », §11).
    horsService: Math.max(0, (q.total ?? 0) - (q.fonctionnels ?? 0)),
    taux: taux(q.fonctionnels ?? 0, q.total ?? 0),
    maintenanceDepassee: Boolean(q.prochaineMaintenance && q.prochaineMaintenance < jour),
  }));
  const total = lignes.reduce((s, l) => s + l.total, 0);
  const fonctionnels = lignes.reduce((s, l) => s + l.fonctionnels, 0);
  const parCategorie = {};
  for (const l of lignes) {
    const k = l.categorie || 'Non renseignée';
    parCategorie[k] ??= { total: 0, fonctionnels: 0, horsService: 0 };
    parCategorie[k].total += l.total;
    parCategorie[k].fonctionnels += l.fonctionnels;
    parCategorie[k].horsService += l.horsService;
  }
  return {
    lignes, total, fonctionnels, horsService: Math.max(0, total - fonctionnels), taux: taux(fonctionnels, total), parCategorie,
    aRemplacer: equipements.filter((q) => q.remplacement === 'Oui').length,
    maintenancesDepassees: lignes.filter((l) => l.maintenanceDepassee).length,
  };
}

// --- Étape 5 : ressources humaines --------------------------------------------------------------

function compter(liste, cle) {
  const c = {};
  for (const x of liste) {
    const k = x[cle] || 'Non renseigné';
    c[k] = (c[k] ?? 0) + 1;
  }
  return c;
}

function calculsRh(agents = [], attendus = []) {
  const presents = agents.filter((a) => a.statut !== 'Sorti');
  const parProfession = compter(presents, 'profession');
  return {
    total: presents.length,
    sortis: agents.length - presents.length,
    parProfession,
    parService: compter(presents, 'service'),
    disponibles: presents.filter((a) => a.disponibilite !== 'Indisponible').length,
    indisponibles: presents.filter((a) => a.disponibilite === 'Indisponible').length,
    ecarts: attendus.filter((n) => n.profession && n.nombre != null).map((n) => ({
      profession: n.profession, attendu: n.nombre, present: parProfession[n.profession] ?? 0, ecart: (parProfession[n.profession] ?? 0) - n.nombre,
    })),
  };
}

/**
 * Effectifs agrégés par catégorie (fiche « Identification générale », §10) : théorique, affecté,
 * présent, absents par motif, écarts et taux de présence. Les RECO sont comptés à part.
 */
function calculsEffectifs(effectifs = []) {
  const lignes = effectifs.map((l) => {
    const a = l.absents ?? {};
    const absents = ['conge', 'formation', 'suspension', 'absence', 'autre'].reduce((s, k) => s + (a[k] ?? 0), 0);
    return {
      categorie: l.categorie, qualification: l.qualification || null, theorique: l.theorique ?? null, affecte: l.affecte ?? null,
      present: l.present ?? null, absents, ecart: l.theorique != null && l.affecte != null ? l.affecte - l.theorique : null,
      tauxPresence: l.affecte ? taux(l.present ?? 0, l.affecte) : null, dateReference: l.dateReference ?? null,
    };
  });
  const somme = (k) => lignes.reduce((s, l) => s + (l[k] ?? 0), 0);
  return {
    lignes, theorique: somme('theorique'), affecte: somme('affecte'), present: somme('present'), absents: somme('absents'),
    tauxPresence: taux(somme('present'), somme('affecte')),
  };
}

// --- Étape 6 : activation des modules -----------------------------------------------------------

/**
 * Modules AMI ouverts : null pour un établissement enregistré avant la fiche AMI (aucune
 * restriction), sinon les modules dont le service est fonctionnel, seulement une fois la fiche
 * active (« pas d'activation sans validation »).
 */
function modulesActifs(e) {
  const statut = e.fiche?.circuit?.statut;
  if (!statut) return null;
  if (e.fiche.circuit.anterieur && !e.fiche.circuit.activeLe && !['Archivée', 'Rejetée', 'Fermée'].includes(statut)) return null;
  if (statut !== 'Active') return [];
  return modulesPrevus(e);
}

/** Ligne de service qui porte un module (CPN, Accouchement, Vaccination), sous son ancien ou son nouveau nom. */
function serviceDuModule(services = [], module) {
  const noms = MODULES[module] ?? [module];
  const lignes = services.filter((s) => noms.includes(s.service));
  return lignes.find((s) => s.fonctionnel === 'Oui') ?? lignes.find((s) => s.fonctionnel === 'Partiel') ?? lignes[0];
}

/** Modules qui seront ouverts à l'activation (selon les services fonctionnels). */
function modulesPrevus(e) {
  return Object.keys(MODULES).filter((m) => serviceDuModule(e.fiche?.services, m)?.fonctionnel === 'Oui');
}

/** Liste courte `services` de la plateforme : services disponibles et fonctionnels (ou partiels). */
function servicesPlateforme(services = []) {
  const s = new Set();
  for (const l of services) {
    if (l.disponible === 'Oui' && (l.fonctionnel === 'Oui' || l.fonctionnel === 'Partiel') && VERS_SERVICES_PLATEFORME[l.service]) {
      s.add(VERS_SERVICES_PLATEFORME[l.service]);
    }
  }
  return [...s];
}

// --- Étape 8 : populations cibles ---------------------------------------------------------------

/** Population de l'année la plus récente (base des cibles). */
const populationRecente = (populations = []) => [...populations].sort((a, b) => b.annee - a.annee)[0] ?? null;

/**
 * Cibles calculées à partir de la population de responsabilité. `coefficients` : coefficients
 * validés du module Épidémiologie (cible FE, NA, NS) ; à défaut, coefficients nationaux initiaux.
 * Femmes enceintes et naissances sont la même cohorte vue de deux façons : jamais additionnées.
 */
function calculsCibles(e, coefficients = {}) {
  const pop = populationRecente(e.fiche?.populations);
  const base = pop?.totale ?? null;
  const lignes = COEFFICIENTS_INITIAUX.map((c) => {
    const valide = coefficients[c.cible];
    const pct = valide?.valeurPct ?? c.valeurPct;
    const annuelle = base != null ? Math.round(base * pct / 100) : null;
    return {
      cible: c.cible,
      indicateur: { FE: 'Femmes enceintes attendues', NA: 'Naissances vivantes attendues', NS: 'Nourrissons survivants attendus' }[c.cible],
      populationBase: base,
      coefficientPct: pct,
      formule: `Population totale × ${(pct / 100).toLocaleString('fr-FR', { maximumFractionDigits: 6 })}`,
      cibleAnnuelle: annuelle,
      cibleSemestrielle: annuelle != null ? Math.round(annuelle / 2) : null,
      cibleTrimestrielle: annuelle != null ? Math.round(annuelle / 4) : null,
      cibleMensuelle: annuelle != null ? Math.round(annuelle / 12) : null,
      coefficient: valide
        ? { code: valide.code, version: valide.version, dateDebut: valide.dateDebut, validePar: valide.validePar ?? null, valideLe: valide.valideLe ?? null, source: 'Épidémiologie (validé)' }
        : { code: c.code, version: null, dateDebut: null, validePar: null, valideLe: null, source: 'Coefficient national par défaut' },
    };
  });
  // Accouchements attendus = population × coefficient des naissances attendues (4 %) :
  // même cohorte que les naissances, affichée séparément pour la maternité.
  const na = lignes.find((l) => l.cible === 'NA');
  // Ajoutée en fin de liste : l'ordre FE, NA, NS des lignes existantes est conservé.
  if (na) lignes.push({ ...na, cible: 'AA', indicateur: 'Accouchements attendus' });
  return {
    annee: pop?.annee ?? null,
    source: pop?.source ?? null,
    populationBase: base,
    periode: 'Annuelle, semestrielle, trimestrielle et mensuelle',
    dateCalcul: new Date().toISOString().slice(0, 10),
    lignes,
    alerte: 'Ne jamais additionner femmes enceintes, accouchements et naissances attendus : c’est la même cohorte vue de plusieurs façons.',
  };
}

// --- Étape 9 : capacités opérationnelles --------------------------------------------------------

/** Contacts CPN attendus par grossesse (norme utilisée pour le besoin mensuel en consultations CPN). */
const CONTACTS_CPN = 4;

/**
 * Compare capacité théorique, capacité opérationnelle, activités réalisées (mois écoulé) et
 * besoins attendus (étape 8). La capacité opérationnelle est la capacité théorique quand le
 * service est fonctionnel et que ses prérequis sont disponibles, la moitié s'il est partiel,
 * zéro sinon.
 */
function calculsCapacites(e, cibles, realisees = {}) {
  const c = e.fiche?.capacites ?? {};
  const infra = e.fiche?.infrastructures ?? {};
  const service = (nom) => serviceDuModule(e.fiche?.services, nom);
  const mensuelle = (code) => cibles.lignes.find((l) => l.cible === code)?.cibleMensuelle ?? null;
  const prerequis = {
    Accouchement: [['personnelQualifie', 'Personnel qualifié', c.personnelQualifie], ['eau', 'Eau', c.eau]],
    CPN: [['personnelQualifie', 'Personnel qualifié', c.personnelQualifie]],
    Vaccination: [['vaccins', 'Vaccins', c.vaccins], ['chaineFroid', 'Chaîne du froid', infra.chaineFroid], ['personnelQualifie', 'Personnel qualifié', c.personnelQualifie]],
  };
  const ligne = (nom, libelle, theorique, besoin, realise) => {
    const s = service(nom);
    const manquants = prerequis[nom].filter(([, , v]) => v === 'Non').map(([, l]) => l);
    let facteur = s?.fonctionnel === 'Oui' ? 1 : s?.fonctionnel === 'Partiel' ? 0.5 : 0;
    if (manquants.length) facteur = 0;
    const operationnelle = theorique != null ? Math.round(theorique * facteur) : null;
    const deficit = besoin != null && operationnelle != null ? Math.max(0, besoin - operationnelle) : null;
    let alerte = null;
    if (deficit > 0) alerte = { niveau: 'rouge', message: `Besoin ${besoin} / mois, capacité ${operationnelle} / mois → déficit de ${deficit}. Capacité insuffisante.` };
    else if (besoin != null && realise != null && realise < besoin * 0.8) alerte = { niveau: 'orange', message: `Activités réalisées (${realise}) inférieures à 80 % du besoin (${besoin}).` };
    else if (besoin != null && operationnelle != null) alerte = { niveau: 'vert', message: 'Capacité suffisante pour le besoin attendu.' };
    return { activite: libelle, service: nom, theorique: theorique ?? null, operationnelle, realisees: realise ?? null, besoin, deficit, prerequisManquants: manquants, alerte };
  };
  const fe = mensuelle('FE');
  return {
    lignes: [
      ligne('Accouchement', 'Accouchements / mois', c.accouchementsMois, mensuelle('NA'), realisees.accouchements),
      ligne('CPN', `Consultations CPN / mois (${CONTACTS_CPN} contacts par grossesse)`, c.cpnMois, fe != null ? fe * CONTACTS_CPN : null, realisees.cpn),
      ligne('Vaccination', 'Séances de vaccination / mois', c.seancesVaccinationMois, null, null),
    ],
    disponibilites: [
      ['Vaccins', c.vaccins], ['Médicaments essentiels', c.medicaments], ['Personnel qualifié', c.personnelQualifie],
      ['Électricité', c.electricite], ['Eau', c.eau], ['Transport de référence', c.transportReference], ['Moyens de communication', c.communication],
    ].map(([libelle, valeur]) => ({ libelle, valeur: valeur ?? null })),
  };
}


// --- Valeurs déduites (jamais ressaisies) -------------------------------------------------------

/** Une ligne de service existante et fonctionnelle (Oui / Partiel) parmi ces noms ? null si aucune ligne. */
function serviceOuiNon(services, noms) {
  const lignes = services.filter((s) => noms.includes(s.service) && s.existence !== 'Non' && s.fonctionnel);
  if (!lignes.length) return null;
  return lignes.some((s) => s.fonctionnel === 'Oui' || s.fonctionnel === 'Partiel') ? 'Oui' : 'Non';
}

const somme = (liste, cle) => liste.reduce((s, x) => s + (x[cle] ?? 0), 0);

/**
 * Recalcule ce qui se déduit d'une autre réponse de la fiche, pour qu'une information ne soit
 * jamais saisie deux fois : catégorie et niveau sanitaire (type), année de création (date de mise
 * en service), fonction du responsable (titre), Oui / Non hérités (services), bâtiments hors
 * service, totaux des lits (lits par unité), eau, électricité, chaîne du froid (équipements),
 * nombre de RECO (personnel).
 */
function deduire(e) {
  const f = e.fiche;
  if (!f) return;
  const id = f.identification;
  const org = f.organisation;
  const infra = f.infrastructures;
  const services = f.services ?? [];

  // Identification : la catégorie d'un type qui n'en admet qu'une n'est pas demandée.
  const permises = C.CATEGORIES_DU_TYPE[e.type];
  if (permises?.length === 1) id.categorie = permises[0];
  else if (!id.categorie && CATEGORIE_DU_TYPE[e.type]) id.categorie = CATEGORIE_DU_TYPE[e.type];
  if (id.categorie && C.NIVEAU_DE_CATEGORIE[id.categorie]) id.niveauSanitaire = C.NIVEAU_DE_CATEGORIE[id.categorie];
  if (id.dateOuverture && /^\d{4}/.test(id.dateOuverture)) id.anneeCreation = Number(id.dateOuverture.slice(0, 4));

  // Responsable principal : sa fonction est son titre (sauf « Autre », précisé à la main).
  if (org.titreResponsable && org.titreResponsable !== 'Autre') org.responsable.fonction = org.titreResponsable;

  // Oui / Non hérités de l'ancienne fiche : déduits des services déclarés.
  const deduits = {
    maternite: ['Maternité', 'Salle d’accouchement', 'Accouchement', 'Obstétrique'],
    chirurgie: ['Chirurgie', 'Chirurgie générale', 'Chirurgie spécialisée', 'Blocs opératoires'],
    hospitalisation: ['Hospitalisation', 'Hospitalisation adulte', 'Hospitalisation pédiatrique'],
  };
  for (const [cle, noms] of Object.entries(deduits)) {
    const v = serviceOuiNon(services, noms);
    if (v) id[cle] = v;
  }
  const ouvrages = {
    blocOperatoire: ['Blocs opératoires'],
    laboratoire: ['Laboratoire', 'Laboratoire de biologie médicale', 'Laboratoire de première ligne'],
    pharmacie: ['Pharmacie hospitalière', 'Pharmacie et dispensation des médicaments'],
    morgue: ['Morgue'],
  };
  for (const [cle, noms] of Object.entries(ouvrages)) {
    const v = serviceOuiNon(services, noms);
    if (v) infra[cle] = v;
  }

  // Infrastructures.
  if (infra.batiments != null && infra.batimentsFonctionnels != null) {
    infra.batimentsHorsService = Math.max(0, infra.batiments - infra.batimentsFonctionnels);
  }
  const unites = infra.litsParUnite ?? [];
  if (unites.length) {
    infra.litsTotal = somme(unites, 'installes');
    infra.litsFonctionnels = somme(unites, 'operationnels');
    const maternite = unites.filter((u) => /maternit|obst/i.test(u.unite));
    if (maternite.length) infra.litsMaternite = somme(maternite, 'operationnels');
  }
  if (infra.litsFonctionnels != null) f.capacites.litsFonctionnels = infra.litsFonctionnels;
  const continuiteEau = infra.eau?.continuite;
  if (continuiteEau) {
    infra.eau.disponibilite = { Continue: 'Permanente', Intermittente: 'Intermittente', Absente: 'Absente' }[continuiteEau];
    infra.pointEau = continuiteEau === 'Absente' ? 'Non' : 'Oui';
  }
  const elec = infra.electriciteDetail;
  if (elec?.sources?.length) {
    infra.electricite = 'Oui';
    infra.groupeElectrogene = elec.sources.includes('Groupe électrogène') ? 'Oui' : 'Non';
  }
  if (elec?.heuresParJour != null) {
    elec.continuite = elec.heuresParJour >= 24 ? 'Continue' : elec.heuresParJour === 0 ? 'Absente' : 'Intermittente';
    if (elec.heuresParJour === 0) infra.electricite = 'Non';
  }
  const frigos = (f.equipements ?? []).filter((q) => C.EQUIPEMENTS_CHAINE_FROID.includes(q.nom));
  if (frigos.length) infra.chaineFroid = frigos.some((q) => (q.fonctionnels ?? q.total ?? 0) > 0) ? 'Oui' : 'Non';

  // Personnel : les RECO sont comptés dans le §10, pas ressaisis.
  const reco = (f.personnel ?? []).find((p) => p.fonction === 'RECO');
  if (reco?.nombre != null) f.recos.nombre = reco.nombre;
}

/** Personnel par fonction (§10) : total et sous-totaux par groupe du catalogue de la structure. */
function calculsPersonnel(personnel = [], type) {
  const groupes = C.PERSONNEL[C.profilCatalogue(type)];
  const nombre = (fonction) => personnel.find((p) => p.fonction === fonction)?.nombre ?? 0;
  const parGroupe = groupes.map((g) => ({ groupe: g.titre, total: g.elements.reduce((s, fct) => s + nombre(fct), 0) }));
  return { total: somme(personnel, 'nombre'), fonctions: personnel.filter((p) => p.nombre).length, parGroupe };
}

// --- Contrôle automatique et complétude --------------------------------------------------------

/** Doublons d'une liste selon une clé (libellés des valeurs répétées). */
function enDouble(liste, cle) {
  const vus = new Set();
  const doubles = new Set();
  for (const x of liste) {
    const k = cle(x);
    if (vus.has(k)) doubles.add(k);
    vus.add(k);
  }
  return [...doubles];
}

/**
 * Contrôle automatique avant vérification : champs obligatoires, cohérences (erreurs bloquantes)
 * et points d'attention (avertissements). Les doublons de code SNIS / GPS sont vérifiés par le
 * contrôleur (base). Les libellés reprennent les rubriques de la fiche « Identification générale ».
 */
function controler(e) {
  const f = e.fiche ?? {};
  const id = f.identification ?? {};
  const loc = f.localisation ?? {};
  const org = f.organisation ?? {};
  const infra = f.infrastructures ?? {};
  const erreurs = [];
  const avertissements = [];
  const exiger = (v, libelle) => { if (!rempli(v)) erreurs.push(`${libelle} : obligatoire.`); };
  const jour = new Date().toISOString().slice(0, 10);

  // 1. Identification générale (et §4 catégorie)
  exiger(e.nom, 'Identification · Nom officiel');
  exiger(e.type, 'Identification · Type de structure');
  exiger(id.categorie, 'Identification · Catégorie de structure');
  exiger(id.statutActuel, 'Identification · Statut de fonctionnement');
  exiger(org.statutJuridique, 'Identification · Statut juridique');
  exiger(org.modeGestion, 'Identification · Régime de gestion / tutelle');
  const permises = C.CATEGORIES_DU_TYPE[e.type];
  if (permises && id.categorie && !permises.includes(id.categorie)) {
    erreurs.push(`Identification · La catégorie « ${C.LIBELLES_CATEGORIE[id.categorie] ?? id.categorie} » ne correspond pas au type « ${e.type} ».`);
  }
  if (id.dateOuverture && id.dateOuverture > jour) erreurs.push('Identification · Date de création / mise en service dans le futur.');
  if (id.anneeCreation != null && (id.anneeCreation < 1850 || id.anneeCreation > new Date().getFullYear())) {
    erreurs.push(`Identification · Année de création invalide (${id.anneeCreation}).`);
  }
  if (id.acteCreation?.date && id.acteCreation.date > jour) erreurs.push('Identification · Date de l’acte dans le futur.');
  if (id.codeSnisVerifieLe && id.codeSnisVerifieLe > jour) erreurs.push('Identification · Date de vérification du code officiel dans le futur.');
  for (const n of id.anciensNoms ?? []) {
    if (n.debut && n.fin && n.fin < n.debut) erreurs.push(`Identification · Ancien nom « ${n.nom} » : fin de validité avant le début.`);
    if (String(n.nom ?? '').trim().toLowerCase() === String(e.nom ?? '').trim().toLowerCase()) {
      erreurs.push(`Identification · « ${n.nom} » est le nom officiel actuel, pas un ancien nom.`);
    }
  }

  // 2. Localisation géographique
  exiger(e.province, 'Localisation · Province');
  exiger(loc.territoire, 'Localisation · Ville ou territoire');
  exiger(e.zonesSante, 'Localisation · Zone de santé');
  exiger(e.aireSante, 'Localisation · Aire de santé');
  exiger(e.adresse, 'Localisation · Adresse détaillée');
  if (e.latitude == null || e.longitude == null) avertissements.push('Localisation · Coordonnées GPS non renseignées : la structure n’apparaîtra pas sur la carte.');
  if (loc.gps?.date && loc.gps.date > jour) erreurs.push('Localisation · Date de collecte GPS dans le futur.');
  for (const [cle, libelle] of [['distanceBczsKm', 'BCZS'], ['distanceHgrKm', 'HGR'], ['distanceCsrKm', 'CSR']]) {
    if (loc[cle] != null && loc[cle] < 0) erreurs.push(`Localisation · Distance au ${libelle} négative.`);
  }

  // 3. Population cible
  const annees = (f.populations ?? []).map((p) => p.annee);
  if (new Set(annees).size !== annees.length) erreurs.push('Population · Deux enregistrements de population pour la même année.');
  for (const p of f.populations ?? []) {
    const t = p.tranches ?? {};
    const groupes = C.GROUPES_POPULATION.filter((g) => t[g.cle] != null && p.totale != null && t[g.cle] > p.totale);
    for (const g of groupes) erreurs.push(`Population · ${p.annee} : ${g.libelle} (${t[g.cle]}) > population totale (${p.totale}).`);
    if (t.moins1 != null && t.de0a23m != null && t.moins1 > t.de0a23m) erreurs.push(`Population · ${p.annee} : 0-11 mois > 0-23 mois.`);
    if (t.de12a23m != null && t.de0a23m != null && t.de12a23m > t.de0a23m) erreurs.push(`Population · ${p.annee} : 12-23 mois > 0-23 mois.`);
    if (t.de0a23m != null && t.moins5 != null && t.de0a23m > t.moins5) erreurs.push(`Population · ${p.annee} : 0-23 mois > 0-59 mois.`);
    if (t.moins1 != null && t.moins5 != null && t.moins1 > t.moins5) erreurs.push(`Population · ${p.annee} : 0-11 mois > 0-59 mois.`);
    if (t.moins1 != null && t.de12a23m != null && t.de0a23m != null && t.moins1 + t.de12a23m !== t.de0a23m) {
      avertissements.push(`Population · ${p.annee} : 0-11 mois + 12-23 mois (${t.moins1 + t.de12a23m}) ≠ 0-23 mois (${t.de0a23m}).`);
    }
    if (p.hommes != null && p.femmes != null && p.totale != null && p.hommes + p.femmes !== p.totale) {
      avertissements.push(`Population · ${p.annee} : hommes + femmes (${p.hommes + p.femmes}) ≠ population totale (${p.totale}).`);
    }
  }
  if (!(f.populations ?? []).length) avertissements.push('Population · Population de l’aire non renseignée : les cibles ne peuvent pas être calculées.');

  // 6. Coordonnées et contacts
  exiger(e.telephone, 'Contacts · Téléphone principal');
  const telephoneValide = (v) => !v || /^\+243\d{9}$/.test(String(v).replace(/[\s.()-]/g, ''));
  const contacts = f.contacts ?? {};
  for (const [v, libelle] of [[e.telephone, 'principal'], [contacts.telephoneSecondaire, 'secondaire'], [contacts.telephoneUrgence, 'd’urgence']]) {
    if (!telephoneValide(v)) avertissements.push(`Contacts · Téléphone ${libelle} : format +243 suivi de 9 chiffres attendu.`);
  }
  for (const c of contacts.contactsService ?? []) {
    if (c.debut && c.fin && c.fin < c.debut) erreurs.push(`Contacts · ${c.service} : fin de validité avant le début.`);
  }

  // 7. Responsables et organisation
  exiger(org.responsable?.nom, 'Responsables · Nom du responsable principal');
  exiger(org.responsable?.prenom, 'Responsables · Prénom du responsable principal');
  exiger(org.titreResponsable || org.responsable?.fonction, 'Responsables · Fonction / titre du responsable principal');
  exiger(org.responsable?.telephone, 'Responsables · Contact du responsable principal');
  if (org.datePriseFonction && org.datePriseFonction > jour) erreurs.push('Responsables · Date de prise de fonction dans le futur.');
  for (const d of enDouble(f.responsablesFonctionnels ?? [], (r) => r.domaine)) erreurs.push(`Responsables · Domaine « ${d} » saisi deux fois.`);
  for (const r of f.responsablesFonctionnels ?? []) {
    if (r.debut && r.fin && r.fin < r.debut) erreurs.push(`Responsables · ${r.domaine} : fin de responsabilité avant le début.`);
    if (r.suppleantDebut && r.suppleantFin && r.suppleantFin < r.suppleantDebut) erreurs.push(`Responsables · ${r.domaine} : fin de suppléance avant le début.`);
  }
  if (org.agrement?.dateEmission && org.agrement?.dateEcheance && org.agrement.dateEcheance < org.agrement.dateEmission) {
    erreurs.push('Responsables · Agrément : échéance avant la date d’émission.');
  }
  for (const p of f.rattachementSanitaire?.programmes ?? []) {
    if (p.debut && p.fin && p.fin < p.debut) erreurs.push(`Rattachement · Programme ${p.programme} : fin de validité avant le début.`);
  }

  // 8. Services et activités
  const services = f.services ?? [];
  if (!services.some((s) => s.fonctionnel === 'Oui' || s.fonctionnel === 'Partiel')) erreurs.push('Services · Aucun service fonctionnel déclaré.');
  for (const d of enDouble(services, (s) => s.service)) erreurs.push(`Services · « ${d} » saisi deux fois.`);
  for (const s of services) {
    if (s.fonctionnel && s.fonctionnel !== 'Non' && s.autorise === 'Non') avertissements.push(`Services · ${s.service} déclaré fonctionnel sans autorisation.`);
    if (s.fonctionnel === 'Oui' && s.disponible === 'Non') erreurs.push(`Services · ${s.service} : fonctionnel mais non disponible.`);
    if (s.existence === 'Non' && s.fonctionnel && s.fonctionnel !== 'Non') erreurs.push(`Services · ${s.service} : déclaré fonctionnel mais inexistant.`);
    if (s.dateDebut && s.dateFin && s.dateFin < s.dateDebut) erreurs.push(`Services · ${s.service} : date de fin avant la date de début.`);
  }

  // 9. Infrastructures
  if (infra.batimentsFonctionnels != null && infra.batiments != null && infra.batimentsFonctionnels > infra.batiments) {
    erreurs.push('Infrastructures · Bâtiments fonctionnels > nombre total de bâtiments.');
  }
  if (infra.litsFonctionnels != null && infra.litsTotal != null && infra.litsFonctionnels > infra.litsTotal) {
    erreurs.push('Infrastructures · Plus de lits opérationnels que de lits installés.');
  }
  for (const u of infra.litsParUnite ?? []) {
    if (u.operationnels != null && u.installes != null && u.operationnels > u.installes) {
      erreurs.push(`Infrastructures · Lits « ${u.unite} » : opérationnels (${u.operationnels}) > installés (${u.installes}).`);
    }
  }
  for (const d of enDouble(infra.litsParUnite ?? [], (u) => String(u.unite).trim().toLowerCase())) erreurs.push(`Infrastructures · Unité de lits « ${d} » saisie deux fois.`);
  if (infra.toilettesFonctionnelles != null && infra.toilettesTotal != null && infra.toilettesFonctionnelles > infra.toilettesTotal) {
    erreurs.push('Infrastructures · Plus de toilettes fonctionnelles que de toilettes au total.');
  }
  if (infra.etatBatiment?.date && infra.etatBatiment.date > jour) erreurs.push('Infrastructures · Date d’évaluation du bâtiment dans le futur.');

  // 10. Ressources humaines
  for (const d of enDouble(f.personnel ?? [], (p) => p.fonction)) erreurs.push(`Ressources humaines · « ${d} » saisi deux fois.`);
  for (const l of f.effectifs ?? []) {
    if (l.present != null && l.affecte != null && l.present > l.affecte) erreurs.push(`Ressources humaines · ${l.categorie} : effectif présent > effectif affecté.`);
  }

  // 11. Équipements
  for (const d of enDouble(f.equipements ?? [], (q) => `${q.categorie ?? ''} · ${q.nom}`)) erreurs.push(`Équipements · ${d} : saisi deux fois.`);
  for (const q of f.equipements ?? []) {
    if ((q.fonctionnels ?? 0) > (q.total ?? 0)) erreurs.push(`Équipements · ${q.nom} : quantité fonctionnelle > quantité totale.`);
    const somme3 = (q.fonctionnels ?? 0) + (q.enPanne ?? 0) + (q.horsService ?? 0);
    if (somme3 > (q.total ?? 0)) erreurs.push(`Équipements · ${q.nom} : fonctionnels + en panne + hors service (${somme3}) > quantité totale (${q.total ?? 0}).`);
  }

  // 13. Informations opérationnelles
  const op = f.operationnel ?? {};
  if (op.urgences?.disponible === 'Oui' && !op.urgences?.horaires && op.fonctionnement24h !== 'Oui') {
    avertissements.push('Opérationnel · Horaires des urgences / de la garde non précisés.');
  }
  if (op.dateDerniereEvaluation && op.dateDerniereEvaluation > jour) erreurs.push('Opérationnel · Date de dernière évaluation dans le futur.');

  // Volet spécifique (hôpital ou centre de santé), s'il a été renseigné.
  const profil = V.profilDe(e);
  if (profil) erreurs.push(...V.controlerVolet(profil, f[profil]));
  return { erreurs, avertissements };
}

/**
 * Champs comptés dans la complétude du dossier, [libellé, valeur] : ceux de la fiche
 * « Identification générale » (les valeurs déduites et les rubriques facultatives comme le site
 * web ou le téléphone secondaire ne pèsent pas).
 */
function champsCompletude(e) {
  const f = e.fiche ?? {};
  const id = f.identification ?? {};
  const loc = f.localisation ?? {};
  const org = f.organisation ?? {};
  const infra = f.infrastructures ?? {};
  const ct = f.contacts ?? {};
  const op = f.operationnel ?? {};
  const pop = populationRecente(f.populations);
  const salles = Object.values(infra.salles?.toObject?.() ?? infra.salles ?? {}).some((v) => v != null);
  const groupes = Object.values(pop?.tranches?.toObject?.() ?? pop?.tranches ?? {}).some((v) => v != null);
  return [
    ['Identification · Nom officiel', e.nom], ['Identification · Type de structure', e.type], ['Identification · Catégorie', id.categorie],
    ['Identification · Code officiel SNIS / DHIS2', id.codeSnis], ['Identification · Source du code officiel', id.codeSnisSource],
    ['Identification · Date de vérification du code', id.codeSnisVerifieLe], ['Identification · Nom usuel / sigle', id.nomUsuel || id.sigle],
    ['Identification · Statut juridique', org.statutJuridique], ['Identification · Régime de gestion / tutelle', org.modeGestion],
    ['Identification · Date de création / mise en service', id.dateOuverture || id.anneeCreation],
    ['Identification · Acte de création (numéro)', id.acteCreation?.numero], ['Identification · Acte de création (autorité)', id.acteCreation?.autorite],
    ['Identification · Statut de fonctionnement', id.statutActuel],
    ['Localisation · Province', e.province], ['Localisation · Ville ou territoire', loc.territoire],
    ['Localisation · Commune / secteur / chefferie', loc.commune], ['Localisation · Groupement / quartier / village', loc.quartier || loc.groupement],
    ['Localisation · Zone de santé', e.zoneSante], ['Localisation · Aire de santé', e.aireSante], ['Localisation · Adresse détaillée', e.adresse],
    ['Localisation · Repère', loc.reperes], ['Localisation · Coordonnées GPS', e.latitude], ['Localisation · Méthode de collecte GPS', loc.gps?.methode],
    ['Population · Population totale de l’aire', pop?.totale], ['Population · Source', pop?.source], ['Population · Groupes cibles', groupes || null],
    ['Contacts · Téléphone principal', e.telephone], ['Contacts · E-mail officiel', e.email],
    ['Contacts · Téléphone d’urgence', ct.telephoneUrgence], ['Contacts · Canal privilégié', ct.canalPrivilegie],
    ['Responsables · Responsable principal', nomPersonne(org.responsable)], ['Responsables · Fonction / titre', org.titreResponsable || org.responsable?.fonction],
    ['Responsables · Contact professionnel', org.responsable?.telephone], ['Responsables · Date de prise de fonction', org.datePriseFonction],
    ['Responsables · Responsables fonctionnels', (f.responsablesFonctionnels ?? []).filter((r) => r.nom)],
    ['Services · Services et activités', (f.services ?? []).some((s) => s.fonctionnel) || null],
    ['Infrastructures · Bâtiments', infra.batiments], ['Infrastructures · Salles par fonction', salles || null],
    ['Infrastructures · Lits', infra.litsTotal], ['Infrastructures · Eau', infra.eau?.continuite || infra.eau?.disponibilite],
    ['Infrastructures · Toilettes fonctionnelles', infra.toilettesFonctionnelles], ['Infrastructures · Électricité', infra.electriciteDetail?.sources],
    ['Infrastructures · Connectivité', infra.connectivite?.internet ?? infra.connectivite?.reseauMobile],
    ['Infrastructures · Accessibilité', infra.accessibilite?.route], ['Infrastructures · État du bâtiment', infra.etatBatiment?.etat],
    ['Ressources humaines · Personnel par fonction', (f.personnel ?? []).filter((p) => p.nombre != null)],
    ['Équipements · Matériel par service', f.equipements],
    ['Opérationnel · Fonctionnement 24h/24', op.fonctionnement24h], ['Opérationnel · Urgences / garde', op.urgences?.disponible],
    ['Opérationnel · Disponibilité des intrants', op.intrants?.etat], ['Opérationnel · Moyens de référence', op.moyensReference],
    ['Opérationnel · Système de rapportage', op.systemeRapportage], ['Opérationnel · Date de dernière évaluation', op.dateDerniereEvaluation],
  ];
}

/** Complétude du dossier en pourcentage (entier). */
function completude(e) {
  const champs = champsCompletude(e);
  return Math.round((champs.filter(([, v]) => rempli(v)).length / champs.length) * 100);
}

/** Libellés des champs non renseignés (affichés avec le pourcentage de complétude). */
function champsManquants(e) {
  return champsCompletude(e).filter(([, v]) => !rempli(v)).map(([libelle]) => libelle);
}

module.exports = {
  NIVEAUX_SANITAIRES, CATEGORIES, STATUTS_ACTUELS, STATUTS_JURIDIQUES, MODES_GESTION, OUI_NON, OUI_NON_PARTIEL, ACCESSIBILITE,
  DISPONIBILITE, ETATS_EQUIPEMENT, PROFESSIONS, CONTRATS, STATUTS_AGENT, REGIMES, SOURCES_POPULATION, SERVICES_SANITAIRES,
  MODULES, STATUTS_CIRCUIT, SECTEUR_DU_STATUT, CATEGORIE_DU_TYPE, CHAMPS_CHEF, SECTIONS, SECTIONS_LISTE, RESPONSABLES, CONTACTS_CPN,
  NIVEAUX_SOINS, TITRES_RESPONSABLE, DOMAINES_RESPONSABILITE, CANAUX_CONTACT, PROGRAMMES, METHODES_GPS, SOURCES_CODE,
  DISPONIBILITES_SERVICE, MOTIFS_INDISPONIBILITE, ETATS_BATIMENT, STABILITES, CONTINUITES, ROUTES, SOURCES_ELECTRICITE, CATEGORIES_RH,
  CATEGORIES_EQUIPEMENT, PREUVES_EQUIPEMENT, MOYENS_REFERENCE, SYSTEMES_RAPPORTAGE, ETATS_INTRANTS, TYPES_PIECE,
  rempli, nomPersonne, abrege, rattachement, calculsEquipements, calculsRh, calculsEffectifs, calculsPersonnel, modulesActifs, modulesPrevus,
  serviceDuModule, servicesPlateforme, populationRecente, calculsCibles, calculsCapacites, deduire, controler, completude, champsManquants,
  profilDe: V.profilDe,
};

// Schéma de la fiche AMI d'un établissement (étapes 1 à 10 du cahier des charges), intégrée au
// document Etablissement. Les champs déjà portés par l'établissement (nom, type, province, zones,
// aire, adresse, téléphone, e-mail, GPS) n'y sont pas répétés.
const mongoose = require('mongoose');
const { dateJour } = require('./commun');
const R = require('../config/ficheEtablissement');
const V = require('../config/ficheSpecifique');

const sansId = { _id: false };
const texte = () => ({ type: String, default: '', trim: true });
const choix = (liste) => ({ type: String, enum: [...liste, null], default: null });
const nombre = (max) => ({ type: Number, min: 0, ...(max ? { max } : {}), default: null });
const entier = (max) => ({
  ...nombre(max),
  validate: { validator: (v) => v == null || Number.isInteger(v), message: 'Nombre entier attendu.' },
});

const personneSchema = new mongoose.Schema({
  nom: texte(), postnom: texte(), prenom: texte(), fonction: texte(), telephone: texte(),
}, sansId);

const fichierSchema = new mongoose.Schema({ url: String, cle: String, nom: String }, sansId);

const acteurSchema = new mongoose.Schema({ type: { type: String, enum: ['comite', 'soignant'] }, id: String, nom: String }, sansId);

const ouiNon = () => choix(R.OUI_NON);
const multi = (liste) => ({ type: [{ type: String, enum: liste }], default: [] });
const sous = (def) => ({ type: new mongoose.Schema(def, sansId), default: () => ({}) });

// --- Volets spécifiques (hôpital, centre de santé) construits à partir de config/ficheSpecifique.js ---

function typeChamp(c) {
  switch (c.type) {
    case 'ouiNon': return ouiNon();
    case 'nombre': return entier();
    case 'decimal': return nombre();
    case 'texte': return texte();
    case 'date': return dateJour();
    case 'choix': return choix(c.options);
    case 'multi': return multi(c.options);
    case 'installeFonctionnel': return sous({ installes: entier(), fonctionnels: entier() });
    case 'groupe': return { type: schemaVolet(c.champs), default: () => ({}) };
    case 'liste': return {
      type: [schemaVolet(c.champs, { element: { type: String, enum: c.elements, required: [true, `${c.libelle} : élément obligatoire.`] } })],
      default: [],
    };
    default: throw new Error(`Type de champ inconnu : ${c.type}`);
  }
}

function schemaVolet(champs, base = {}) {
  const def = { ...base };
  for (const c of champs) def[c.cle] = typeChamp(c);
  return new mongoose.Schema(def, sansId);
}

const voletSchema = (profil) => ({ type: schemaVolet(V.PROFILS[profil].sections), default: undefined });

/** Période de validité (début / fin, AAAA-MM-JJ). */
const periode = () => ({ debut: dateJour(), fin: dateJour() });

// Étape 1 (compléments de l'identité portée par l'établissement).
const identificationSchema = new mongoose.Schema({
  codeSnis: texte(),
  /** Source du code officiel (SNIS, DHIS2…) et date de sa dernière vérification. */
  codeSnisSource: choix(R.SOURCES_CODE),
  codeSnisVerifieLe: dateJour(),
  nomUsuel: texte(),
  sigle: texte(),
  /** Ancien(s) nom(s) et période de validité. */
  anciensNoms: { type: [new mongoose.Schema({ nom: { type: String, required: true, trim: true }, ...periode() }, sansId)], default: [] },
  niveauSanitaire: choix(R.NIVEAUX_SANITAIRES),
  categorie: choix(R.CATEGORIES),
  /** Classification sanitaire : niveau de soins, fonction de référence, activités principales. */
  niveauSoins: choix(R.NIVEAUX_SOINS),
  fonctionReference: ouiNon(),
  categorieReference: texte(),
  territoireCouvert: texte(),
  hospitalisation: ouiNon(),
  maternite: ouiNon(),
  chirurgie: ouiNon(),
  anneeCreation: entier(2100),
  dateOuverture: dateJour(),
  /** Acte de création : numéro, date, autorité émettrice, pièce jointe. */
  acteCreation: sous({ numero: texte(), date: dateJour(), autorite: texte(), piece: { type: fichierSchema, default: null } }),
  statutActuel: choix(R.STATUTS_ACTUELS),
  siteWeb: texte(),
}, sansId);

// Étape 2 (compléments de la localisation ; DPS et BCZS sont déduits).
const localisationSchema = new mongoose.Schema({
  pays: { type: String, default: 'RDC', trim: true },
  territoire: texte(),
  commune: texte(),
  groupement: texte(),
  quartier: texte(),
  /** Adresse détaillée (l'adresse libre reste portée par l'établissement). */
  avenue: texte(),
  numero: texte(),
  reperes: texte(),
  /** Coordonnées GPS (WGS84, portées par l'établissement) : précision, date et méthode de collecte. */
  gps: sous({ precisionM: nombre(), date: dateJour(), methode: choix(R.METHODES_GPS) }),
  distanceBczsKm: nombre(),
  distanceHgrKm: nombre(),
  distanceCsrKm: nombre(),
  tempsDeplacement: texte(),
  moyenTransport: texte(),
  accessibilitePluies: choix(R.ACCESSIBILITE),
  accessibiliteUrgence: choix(R.OUI_NON),
}, sansId);

// Étape 3.
const organisationSchema = new mongoose.Schema({
  statutJuridique: choix(R.STATUTS_JURIDIQUES),
  proprietaire: texte(),
  modeGestion: choix(R.MODES_GESTION),
  tutelleAdministrative: texte(),
  tutelleTechnique: texte(),
  autorisation: {
    type: new mongoose.Schema({ reference: texte(), date: dateJour(), piece: { type: fichierSchema, default: null } }, sansId),
    default: () => ({}),
  },
  agrement: {
    type: new mongoose.Schema({
      numero: texte(), dateEcheance: dateJour(), autorite: texte(), dateEmission: dateJour(), piece: { type: fichierSchema, default: null },
    }, sansId),
    default: () => ({}),
  },
  responsable: { type: personneSchema, default: () => ({}) },
  /** Titre du responsable principal et date de prise de fonction. */
  titreResponsable: choix(R.TITRES_RESPONSABLE),
  datePriseFonction: dateJour(),
  responsableMedical: { type: personneSchema, default: () => ({}) },
  responsableInfirmier: { type: personneSchema, default: () => ({}) },
  responsableAdministratif: { type: personneSchema, default: () => ({}) },
  responsableMaternite: { type: personneSchema, default: () => ({}) },
  joursFonctionnement: { ...entier(7), min: 1 },
  horaires: texte(),
  garde: { type: new mongoose.Schema({ disponible: choix(R.OUI_NON), horaires: texte() }, sansId), default: () => ({}) },
}, sansId);

/** Changement de responsable : l'ancien est conservé, jamais écrasé. */
const changementResponsableSchema = new mongoose.Schema({
  role: String, ancien: personneSchema, nouveau: personneSchema, le: Date, par: acteurSchema,
}, sansId);

// Coordonnées et contacts (le téléphone principal et l'e-mail restent portés par l'établissement).
const contactsSchema = new mongoose.Schema({
  telephoneSecondaire: texte(),
  telephoneUrgence: texte(),
  canalPrivilegie: choix(R.CANAUX_CONTACT),
  /** Contacts de service, avec leur période de validité. */
  contactsService: {
    type: [new mongoose.Schema({
      service: { type: String, required: [true, 'Service du contact obligatoire.'], trim: true },
      nom: texte(), fonction: texte(), telephone: texte(), email: texte(), ...periode(),
    }, sansId)],
    default: [],
  },
}, sansId);

// Rattachement administratif et sanitaire (DPS, BCZS déduits ; zone et aire portées par l'établissement).
const rattachementSanitaireSchema = new mongoose.Schema({
  autoriteTutelle: texte(),
  /** Structure de référence : choisie dans le référentiel des établissements (pas de saisie libre). */
  structureReferenceId: { type: String, default: null },
  /** Structures référées / desservies (identifiants d'établissements). */
  structuresDesservies: { type: [String], default: [] },
  /** Programmes et réseaux, avec leurs dates de validité. */
  programmes: {
    type: [new mongoose.Schema({ programme: { type: String, enum: R.PROGRAMMES, required: true }, precision: texte(), ...periode() }, sansId)],
    default: [],
  },
}, sansId);

// Responsables fonctionnels (CPN, Maternité, PEV, Surveillance, Données, Informatique) et suppléants.
const responsableFonctionnelSchema = new mongoose.Schema({
  domaine: { type: String, enum: R.DOMAINES_RESPONSABILITE, required: [true, 'Domaine de responsabilité obligatoire.'] },
  nom: texte(), postnom: texte(), prenom: texte(), fonction: texte(), telephone: texte(), email: texte(),
  ...periode(),
  suppleant: { type: personneSchema, default: () => ({}) },
  suppleantDebut: dateJour(),
  suppleantFin: dateJour(),
}, sansId);

// Étape 4.
const infrastructuresSchema = new mongoose.Schema({
  batiments: entier(),
  batimentsFonctionnels: entier(),
  batimentsHorsService: entier(),
  salles: {
    type: new mongoose.Schema({
      consultation: entier(), cpn: entier(), accouchement: entier(), vaccination: entier(), observation: entier(),
      laboratoire: entier(), chirurgie: entier(), hospitalisation: entier(),
    }, sansId),
    default: () => ({}),
  },
  litsTotal: entier(),
  litsFonctionnels: entier(),
  litsMaternite: entier(),
  /** Lits par unité : capacité installée et lits opérationnels. */
  litsParUnite: {
    type: [new mongoose.Schema({ unite: { type: String, required: true, trim: true }, installes: entier(), operationnels: entier() }, sansId)],
    default: [],
  },
  eau: sous({ source: texte(), disponibilite: choix(['Permanente', 'Intermittente', 'Absente']), continuite: choix(R.CONTINUITES) }),
  electriciteDetail: sous({ sources: multi(R.SOURCES_ELECTRICITE), heuresParJour: { ...entier(24) }, continuite: choix(R.CONTINUITES) }),
  connectivite: sous({ internet: ouiNon(), reseauMobile: ouiNon(), stabilite: choix(R.STABILITES), operateur: texte() }),
  accessibilite: sous({ route: choix(R.ROUTES), saisonnalite: texte(), pmr: ouiNon() }),
  etatBatiment: sous({ etat: choix(R.ETATS_BATIMENT), date: dateJour(), evaluateur: texte() }),
  blocOperatoire: choix(R.OUI_NON),
  laboratoire: choix(R.OUI_NON),
  pharmacie: choix(R.OUI_NON),
  morgue: choix(R.OUI_NON),
  salleAttente: choix(R.OUI_NON),
  toilettesTotal: entier(),
  toilettesFonctionnelles: entier(),
  pointEau: choix(R.OUI_NON),
  electricite: choix(R.OUI_NON),
  groupeElectrogene: choix(R.OUI_NON),
  chaineFroid: choix(R.OUI_NON),
}, sansId);

const equipementSchema = new mongoose.Schema({
  nom: { type: String, required: [true, 'Nom de l’équipement obligatoire.'], trim: true },
  categorie: texte(),
  total: { ...entier(), default: 0 },
  fonctionnels: { ...entier(), default: 0 },
  enPanne: { ...entier(), default: 0 },
  horsService: { ...entier(), default: 0 },
  dateAcquisition: dateJour(),
  etat: choix(R.ETATS_EQUIPEMENT),
  financement: texte(),
  derniereMaintenance: dateJour(),
  prochaineMaintenance: dateJour(),
  remplacement: choix(R.OUI_NON),
  marque: texte(),
  modele: texte(),
  numeroInventaire: texte(),
  /** Localisation interne : service / salle. */
  service: texte(),
  salle: texte(),
  /** Preuve de recensement : photo sans patient ou fiche d'inventaire. */
  preuveType: choix(R.PREUVES_EQUIPEMENT),
  preuve: { type: fichierSchema, default: null },
}, sansId);

// Étape 5 : registre du personnel (données nominatives : comité et médecin chef seulement).
const agentSchema = new mongoose.Schema({
  code: texte(),
  nom: { type: String, required: [true, 'Nom de l’agent obligatoire.'], trim: true },
  postnom: texte(),
  prenom: texte(),
  sexe: choix(['M', 'F']),
  profession: { type: String, enum: R.PROFESSIONS, required: [true, 'Profession de l’agent obligatoire.'] },
  specialite: texte(),
  qualification: texte(),
  numeroOrdre: texte(),
  fonction: texte(),
  service: texte(),
  contrat: choix(R.CONTRATS),
  statut: { type: String, enum: R.STATUTS_AGENT, default: 'Actif' },
  datePriseFonction: dateJour(),
  disponibilite: { type: String, enum: R.DISPONIBILITE, default: 'Disponible' },
  regime: choix(R.REGIMES),
}, sansId);

const effectifAttenduSchema = new mongoose.Schema({ profession: { type: String, enum: R.PROFESSIONS, required: true }, nombre: entier() }, sansId);

/** Effectifs agrégés par catégorie (théorique, affecté, présent, absents par motif). */
const effectifCategorieSchema = new mongoose.Schema({
  categorie: { type: String, enum: R.CATEGORIES_RH, required: [true, 'Catégorie de personnel obligatoire.'] },
  qualification: texte(),
  theorique: entier(),
  affecte: entier(),
  present: entier(),
  absents: sous({ conge: entier(), formation: entier(), suspension: entier(), absence: entier(), autre: entier() }),
  dateReference: dateJour(),
  source: texte(),
  verificateur: texte(),
}, sansId);

/** Relais communautaires (RECO) liés à l'aire de santé : comptés à part des salariés. */
const recosSchema = new mongoose.Schema({
  nombre: entier(), actifs: entier(), formes: entier(), sitesCommunautaires: entier(), dateReference: dateJour(), source: texte(),
}, sansId);

// Informations opérationnelles.
const operationnelSchema = new mongoose.Schema({
  fonctionnement24h: ouiNon(),
  urgences: sous({ disponible: ouiNon(), horaires: texte() }),
  intrants: sous({ etat: choix(R.ETATS_INTRANTS), date: dateJour(), commentaire: texte() }),
  moyensReference: multi(R.MOYENS_REFERENCE),
  systemeRapportage: multi(R.SYSTEMES_RAPPORTAGE),
  numerique: sous({ ordinateurs: entier(), tablettes: entier(), logiciel: texte(), connectivite: ouiNon(), alimentation: ouiNon() }),
  dateDerniereEvaluation: dateJour(),
}, sansId);

// Étape 6.
const serviceSchema = new mongoose.Schema({
  service: { type: String, enum: R.SERVICES_SANITAIRES, required: true },
  existence: choix(R.OUI_NON),
  autorise: choix(R.OUI_NON),
  disponible: choix(R.OUI_NON),
  /** Disponibilité détaillée : permanente, certains jours, sur appel, indisponible. */
  disponibilite: choix(R.DISPONIBILITES_SERVICE),
  fonctionnel: choix(R.OUI_NON_PARTIEL),
  personnelQualifie: choix(R.OUI_NON),
  equipement: choix(R.DISPONIBILITE),
  joursActivite: entier(7),
  jours: multi(V.JOURS),
  horaires: texte(),
  gardes: texte(),
  dateDebut: dateJour(),
  dateFin: dateJour(),
  motifIndisponibilite: choix(R.MOTIFS_INDISPONIBILITE),
  motifPrecision: texte(),
  dateVerification: dateJour(),
}, sansId);

/** Historique des changements d'état des services (existence, disponibilité, fonctionnalité). */
const changementServiceSchema = new mongoose.Schema({
  service: String, champ: String, ancien: String, nouveau: String, le: Date, par: acteurSchema,
}, sansId);

// Étape 7 : un enregistrement par année, les anciennes valeurs sont conservées.
const populationSchema = new mongoose.Schema({
  annee: { type: Number, required: true, min: 1950, max: 2100 },
  village: texte(),
  /** Population de responsabilité : base des cibles (étape 8). */
  totale: { ...entier(), required: [true, 'Population totale obligatoire.'] },
  administrative: entier(),
  frequentant: entier(),
  menages: entier(),
  urbaine: entier(),
  rurale: entier(),
  hommes: entier(),
  femmes: entier(),
  tranches: {
    type: new mongoose.Schema({ moins1: entier(), moins5: entier(), de5a14: entier(), de15a49: entier(), plus50: entier() }, sansId),
    default: () => ({}),
  },
  source: choix(R.SOURCES_POPULATION),
  dateCollecte: dateJour(),
  dateValidation: dateJour(),
  autorite: texte(),
  methode: texte(),
  saisiPar: { type: acteurSchema, default: null },
  saisiLe: { type: Date, default: null },
}, sansId);

// Étape 9.
const capacitesSchema = new mongoose.Schema({
  accueil: entier(),
  litsFonctionnels: entier(),
  accouchementsMois: entier(),
  cpnMois: entier(),
  seancesVaccinationMois: entier(),
  examensLaboPeriode: entier(),
  urgencesPeriode: entier(),
  vaccins: choix(R.OUI_NON),
  medicaments: choix(R.OUI_NON),
  personnelQualifie: choix(R.OUI_NON),
  electricite: choix(R.OUI_NON),
  eau: choix(R.OUI_NON),
  transportReference: choix(R.OUI_NON),
  communication: choix(R.OUI_NON),
}, sansId);

// Étape 10.
const etapeCircuitSchema = new mongoose.Schema({
  de: String, vers: String, action: String, motif: String, par: acteurSchema, le: Date,
  /** Date d'effet de la décision (par défaut, la date de la transition). */
  dateEffet: { type: String, default: null },
}, sansId);

/** Pièce justificative : fichier + type, numéro, date, émetteur, validité, accès restreint. */
const pieceSchema = new mongoose.Schema({
  url: String, cle: String, nom: String,
  type: choix(R.TYPES_PIECE), numero: texte(), date: dateJour(), emetteur: texte(), validite: dateJour(),
  accesRestreint: { type: Boolean, default: true },
}, sansId);

const circuitSchema = new mongoose.Schema({
  statut: { type: String, enum: R.STATUTS_CIRCUIT, default: 'Brouillon' },
  /**
   * Fiche ouverte pour un établissement enregistré avant la fiche AMI : ses modules restent
   * ouverts jusqu'à sa première activation (il fonctionnait déjà sur la plateforme).
   */
  anterieur: { type: Boolean, default: false },
  /** Auteurs de la saisie (membres du comité) : aucun ne peut vérifier la fiche. */
  auteurs: { type: [String], default: [] },
  controle: {
    type: new mongoose.Schema({ le: Date, erreurs: [String], avertissements: [String] }, sansId),
    default: null,
  },
  verification: {
    type: new mongoose.Schema({
      par: acteurSchema, nom: String, fonction: String, date: String, resultat: { type: String, enum: ['Conforme', 'Non conforme'] },
      observations: String,
    }, sansId),
    default: null,
  },
  /** Pièces justificatives de la vérification (stockage privé, liens signés à la lecture). */
  pieces: { type: [pieceSchema], default: [] },
  motifsCorrection: { type: [String], default: [] },
  validation: {
    type: new mongoose.Schema({ par: acteurSchema, nom: String, fonction: String, date: String, statutFinal: String }, sansId),
    default: null,
  },
  completude: { type: Number, default: 0 },
  qrCode: { type: String, default: null },
  activeLe: { type: Date, default: null },
  historique: { type: [etapeCircuitSchema], default: [] },
}, sansId);

const ficheSchema = new mongoose.Schema({
  identification: { type: identificationSchema, default: () => ({}) },
  localisation: { type: localisationSchema, default: () => ({}) },
  organisation: { type: organisationSchema, default: () => ({}) },
  historiqueResponsables: { type: [changementResponsableSchema], default: [] },
  contacts: { type: contactsSchema, default: () => ({}) },
  rattachementSanitaire: { type: rattachementSanitaireSchema, default: () => ({}) },
  responsablesFonctionnels: { type: [responsableFonctionnelSchema], default: [] },
  infrastructures: { type: infrastructuresSchema, default: () => ({}) },
  equipements: { type: [equipementSchema], default: [] },
  agents: { type: [agentSchema], default: [] },
  effectifsAttendus: { type: [effectifAttenduSchema], default: [] },
  effectifs: { type: [effectifCategorieSchema], default: [] },
  recos: { type: recosSchema, default: () => ({}) },
  services: { type: [serviceSchema], default: [] },
  historiqueServices: { type: [changementServiceSchema], default: [] },
  populations: { type: [populationSchema], default: [] },
  capacites: { type: capacitesSchema, default: () => ({}) },
  operationnel: { type: operationnelSchema, default: () => ({}) },
  /** Volet spécifique : présent selon le type de structure (config/ficheSpecifique.js). */
  hopital: voletSchema('hopital'),
  centreSante: voletSchema('centreSante'),
  circuit: { type: circuitSchema, default: () => ({}) },
  /** Dernières modifications (qui, quelles sections). */
  modifications: {
    type: [new mongoose.Schema({ par: acteurSchema, le: Date, sections: [String] }, sansId)],
    default: [],
  },
}, sansId);

module.exports = { ficheSchema };
